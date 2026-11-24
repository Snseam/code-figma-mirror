# 将采集包传到 Figma staging 页

在验收草稿中准备一张独立空页，把它的原生页面 ID 赋给 `STAGING_PAGE_ID`。在项目根目录运行以下命令。第一条输出 `chunks`、`batches` 和紧凑 JSON 的 `sha256`，第二条仅输出第一批可直接交给 `use_figma.code` 的 JavaScript。

```sh
node mcp/transfer.mjs build/inbox/bundle.json --staging-page "$STAGING_PAGE_ID"
node mcp/transfer.mjs build/inbox/bundle.json --staging-page "$STAGING_PAGE_ID" --batch 1
```

在同一验收文件和 MCP session 中执行第二条的输出，`skillNames` 填 `figma-use,figma-generate-design`。要先验一批，可检查回执的 `sourcePageId`、`transferFrameId`、`added` 和 `received`。重跑同一批应返回相同 frame ID 和 `added: 0`。按 `1` 到 `batches` 顺序继续，直到收到 `complete: true`。每个脚本最多 8192 个 UTF-8 字节。可用 `--chunk-size`（默认 420 个 Unicode 码点）和 `--batch-size`（默认最多 8 片）调整计划，各批沿用同一组参数。

将最终回执中的 `sourcePageId`、`transferFrameId` 分别用于 `--source` 和 `--frame`。`OUTPUT_PAGE_ID` 指向另一张渲染输出页。下面的命令输出渲染器第 1 段，后续阶段见同目录 `README.md`。

```sh
node mcp/compact.mjs --stage 1 --source "$STAGING_PAGE_ID" --frame "$TRANSFER_FRAME_ID" --output "$OUTPUT_PAGE_ID"
```

每个 staging 页承载一份采集包。独立页的唯一直接子层是一个原生 frame，名称包含页 ID、紧凑 JSON 的 SHA-256、分片规格和 frame 自身 ID。其直接子层为 `compact.mjs` 原样生成的 `PARITYDATA|0000|…` TEXT。每次调用均从实际 `characters` 读取序号，检查序号连续且唯一，再从脚本携带的根校验值开始，逐片验证内容与图层名中的下一片 FNV-1a 校验值。本批已有文本另与输入原文逐字比较。签名和校验值只出现在图层名称及调用参数中。

同一批执行中断时，重跑会复用已逐片核实的连续前缀，从首个缺片继续。副本或移至其他页的 frame、改写的文本及中间缺片都会报冲突。`sha256` 是本机对紧凑 JSON 计算的整包摘要，`added` 是该批新建的 TEXT 数。

本地回归命令为 `node --test mcp/transfer.test.mjs`。
