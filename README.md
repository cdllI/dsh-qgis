English | [简体中文](README.zh-CN.md)

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

- Windows with QGIS **4.x** installed (tested on 4.0.2 at `E:\QGIS 4.0.2`).
- DeepSeek Harness with the plugin manager.
- Nothing else: the engine uses the Python that ships with QGIS.

## Install

### npm (recommended)

```bash
npm install -g dsh-qgis
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

If QGIS is not at `E:\QGIS 4.0.2`, copy `dsh-qgis/qgis.config.example.json` to `dsh-qgis/qgis.config.json`
and set `qgisDir`; the plugin also scans drive roots for `QGIS*` and `OSGeo4W*` folders automatically.

After installation the tools `qgis_*` appear in the session. There is deliberately no QGIS dock: `qgis_map`
posts the PNG straight into the chat, and every tool reports the absolute path of what it saved.

## Quick start

> 扫描 D:\data\太谷 这个文件夹，把耕地和永久基本农田做叠加，统计被占面积，最后出一张 300dpi 的图。

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
