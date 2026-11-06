# QGIS (headless)

Use the `qgis_*` tools to do real GIS work without opening QGIS. A long-lived PyQGIS engine runs under the
QGIS 4 interpreter; every tool call is one operation inside that engine. QGIS does **not** need to be open,
and no GUI is involved.

Start with `qgis_status`. It reports the QGIS version, providers, algorithm count, CJK fonts, the GRASS
install (if any) and the output folders. It also discovers QGIS automatically. If it reports that QGIS is
missing, do not ask the user to edit configuration: locate the directory that contains `bin\qgis-bin.exe`
(search the available drives or the OS package list), then call `qgis_status qgis_dir=<directory>`. The
plugin starts the engine from that directory and saves the choice to `qgis.config.json` for later calls.

## The workflow

```
qgis_scan  →  qgis_find  →  qgis_run  →  qgis_check  →  qgis_map  →  qgis_history
```

1. **Scan, do not guess.** `qgis_scan` takes files, folders or `.qgs/.qgz` projects and returns every layer
   with path, CRS, geometry, feature count, fields, extent and size. Use those exact paths afterwards.
2. **Find the algorithm.** `qgis_find query="buffer"` searches 769 algorithms; `qgis_find id="native:buffer"`
   returns the exact parameter names, types, defaults, optional flags and enum values.
3. **Run it.** `qgis_run` runs one algorithm. Omit destination parameters and the plugin writes them under
   `exports/` (`.gpkg` for vector, `.tif` for raster). Every run also writes a rerunnable Python script.
4. **Check the result.** `qgis_check` reports CRS, feature count, empty/null/invalid geometries, fields,
   band statistics and nodata. Do this before quoting a number or shipping a figure.
5. **Map it.** `qgis_map` renders a page layout (title, legend, scale bar, north arrow) to PNG at the
   requested dpi and shows it in the conversation.
6. **Keep it reproducible.** `qgis_history action=methods` writes a Markdown methods section with every
   algorithm, parameter, output and duration.

## Tools

| Tool | Use it for |
|---|---|
| `qgis_status` | Environment check: QGIS version, providers, algorithms, fonts, output folders. |
| `qgis_scan` | Inventory files/folders/projects; read an existing `.qgz` without opening QGIS. |
| `qgis_find` | Keyword search over the algorithm registry, or exact parameter help for one id. |
| `qgis_run` | Run one processing algorithm headlessly; outputs, log, script. |
| `qgis_check` | Vector/raster quality check; warnings first. |
| `qgis_map` | 300 dpi print layout PNG (and optional PDF) with legend/scale bar/north arrow. |
| `qgis_history` | List this session's steps, list every saved file with absolute paths, or export a methods document. |

## Rules that prevent most wrong results

- **Never guess an algorithm id or a parameter name.** Call `qgis_find` first. Parameter names are case
  sensitive (`INPUT`, `DISTANCE`, `OUTPUT`).
- **Never guess a data path.** `qgis_scan` returns paths; pass them verbatim, including Chinese characters and
  spaces. All I/O is UTF-8.
- **CRS first.** `qgis_check` warns when a layer is geographic (degrees). Distances and areas in `native:buffer`,
  `native:area`, `$area` etc. use the layer's units. Reproject to a projected CRS before measuring:
  `native:reprojectlayer` with `TARGET_CRS=EPSG:4547` (CGCS2000 / 3-degree GK CM 114E) or `EPSG:32649`.
- **Outputs are files, not layers in a project.** After `qgis_run`, the result exists as a path in `exports/`.
  Use that path in the next tool call or in `qgis_map`.
- **memory: outputs are allowed** but they disappear with the session; convert them to a file by passing an
  `OUTPUT` path instead.
- **Long algorithms block the engine**, not a window. They can take minutes (IDW, hydrology, national rasters).
  Prefer a study-area clip first. A timeout message is not a wrong result: re-run smaller or raise the scope
  only when asked.
- **Never claim success from `qgis_run` alone.** Run `qgis_check` on the output, and for a claimed area/count,
  quote the check's numbers.

## Common recipes

**Buffer, then overlay and measure**

```
qgis_find query="buffer"
qgis_run algorithm="native:buffer"
  parameters={"INPUT":"<data>/farmland.gpkg","DISTANCE":500,"SEGMENTS":8,"DISSOLVE":false}
qgis_check path="<OUTPUT from run>" expected_crs="EPSG:4547"
```

Distances are in input units. If the layer is EPSG:4326, first `native:reprojectlayer` to EPSG:4547;
otherwise 500 means 500 degrees.

**Clip / intersect**

```
qgis_run algorithm="native:clip" parameters={"INPUT":"...","OVERLAY":"...","OUTPUT":"..."}
qgis_run algorithm="native:intersection" parameters={"INPUT":"...","OVERLAY":"...","OUTPUT":"..."}
```

**Zonal statistics**

```
qgis_run algorithm="native:zonalstatisticsfb"
  parameters={"INPUT":"<data>/regions.gpkg","INPUT_RASTER":"<data>/ndvi.tif","RASTER_BAND":1,"COLUMN_PREFIX":"ndvi_"}
```

**Reproject a layer**

```
qgis_run algorithm="native:reprojectlayer"
  parameters={"INPUT":"...","TARGET_CRS":"EPSG:4547"}
```

**Points from an Excel table**

```
qgis_find query="points from table"
qgis_run algorithm="native:createpointslayerfromtable"
  parameters={"INPUT":"<data>/stations.xlsx","XFIELD":"lon","YFIELD":"lat","TARGET_CRS":"EPSG:4326"}
```

**A figure for a paper**

```
qgis_map layers=[{"path":"<workspace>/exports/farmland_buffer.gpkg"},{"path":"<data>/admin.gpkg"}]
  title="研究区耕地缓冲分析" subtitle="500 m buffer, 2024" source="数据：XX"
  dpi=300 width_mm=190 height_mm=140
```

The extent defaults to the union of the layers. Pass `extent=[west,south,east,north]` in the map CRS when the
study area should be fixed; pass `crs="EPSG:4547"` when the data is projected and the scale bar must be in
metres. Titles and labels render with SimHei, so Chinese text is safe. The legend lists vector layers only —
a classified raster would add dozens of rows — so put counts and raster names in `subtitle` or `source`.

## When the data does not fit the request

If the scan shows a different CRS, resolution, year or extent than the user asked for, **stop and say so**:
what was asked, what exists, the options with their trade-offs, and your recommendation. Do not silently
substitute a different dataset or a coarser resolution — the resulting number is a different number.

If an operation has no algorithm in the registry (for example a bespoke model), say that it is not available
rather than inventing a result.

## Pitfalls

| Symptom | Cause and fix |
|---|---|
| `QGIS 4 was not found` | Set `qgisDir` in `qgis.config.json`, or install QGIS 4.x. |
| `engine timed out` | Long job. Clip the study area first; the engine is killed and restarted on timeout. |
| Buffer distance looks absurd | Layer is in degrees. Reproject before buffering. |
| `no algorithm with id ...` | Call `qgis_find` with a keyword; ids look like `native:buffer`, `gdal:cliprasterbyextent`. |
| Empty layer with 0 features | Check the input path and any filter expression; `qgis_check` reports empty geometry counts. |
| Map is blank | Layer paths wrong, or extent outside the data. Omit `extent` or pass it in the same CRS as `crs`. |
| Legend shows layer file names | Set `name` per layer in `qgis_map` for readable labels. |
| Chinese text in the map is boxes | Only SimHei is guaranteed; keep the default font. |
| Output file locked / missing | The algorithm failed; read the `log` tail in the `qgis_run` result. |

## Conventions

- Coordinates and extents are `[west, south, east, north]` or x/y in the stated CRS.
- `qgis_map` defaults: EPSG:3857, 300 dpi, and a page orientation derived from the extent (a tall study
  area gets a portrait page automatically). For paper figures, keep 300 dpi.
- Deliver spatial results twice: the layer path from `qgis_run` **and** a rendered `qgis_map` image. The
  image is posted into the chat; there is no dock or panel to open.
- Every step is recorded; close the analysis with `qgis_history action=methods` so the method section is ready.

## Tell the user where the results are

Never end a task with only "done". Every tool result already carries absolute paths, and the final answer
must say where the files live:

1. call `qgis_history action=files` and report the `folder:` line(s) plus the file names;
2. mention the map PNG path and the main data outputs (`.gpkg`, `.tif`) with their absolute paths;
3. if the user only needs the figure, still give its absolute path next to the embedded image.

The default output folder is `<workspace>\exports`; scripts land in `<workspace>\scripts`.
