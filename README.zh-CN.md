[English](README.md) | 简体中文

# dsh-qgis

给 DeepSeek Harness 的 QGIS 4 能力插件。它运行一个无界面的 PyQGIS 引擎：**不需要打开 QGIS**，也不涉及任何 GUI。

- **清点数据**：扫描文件、文件夹、`.qgz` 工程，返回 CRS、几何类型、字段、范围、要素数；
- **找算法**：在 769 个处理算法里按关键词搜索，或读取某个算法的完整参数表；
- **跑算法**：任意 processing 算法，产物写入 `exports/`，同时生成可复跑的 Python 脚本；
- **质检**：CRS、空几何/非法几何、波段统计、nodata，先验证再报数；
- **出图**：300 dpi 排版图，含图例、比例尺、指北针，中文标注正常；
- **方法记录**：每一步自动记录，一键导出 Methods 段落。

## 环境要求

- Windows，已安装 QGIS **4.x**（已验证 4.0.2）。插件会自动发现安装位置；如果在非常规目录，agent 可以定位
  `bin\qgis-bin.exe` 并用 `qgis_status qgis_dir=<目录>` 记住它。
- 带插件管理器的 DeepSeek Harness。
- 不需要额外 Python 环境：直接用 QGIS 自带的解释器。

## 安装

### npm

目前可以直接装 Release 里的 tarball；发布到 npm registry 后可以按包名安装。

```bash
npm install -g https://github.com/cdllI/dsh-qgis/releases/download/v0.2.1/dsh-qgis-0.2.1.tgz
# 发布后：npm install -g dsh-qgis
```

然后让 agent 用 `plugin_manager` 的 `install_bundle`，目标填 npm 全局包目录（Windows：
`%APPDATA%\npm\node_modules\dsh-qgis`，可以用 `npm root -g` 查）。

### 从源码

```powershell
git clone https://github.com/cdllI/dsh-qgis
```

然后 `install_bundle` 填 `<clone>\dsh-qgis` 的绝对路径。本地改动用副本测试：

```powershell
Copy-Item -Recurse -Force dsh-qgis .install\dsh-qgis
```

如果 QGIS 不在自动发现范围内，不要手改配置文件：让 agent 找到包含 `bin\qgis-bin.exe` 的目录，调用
`qgis_status qgis_dir=<目录>`。插件会从该目录启动引擎，并把选择写入 `qgis.config.json` 供以后使用。

安装后，会话里出现 `qgis_*` 工具。刻意不做侧栏面板：`qgis_map` 直接把 PNG 发到聊天框，每个工具都会返回保存的绝对路径。

## 快速开始

> 扫描我的数据文件夹，把耕地和永久基本农田做叠加，统计被占面积，最后出一张 300dpi 的图。

agent 会依次调用 `qgis_scan` → `qgis_find` → `qgis_run` → `qgis_check` → `qgis_map` → `qgis_history`。
你会得到 `exports/` 下的图层文件、对话里的 PNG 图，以及一份方法记录。

## 工具

| 工具 | 用途 |
|---|---|
| `qgis_status` | QGIS 版本、数据源、算法数、中文字体、输出目录。先跑这个。 |
| `qgis_scan` | 清点数据与工程；不打开 QGIS 也能读 `.qgz` 的图层清单。 |
| `qgis_find` | 算法关键词搜索；按 id 读完整参数。 |
| `qgis_run` | 无界面运行一个算法；默认输出路径、日志、脚本。 |
| `qgis_check` | 矢量/栅格质检，带警告。 |
| `qgis_map` | 300 dpi 排版图（可同时出 PDF），图例/比例尺/指北针。 |
| `qgis_history` | 列出步骤，或导出 Methods 文档。 |

## 限制

- 仅支持 QGIS 4.x（QGIS 3 的插件 API 不同）。
- 单 worker 串行执行：长算法会挡住下一次工具调用，但不会冻结任何 QGIS 窗口。
- 不打开/编辑/保存 `.qgz` 工程，只读取工程里的图层清单。
- 刻意不暴露“执行任意 PyQGIS 代码”的工具。
