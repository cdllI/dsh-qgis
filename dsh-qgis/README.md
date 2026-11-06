# dsh-qgis

A headless QGIS 4 capability bundle for [DeepSeek Harness](https://www.deepseek.com/harness/). QGIS does not
need to be open: a long-lived PyQGIS worker runs under the QGIS-bundled interpreter and the agent drives it
through `qgis_*` tools.

- **inventory** files, folders and `.qgz` projects (CRS, geometry, fields, extent, feature count);
- **find** the right algorithm among 769 and read its exact parameters;
- **run** any processing algorithm, including GRASS hydrology (`grass:r.watershed`);
- **check** results (CRS, invalid/empty geometry, band statistics, nodata);
- **map** publication figures in the chat: 300 dpi, adaptive page, scale bar, north arrow, Chinese labels;
- **history**: every step becomes a `qgis_history action=files|methods` record.

## Requirements

- Windows with QGIS **4.x** installed (tested on 4.0.2).
- DeepSeek Harness with the plugin manager.
- Node.js 22+ (only for installing the package; the engine uses QGIS's own Python).

## Install

```bash
npm install -g dsh-qgis
```

Then install the bundle into DeepSeek Harness with `plugin_manager` `install_bundle` and the package
directory as target:

- Windows: `%APPDATA%\npm\node_modules\dsh-qgis`
- find it with `npm root -g`

The `qgis_*` tools and the `qgis` skill appear in the session. There is no dock or panel: `qgis_map` posts the
PNG straight into the chat and every tool reports the absolute path it saved.

## Use

> 扫描我的数据文件夹，把耕地和永久基本农田做叠加，统计被占面积，最后出一张 300 dpi 的图。

The agent calls `qgis_scan` → `qgis_find` → `qgis_run` → `qgis_check` → `qgis_map` → `qgis_history`.
Outputs go to `<workspace>\exports`, scripts to `<workspace>\scripts`.

## Tools

| Tool | Purpose |
|---|---|
| `qgis_status` | QGIS version, providers, algorithm count, GRASS install, CJK fonts, output folders. |
| `qgis_scan` | Inventory datasets and projects. |
| `qgis_find` | Search algorithms or read one algorithm's parameters. |
| `qgis_run` | Run an algorithm headlessly; outputs, log, rerunnable script. |
| `qgis_check` | Vector/raster quality check. |
| `qgis_map` | 300 dpi PNG in the chat (optional PDF). |
| `qgis_history` | List steps, list saved files, or export methods. |

## Configuration

QGIS is discovered automatically from the drive roots, `Program Files`, `QGIS_PREFIX_PATH` and
`OSGEO4W_ROOT`. If it lives elsewhere, the agent should call `qgis_status qgis_dir=<install directory>`
(the directory containing `bin\qgis-bin.exe`); the plugin saves it to `qgis.config.json`.
`GISBASE` is detected from `<qgisDir>\apps\grass` automatically.

## License

MIT
