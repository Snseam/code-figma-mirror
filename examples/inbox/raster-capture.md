# 字体采集与验收

## 字体方案

在项目根目录执行 `node cli.mjs capture examples/inbox/scenarios.json build/font-original --font-mode original` 可单独采集严格对齐基线。采集器保留源页面样式，从 Chromium 读取可编辑文本实际使用的字族。Figma 中需要启用相应的字体和字重。

统一字体实验接受本地字体文件和 SHA-256。例如，以下命令使用固定修订的 Noto Sans SC 可变字体，仅覆盖字体，保留页面的平滑设置。

```sh
mkdir -p build/raster-acceptance/fonts
curl --fail --location 'https://raw.githubusercontent.com/google/fonts/903d46673260c1f4c7f7ef67f5190fb03eab5042/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf' -o build/raster-acceptance/fonts/noto-sans-sc.ttf
node cli.mjs capture examples/inbox/scenarios.json build/font-pair --font-mode controlled --raster-profile examples/inbox/noto-sc-profile.json
```

`fontMode` 也可写入场景 JSON，命令行选项优先。每次选择新的输出目录。实验生成 `original/` 和 `controlled/`，各自包含场景包和参考 PNG。`fontFamily` 指定 Figma 字族。若浏览器报告的字体内部名称不同，可用 `platformFamily` 精确指定预期名称。发现其他字族回退时，实验采集会报出位置。

在桌面插件中选择 `build/font-pair` 目录，选中所需方案后导入并导出。也可分别导入两个子目录的 `bundle.json`。把各自导出的 `design-diff.json` 和 PNG 保存到各自的导出目录，分别运行以下命令。

```sh
node cli.mjs verify build/font-pair/original build/export-original build/font-reports --pixel-tolerance 16 --max-diff-ratio 0.01
node cli.mjs verify build/font-pair/controlled build/export-controlled build/font-reports --pixel-tolerance 16 --max-diff-ratio 0.01
```

报告位于 `build/font-reports/original/` 和 `build/font-reports/controlled/`。验收核对源包摘要、实际字族、Figma 图层字族与字重；缺少证据、字体不匹配或像素超差都会阻止通过。原始渲染中若同一文字宿主使用多个字族，当前工具会列出未验证的文字层。共享字体实验的结论仅适用于指定条件。已有 `--raster-profile` 命令仍使用其原有输出布局。

## Arimo 配置

在项目根目录运行。首次从 Google Fonts 的固定修订取得 Arimo，也可以将同一版本的本地字体放到该路径。采集器在启动浏览器前核对配置中的 SHA-256。字体就位后可以离线采集。

```sh
mkdir -p build/raster-acceptance/fonts
curl --fail --location 'https://raw.githubusercontent.com/google/fonts/903d46673260c1f4c7f7ef67f5190fb03eab5042/ofl/arimo/Arimo%5Bwght%5D.ttf' -o build/raster-acceptance/fonts/arimo.ttf
node cli.mjs capture examples/inbox/scenarios.json build/raster-acceptance/capture --raster-profile examples/inbox/raster-profile.json
```

配置文件为 `examples/inbox/raster-profile.json`。`fontFile` 相对于配置文件解析。也可以在自己的场景 JSON 顶层用 `"rasterProfile": "./profile.json"` 引用配置，命令行参数优先。原始示例场景继续使用页面自身的字体和抗锯齿设置。

采集器先校验本地字体文件的 SHA-256，再将字体字节载入每个 Chromium 场景和跳转重放页面。截图前等待字体和绘制就绪，逐个可编辑文字宿主检查 `-webkit-font-smoothing: antialiased` 与 Chromium 实际渲染的 Arimo 字体。缺少字体、散列不符、字体回退或文字宿主的平滑设置不符都会使采集失败。像素级复跑请使用同一 macOS、Chromium 版本与字体文件。

`build/raster-acceptance/capture/bundle.json` 顶层记录 `rasterProfile`，字段为 `name`、`fontFamily`、`sha256`、`smoothing`，均为字符串。每个画板的 `fontEvidence` 记录实际字形来源。浏览器参考图位于同目录的 `source/<viewport>--<state>.png`。

原始基准使用 `build/inbox`，其 bundle 省略 `rasterProfile`。采集器会拒绝在已有 bundle 的目录中切换基准。

```sh
node --test tests/raster-profile.test.mjs
```

集成测试默认使用上述字体路径，也可用环境变量 `UI_PARITY_ARIMO_TTF` 指向相同 SHA-256 的文件。
