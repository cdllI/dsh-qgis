"""dsh-qgis headless engine.

Long-lived PyQGIS worker: one JSON request per stdin line, one JSON reply per
stdout line.  Every call runs inside the QGIS application this process owns;
nothing here touches a QGIS GUI or opens a port.

Run with the QGIS-bundled interpreter, for example:

    cmd /c "E:\\QGIS 4.0.2\\bin\\python-qgis.bat" engine.py

The caller sets QT_QPA_PLATFORM=offscreen and QT_QPA_FONTDIR before start.
"""

import contextlib
import datetime
import io
import json
import math
import os
import sys
import time
import traceback

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QPA_FONTDIR", os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts"))

from qgis.core import (  # noqa: E402
    QgsApplication,
    QgsColorRampShader,
    QgsCoordinateReferenceSystem,
    QgsCoordinateTransform,
    QgsGeometry,
    QgsLayoutExporter,
    QgsLayoutItemLabel,
    QgsLayoutItemLegend,
    QgsLayoutItemMap,
    QgsLayoutItemPage,
    QgsLayoutItemPicture,
    QgsLayoutItemScaleBar,
    QgsLayoutPoint,
    QgsLayoutSize,
    QgsMapLayer,
    QgsMessageLog,
    QgsPalettedRasterRenderer,
    QgsPointXY,
    QgsPrintLayout,
    QgsProcessingContext,
    QgsProcessingFeedback,
    QgsProcessingParameterDefinition,
    QgsProviderRegistry,
    QgsProject,
    QgsRasterBandStats,
    QgsRasterLayer,
    QgsRasterShader,
    QgsRectangle,
    QgsSingleBandPseudoColorRenderer,
    QgsTextFormat,
    QgsUnitTypes,
    QgsVectorLayer,
    QgsWkbTypes,
    Qgis,
)
from qgis.PyQt.QtCore import QSizeF, QVariant  # noqa: E402
from qgis.PyQt.QtGui import QColor, QFont, QFontDatabase, QFontInfo, QImage  # noqa: E402

VERBOSE = os.environ.get("QGIS_AGENT_VERBOSE") == "1"
MAX_CJK_FONT = os.environ.get("QGIS_AGENT_FONT", "SimHei")
VECTOR_EXTS = {
    ".shp", ".gpkg", ".geojson", ".json", ".kml", ".gml", ".sqlite", ".sqlite3",
    ".tab", ".mif", ".mid", ".fgb", ".parquet", ".csv", ".xlsx", ".ods",
}
RASTER_EXTS = {".tif", ".tiff", ".img", ".vrt", ".asc", ".nc", ".hdf", ".h5", ".bil", ".ecw", ".jp2", ".png", ".jpg"}
PROJECT_EXTS = {".qgs", ".qgz"}


# --------------------------------------------------------------------------- #
# JSON helpers
# --------------------------------------------------------------------------- #

def rect_to_list(rect):
    if rect is None:
        return None
    return [rect.xMinimum(), rect.yMinimum(), rect.xMaximum(), rect.yMaximum()]


def crs_label(crs):
    if crs is None or not crs.isValid():
        return ""
    authid = crs.authid()
    return authid or crs.description() or crs.toWkt()


def layer_kind(layer):
    if isinstance(layer, QgsVectorLayer):
        return "vector"
    if isinstance(layer, QgsRasterLayer):
        return "raster"
    return "other"


def layer_summary(layer, detailed=False):
    if layer is None:
        return None
    summary = {
        "name": layer.name(),
        "id": layer.id(),
        "kind": layer_kind(layer),
        "provider": layer.providerType(),
        "crs": crs_label(layer.crs()),
        "valid": bool(layer.isValid()),
        "source": layer.source(),
        "extent": rect_to_list(layer.extent()),
    }
    if isinstance(layer, QgsVectorLayer):
        count = layer.featureCount()
        summary["feature_count"] = int(count) if count >= 0 else None
        summary["geometry"] = QgsWkbTypes.displayString(layer.wkbType())
        if detailed:
            summary["fields"] = [{"name": f.name(), "type": f.typeName()} for f in layer.fields()]
    elif isinstance(layer, QgsRasterLayer):
        summary["width"] = layer.width()
        summary["height"] = layer.height()
        summary["band_count"] = layer.bandCount()
        if detailed:
            summary["bands"] = [
                {"band": i + 1, "name": layer.bandName(i + 1), "nodata": layer.dataProvider().sourceNoDataValue(i + 1)}
                for i in range(layer.bandCount())
            ]
    return summary


def to_json(value, depth=0):
    """Lossless-enough conversion for the model; never raises for QGIS types."""
    if depth > 6:
        return str(value)
    if isinstance(value, float):
        # JSON has no NaN/Infinity. A raster with no declared nodata returns
        # NaN, and emitting it makes the Host's JSON.parse fail silently.
        return value if math.isfinite(value) else None
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    if isinstance(value, (list, tuple, set)):
        return [to_json(v, depth + 1) for v in value]
    if isinstance(value, dict):
        return {str(k): to_json(v, depth + 1) for k, v in value.items()}
    if isinstance(value, QgsMapLayer):
        return layer_summary(value)
    if isinstance(value, QgsGeometry):
        return value.asWkt()
    if isinstance(value, QgsRectangle):
        return rect_to_list(value)
    if isinstance(value, QgsCoordinateReferenceSystem):
        return crs_label(value)
    if isinstance(value, QgsPointXY):
        return [value.x(), value.y()]
    if isinstance(value, QVariant):
        return to_json(value.value(), depth + 1)
    if isinstance(value, QSizeF):
        return [value.width(), value.height()]
    if isinstance(value, bytes):
        return f"<{len(value)} bytes>"
    return repr(value)


# --------------------------------------------------------------------------- #
# Application / processing
# --------------------------------------------------------------------------- #

class RecordingFeedback(QgsProcessingFeedback):
    """Keeps the tail of algorithm messages so a failed run is diagnosable."""

    def __init__(self):
        super().__init__()
        self.lines = []

    def _push(self, message):
        self.lines.append(str(message).strip())
        if len(self.lines) > 200:
            del self.lines[:-100]

    def pushInfo(self, info):
        self._push(info)

    def pushWarning(self, warning):
        self._push(f"warning: {warning}")

    def pushDebug(self, debug):
        if VERBOSE:
            self._push(f"debug: {debug}")

    def reportError(self, error, fatalError=False):
        self._push(f"error: {error}")


class Engine:
    def __init__(self):
        started = time.time()
        self.app = QgsApplication([], False)
        prefix = os.environ.get("QGIS_PREFIX_PATH") or ""
        if prefix:
            QgsApplication.setPrefixPath(prefix, True)
        self.app.initQgis()
        self.qgis_init_ms = int((time.time() - started) * 1000)
        processing_started = time.time()
        self.processing = None
        self.processing_error = ""
        try:
            plugins = os.path.join(prefix or QgsApplication.prefixPath(), "python", "plugins")
            if os.path.isdir(plugins) and plugins not in sys.path:
                sys.path.append(plugins)
            from processing.core.Processing import Processing  # noqa: WPS433

            Processing.initialize()
            self.processing = Processing
        except Exception as exc:  # pragma: no cover - reported through status
            self.processing_error = f"{type(exc).__name__}: {exc}"
        self.processing_ms = int((time.time() - processing_started) * 1000)
        self.project = QgsProject.instance()
        self.font_family = MAX_CJK_FONT
        fonts_started = time.time()
        self.font_status = self.register_fonts()
        self.fonts_ms = int((time.time() - fonts_started) * 1000)
        self.startup_ms = int((time.time() - started) * 1000)

    def startup(self):
        return {
            "qgis_ms": self.qgis_init_ms,
            "processing_ms": self.processing_ms,
            "fonts_ms": self.fonts_ms,
            "total_ms": self.startup_ms,
        }

    def register_fonts(self):
        """Register the few CJK faces we need instead of scanning every system font.

        Enumerating C:\\Windows\\Fonts through QT_QPA_FONTDIR loads hundreds of
        faces and can block for minutes when the font service or cache is
        contended. Registering two files directly is bounded work, and the
        result is cached for the life of the worker.
        """
        roots = []
        font_dir = os.environ.get("QGIS_AGENT_FONT_DIR") or ""
        if font_dir:
            roots.append(font_dir)
        roots.append(os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts"))
        names = ("simhei.ttf", "msyh.ttc", "msyhbd.ttc", "simsun.ttc", "Deng.ttf")
        added = []
        for root in dict.fromkeys(roots):
            for name in names:
                candidate = os.path.join(root, name)
                if not os.path.exists(candidate):
                    continue
                try:
                    font_id = QFontDatabase.addApplicationFont(candidate)
                    if font_id >= 0:
                        added.extend(QFontDatabase.applicationFontFamilies(font_id))
                except Exception:
                    continue
        families = sorted(set(added))
        for preferred in ("SimHei", "Microsoft YaHei", "SimSun", "DengXian"):
            if preferred in families:
                self.font_family = preferred
                break
        try:
            resolved = QFontInfo(QFont(self.font_family, 12)).family()
        except Exception:
            resolved = ""
        return {
            "dir": font_dir or (roots[-1] if roots else ""),
            "cjk": families,
            "family": self.font_family,
            "resolved": resolved,
            "available": bool(resolved),
            "count": len(families),
        }

    # -- registry ---------------------------------------------------------- #

    def registry(self):
        return QgsApplication.processingRegistry()

    def provider_ids(self):
        return [p.id() for p in self.registry().providers()]

    # -- data access ------------------------------------------------------- #

    def open_layer(self, path, name=None):
        """Open one vector or raster layer from a path or a QGIS layer uri."""
        if not path:
            raise ValueError("empty path")
        path = str(path)
        if os.path.exists(path) is False and "|" not in path and ":" not in path:
            raise FileNotFoundError(path)
        candidates = []
        if "|" in path:
            candidates.append(("ogr", path))
        else:
            ext = os.path.splitext(path.split("|")[0])[1].lower()
            if ext in PROJECT_EXTS:
                raise ValueError(f"{path} is a QGIS project, use scan with a project path")
            if ext in RASTER_EXTS:
                candidates.append(("gdal", path))
                candidates.append(("ogr", path))
            else:
                candidates.append(("ogr", path))
                candidates.append(("gdal", path))
        last_error = ""
        for provider, uri in candidates:
            for label in ([name] if name else []) + [os.path.splitext(os.path.basename(uri.split("|")[0]))[0]]:
                if provider == "gdal":
                    layer = QgsRasterLayer(uri, label, "gdal")
                else:
                    layer = QgsVectorLayer(uri, label, "ogr")
                if layer.isValid():
                    return layer
                last_error = f"{layer.error().summary() if hasattr(layer.error(), 'summary') else ''}"
        # Last resort: qgis provider auto-detection
        layer = QgsVectorLayer(path, name or os.path.basename(path), "ogr")
        if layer.isValid():
            return layer
        layer = QgsRasterLayer(path, name or os.path.basename(path), "gdal")
        if layer.isValid():
            return layer
        raise ValueError(f"cannot open layer {path!r}: {last_error or 'unsupported or missing file'}")

    def sublayers(self, path):
        """Return [(kind, uri, name)] for a dataset, covering GeoPackage layers."""
        ext = os.path.splitext(path)[1].lower()
        if ext in RASTER_EXTS:
            return [("raster", path, os.path.basename(path))]
        md = QgsProviderRegistry.instance().providerMetadata("ogr")
        if md is None:
            return [("vector", path, os.path.basename(path))]
        try:
            details = md.querySublayers(path)
        except Exception:
            details = []
        found = []
        for detail in details:
            kind = "raster" if detail.type() == Qgis.LayerType.Raster else "vector"
            found.append((kind, detail.uri(), detail.name()))
        if not found:
            found.append(("vector", path, os.path.splitext(os.path.basename(path))[0]))
        return found

    # -- operations -------------------------------------------------------- #

    def op_status(self, args):
        alg_count = 0
        try:
            alg_count = len(self.registry().algorithms())
        except Exception:
            pass
        return {
            "qgis_version": Qgis.version(),
            "python": sys.version.split()[0],
            "prefix": QgsApplication.prefixPath(),
            "providers": self.provider_ids(),
            "algorithm_count": alg_count,
            "processing_ready": self.processing is not None,
            "processing_error": self.processing_error,
            "fonts": self.font_status,
            "grass": self.grass_status(),
            "startup": self.startup(),
            "project": self.project.fileName() or None,
            "cwd": os.getcwd(),
            "version": "0.1.0",
        }

    def grass_status(self):
        gisbase = os.environ.get("GISBASE", "")
        version_file = os.path.join(gisbase, "etc", "VERSIONNUMBER") if gisbase else ""
        version = ""
        if version_file and os.path.isfile(version_file):
            try:
                with open(version_file, encoding="utf-8") as handle:
                    version = handle.read().split()[0]
            except Exception:
                version = ""
        return {
            "gisbase": gisbase,
            "version": version,
            "available": bool(gisbase and version),
            "hint": "" if gisbase and version else "set GISBASE to the GRASS install under the QGIS bundle",
        }

    def op_scan(self, args):
        paths = args.get("paths") or []
        if isinstance(paths, str):
            paths = [paths]
        recursive = bool(args.get("recursive", True))
        limit = int(args.get("limit") or 400)
        files = []
        projects = []
        skipped = []
        for raw in paths:
            path = os.path.abspath(str(raw))
            if os.path.isdir(path):
                if recursive:
                    for root, dirs, names in os.walk(path):
                        dirs[:] = [d for d in dirs if not d.startswith(".")]
                        for name in names:
                            ext = os.path.splitext(name)[1].lower()
                            if ext in PROJECT_EXTS:
                                projects.append(os.path.join(root, name))
                            elif ext in VECTOR_EXTS or ext in RASTER_EXTS:
                                files.append(os.path.join(root, name))
                        if len(files) >= limit:
                            break
                else:
                    for name in os.listdir(path):
                        full = os.path.join(path, name)
                        if not os.path.isfile(full):
                            continue
                        ext = os.path.splitext(name)[1].lower()
                        if ext in PROJECT_EXTS:
                            projects.append(full)
                        elif ext in VECTOR_EXTS or ext in RASTER_EXTS:
                            files.append(full)
            elif os.path.isfile(path):
                ext = os.path.splitext(path)[1].lower()
                if ext in PROJECT_EXTS:
                    projects.append(path)
                elif ext in VECTOR_EXTS or ext in RASTER_EXTS:
                    files.append(path)
                else:
                    skipped.append({"path": path, "reason": "unsupported extension"})
            else:
                skipped.append({"path": path, "reason": "missing"})

        files = sorted(dict.fromkeys(files))[:limit]
        projects = sorted(dict.fromkeys(projects))[:40]
        items = []
        errors = []
        for file_path in files:
            try:
                for kind, uri, name in self.sublayers(file_path):
                    layer = self.open_layer(uri, name)
                    item = layer_summary(layer, detailed=True)
                    item.update(
                        {
                            "path": file_path,
                            "uri": uri,
                            "size_bytes": os.path.getsize(file_path) if os.path.exists(file_path) else None,
                            "modified": datetime.datetime.fromtimestamp(os.path.getmtime(file_path)).isoformat(timespec="seconds")
                            if os.path.exists(file_path)
                            else None,
                            "kind": kind,
                        }
                    )
                    items.append(item)
            except Exception as exc:
                errors.append({"path": file_path, "error": f"{type(exc).__name__}: {exc}"})

        project_items = []
        for project_path in projects:
            try:
                project = QgsProject()
                ok = project.read(project_path)
                layers = []
                for layer in project.mapLayers().values():
                    layers.append(layer_summary(layer, detailed=True))
                project_items.append(
                    {
                        "path": project_path,
                        "read": bool(ok),
                        "crs": crs_label(project.crs()),
                        "layer_count": len(layers),
                        "layers": layers,
                    }
                )
            except Exception as exc:
                errors.append({"path": project_path, "error": f"{type(exc).__name__}: {exc}"})

        return {
            "scanned": len(files) + len(projects),
            "layer_count": len(items),
            "items": items,
            "projects": project_items,
            "skipped": skipped,
            "errors": errors,
            "truncated": len(files) >= limit,
        }

    def parameter_help(self, algorithm):
        params = []
        try:
            definitions = algorithm.parameterDefinitions()
        except Exception:
            definitions = []
        for definition in definitions:
            flags = int(definition.flags())
            entry = {
                "name": definition.name(),
                "type": definition.type(),
                "description": definition.description(),
                "optional": bool(flags & int(QgsProcessingParameterDefinition.FlagOptional)),
                "advanced": bool(flags & int(QgsProcessingParameterDefinition.FlagAdvanced)),
                "destination": bool(definition.isDestination()) if hasattr(definition, "isDestination") else False,
            }
            try:
                default = definition.defaultValue()
                if default is not None and not isinstance(default, (str, int, float, bool, list, dict)):
                    default = str(default)
                entry["default"] = to_json(default)
            except Exception:
                pass
            options = getattr(definition, "options", None)
            if callable(options):
                try:
                    opts = list(options())
                    if opts:
                        entry["options"] = [str(o) for o in opts]
                except Exception:
                    pass
            params.append(entry)
        outputs = []
        try:
            for output in algorithm.outputDefinitions():
                outputs.append({"name": output.name(), "type": output.type(), "description": output.description()})
        except Exception:
            pass
        return {
            "algorithm": algorithm.id(),
            "name": algorithm.displayName(),
            "group": algorithm.group(),
            "short_description": algorithm.shortDescription(),
            "help_url": algorithm.helpUrl() if hasattr(algorithm, "helpUrl") else "",
            "parameters": params,
            "outputs": outputs,
            "notes": [
                "parameter names are case sensitive",
                "optional parameters can be omitted; QGIS applies the default",
            ],
        }

    def op_find(self, args):
        registry = self.registry()
        algorithm_id = args.get("id") or ""
        query = str(args.get("query") or "").strip()
        provider = str(args.get("provider") or "").strip()
        limit = int(args.get("limit") or 12)
        if not registry:
            raise RuntimeError("processing registry is not available")
        if algorithm_id:
            algorithm = registry.algorithmById(algorithm_id)
            if algorithm is None:
                raise ValueError(f"no algorithm with id {algorithm_id!r}")
            return {"help": self.parameter_help(algorithm)}
        tokens = [t for t in query.lower().replace("_", " ").split() if t]
        scored = []
        for algorithm in registry.algorithms():
            try:
                if provider and algorithm.provider() and algorithm.provider().id() != provider:
                    continue
                display_name = (algorithm.displayName() or "").lower()
                haystack = " ".join(
                    [
                        algorithm.id(),
                        display_name,
                        algorithm.group() or "",
                        algorithm.shortDescription() or "",
                        " ".join(algorithm.tags() or []),
                    ]
                ).lower()
            except Exception:
                continue
            score = 0
            for token in tokens:
                if token in haystack:
                    score += 1
                if token in display_name:
                    score += 2
            if not tokens:
                score = 1
            if score:
                scored.append((score, algorithm.id(), algorithm))
        scored.sort(key=lambda row: (-row[0], row[1]))
        matches = []
        for score, alg_id, algorithm in scored[:limit]:
            matches.append(
                {
                    "id": alg_id,
                    "name": algorithm.displayName(),
                    "group": algorithm.group(),
                    "short_description": algorithm.shortDescription(),
                    "provider": algorithm.provider().id() if algorithm.provider() else "",
                    "score": score,
                }
            )
        return {
            "query": query,
            "total": len(scored),
            "matches": matches,
            "hint": "call qgis_find with id=<algorithm id> for the full parameter list"
            if matches
            else "no match; try an English verb such as buffer, clip, reproject, join, zonal",
        }

    def op_run(self, args):
        if self.processing is None:
            raise RuntimeError(f"processing is unavailable: {self.processing_error}")
        algorithm_id = str(args.get("algorithm") or "")
        parameters = args.get("parameters") or {}
        if not isinstance(parameters, dict):
            raise ValueError("parameters must be an object")
        registry = self.registry()
        algorithm = registry.algorithmById(algorithm_id)
        if algorithm is None:
            raise ValueError(f"no algorithm with id {algorithm_id!r}; call qgis_find first")
        started = time.time()

        context = QgsProcessingContext()
        feedback = RecordingFeedback()
        feedback.setProgressText("")
        context.setProject(self.project)

        output_dir = str(args.get("output_dir") or "")
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
            slug = algorithm_id.replace(":", "-").replace("/", "-")
            for definition in algorithm.parameterDefinitions():
                if not definition.isDestination() or definition.name() in parameters:
                    continue
                flags = int(definition.flags())
                if flags & int(QgsProcessingParameterDefinition.FlagOptional):
                    continue
                param_type = (definition.type() or "").lower()
                extension = ".tif" if "raster" in param_type else ".gpkg"
                parameters[definition.name()] = os.path.join(
                    output_dir, f"{slug}-{definition.name().lower()}{extension}"
                )

        result = self.processing.runAlgorithm(
            algorithm_id,
            parameters,
            None,
            feedback,
            context,
        )
        duration = int((time.time() - started) * 1000)
        outputs = {}
        for key, value in (result or {}).items():
            if isinstance(value, QgsMapLayer):
                summary = layer_summary(value, detailed=True)
                summary["result_key"] = key
                outputs[key] = summary
            else:
                outputs[key] = to_json(value)
        return {
            "algorithm": algorithm_id,
            "outputs": outputs,
            "duration_ms": duration,
            "log": feedback.lines[-60:],
            "parameters": to_json(parameters),
        }

    def open_target(self, args):
        path = args.get("path")
        layer = args.get("layer")
        if not path:
            raise ValueError("path is required")
        layers = self.sublayers(path)
        if layer:
            for kind, uri, name in layers:
                if name == layer:
                    return self.open_layer(uri, name)
            raise ValueError(f"layer {layer!r} not found in {path}; available: {[n for _, _, n in layers]}")
        if len(layers) > 1:
            # Prefer a vector layer for checks, list the rest.
            for kind, uri, name in layers:
                if kind == "vector":
                    return self.open_layer(uri, name)
        kind, uri, name = layers[0]
        return self.open_layer(uri, name)

    def op_check(self, args):
        layer = self.open_target(args)
        expected_crs = args.get("expected_crs")
        warnings = []
        info = layer_summary(layer, detailed=True)
        if expected_crs:
            wanted = QgsCoordinateReferenceSystem(str(expected_crs))
            if not wanted.isValid():
                warnings.append(f"expected_crs {expected_crs!r} is not a valid CRS")
            elif layer.crs().authid() and wanted.authid() and layer.crs().authid().upper() != wanted.authid().upper():
                warnings.append(f"CRS mismatch: layer is {layer.crs().authid()}, expected {wanted.authid()}")
        if not layer.crs().isValid():
            warnings.append("layer has no valid CRS")
        elif layer.crs().isGeographic():
            warnings.append("layer CRS is geographic (degrees); area/length must be computed with an equal-area or projected CRS")

        if isinstance(layer, QgsVectorLayer):
            total = 0
            empty = 0
            invalid = 0
            null_geom = 0
            checked = 0
            invalid_sample = []
            for feature in layer.getFeatures():
                checked += 1
                total += 1
                geometry = feature.geometry()
                if geometry is None or geometry.isNull():
                    null_geom += 1
                    continue
                if geometry.isEmpty():
                    empty += 1
                    continue
                if not geometry.isGeosValid():
                    invalid += 1
                    if len(invalid_sample) < 5:
                        invalid_sample.append(geometry.asWkt()[:160])
                if checked >= 200000:
                    break
            if null_geom:
                warnings.append(f"{null_geom} feature(s) have null geometry")
            if empty:
                warnings.append(f"{empty} feature(s) have empty geometry")
            if invalid:
                warnings.append(f"{invalid} feature(s) have invalid geometry")
            if total == 0:
                warnings.append("layer has no features")
            info.update(
                {
                    "sampled_features": checked,
                    "empty_geometry": empty,
                    "null_geometry": null_geom,
                    "invalid_geometry": invalid,
                    "invalid_examples": invalid_sample,
                }
            )
        elif isinstance(layer, QgsRasterLayer):
            provider = layer.dataProvider()
            bands = []
            for band in range(1, layer.bandCount() + 1):
                entry = {"band": band, "name": layer.bandName(band)}
                try:
                    stats = provider.bandStatistics(
                        band,
                        QgsRasterBandStats.All,
                        layer.extent(),
                        int(args.get("sample_size") or 120000),
                    )
                    entry.update(
                        {
                            "min": stats.minimumValue,
                            "max": stats.maximumValue,
                            "mean": stats.mean,
                            "stddev": stats.stdDev,
                            "sample_count": stats.elementCount,
                        }
                    )
                    if hasattr(stats, "nodataCount"):
                        entry["nodata_count"] = stats.nodataCount
                except Exception as exc:
                    entry["error"] = f"{type(exc).__name__}: {exc}"
                entry["nodata"] = provider.sourceNoDataValue(band)
                bands.append(entry)
            if provider.sourceNoDataValue(1) is None:
                warnings.append("band 1 has no declared nodata value")
            info["bands"] = bands
        return {"layer": info, "warnings": warnings, "sample_size_capped": True}

    def map_extent(self, layers, extent_arg, target_crs):
        if extent_arg:
            values = [float(v) for v in extent_arg]
            if len(values) != 4:
                raise ValueError("extent must be [west, south, east, north]")
            return QgsRectangle(*values)
        rectangle = None
        xmins, ymins, xmaxs, ymaxs = [], [], [], []
        for layer in layers:
            if not layer.crs().isValid():
                continue
            rect = layer.extent()
            if layer.crs() != target_crs:
                transform = QgsCoordinateTransform(layer.crs(), target_crs, self.project.transformContext())
                rect = transform.transformBoundingBox(rect)
            if rect.isEmpty():
                continue
            xmins.append(rect.xMinimum())
            ymins.append(rect.yMinimum())
            xmaxs.append(rect.xMaximum())
            ymaxs.append(rect.yMaximum())
        if xmins:
            rectangle = QgsRectangle(min(xmins), min(ymins), max(xmaxs), max(ymaxs))
        if rectangle is None or rectangle.isEmpty():
            raise ValueError("cannot derive a map extent from the given layers")
        if rectangle.width() <= 0 or rectangle.height() <= 0:
            raise ValueError("map extent is degenerate")
        margin = 0.04
        return rectangle.buffered(max(rectangle.width(), rectangle.height()) * margin)

    def style_raster(self, layer):
        """Readable default symbology: categorical for few values, ramp otherwise."""
        try:
            provider = layer.dataProvider()
            if provider is None or layer.bandCount() < 1:
                return
            if provider.colorTable(1):
                return
            stats = provider.bandStatistics(1, QgsRasterBandStats.All, layer.extent(), 100000)
            vmin, vmax = float(stats.minimumValue), float(stats.maximumValue)
            if not (math.isfinite(vmin) and math.isfinite(vmax)) or vmax <= vmin:
                return
            sample_w = min(layer.width() or 96, 96)
            sample_h = min(layer.height() or 96, 96)
            block = provider.block(1, layer.extent(), sample_w, sample_h)
            unique = set()
            if block is not None and block.isValid():
                for y in range(block.height()):
                    for x in range(block.width()):
                        value = block.value(x, y)
                        if value is None:
                            continue
                        try:
                            value = float(value)
                        except (TypeError, ValueError):
                            continue
                        if math.isfinite(value):
                            unique.add(round(value, 6))
            if 1 < len(unique) <= 24:
                palette = [
                    "#2166ac", "#d6604d", "#4dac26", "#f1a340", "#998ec3", "#018571",
                    "#b2182b", "#80cdc1", "#f4a582", "#5ab4ac", "#d8b365", "#762a83",
                ]
                classes = [
                    QgsPalettedRasterRenderer.Class(value, QColor(palette[index % len(palette)]), f"{value:g}")
                    for index, value in enumerate(sorted(unique))
                ]
                if classes:
                    layer.setRenderer(QgsPalettedRasterRenderer(provider, 1, classes))
                    return
            stops = [
                (0.0, "#08306b"),
                (0.2, "#2171b5"),
                (0.4, "#6baed6"),
                (0.6, "#c7e9b4"),
                (0.8, "#f4a582"),
                (1.0, "#8c510a"),
            ]
            items = [
                QgsColorRampShader.ColorRampItem(
                    vmin + (vmax - vmin) * fraction,
                    QColor(color),
                    f"{vmin + (vmax - vmin) * fraction:.1f}",
                )
                for fraction, color in stops
            ]
            shader = QgsColorRampShader(vmin, vmax)
            shader.setColorRampType(Qgis.ShaderInterpolationMethod.Linear)
            shader.setColorRampItemList(items)
            raster_shader = QgsRasterShader()
            raster_shader.setRasterShaderFunction(shader)
            layer.setRenderer(QgsSingleBandPseudoColorRenderer(provider, 1, raster_shader))
        except Exception:
            # Styling is cosmetic: a failure must never fail the map.
            pass

    def op_map(self, args):
        layers_arg = args.get("layers") or []
        if isinstance(layers_arg, str):
            layers_arg = [{"path": layers_arg}]
        if not layers_arg:
            raise ValueError("layers is required, for example [{\"path\": \"D:/data/roads.shp\"}]")
        dpi = int(args.get("dpi") or 300)
        title = str(args.get("title") or "")
        subtitle = str(args.get("subtitle") or "")
        source_note = str(args.get("source") or "")
        output = str(args.get("output") or "")
        if not output:
            raise ValueError("output path is required")
        os.makedirs(os.path.dirname(os.path.abspath(output)) or ".", exist_ok=True)

        project = QgsProject()
        project.setCrs(QgsCoordinateReferenceSystem(str(args.get("crs") or "EPSG:3857")))
        target_crs = project.crs()
        if not target_crs.isValid():
            raise ValueError(f"invalid CRS {args.get('crs')!r}")

        loaded = []
        for spec in layers_arg:
            if isinstance(spec, str):
                spec = {"path": spec}
            layer = self.open_layer(spec.get("path") or spec.get("uri"), spec.get("name"))
            if isinstance(layer, QgsRasterLayer) and args.get("style", True):
                self.style_raster(layer)
            loaded.append(layer)
            # Only vectors feed the legend: a classified raster can contribute
            # dozens of legend rows and push the legend off the page.
            project.addMapLayer(layer, isinstance(layer, QgsVectorLayer))
            if spec.get("opacity") is not None:
                layer.setOpacity(float(spec["opacity"]))
        extent = self.map_extent(loaded, args.get("extent"), target_crs)

        requested_w = args.get("width_mm")
        requested_h = args.get("height_mm")
        if requested_w and requested_h:
            width_mm, height_mm = float(requested_w), float(requested_h)
        elif requested_w or requested_h:
            width_mm = float(requested_w or 140)
            height_mm = float(requested_h or 190)
        else:
            aspect = extent.width() / extent.height() if extent.height() else 1.0
            if aspect < 0.85:
                width_mm, height_mm = 130, 190
            elif aspect < 1.15:
                width_mm, height_mm = 150, 190
            elif aspect < 1.5:
                width_mm, height_mm = 180, 170
            else:
                width_mm, height_mm = 190, 140

        layout = QgsPrintLayout(project)
        layout.initializeDefaults()
        layout.setName(str(args.get("title") or "qgis-agent"))
        page = layout.pageCollection().page(0)
        page.setPageSize(QgsLayoutSize(width_mm, height_mm, QgsUnitTypes.LayoutMillimeters))

        margin = 10.0
        title_font = QFont(self.font_family, 15)
        title_font.setBold(True)
        if title:
            header_bottom = 26.0
        elif subtitle:
            header_bottom = 18.0
        else:
            header_bottom = margin
        footer_band = 18.0
        box_w = width_mm - 2 * margin
        box_h = height_mm - header_bottom - footer_band
        aspect = extent.width() / extent.height() if extent.height() else 1.0
        if aspect >= box_w / box_h:
            map_w, map_h = box_w, box_w / aspect
        else:
            map_h, map_w = box_h, box_h * aspect
        map_x = margin + (box_w - map_w) / 2
        map_y = header_bottom + (box_h - map_h) / 2

        map_item = QgsLayoutItemMap(layout)
        layout.addLayoutItem(map_item)
        map_item.attemptMove(QgsLayoutPoint(map_x, map_y))
        map_item.attemptResize(QgsLayoutSize(map_w, map_h))
        map_item.setCrs(target_crs)
        map_item.setLayers(loaded)
        map_item.setExtent(extent)
        map_item.setBackgroundColor(QColor(255, 255, 255))

        if title:
            title_label = QgsLayoutItemLabel(layout)
            title_label.setTextFormat(self.text_format(title_font, 15))
            title_label.setText(title)
            title_label.adjustSizeToText()
            layout.addLayoutItem(title_label)
            title_label.attemptMove(QgsLayoutPoint(margin, 9))
            rule = QgsLayoutItemLabel(layout)
            rule.setBackgroundEnabled(True)
            rule.setBackgroundColor(QColor("#0f766e"))
            layout.addLayoutItem(rule)
            rule.attemptResize(QgsLayoutSize(24, 0.8))
            rule.attemptMove(QgsLayoutPoint(margin, 18.4))

        if subtitle:
            subtitle_label = QgsLayoutItemLabel(layout)
            subtitle_label.setTextFormat(
                self.text_format(QFont(self.font_family, 9), 9, QColor("#6b7280"))
            )
            subtitle_label.setText(subtitle)
            subtitle_label.adjustSizeToText()
            layout.addLayoutItem(subtitle_label)
            subtitle_label.attemptMove(QgsLayoutPoint(margin, 21 if title else 9))

        legend_vectors = [layer for layer in loaded if isinstance(layer, QgsVectorLayer)]
        if args.get("legend", True) and legend_vectors:
            legend = QgsLayoutItemLegend(layout)
            legend.setTitle(str(args.get("legend_title") or "图例"))
            legend.setLinkedMap(map_item)
            legend.setBackgroundEnabled(True)
            legend.setBackgroundColor(QColor(255, 255, 255, 225))
            layout.addLayoutItem(legend)
            if hasattr(legend, "updateLegend"):
                legend.updateLegend()
            legend.adjustBoxSize()
            legend_width = min(legend.sizeWithUnits().width() or 50, (width_mm - 2 * margin) * 0.42)
            legend_height = min(legend.sizeWithUnits().height() or 20, map_h - 6)
            legend.attemptResize(QgsLayoutSize(legend_width, legend_height))
            legend.attemptMove(QgsLayoutPoint(map_x + 3, map_y + 3))

        if args.get("scalebar", True):
            scalebar = QgsLayoutItemScaleBar(layout)
            scalebar.setStyle("Single Box")
            scalebar.setLinkedMap(map_item)
            scalebar.applyDefaultSize()
            scalebar.setTextFormat(self.text_format(QFont(self.font_family, 7), 7))
            # Keep QGIS's default units, but double the segment length so the
            # three labels of a short default bar stop colliding.
            try:
                base = scalebar.unitsPerSegment() or 1000.0
                scalebar.setUnitsPerSegment(base * 2)
                scalebar.setNumberOfSegments(2)
                scalebar.setNumberOfSegmentsLeft(0)
                if hasattr(scalebar, "refreshItemSize"):
                    scalebar.refreshItemSize()
            except Exception:
                pass
            layout.addLayoutItem(scalebar)
            scalebar.attemptMove(QgsLayoutPoint(margin, height_mm - 22))

        if args.get("north_arrow", True):
            svg = os.path.join(os.path.dirname(os.path.abspath(__file__)), "north.svg")
            if not os.path.exists(svg):
                svg = os.path.join(QgsApplication.prefixPath(), "svg", "arrows", "NorthArrow_04.svg")
            if os.path.exists(svg):
                arrow = QgsLayoutItemPicture(layout)
                arrow.setPicturePath(svg)
                arrow.setResizeMode(QgsLayoutItemPicture.Zoom)
                layout.addLayoutItem(arrow)
                arrow.attemptResize(QgsLayoutSize(12, 16.8))
                # Outside the map frame: top-right of the page, beside the title block.
                arrow.attemptMove(QgsLayoutPoint(width_mm - margin - 12, 4))

        note_parts = []
        if source_note:
            note_parts.append(source_note[:90])
        note_parts.append(f"{crs_label(target_crs)} · {dpi} dpi")
        note = QgsLayoutItemLabel(layout)
        note.setTextFormat(self.text_format(QFont(self.font_family, 8), 8, QColor("#6b7280")))
        note.setText(" · ".join(note_parts))
        note.adjustSizeToText()
        layout.addLayoutItem(note)
        note.attemptMove(QgsLayoutPoint(margin, height_mm - 9.5))

        separator = QgsLayoutItemLabel(layout)
        separator.setBackgroundEnabled(True)
        separator.setBackgroundColor(QColor("#e5e7eb"))
        layout.addLayoutItem(separator)
        separator.attemptResize(QgsLayoutSize(width_mm - 2 * margin, 0.25))
        separator.attemptMove(QgsLayoutPoint(margin, height_mm - 12.5))

        settings = QgsLayoutExporter.ImageExportSettings()
        settings.dpi = dpi
        exporter = QgsLayoutExporter(layout)
        result = exporter.exportToImage(output, settings)
        if result != QgsLayoutExporter.Success:
            raise RuntimeError(f"layout export failed with code {result}")
        image = QImage(output)
        outputs = [output]
        pdf = args.get("pdf")
        if pdf:
            pdf_path = str(pdf)
            os.makedirs(os.path.dirname(os.path.abspath(pdf_path)) or ".", exist_ok=True)
            pdf_settings = QgsLayoutExporter.PdfExportSettings()
            pdf_settings.dpi = dpi
            pdf_result = exporter.exportToPdf(pdf_path, pdf_settings)
            if pdf_result == QgsLayoutExporter.Success:
                outputs.append(pdf_path)
        return {
            "path": output,
            "paths": outputs,
            "width": image.width(),
            "height": image.height(),
            "dpi": dpi,
            "crs": crs_label(target_crs),
            "extent": rect_to_list(extent),
            "layers": [layer_summary(layer) for layer in loaded],
            "page_mm": [width_mm, height_mm],
            "map_mm": [map_item.sizeWithUnits().width(), map_item.sizeWithUnits().height()],
            "map_pos_mm": [map_item.positionWithUnits().x(), map_item.positionWithUnits().y()],
        }

    @staticmethod
    def text_format(font, size, color=None):
        fmt = QgsTextFormat()
        fmt.setFont(font)
        fmt.setSize(size)
        fmt.setSizeUnit(Qgis.RenderUnit.Points)
        fmt.setColor(color or QColor(31, 41, 55))
        return fmt

    # -- dispatch ---------------------------------------------------------- #

    def dispatch(self, op, args):
        handlers = {
            "status": self.op_status,
            "scan": self.op_scan,
            "find": self.op_find,
            "run": self.op_run,
            "check": self.op_check,
            "map": self.op_map,
        }
        handler = handlers.get(op)
        if handler is None:
            raise ValueError(f"unknown op {op!r}; available: {sorted(handlers)}")
        return handler(args or {})


# --------------------------------------------------------------------------- #
# Main loop
# --------------------------------------------------------------------------- #

def json_safe(value):
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    return value


def emit(payload):
    sys.stdout.write(json.dumps(json_safe(payload), ensure_ascii=False, allow_nan=False) + "\n")
    sys.stdout.flush()


def main():
    engine = Engine()
    emit({"event": "ready", "version": "0.1.0", "qgis_version": Qgis.version(), "startup": engine.startup()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            op = request.get("op")
            args = request.get("args") or {}
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                result = engine.dispatch(op, args)
            printed = buffer.getvalue().strip()
            if printed and VERBOSE:
                result = {"result": result, "stdout": printed}
            emit({"id": request_id, "ok": True, "result": to_json(result)})
        except Exception as exc:
            emit(
                {
                    "id": request_id,
                    "ok": False,
                    "error": f"{type(exc).__name__}: {exc}",
                    "traceback": traceback.format_exc()[-3000:],
                }
            )


if __name__ == "__main__":
    main()
