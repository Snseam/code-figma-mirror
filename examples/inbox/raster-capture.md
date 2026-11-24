# Arimo 受控采集

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
