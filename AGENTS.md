# dsh-qgis workspace

A DeepSeek Harness bundle that gives the agent headless QGIS 4 capabilities: inventory data, run
processing algorithms, quality-check results, render print maps. The QGIS GUI is never required.

## Layout

- `dsh-qgis/index.js` — Host half: tools, worker lifecycle, history.
- `dsh-qgis/engine.py` — long-lived PyQGIS worker, JSON lines over stdin/stdout.
- `dsh-qgis/skill.md` — registered as the `qgis` skill.
- `tools/check-plugin.mjs` — schema/manifest validation before installing.
- `tools/smoke-plugin.mjs` — drives every tool against the real engine without the harness.

## Hard rule: tool schemas

`ctx.tools.register()` forwards `parameters` verbatim to the model API. Every tool needs a complete,
object-rooted JSON Schema. A property map (`{ code: { type: 'string' } }`) produces `400 INVALID_REQUEST`
on the first model turn and breaks the session. Run before every reload:

```bash
node tools/check-plugin.mjs dsh-qgis
```

## Development loop

```bash
node --check dsh-qgis/index.js
node tools/check-plugin.mjs dsh-qgis
node tools/smoke-plugin.mjs      # real PyQGIS: status/scan/find/run/check/map/history
```

`smoke-plugin.mjs` writes under `.probe/run` and calls `process.exit(0)` so the engine does not keep Node
alive.

## Reloading

- `index.js` / `cordis.patch.yml` → re-apply the bundle. There is no client half; the bundle has no dock.
- `engine.py` → the Host keeps one Python worker alive, so edit the file and **kill the worker**:
  `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'engine\.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId }`.
  The next call starts the new code. The 10-minute idle timer also recycles it.
- `skill.md` is read inside `apply()`, so it only changes after the bundle is re-applied.

## Install

Install from a copy, never from the development tree:

```powershell
Copy-Item -Recurse -Force dsh-qgis .install\dsh-qgis
```

then `plugin_manager` `install_bundle` with the absolute path to `.install\dsh-qgis`. Do not hand-edit the
profile's `package.json` or `cordis.patch.yml`.

## QGIS 4 API traps (verified on 4.0.2)

- `Processing` has no `run`/`createContext`; use `Processing.runAlgorithm(id, parameters, None, feedback,
  context)` with `QgsProcessingContext()` and `RecordingFeedback`.
- `QgsRectangle` has no `combined`; union extents by hand.
- `QgsLayoutItemMap.setExtent()` resizes the item to the **extent's aspect ratio**; it also produces NaN Y
  if the item has no size yet. Compute a map rectangle whose aspect matches the extent, set move/size first,
  then `setCrs` → `setLayers` → `setExtent`.
- A layout legend only fills when its layers were added to the project **with legend**:
  `project.addMapLayer(layer, isinstance(layer, QgsVectorLayer))` — rasters are kept out of the legend
  because a classified raster contributes dozens of rows and pushes the legend off the page.
- `QgsLayoutItemLabel` has no `adjustSize()`; use `adjustSizeToText()` and `setTextFormat(QgsTextFormat)`.
- `QgsTextFormat.setSizeUnit()` takes `Qgis.RenderUnit`, not `QgsUnitTypes.RenderPoints`.
- Parameter optionality is `flags() & QgsProcessingParameterDefinition.FlagOptional`, not `isOptional()`.
- Import `QgsProviderRegistry` explicitly; `providerMetadata('ogr').querySublayers(path)` is how a
  GeoPackage's layers are enumerated.
- North arrows live at `<prefix>/svg/arrows/NorthArrow_01.svg`.
- GRASS auto-detection in QGIS 4.0.2 only looks for folders named `grass-7.*`; this bundle's GRASS is
  `apps\grass\grass84`, so the Host must export `GISBASE` (it discovers it under `<qgisDir>\apps\grass`).
  Without it, every `grass:*` call fails immediately with "GRASS GIS folder is not configured".

## Failure modes that already bit us

- **NaN breaks the protocol.** A raster without a declared nodata returns `NaN`; `json.dumps` emits bare
  `NaN`, which is not JSON, so the Host's `JSON.parse` silently dropped the reply and the call waited for its
  300 s timeout. `to_json`/`emit` now convert non-finite floats to `null`; keep it that way and keep the
  "unparsable engine line" log in `host.log`.
- **Never block the Host event loop.** A synchronous `fs.statSync` on a workspace path froze every session:
  the workspace registry contains WSL UNC paths (`\\wsl.localhost\...`) and stat on a stopped distro blocks
  for minutes. The bundle no longer serves a panel or any HTTP route; keep tool code async and never touch
  UNC paths. `execFileSync` is likewise banned (the QGIS version probe is async and cached).
- **Do not scan `C:\Windows\Fonts`.** `QT_QPA_FONTDIR` + `QFontDatabase.families()` loads hundreds of faces
  and can block for minutes; register `simhei.ttf`/`msyh.ttc` with `addApplicationFont` instead, cache the
  result, and never call `families()` per request.

## Spawning the interpreter

`E:\QGIS 4.0.2\bin\python-qgis.bat` contains spaces, and `cmd.exe` cannot take a quoted command line
reliably through `spawn` argv. The Host writes a wrapper at `%LOCALAPPDATA%\qgisagent\run-engine.cmd` and
spawns `cmd.exe /d /c <wrapper>`.

## Runtime output

Everything the agent produces lives under the session working directory: `exports/`, `scripts/`,
`.qgis-agent/history.jsonl`. Never write into the bundle install directory (it sits outside the session
workspace).

## Fonts and encoding

The engine sets `QT_QPA_PLATFORM=offscreen`; it does **not** set `QT_QPA_FONTDIR`. At startup it registers
SimHei/Microsoft YaHei/SimSun from `C:\Windows\Fonts` with `addApplicationFont`, resolves the family with
`QFontInfo`, and caches the result for the worker's lifetime. All JSON is UTF-8; the worker sets
`PYTHONIOENCODING=utf-8` and `PYTHONUNBUFFERED=1`.
