# Figma MCP 写入

`compact.mjs` 从 `renderer.js` 生成可直接作为 `use_figma.code` 的 JavaScript。每次调用都显式传入源页、传输 frame 和独立输出页。渲染器检查 frame 归属，读取其文本分片，再切换并核对输出页。所有画板和主组件都在新分区内。颜色变量属于文件，集合名称包含分区 ID。

## 在真实 Figma 文件复跑

1. 在隔离测试文件内打开 MCP session，各次调用沿用同一 `fileKey` 和 `sessionId`。创建和渲染时使用 `skillNames: "figma-use,figma-generate-design"`。新文件先按[分片传输说明](transfer.md)写入源数据，将回执里的 `sourcePageId`、`transferFrameId` 分别赋给 `SOURCE_PAGE_ID`、`TRANSFER_FRAME_ID`。
2. 用下列 `use_figma.code` 创建独立输出页，记录返回的 `outputPageId`。每次新复跑选择唯一页名，已有同名页时脚本会停止。

```js
const name = '自动渲染复跑'
if (figma.root.children.some(page => page.name === name)) throw Error(`页面已存在：${name}`)
const page = $fig.page({ name })
await $fig.done()
return { outputPageId: page.node.id }
```

3. 在独立项目根目录执行下列命令，将标准输出整段传给一次 `use_figma.code`。`OUTPUT_PAGE_ID` 取上一步的回执，源页和传输 frame 也可换为当前文件的 ID。若按名字选择，使用 `--source-name`、`--frame-name`、`--output-name`。

```sh
node mcp/compact.mjs --stage all --source "$SOURCE_PAGE_ID" --frame "$TRANSFER_FRAME_ID" --output "$OUTPUT_PAGE_ID"
```

4. 保存回执的 `sectionId` 和 `boards`。导出时对 `boards["phone/open"]` 调用 `download_assets`，传同一 `fileKey`、`sessionId`、该 `nodeId` 和 `defaultFormat: "png"`，将返回的临时 `export.url` 保存为本地 PNG。

需要短调用时，从空页按 `1 → 2 → 3 → 4 → 5 → fit → 6 → 7 → 8` 执行。第一段使用与上面相同的三个选择器，把 `--stage all` 换成 `--stage 1`。将其回执的 `sectionId` 赋给 `SECTION_ID`，以后每一段使用下列形式，每次只提交一段标准输出。运行中断后先按 MCP 的重试标志核对现场，再使用已创建的分区续跑。

```sh
node mcp/compact.mjs --stage "$STAGE" --source "$SOURCE_PAGE_ID" --frame "$TRANSFER_FRAME_ID" --output "$OUTPUT_PAGE_ID" --section "$SECTION_ID"
```

| 阶段 | 操作 |
| --- | --- |
| 1 | 核对两个页面 ID 和传输 frame 归属，还原输入，在指定输出页建立独立 SECTION |
| 2 | 为本次渲染建立颜色变量集合 |
| 3 | 创建本地主组件、变体、文字属性、嵌套实例和全部画板 |
| 4 | 应用主组件样式与采集几何 |
| 5 | 应用画板原生层样式，并通过文字属性更新实例和嵌套实例的标签 |
| fit | 用临时文字副本实测自然宽度，回读单行文字框和字距，并列出可能换行的文字 |
| 6 | 将 `ON_CLICK` 原型交互写到对应的源节点 |
| 7 | 回读每块画板、每个节点、实例主组件、文字、字体和原型目标 |
| 8 | 同时检查变量值、绑定 ID、实际 paint RGB 和透明度 |

前六个编号阶段返回 `sectionId` 和本次 `stage`。单次执行合并返回第七、八段以及 `fit` 的结果。`boards` 将 bundle ID 映射到可单独导出 PNG 的 Figma frame ID。`instanceRefs` 从源节点关联到实例及主组件；`masters` 返回每个主组件的 `mainId`、`setId`、`family`、原代码变体（缺省为 `Default`）和几何变体 `layout`。公开 inbox 样例应有 10 张画板、180 个源节点、66 个文字节点、36 个实例、16 条边、6 个颜色变量和 130 处绑定。字体清单只有 Arimo 时，`warnings` 应包括 `Arial Regular → Arimo Regular` 和 `Arial Bold → Arimo Bold`。

## 在自己的文件核对结果

在当前运行的 `RUN_DIR/replies` 收齐每块画板的结构回包与变量回包。`BUNDLE` 指向本次传输的采集包，四个 ID 均来自同一轮的真实回执。以下命令在本地检查回读结果。逐板 PNG 导出与视觉比较见[云端验收说明](../tools/cloud-export.md)。

```sh
node tools/cloud-export.mjs check "$BUNDLE" "$RUN_DIR/replies" \
  --source "$SOURCE_PAGE_ID" --frame "$TRANSFER_FRAME_ID" \
  --output "$OUTPUT_PAGE_ID" --section "$SECTION_ID" --geometry-tolerance 0
```

## 文本传输

```sh
node mcp/compact.mjs build/inbox/bundle.json
node mcp/compact.mjs build/inbox/bundle.json --chunks 420
```

第一条输出完整 minified JSON。第二条每行给出一个 TEXT 节点的 `characters`，格式为 `PARITYDATA|0000|` 后直接跟原文。四位十进制序号从 `0000` 连续递增。分片按 Unicode 码点截取，当前样例为 92 片。HTML/XML 承载时在写入标记语言的边界转义，Figma 中的 `characters` 应为解码后的原文。渲染器逐片校验序号并拼接，保留空格、反斜杠、小数、节点 ID 和所有字段。

## 支持范围

- 画板及后代按输入顺序绘制。渲染计划在画板绝对坐标中对齐有可见填充或描边的框边，再换算子层相对坐标。单行文字保留实测的纵向位置、高度和水平对齐锚点，在父级与相邻内容允许的范围内拓宽编辑框。多行文字保留采集宽度。文字采用原字号、行高、`textAutoResize: 'NONE'` 和 `textAlignVertical: 'CENTER'`。Arial 缺字族时优先找同字形 Arimo，再找同字形 Inter。
- 每个组件家族共用一个 COMPONENT_SET。`State` 保存原代码变体，`Layout` 根据子树的父相对几何、约束、层类型、矢量及样式确定。签名忽略状态 ID、节点 ID 和文字内容。对称留白可随宽高拉伸，右/下贴边可随父框移动，其余固定左/上间距。Masthead 的 16/32 px 左距分别落在同一集合的两个主组件。来自相同布局的实例用局部文字属性替换标签。实例的几何与 paint 继承自主组件。
- 每个 `STRETCH` 约束将其父框在该轴的尺寸小数部分计入布局签名，嵌套子树同样参与。父框在该轴只增减整像素时仍可复用主组件。公开样例中的 Tab 在 `Selected` 和 `Rest` 下各有两个布局，Action 的详情入口与返回按钮也分开。已有分区的第 3 段复用现有画板；人工改好真实稿的实例映射后可直接重跑 `fit` 和第 7 段。
- 文字测量使用实际字族、字形、字号、源字距和字符内容。`textAdjustments` 记录文字框调整，`unfittedText` 列出受可用空间限制仍可能换行的内容，供逐板核对 PNG。字距核对包含源值为零的文字。原始 DOM 几何审计会显示有意进行的框边对齐和文字扩框。渲染计划的几何审计单独衡量 Figma 是否准确执行这些调整。
- 支持 frame、可编辑 text、内联矢量 SVG、实色填充和描边、圆角、透明度、裁切及颜色变量绑定。连线支持 `NAVIGATE`、`OVERLAY` 和 `BACK`。PNG、SVG 中的 image/foreignObject 和外部 `figmaKey` 在建区前报错。
- 后续调用通过 `sectionId`、分区名称中的源数据指纹和真实画板结构识别本次输出。已有输出时，省略 `--section` 会报错并返回候选分区 ID。显式指定该 ID 后可以重入单次入口，复用集合、画板和主组件，再应用输入中的样式、文字和交互。第七、八段可单独回读。发生同名冲突或发现缺板时保留现场。调用结果未知时先核对该分区，并按 MCP 返回的重试标志处理。
- 传输工具在本机读文件、向标准输出写文本。项目已有 `esbuild` 时会压缩分段脚本，缺少它时输出同样可执行的可读代码。准备 staging HTML 时使用公开样例。
- 使用 `node --test mcp/renderer.test.mjs` 在本地运行分区隔离、实例写入边界、几何复用、颜色、文字及重跑回归。云端插件行为与导出像素通过实际 `use_figma` 和 PNG 对照验收。
