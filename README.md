English | [绠€浣撲腑鏂嘳(README.zh-CN.md)

# dsh-qgis

A QGIS 4 capability bundle for DeepSeek Harness. It runs a headless PyQGIS engine, so QGIS does not need
to be open and no GUI is involved:

- **inventory** files, folders and `.qgz` projects (CRS, geometry, fields, extent, feature count);
- **find** the right algorithm among 769 and read its exact parameters;
- **run** any processing algorithm, with outputs written to `exports/` and a rerunnable script;
- **check** results (CRS, invalid/empty geometry, band statistics, nodata) before trusting them;
- **map** publication figures: 300 dpi, legend, scale bar, north arrow, Chinese labels;
- **methods**: every step becomes a Markdown methods section.

## Requirements

- Windows with QGIS **4.x** installed (tested with 4.0.2). The plugin discovers the install automatically;
  if it is in a non-standard place, the agent can locate `bin\qgis-bin.exe` and persist it with
  `qgis_status qgis_dir=<directory>`.
- DeepSeek Harness with the plugin manager.
- Nothing else: the engine uses the Python that ships with QGIS.

## Install

### npm

The package is available as a release tarball today; once published to the npm registry the same install
works by name.

```bash
npm install -g https://github.com/cdllI/dsh-qgis/releases/download/v0.2.1/dsh-qgis-0.2.1.tgz
# after publishing: npm install -g dsh-qgis
```

Then install the bundle into DeepSeek Harness with `plugin_manager` `install_bundle`, using the package
directory (Windows: `%APPDATA%\npm\node_modules\dsh-qgis`). The agent can find it with
`npm root -g`.

### From source

```powershell
git clone https://github.com/cdllI/dsh-qgis
```

then `plugin_manager` `install_bundle` with the absolute path to `<clone>\dsh-qgis`. To test a local edit
without touching the clone, copy it first:

```powershell
Copy-Item -Recurse -Force dsh-qgis .install\dsh-qgis
```

If QGIS is not discoverable, do not edit configuration files by hand: ask the agent to locate the directory
that contains `bin\qgis-bin.exe` and call `qgis_status qgis_dir=<directory>`. The plugin starts the engine
from there and saves the choice to `qgis.config.json` for later calls.

After installation the tools `qgis_*` appear in the session. There is deliberately no QGIS dock: `qgis_map`
posts the PNG straight into the chat, and every tool reports the absolute path of what it saved.

## Quick start

> 鎵弿鎴戠殑鏁版嵁鏂囦欢澶癸紝鎶婅€曞湴鍜屾案涔呭熀鏈啘鐢板仛鍙犲姞锛岀粺璁¤鍗犻潰绉紝鏈€鍚庡嚭涓€寮?300dpi 鐨勫浘銆?
The agent calls `qgis_scan`, `qgis_find`, `qgis_run`, `qgis_check`, `qgis_map` and `qgis_history`. You get
layer files under `exports/`, a PNG figure in the chat, and a methods document.

## Tools

| Tool | Purpose |
|---|---|
| `qgis_status` | QGIS version, providers, algorithm count, CJK fonts, output folders. Start here. |
| `qgis_scan` | Inventory datasets and projects; read a `.qgz` without opening QGIS. |
| `qgis_find` | Keyword search over the algorithm registry; exact parameter help by id. |
| `qgis_run` | Run one algorithm headlessly; default output paths, log, script. |
| `qgis_check` | Vector/raster quality check with warnings. |
| `qgis_map` | 300 dpi print layout PNG (optional PDF) with legend/scale bar/north arrow. |
| `qgis_history` | List steps or export a methods document. |

## Limits

- QGIS 4.x only; the QGIS 3 plugin API is different.
- One worker serializes calls: a long algorithm blocks the next tool call, not a QGIS window.
- This bundle does not open, edit or save `.qgz` projects; it reads them for layer inventory.
- Arbitrary PyQGIS code execution is deliberately not exposed as a tool.

