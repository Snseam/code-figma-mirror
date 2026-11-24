# 从云端画板取得验收证据

在项目根目录执行。先从目标文件的渲染回执取得源页、传输框、输出页和 SECTION 的原生 ID，分别设置 `SOURCE_ID`、`FRAME_ID`、`OUTPUT_ID`、`SECTION_ID`。`request`、`requests`、`tokens` 和 `check` 均要求显式传入这四个 ID。已有回包可运行 `decode` 查看 `context`，核对所属文件与分区。

```sh
BUNDLE=build/inbox/bundle.json
RUN=build/cloud-acceptance
IDS=(--source "$SOURCE_ID" --frame "$FRAME_ID" --output "$OUTPUT_ID" --section "$SECTION_ID")
mkdir -p "$RUN/replies" "$RUN/export"
node tools/cloud-export.mjs requests "$BUNDLE" "$RUN/requests" "${IDS[@]}"
```

每个 `.js` 文件是一块画板的完整 `use_figma.code`。使用同一个 Figma 文件和 session，`skillNames` 填 `figma-use`。逐个执行，把返回的 JSON 对象原样保存为 `replies/001-1.json` 等文件。命令会打印请求文件与板 ID 的对应关系。回包和最终报告放在各自目录中。

回包含 `board`、`part`、`parts` 和校验字段。通常每板一包。若 `phone/open` 的第一包显示 `parts: 2`，用下列命令生成第二次请求，把回包存成独立 JSON。多包来自同一板的完整重读，采集期间板内容变化会使校验值不同，届时重新收集该板所有分片。

```sh
node tools/cloud-export.mjs request "$BUNDLE" phone/open "${IDS[@]}" --part 2
```

## 可选的颜色 token 快照

已有十份画板回包时，只需生成并执行一次独立的 token 请求。下例使用 Bash 或 Zsh 数组 `IDS`。

```sh
node tools/cloud-export.mjs tokens "$BUNDLE" "${IDS[@]}" > "$RUN/tokens.js"
```

在同一文件的 `use_figma.code` 中执行 `tokens.js`，把返回的 JSON 保存到现有的 `"$RUN/replies/tokens-1.json"`。若返回的 `parts` 大于 1，给同一命令加 `--part 2` 等参数，逐份保存后再合并。`merge` 自动识别 token 回包，并检查其文件键、四个原生 ID 和源指纹与画板回包一致。

读端精确匹配渲染器为该 SECTION 创建的本地变量集合（集合名为分区全名加 ` / <sectionId>`），读取完整变量清单中每个 COLOR 的默认模式字面值。名称按当前集合回读，颜色通道按 8 位转换。采集过程中不会用源颜色覆盖实际值或因设计改色而中断。重名集合、重名变量、不可读变量、别名或非 COLOR 数据会使读取或合并报错，以免部分清单被当作完整快照。其他模式、图层上的覆盖和变量绑定不在这次快照的范围内。

随 token 回包合并后，报告顶层 `tokens` 是实测色表，`changes` 含相对源 bundle 的 `scope: "token"` 增、删、改记录，`cloud.tokenCoverage` 给出集合、模式和数量。变量以名称对照，重命名表现为旧名称删除和新名称新增。透明色保留 `#RRGGBBAA`，当前 CSS `review` 只接受 `#RRGGBB`，会将透明色列入冲突。实测空集合输出 `tokens: {}`。

仅合并旧画板回包时，`cloud.tokenCoverage.status` 为 `unobserved`，报告会省略 `tokens` 并给出告警。此时可验收画板；`review` 中缺少 token 差异不能证明颜色未变。

## 校验与合并

`decode` 可以先查看已收齐的板及待收板 ID。`check` 需要收齐全部板，它核对指定画布、父相对几何、层级、堆叠次序、文字、组件复用和原型交互。有 token 回包时，颜色变化也计入 `issues`。几何容差默认 1 px。退出码 `0` 表示已采集范围通过，`2` 表示观察到差异，`1` 表示输入或证据无效。存在真实设计差异时，仍可运行 `merge` 供 `review` 审阅。

```sh
node tools/cloud-export.mjs decode "$BUNDLE" "$RUN/replies" > "$RUN/decoded.json"
node tools/cloud-export.mjs check "$BUNDLE" "$RUN/replies" "${IDS[@]}" --geometry-tolerance 1
```

把另外导出的 1× Figma PNG 放入 `"$RUN/export"`，文件名可用 `phone--open.png` 或插件标准名 `board-phone--open.png`。每板只放一份。`merge` 解码 PNG、核对尺寸并使用实际文件名写入清单。`--out` 在所有检查成功后替换目标。现在可以用 `export/` 中的文件组装 ZIP。

```sh
node tools/cloud-export.mjs merge "$BUNDLE" "$RUN/replies" \
  --png-dir "$RUN/export" --out "$RUN/export/design-diff.json"
node cli.mjs audit "$BUNDLE" "$RUN/export/design-diff.json" "$RUN/audit.json"
```

暂缺 PNG 时也可以省略 `--png-dir` 生成测量快照，板状态为 `measured`、`file` 为 `null`。绑定实际 PNG 后为 `exported`。`check` 检查同一组件集、源变体和实际 Layout 是否复用同一 `mainId`。若某版根包 `audit` 仅按源变体比较 `mainId`，跨 Layout 可能报告 `different-master`；可核对 `observed.instances` 的 `mainId`、`setId`、`variant` 和 `layout`。

## 证据范围

- 读端核对传输分片、输出页、指定 SECTION 和渲染器的源指纹。画板按稳定 ID 定位，后代沿渲染器的源树路径映射。同名兄弟沿用渲染顺序。源树没有持久化的子层原生 ID，无法识别仅交换了身份的同名同构兄弟。无法确定映射的增删或结构变化会报出位置。
- 几何、父原生 ID、文本、实际主组件及其父组件集、State 和 Layout 轴均在输出节点上读取。`observed.geometry` 含实际 `figmaId` 和映射后的直接 `parentId`。SVG 按采集树中的单个源图层处理。可解析的点击目标回映射到稳定板 ID；`observed.reactions` 额外保留映射前的实际 trigger、actions 和原生目的 ID。
- `changes` 比较源树与本次可测字段。`sourceSha256` 对本地原始 bundle 字节计算，`cloud.stamp` 对云端传输的紧凑 JSON 核对。MCP 渲染没有插件导入修订号，`revision` 为 `null`。分板回读期间请保持文件稳定。

本地回归命令为 `node --test tools/cloud-export.test.mjs`。
