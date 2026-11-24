# UI Parity 本地开发插件

在 Figma Desktop → Plugins → Development → New plugin 创建个人开发插件，取得 Figma 分配的 `id`。把本目录的 `manifest.json`、`code.js`、`ui.html` 复制到单独的本地目录，用该 ID 替换副本 manifest 里的全零占位值。通过 Import plugin from manifest 载入副本。在可编辑的 Figma Design 文件中运行 **UI Parity · 本地同步**，选择 UTF-8 JSON，再点 **导入项目**。`example.json` 包含两个画板、两个本地变体、不同宽度和文案的实例，以及三种点击动作。

## 导入与重导

- `project` 是非空字符串。画板 `id` 在项目内唯一，节点 `id` 在所属画板内唯一，也须与画板自身的 ID 区分。节点的 `x/y` 相对于父节点，尺寸为正数。填充、描边、文字和变量接受 `#RRGGBB`、`#RRGGBBAA` 及短写。节点 `opacity` 单独生效。
- `frame`、`text`、`svg` 和 `image` 对应可编辑容器、文字、矢量树和带图片填充的矩形。`data` 是 PNG 原始字节的 Base64，不带 data URL 前缀。`lineHeight` 和 `letterSpacing` 的单位为像素，字距支持负数。新导入的基准会记录字距，旧版本页继续按其原有字段比较。缺失资源记录在 `warnings` 中。
- 单行 Range 紧框沿用采集宽高和坐标，在原节点及实例文字层上设置固定尺寸与垂直居中。v1 根据非空、无换行、框高 ≤ `1.35 × 字号 + 1px` 判断紧框。Arial 缺失时依次尝试 Arimo 同字形、Inter 同字形、Inter Regular；其他字体缺失时从 Inter 同字形开始。每次替代均将节点 ID、请求字体和实际字体写入 `warnings`。
- 相同 `component` 和 `variant` 共用本地主组件。实例使用各自的位置、尺寸和文字。显式变体放入 Component Set。对 `figmaKey` 引用的实例优先按子层名匹配。引用不可用、子层匹配不唯一或同名模板结构不兼容时，使用本地组件或独立可编辑节点，并给出节点级告警。
- 本地主组件按采集到的直接子层布局建层。位置、尺寸或后代几何不同的子层按需各建一份；每个实例只显示匹配的一份，并在其上覆盖文案。不同视口可共用同一个 `mainId`。实例根层正常定位和缩放，内部坐标与尺寸在主组件上确定。已有文件组件和发布库组件使用其原生布局，几何冲突会在 `warnings` 中列出实际值和采集值，`observed.geometry` 导出实际值。
- `figmaKey: "12:34"` 使用当前目标文件的原生节点 ID，可引用其他页面的未发布 `COMPONENT` 或 `COMPONENT_SET`。组件集可用 `variant` 选择唯一变体，省略时使用默认变体。其他格式继续按已发布库 key 解析。节点不存在、类型错误、变体不匹配或宿主拒绝创建实例时会告警并回退。复用成功时源组件留在原页，`observed.instances[].mainId` 对应实际主组件或变体的原生 ID。
- `edges` 的 `from/to` 建议使用完整画板 ID，也支持同 viewport 内的状态名。`source` 为起点画板内节点 ID，空值表示整个画板。每个来源最多一个点击动作。`BACK` 忽略 `to`。
- 每个 viewport 按 `boards[]` 顺序取首板，注册到版本页的 `flowStartingPoints`，播放器中以 viewport 名称显示入口。
- 第一次导入创建 `UI Parity · <project> · r1` 和该版本独立的变量集合。用本地 SHA-256 识别同一文件，再导入会打开原版本。修改文件后，只有最新版本符合下文条件才原位更新，否则另建 `r2`、`r3` 等，旧页继续可导出。复制的页面不继承原页所有权。
- 对含组件的旧版采集包，升级本次实例布局实现后，首次重新导入同一 JSON 会另建版本页，保留旧稿的设计师编辑。再次导入会复用使用新布局的版本页。
- 原位更新要求 token 名称集合相同、颜色映射唯一、所有引用的源色值随 token 一起更新，而且替换这些颜色后整个源 JSON（含标注、顺序、边和 warnings）内容相同。插件核对实际画笔绑定，并比较当前 Figma 图层、变量和 REST 导出快照与基线。通过后更新变量和基线，返回原页、原画板、原实例。变量集合依 Figma 文档作用域生效，手工复用到其他位置的变量也会跟随变色。
- 旧版基线缺少完整快照、宿主不能提供快照、源结构或 REST 快照超过各自 150 万字符、发生设计编辑、存在歧义时，走新版本页。不同 token 同色时保留字面颜色并提示。设计师改动留在原页，可通过导出差异合回源文件。

## 导出协议 v1

打开所需项目版本页，点 **导出并下载 ZIP**。插件按点击时的页面 ID 读取该版本的基线和画板，完成时显示项目、版本号和页面 ID。`ui-parity-export.zip` 使用 ZIP STORE，UTF-8 文件名。若桌面宿主拦截自动下载，点保留的 **下载整套 ZIP** 链接。也可以逐个下载。

| 文件 | 内容 |
| --- | --- |
| `design-diff.json` | `{version:1, project, revision, sourceSha256, pageId, boards, changes, observed, warnings}`。SHA-256 对导入文件原始字节计算。 |
| `board-<画板ID>.png` | 由当前画板 `exportAsync` 生成的 1× PNG。文件名里的 `/` 等字符替换成 `--`，碰撞追加序号。请使用 `boards[].file` 关联。 |

`boards[]` 含 `id, state, viewport, figmaId, file, status`。导出成功时 `status` 为 `exported`，`width/height` 读取 PNG 的 IHDR 像素尺寸。导出前已删除或移出所属页的画板为 `missing`，`file` 为 `null`。若画板在生成 PNG 时被移动到其他页或删除，插件提示重新导出。

`changes[]` 含 `scope, boardId, id, figmaId, op, before, after`，与最近一次成功同步后的 Figma 状态比较。源节点的反向同步键为 `(scope, boardId, id)`。`scope` 可取 `board`、`node`、`token`、`design`。`design` 表示没有输入节点 ID 的 Figma 原生层（含主组件、SVG 内部以及手工新增图层），使用 `figma:<原生ID>` 定位。token 用源变量名且 `boardId` 为空。

- `update` 的 `before/after` 只含变化字段。`add` 和 `remove` 的一侧为完整可导出字段，另一侧为 `null`。
- 画板内新增的无来源层使用 `scope: "design"`、`op: "add"`、实际所属的 `boardId` 和 `id: "figma:<原生ID>"`。`after.parent` 可定位直接父层，`after.index` 为堆叠次序。
- 文本是 `text`，几何为 `x/y/width/height`，样式字段直接列在 `before/after` 下。`fills/strokes` 保留原生画笔和变量引用。`parent/index` 表示父层和堆叠次序，`reactions` 的已知目标回写稳定画板 ID。
- 例如，编辑详情页的按钮文案后，记录可为 `{"scope":"node","boardId":"mobile/detail","id":"label","figmaId":"I42:7;3:9","op":"update","before":{"text":"返回首页"},"after":{"text":"返回列表"}}`。
- 导出覆盖上述属性、组件引用、变量及子层变化。其余视觉属性可用实际 PNG 比对。复杂设计改动需要结合 `design` 记录和图像人工合入。

`observed` 是导出时的 Figma 实况。即使 `changes` 为空，也会输出三个数组。范围是当前仍在所属版本页、具有输入稳定 ID 的画板和画板内图层。

- `edges[]` 为 `{from, source, action, to}`。`from` 是来源所在画板 ID，`source` 是来源节点 ID。点击源若是画板自身，`source` 等于 `from`。`action` 为 `NAVIGATE`、`OVERLAY` 或 `BACK`。`to` 回映射为当前版本页的稳定画板 ID，`BACK` 或无法回映射的目标为 `null`。每个实际点击动作对应一条记录。
- `instances[]` 为 `{boardId, id, mainId}`。`mainId` 是实际 Figma 主组件节点的原生 ID，可在同一版本中用来验证实例复用。主组件无法解析时为 `null`。
- `geometry[]` 为 `{boardId, id, x, y, width, height, type, text?, parentId?}`。画板包含在内。子图层的 `id` 原样使用 bundle 中的 `node.id`，同名 ID 可用 `boardId` 区分。`x/y` 相对实际直接父级，`type` 是原生 Figma 节点类型，如 `INSTANCE`、`FRAME`、`TEXT`。`TEXT` 的 `text` 为实际 `characters`，保留空字符串、空白和换行。子层的直接父层有源引用时，`parentId` 为该父层的源 ID。移出源画板的已识别子层通过 `changes` 记录，`observed` 中仍按源画板范围核验。

## 本地验证

在本目录运行 `node --test core.test.cjs`。测试使用 Node 内置库和内存宿主覆盖导入、重导、原位更新、差异、回滚、SHA-256 与 ZIP。

已有真实采集包 `../build/inbox/bundle.json` 时，在本目录运行 `UI_PARITY_INBOX_AUDIT=1 node --test core.test.cjs`。集成用例把采集包导入内存宿主，通过插件导出 `design-diff.json`，再调用父目录 `audit(bundle, designDiff)` 核对 36 个实例、16 条边和 180 层几何。模拟宿主仅提供画板尺寸头，图像像素验收使用真实 Figma 导出的 PNG。

桌面冒烟可先导入 `example.json`，然后在副本中将全部 `#2459D6` 同时替换成 `#143D99`，导入后检查仍在原页、`boards[].figmaId` 一致且 `changes` 为空。再手工改按钮文案，导出 ZIP 应含该节点的 `text` 差异和两张 PNG。此时把新颜色改为第三个颜色再导入，应创建另一页。
