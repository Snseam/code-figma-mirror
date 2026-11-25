# 微信小程序 DevTools 采集

`native/capture.mjs` 连接已开启自动化的微信开发者工具，为每个视口和状态保存模拟器实际返回的 PNG，并把声明的 WXML 元素转换为现有 Figma 导入器和 `cli.mjs inspect` 使用的 v1 IR。随附的“观察卡”小程序使用本地合成数据，可独立打开。

## 运行

以下命令在仓库根目录执行。沿用项目的 Node 22 和已有 `pngjs` 依赖。仅运行合同测试时使用第一条命令即可。

```sh
node --test native/capture.test.mjs
```

需要采集时，在已有微信开发者工具中启用安全设置里的 CLI/HTTP 服务，打开 `native/example`，确认观察卡可以点击展开。基础库使用 2.20.1 或以上版本。示例使用游客 AppID；若本地工具要求 AppID，可在自己的示例副本中使用开发测试 AppID。macOS 默认安装位置的启动命令如下。

```sh
npm install --prefix native --no-save --package-lock=false miniprogram-automator@0.13.0
/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto --project "$PWD/native/example" --auto-port 9420
native/capture.mjs native/example.json native/output
node cli.mjs inspect native/output/bundle.json
```

也可执行 `node native/capture.mjs <config.json> <output>`。输出目录须新建或为空。成功后可看到 `phone/closed`、`phone/open` 和两条点击连线。连接到已有窗口时，采集结束会断开自动化连接，窗口保持打开。

| 文件 | 内容 |
| --- | --- |
| `bundle.json` | `version: 1`、项目名、画板、可编辑图层、已回放的 `NAVIGATE` 与 `BACK` 连线、空 `tokens` 字典和采集提示 |
| `source/phone--closed.png`、`source/phone--open.png` | 各状态的原始模拟器截图，保持 SDK 返回的 PNG 字节和像素尺寸 |
| `evidence.json` | 渠道 `source`、每板实际页面路径、可用窗口尺寸、滚动位置、截图坐标模式和缩放比、是否注入场景数据 |

## 声明状态

完整配置见 `example.json`。一次运行按 `viewports × states` 采集。每个视口连接自己的 `wsEndpoint`。如需多种尺寸，先在相应模拟器窗口设好机型。视口可选的 `width`、`height` 用于核对实际**可用窗口逻辑像素**，任一不符会报错。

| 字段 | 行为 |
| --- | --- |
| `state.path` | 每次通过 `miniProgram.reLaunch` 从指定小程序页面独立入场，支持路径中的查询参数 |
| `state.data` | 可选 JSON 对象，通过刚进入页面的 `page.setData` 设置场景。适合可重复、无外部依赖的数据 |
| `state.steps` | 可选有序操作。`{"action":"tap","selector":"#toggle"}` 点击，`{"action":"input","selector":"#search","value":"叶"}` 输入，`{"action":"waitFor","selector":"#loaded"}` 等待元素，`{"action":"waitForPage","path":"/pages/detail/index"}` 等待跳转 |
| `state.expectPath`、`state.ready` | 最终路径默认等于 `path`。步骤会跳页时填写 `expectPath`；`ready` 应选择渲染完成后才出现的 WXML 元素，例如由 `wx:if` 控制的结果标签 |
| `state.selectors` | 按绘制次序声明 `{id, kind, selector, name?, component?, children?}`。`kind` 为 `frame` 或 `text`；子节点在父元素内查找。文本逐字读取 `element.text()` |
| `edges` | 默认的 `{from, to, source}` 中 `from`、`to` 是状态 ID，`source` 是起点状态内声明的节点 ID。每个视口点击声明的控件，核对终点路径、就绪标志、文本、样式和框。连续场景和按来源返回的配置见下文。 |
| `timeoutMs` | 对入场条件和点击结果的轮询等待时间，默认 8000 毫秒 |

## 按来源返回的连续回放

在开发者工具中打开同一个 `native/example`，使用以下配置采集公开的合成目录。手动复验从 `pages/catalog/index` 开始。先点「白桦叶」再返回，然后点「只看叶片」并重复进入同一详情。第一次返回应看到鹅卵石，第二次返回应保留叶片筛选。

```sh
node native/capture.mjs native/return-context.json build/native-return
node cli.mjs inspect build/native-return/bundle.json
```

`scenarios` 的每项用 `id` 命名任务，`entry` 指定起始状态，`steps` 按顺序列出当前状态内的控件 ID。采集器先采各状态的参考画板，再从每个任务入口连续点击。中间步骤和返回后的页面都从运行时读回。可选的 `state.expectContext` 声明需要比对的顶层页面数据字段和预期标量值，例如 `{"filter":"leaves"}`。`state.data` 用于准备参考或入口，`expectContext` 只用于读回断言。

| 场景中的边 | 点击后的断言 |
| --- | --- |
| `NAVIGATE`（默认） | 原生栈保留来源页并压入一页，目标匹配声明的 `to`。 |
| `NAVIGATE` 带 `samePage: true` | 当前页面实例和栈深保持一致，画板切换到 `to`。适用于列表筛选等页内动作。 |
| `BACK` | 省略 `to`。必须在连续场景内点击，原生栈弹出一页，恢复同一来源页实例及其画板和上下文。 |

旧配置中的独立 `NAVIGATE` 仍逐边回放。示例有三块画板、五条控件连线；详情的返回控件在每个视口只导出一条 Figma `BACK`。`evidence.json` 的 `scenarios[].steps` 分别记录每次实际通过的来源、控件、动作、目标状态和核对的字段名。任一步失败会终止整批输出。`node --test native/return-context.test.mjs` 可运行合成合同回归，模拟器和 Figma Present 的实测需要各自的回放记录。

选择器使用自动化 API 支持的 WXSS 选择器子集。每段必须匹配一个元素。跨自定义组件时可写 `["#card-component", ".caption"]`，先从页面定位宿主，再从宿主内部定位文字。节点 ID 在同一状态内唯一，视口和状态名支持字母、数字、下划线和单连字符。最终节点 ID 例如 `phone/closed#toggle`。

## 图像与坐标

页面顶部的节点位置由 `element.offset()`、`element.size()` 和 `page.scrollTop()` 得出。子节点坐标相对父层。适配器比较 PNG 与 `wx.getWindowInfo()` 的实际尺寸；页面窗口截图从零开始，匹配整屏的截图按报告的 `screenTop` 加上顶部偏移。画板、框、字号、行高、描边和圆角统一使用 PNG 像素。无法对齐的截图会报错。

框读取纯色背景、顶部描边、左上圆角、透明度和溢出裁剪；文本读取颜色、字体、字号、字重、斜体、行高和对齐。渐变、复杂边框、系统栏和未声明元素仍可从 PNG 查看。文本框使用整个 WXML 元素的边界。独立文字样式请声明独立的 `<text>`。采集期间应让页面停在可重复的稳定状态；截图与各元素读数是相继获取的。

## 证据渠道

| 运行情况 | 结果 |
| --- | --- |
| 官方 SDK 已连接，`systemInfo().platform === "devtools"` | 成功采集标记 `wechat-devtools-simulator`，代表微信开发者工具内的小程序渲染 |
| 缺少可选 SDK / 未连上自动化端口 | 分别返回 `AUTOMATOR_NOT_INSTALLED` / `DEVTOOLS_NOT_CONNECTED`，退出码 1 |
| iOS、Android 等手机运行时 | 返回 `DEVICE_SCREENSHOT_UNSUPPORTED`。微信官方截图 API 仅支持开发者工具模拟器 |
| 静态 HTML | 由根目录的 Web `cli.mjs capture` 采集。原生配置中提供 HTML `url` 会被拒绝 |
| 合同测试 | 仅测试入口 `captureWithStub` 接收 double。其 `evidence.json` 固定标记 `contract-stub`，`bundle.warnings` 也标明图像和测量值均为合成。临时结果在测试结束后清理 |

只有所有画板和连线完成后才发布整批文件。配置错误、缺少元素、截图损坏、目标状态不符或连接中断都会使本次运行失败。

## 官方参考

- [微信开发者工具命令行](https://developers.weixin.qq.com/miniprogram/dev/devtools/cli.html)
- [Automator 连接](https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/automator.html)
- [MiniProgram 截图、运行时信息与断开连接](https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/miniprogram.html)
- [Page 页面查询、数据与滚动](https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/page.html)
- [Element 作用域、测量、样式与点击](https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/element.html)
- [wx.getWindowInfo 窗口尺寸与 screenTop](https://developers.weixin.qq.com/miniprogram/dev/api/base/system/wx.getWindowInfo.html)
