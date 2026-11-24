# 十板 Figma 云端复跑

在仓库根目录运行。`--bundle` 指向实际上传的结构源包，`--capture` 指向像素参考目录，默认后者为 `build/raster-acceptance/capture`。在 `build/raster-acceptance/cloud/preflight.json` 填写本次的 `fileKey`、`sessionId`、`sourcePage.id`、`outputPage.id` 和 `expectedPngCount`。只读核对已有分区时再填 `transferFrameId` 和 `sectionId`。下方只读示例假设已把 `tests/fixtures/field-notes.json` 导入自己的文件。

```sh
node tools/raster-acceptance.mjs prepare --readback --bundle tests/fixtures/field-notes.json --dir build/raster-acceptance/prepared-readback
```

这一步在本地记录原包字节、每张源 PNG、计划和渲染器的 SHA-256。已有分区的来源以其回包指纹为准。更新输入或渲染器后使用新的 `--dir`。

## 云端执行入口

协调者启动后，在已经注册 Figma 工具的 Codex CLI 环境运行以下命令。`--server` 默认 `codex_apps`，可指定另一个已登录、工具签名兼容的 MCP 服务。

```sh
node tools/raster-acceptance.mjs run --readback --bundle tests/fixtures/field-notes.json --dir build/raster-acceptance/prepared-readback
```

CLI 经 `codex app-server` 查询当前目录可用的 MCP 工具，在第一个写请求前核对 `use_figma` 和单节点 `download_assets`。实际写入由 `use_figma` 执行。

**用当前桌面连接器执行。** 把上述命令的 `run` 换成 `next`，其余参数相同。读取输出中 `request` 指向的 JSON，用指定的 Figma 工具提交 `arguments`，把原始 JSON 回执保存到 `receipt` 指定的路径。重复同一条命令即可处理下一批、下一阶段或下一块板。协调者使用 `figma-use`，写入时同时加载 `figma-generate-design`。`next` 把 MCP 分派交给桌面连接器，收到导出回执后会从其中的 HTTPS URL 下载 PNG。

**在新页重新传输及渲染。** 协调者分配独立空的 `sourcePage`（也可指定 `stagingPage`）和 `outputPage`，在单独预检 JSON 中填入相同字段，`sectionId` 留空。从以下命令开始准备；正式执行时将 `prepare` 换成 `run`，或用 `next` 交给桌面连接器。下面选择受控采集的 bundle 同时作为结构源和像素参考。

```sh
node tools/raster-acceptance.mjs prepare --preflight "$NEW_PREFLIGHT" --dir "$NEW_RUN_DIR" --capture build/raster-acceptance/capture
```

- 传输使用 `mcp/transfer.mjs`，一批一个请求。最后一批必须返回匹配的 SHA-256、分片总数、连续使用的 `transferFrameId` 和 `complete:true`。
- 渲染使用 `mcp/compact.mjs` 的 `1 → 2 → 3 → 4 → 5 → fit → 6`。阶段 1 返回本次 `sectionId`。之后所有渲染、结构读取和验证都使用同一组原生 ID。
- 结构包来自 `tools/cloud-reader.mjs` 在云端实际读取的图层、父节点、位置、文本内容、字号、实例主组件、变体以及原型动作。`tools/cloud-export.mjs` 核对原包指纹、板树、分片签名和跨包上下文。流程也读取分区变量集合。`get_metadata` 提供的节点概览仅适合定位。
- `download_assets` 每次使用结构回包中的一块板 `figmaId`，显式传 `defaultFormat:"png"` 和 `defaultScale:1`。下载 `export.url`，解码并核对板尺寸。`exports.json` 逐板记录原生 frame ID、文件名和实际文件哈希。最后的 `verify-7`、`verify-8` 回执另行记录渲染器对文字、组件、连线和颜色绑定的检查。

`requests/`、`receipts/` 保留分派记录，`replies/` 只含可交给 `cloud-export` 的板包和 token 包。重新执行会复用相同请求的已存回执。写请求存在 `.sent` 且缺失回执时，先检查 Figma 现场并补入实际回执。若能确认请求从未执行，可移走对应标记后重发。导出 URL 过期时只需移走对应的只读 `receipts/png-N.json`，重新取得该节点的导出链接。已有分区只读取证时，给预检 JSON 填入匹配的 `transferFrameId` 和 `sectionId`，在独立 `--dir` 上对 `prepare`、`next` 或 `run` 加 `--readback`。

## 接手已取回的证据

已有协调者取得的十张 PNG、板包和 token 包时，以下命令在本地一次完成合并、双审计及像素报告。`FRAME_ID` 和 `SECTION_ID` 来自本批云端回执。预检 JSON 已填入这两个值时可省略相应参数。

```sh
node tools/raster-acceptance.mjs finish --bundle tests/fixtures/field-notes.json \
  --replies build/raster-acceptance/cloud/replies --png build/raster-acceptance/cloud/png \
  --dir build/raster-acceptance/collected
```

`finish` 依赖交接方提供的 PNG 来源记录。它核实文件、板名、尺寸及结构回包归属。分区渲染器的第 7、8 阶段由负责云端的协调者单独留存回执。仅需对已经合并的 `design-diff.json` 做双审计时可单独运行以下命令。

```sh
node tools/raster-acceptance.mjs audit \
  --bundle tests/fixtures/field-notes.json \
  --snapshot build/raster-acceptance/collected/figma/design-diff.json \
  --dir build/raster-acceptance/collected
```

| 文件 | 比较口径 |
| --- | --- |
| `figma/design-diff.json`、`cloud-check-dom.json`、`audit-dom.json` | 均以原始采集包为基准。完整保留单行框扩宽、像素贴齐以及其它实测偏差。`audit-dom` 记录逐层预期值、实测值和最大误差。 |
| `render-plan.json`、`audit-plan.json` | 直接复用 `mcp/compact.mjs` 从 `renderer.js` 导出的 `planGeometry`。同一份实测快照逐层按 0 px 容差审计。这里的 `maxDeviation` 专指渲染计划。 |
| `visual/report.json`、`strict/report.json` | 同一组原始浏览器 PNG 与 Figma PNG。分别按每通道容差 16、每板超差面积 ≤1%，以及严格逐像素相等计算。 |
| `result.json` | 独立报告原始 DOM、计划、语义、既定视觉和严格像素结果。总判定采用计划零容差、语义和既定视觉阈值。`run` 另要求阶段 7、8 成功。 |

`0` 表示相应命令完成并通过其判定，`2` 表示发现差异，`1` 表示取证不完整或运行错误。`prepare` 返回 `prepared`，`next` 等待真实回执时返回 `awaiting-MCP`。
