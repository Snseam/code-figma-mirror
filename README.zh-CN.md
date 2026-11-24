# Code Figma Mirror

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](package.json)
[![Platform](https://img.shields.io/badge/runtime-Web%20%7C%20WeChat%20Mini--Program-0ea5e9.svg)](native/README.md)

[English](README.md) | 简体中文

Code Figma Mirror 是一个面向运行态前端应用的**确定性代码 ↔ Figma 镜像、双向同步与 UI 一致性（Parity）校验引擎**。你只需要声明视口、页面状态与交互边；真实浏览器或小程序运行时提供实测几何尺寸、计算样式、组件身份和基准截图，Figma 端则重建为可编辑的 Variables、Component Instances 与交互原型，并通过结构审计、像素比对与三方差异（3-way diff）将设计修改安全地反向生成可审查的 CSS Patch。

## 核心设计理念

- **基于真实运行时采样，而非静态 AST 猜测**：直接从 Playwright/Chromium（或微信开发者工具）采集真实 `BoundingBox`、计算样式与字体渲染证据，避免静态源码解析导致的换行错位和高度塌陷。
- **可编辑的 Figma 组件级重建**：生成 Figma Variables、Component Sets、Instance、Auto Layout 与交互连线，而不是扁平截图或散落矩形。
- **闭环一致性验收**：`audit` 校验几何尺寸、文本可编辑性、组件引用与原型跳转目标；`verify` 对源截图与 Figma 导出图做逐像素比对并输出可视化热力图报告。
- **非对称三方反向同步**：联合对比 `base`、`current` 代码与 `figma` 快照，识别冲突并输出可审查的 CSS Token / 样式补丁（`review`、`review-styles`），不盲目覆盖业务逻辑。

## 快速开始

需要 **Node.js >= 22**。克隆仓库后执行：

```sh
npm ci
npx playwright install chromium
npm run demo
node cli.mjs inspect build/inbox/bundle.json
```

**Field notes** 示例（[examples/inbox/scenarios.json](examples/inbox/scenarios.json)）会在手机端（`375×700`）与桌面端（`1024×720`）采集打开列表、关闭列表和三个详情态，生成包含 10 个画板、36 个组件实例、16 条已验证交互跳转、6 个颜色 Token 的 `bundle.json`，并在 `build/inbox/source/` 下输出 10 张基准 PNG。

1. **在 Figma 中重建镜像**
   - **桌面插件路径**（[plugin/README.md](plugin/README.md)）：在 Figma Desktop 新建开发插件获取自己的插件 ID，拷贝 `plugin/manifest.json`、`plugin/code.js` 与 `plugin/ui.html`，替换 manifest 中的占位 ID 后通过 **Plugins → Development** 导入，加载 `build/inbox/bundle.json`。
   - **Figma MCP 路径**（[mcp/README.md](mcp/README.md)）：使用 `mcp/` 提供的传输与渲染命令写入你的暂存页和目标页。
2. **验证交互原型**：在手机端流程中切换列表、进入详情页并返回；选中卡片检查其主组件引用。
3. **结构审计与像素验收**：从插件导出 ZIP（或通过 [tools/cloud-export.md](tools/cloud-export.md) 收集节点回读与 1× PNG）解压到 `build/figma/`，运行：

```sh
node cli.mjs audit build/inbox/bundle.json build/figma/design-diff.json build/audit.json
node cli.mjs verify build/inbox build/figma build/visual
```

`audit` 默认允许 `1` 逻辑像素的几何容差；`verify` 会生成包含原图、Figma 导出图与差异热力图的 `build/visual/report.html`。两者在发现差异时均返回退出码 `2`。

## 仓库架构

| 目录 / 文件 | 职责 |
| --- | --- |
| `cli.mjs`, `capture.mjs`, `capture-dom.mjs` | Playwright 场景执行器，DOM/样式/几何/跳转采集 |
| `audit.mjs`, `verify.mjs` | 结构回读审计与逐像素 PNG 差异报告 |
| `review.mjs`, `style-review.mjs` | 三方（`base` / `current` / `figma`）Token 与样式补丁生成 |
| [`plugin/`](plugin/README.md) | Figma Desktop 插件：导入 bundle、生成组件/原型、导出 `design-diff.json` |
| [`mcp/`](mcp/README.md) | Figma MCP 渲染器、紧凑载荷构建与跨页传输工具 |
| [`native/`](native/README.md) | 微信小程序开发者工具模拟器适配（`capture.mjs`, `measure.mjs`, `config.mjs`） |
| [`integrations/`](integrations/react.mjs) | 可选的 React JSX（`react.mjs`）与 Vue SFC（`vue.mjs`）编译期组件身份探针 |
| [`tools/`](tools/cloud-export.md) | 云端导出辅助与可控光栅验收（`raster-acceptance.mjs`） |
| [`skills/ui-parity/`](skills/ui-parity/SKILL.md) | 面向 Agent 的端到端采集、镜像、审计与反向同步工作流 |

## CLI 命令参考

```sh
node cli.mjs capture <scenarios.json> <capture-dir> [--font-evidence] [--raster-profile <profile.json>]
node cli.mjs inspect <bundle.json>
node cli.mjs audit <bundle.json> <design-diff.json> <audit.json> [--geometry-tolerance 1]
node cli.mjs verify <capture-dir> <figma-png-dir> <report-dir> [--pixel-tolerance 16] [--max-diff-ratio 0.01]
node cli.mjs review <base.json> <current.json> <figma-snapshot.json> <out-dir> [--css theme.css] [--scenarios scenarios.json]
node cli.mjs review-styles <base.json> <current.json> <figma-snapshot.json> <out-dir> --css theme.css --mappings mappings.json
```

## 已验证基准与当前边界

下表在 macOS 上用**同一组 10 张 Figma 导出 PNG** 对比两组 Chromium 基准截图（`--pixel-tolerance 16 --max-diff-ratio 0.01`，详见 [examples/inbox/raster-capture.md](examples/inbox/raster-capture.md)）：

| 浏览器基准 | 桌面端 · 1024 × 720 | 手机端 · 375 × 700 |
| --- | ---: | ---: |
| 原始页面（系统 Arial） | 5 / 5 | 1 / 5 |
| 锁定 Arimo 字体与灰度抗锯齿 | 5 / 5 | 5 / 5 |

Figma 回读验证了 **66 个可编辑文本图层**、**36 个组件实例**与 **16/16 条原型点击跳转**。相对未修改的 DOM，像素对齐与单行文本框加宽使部分位置/宽度产生最多 `4.97 px` 偏移。

**当前边界：**
- 任意复杂 CSS（复杂 Grid、伪元素、流体 `clamp()`、自定义着色器）无法 1:1 无损转换为 Figma Auto Layout。
- MCP 路径支持可编辑文本、Frame、纯色填充与内联 SVG；采集的位图资源需走桌面插件路径。
- MCP 渲染器按颜色值反查绑定纯色 Variable；若两个语义 Token 共用完全相同的色值，会合并为同一变量。
- 跨系统字体度量与亚像素抗锯齿会影响像素差异率，需配合 `--font-evidence` 与 `--raster-profile` 控制。
- `review` / `review-styles` 针对无歧义 CSS Token 及显式映射的 `width`、`height`、`border-radius`、`font-size` 生成补丁；组件树结构改动仍需人工或 Agent 审查。

## 采集你自己的界面

可从 `examples/inbox/scenarios.json` 起步，将 `states[].url` 指向运行中的应用或本地 HTML，为每个状态配置唯一 `ready` 选择器，并声明视口与点击 `edges`：

```sh
node cli.mjs capture path/to/scenarios.json build/app --font-evidence
node cli.mjs inspect build/app/bundle.json
```

- **组件身份标记**：在宿主元素上添加 `data-component` / `data-variant`，通过选择器映射，或启用 [React](integrations/react.mjs) / [Vue](integrations/vue.mjs) 编译期插件。
- **微信小程序**：参考 [native/README.md](native/README.md) 使用微信开发者工具模拟器采集与测量。

## 反向审查 Figma 修改

保留导入时的 `bundle.json` 作为 `base.json`，代码变更后重新采集到 `current.json`，从 Figma 导出修订后的 `design-diff.json`，然后运行：

```sh
node cli.mjs review base.json current.json build/figma/design-diff.json build/review \
  --scenarios examples/inbox/scenarios.json --css examples/inbox/theme.css
```

查看 `build/review/review.json` 中的三方冲突，以及 `tokens.patch`（或通过 `review-styles` 生成的 `styles.patch`）进行代码审查后合入。

## 开发与测试

```sh
npm test
npm run test:integrations
```

环境搭建、测试规范与问题反馈请见 [CONTRIBUTING.md](CONTRIBUTING.md)，开源协议见 [LICENSE](LICENSE)（Apache-2.0）。
