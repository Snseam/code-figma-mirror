const ids = {}
const source = figma.root.children.find(node => node.id === ids.sourcePageId)
const page = figma.root.children.find(node => node.id === ids.outputPageId)
if (!source || !page || source.id === page.id) throw Error('Expected distinct pages')
await source.loadAsync()
const transfer = await figma.getNodeByIdAsync(ids.transferFrameId)
let owner = transfer
while (owner && owner.type !== 'PAGE') owner = owner.parent
if (!transfer || transfer.type !== 'FRAME' || owner?.id !== source.id) throw Error('Wrong transfer frame')
const chunks = transfer.query('TEXT').map(node => node.characters)
  .filter(text => text.startsWith('PARITYDATA|')).sort()
if (!chunks.length) throw Error('Missing PARITYDATA')
const json = chunks.map((text, index) => {
  const prefix = `PARITYDATA|${String(index).padStart(4, '0')}|`
  if (!text.startsWith(prefix)) throw Error(`Missing or repeated chunk ${index}`)
  return text.slice(prefix.length)
}).join('')
const capture = JSON.parse(json)
const sourceOf = new WeakMap()
const singleLines = new WeakSet()
let bundle = capture
let hash = 2166136261
for (let offset = 0; offset < json.length; offset++) hash = Math.imul(hash ^ json.charCodeAt(offset), 16777619)
const signature = `${json.length}/${hash >>> 0}`
const prefix = `UI parity v2 / ${bundle.project} [`
const title = `${prefix}${transfer.id} ${signature}]`
if (figma.currentPage.id !== page.id) await figma.setCurrentPageAsync(page)
if (figma.currentPage.id !== page.id) throw Error('Output page mismatch')
const matches = page.children.filter(node => node.name.startsWith(prefix))
let section = matches[0]
if (ids.sectionId && (!section || section.id !== ids.sectionId || section.name !== title || section.type !== 'SECTION'))
  throw Error('Wrong section or changed source')
if (matches.length > 1 || (section && !ids.sectionId)) throw Error(`Inspect existing section ${section.id}`)
const report = { ...ids, chunks: chunks.length }
const children = spec => spec.children || []
const key = spec => JSON.stringify([spec.component, spec.variant || 'Default'])

function planGeometry(input, onNode) {
  const visiblePaint = color => color && !(color.length === 9 && color.endsWith('00'))
  function edge(start, size, snap) {
    const near = Math.round(start), far = Math.round(start + size)
    return snap && far > near ? [near, far - near] : [start, size]
  }
  function project(parent, sourceX, sourceY, paintX, paintY, parentWidth) {
    const siblings = (parent.children || []).map(child => {
      const style = child.style || {}, left = sourceX + child.x, top = sourceY + child.y
      const snap = child.kind === 'frame' && style.opacity !== 0 &&
        (visiblePaint(style.fill) || (style.strokeWidth ?? 1) > 0 && visiblePaint(style.stroke))
      const [drawLeft, width] = edge(left, child.width, snap)
      const [drawTop, height] = edge(top, child.height, snap)
      const singleLine = child.kind === 'text' && child.text && !/[\r\n\u2028\u2029]/.test(child.text) &&
        !['JUSTIFY', 'JUSTIFIED'].includes(style.align) && !(style.lineHeight > 0 && child.height >= 1.5 * style.lineHeight)
      const anchor = style.align === 'CENTER' ? 0.5 : ['END', 'RIGHT'].includes(style.align) ? 1 : 0
      return { child, left, top, drawLeft, drawTop, width, height, singleLine, anchor }
    })
    return siblings.map(box => {
      const { child, top, left, drawTop, height, singleLine, anchor } = box
      const { drawLeft } = box
      let width = box.width, extra = 0
      if (singleLine) {
        let min = paintX, max = paintX + parentWidth
        for (const peer of siblings) {
          if (peer === box || peer.drawTop >= top + height || peer.drawTop + peer.height <= top) continue
          const end = left + width, peerEnd = peer.drawLeft + peer.width
          if (peer.drawLeft >= end) {
            max = Math.min(max, peer.singleLine && peer.anchor > 0 ? (end + peer.drawLeft) / 2 : peer.drawLeft)
          } else if (peerEnd <= left) {
            min = Math.max(min, peer.singleLine && peer.anchor < 1 ? (left + peerEnd) / 2 : peerEnd)
          } else { min = left; max = end }
        }
        extra = Math.max(0, Math.min(Math.ceil(width) + 4 - width, anchor ? (left - min) / anchor : Infinity,
          anchor < 1 ? (max - left - width) / (1 - anchor) : Infinity))
        width += extra
      }
      const localLeft = drawLeft === left ? child.x + (sourceX - paintX) : drawLeft - paintX
      const localTop = drawTop === top ? child.y + (sourceY - paintY) : drawTop - paintY
      const drawn = { ...child, x: localLeft - anchor * extra, y: localTop, width, height }
      if (child.children) drawn.children = project(child, left, top, drawLeft, drawTop, width)
      if (onNode) onNode(child, drawn, singleLine)
      return drawn
    })
  }
  return { ...input, boards: input.boards.map(board => ({ ...board, children: project(board, 0, 0, 0, 0, board.width) })) }
}

function useDrawingPlan() {
  bundle = planGeometry(capture, (source, drawn, singleLine) => {
    sourceOf.set(drawn, source)
    if (singleLine) singleLines.add(drawn)
  })
}

function layoutIndex() {
  const layouts = new Map(), bySpec = new Map()
  function axis(offset, size, extent) {
    const end = Number((extent - offset - size).toFixed(8))
    if (Math.abs(offset - end) < 0.001) return ['STRETCH', offset, end, Math.round(extent * 1e8) % 1e8]
    if (end === 0 && offset > 0) return ['MAX', end, size]
    return ['MIN', offset, size]
  }
  function shape(spec, parent) {
    const horizontal = axis(spec.x, spec.width, parent.width), vertical = axis(spec.y, spec.height, parent.height)
    const subtree = children(spec).map(child => shape(child, spec))
    const style = Object.entries(spec.style || {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    const body = [spec.kind, style, spec.svg, subtree]
    const entry = { constraints: { horizontal: horizontal[0], vertical: vertical[0] } }
    if (spec.component) {
      const family = key(spec), signature = JSON.stringify(body)
      if (!layouts.has(family)) layouts.set(family, new Map())
      const shapes = layouts.get(family)
      if (!shapes.has(signature)) shapes.set(signature, `L${shapes.size + 1}`)
      entry.layout = shapes.get(signature)
      entry.label = JSON.stringify([spec.component, spec.variant || 'Default', entry.layout])
    }
    bySpec.set(spec, entry)
    return [horizontal, vertical, spec.component, spec.variant, body]
  }
  for (const board of bundle.boards) board.children.forEach(child => shape(child, board))
  return bySpec
}

function validate() {
  const ids = new Map(), clicks = new Set()
  const require = (ok, message) => { if (!ok) throw Error(message) }
  require(bundle.version === 1 && typeof bundle.project === 'string' && bundle.boards?.length, 'Invalid v1 bundle')
  function visit(spec, nodes, board) {
    require(spec.id && !nodes.has(spec.id), `Duplicate/missing ID in ${board}`)
    nodes.add(spec.id)
    require([spec.x, spec.y, spec.width, spec.height].every(Number.isFinite) &&
      spec.width > 0 && spec.height > 0, `Invalid geometry: ${spec.id}`)
    require(spec.kind !== 'image' && spec.data == null, `PNG/image unsupported: ${spec.id}`)
    require(spec.style?.letterSpacing == null || Number.isFinite(spec.style.letterSpacing), `Invalid letter spacing: ${spec.id}`)
    require(['frame', 'svg', 'text'].includes(spec.kind) && !spec.figmaKey, `Unsupported kind or library key: ${spec.id}`)
    require(spec.kind === 'frame' || (!children(spec).length && !spec.component), `Unsupported leaf: ${spec.id}`)
    require(spec.kind !== 'svg' || typeof spec.svg === 'string' && spec.svg.trim(), `Missing SVG: ${spec.id}`)
    require(spec.kind !== 'svg' || !/<(?:image|foreignObject)\b/i.test(spec.svg), `Embedded image/HTML unsupported: ${spec.id}`)
    require(spec.kind !== 'text' || typeof spec.text === 'string', `Missing text: ${spec.id}`)
    for (const child of children(spec)) visit(child, nodes, board)
  }
  for (const board of capture.boards) {
    require(!ids.has(board.id), `Duplicate board: ${board.id}`)
    const nodes = new Set()
    visit({ ...board, x: 0, y: 0, kind: 'frame' }, nodes, board.id)
    ids.set(board.id, nodes)
  }
  for (const edge of bundle.edges) {
    const source = JSON.stringify([edge.from, edge.source])
    require(ids.get(edge.from)?.has(edge.source) && (ids.has(edge.to) || edge.action === 'BACK' && edge.to == null) && !clicks.has(source) &&
      ['NAVIGATE', 'OVERLAY', 'BACK'].includes(edge.action), `Invalid edge: ${source}`)
    clicks.add(source)
  }
  for (const [name, color] of Object.entries(bundle.tokens)) {
    require(name && !name.includes('.') && /^#[\da-f]{6}([\da-f]{2})?$/i.test(color), `Invalid token: ${name}`)
  }
}

async function prepare() {
  validate()
  if (section) return
  const right = Math.ceil(page.children.reduce((end, node) => Math.max(end, node.x + node.width), 0))
  const width = bundle.boards.reduce((sum, board) => sum + board.width + 64, 64)
  const height = Math.max(...bundle.boards.map(board => board.height)) + 160
  const handle = $fig.section({ name: title, x: right + 128, y: 0, width, height })
  await $fig.done()
  section = handle.node
}

async function tokens() {
  const name = `${title} / ${section.id}`
  const collections = await figma.variables.getLocalVariableCollectionsAsync()
  const matches = collections.filter(group => group.name === name)
  if (matches.length === 1 && matches[0].variableIds.length === Object.keys(bundle.tokens).length) return
  if (matches.length) throw Error(`Partial or repeated token collection: ${name}`)
  const group = $fig.varCollection({ name, modes: ['Source'] })
  for (const [name, color] of Object.entries(bundle.tokens))
    group.colorVar({ name, values: { Source: color }, scopes: ['ALL_FILLS', 'STROKE_COLOR'] })
  await $fig.done()
}

async function tokenIndex() {
  const groups = (await figma.variables.getLocalVariableCollectionsAsync()).filter(group => group.name === `${title} / ${section.id}`)
  if (groups.length !== 1) throw Error('Expected one local token collection')
  const [group] = groups, result = new Map(), names = new Set()
  for (const id of group.variableIds) {
    const variable = await figma.variables.getVariableByIdAsync(id), color = bundle.tokens[variable.name]
    if (!color || names.has(variable.name) || variable.resolvedType !== 'COLOR') throw Error(`Unexpected token ${variable.name}`)
    const expected = figma.util.rgba(color), value = variable.valuesByMode[group.defaultModeId]
    if (['r', 'g', 'b', 'a'].some(field => Math.abs((value[field] ?? 1) - expected[field]) > 0.0001)) throw Error(variable.name)
    names.add(variable.name)
    result.set(color.toUpperCase(), id)
  }
  if (names.size !== Object.keys(bundle.tokens).length) throw Error('Token count')
  return result
}

function resolveFont(style, fonts, fontMode) {
  const family = style.fontFamily || 'Inter', weight = style.fontStyle || 'Regular'
  for (const candidate of fontMode ? [family] : [family, ...(family.toLowerCase() === 'arial' ? ['Arimo'] : []), 'Inter']) {
    const normalize = value => value.replace(/[\s-]/g, '').toLowerCase()
    const font = fonts.find(item => item.family.toLowerCase() === candidate.toLowerCase() &&
      (fontMode ? normalize(item.style) === normalize(weight) : item.style === weight))
    if (font) return font
  }
  throw Error(`Missing font: ${family} ${weight}`)
}

function geometry({ name, x, y, width, height }) {
  return { name, x, y, width, height }
}

function textProps(spec) {
  const props = {}
  function visit(node, path) {
    if (node.component) return
    if (node.kind === 'text') props[`Text ${path.join('-')}`] = node.text
    children(node).forEach((child, index) => visit(child, [...path, index + 1]))
  }
  children(spec).forEach((child, index) => visit(child, [index + 1]))
  return props
}

async function structure() {
  if (section.children.length) { boardPairs(); return }
  const shelfY = Math.max(...bundle.boards.map(board => board.height)) + 128
  let shelfX = 32, shelfHeight = 0, boardX = 32
  const masters = new Map(), groups = new Map()
  const layouts = layoutIndex()
  function layer(spec, path, expose) {
    const box = geometry(spec)
    box.constraints = layouts.get(spec).constraints
    if (spec.component) {
      const { label, layout } = layouts.get(spec)
      if (!masters.has(label)) {
        const layers = children(spec).map((child, index) => layer(child, [index + 1], true))
        const main = $fig.component({ ...geometry(spec), name: `State=${spec.variant || 'Default'}, Layout=${layout}` }, layers)
        masters.set(label, main)
        if (!groups.has(spec.component)) groups.set(spec.component, [])
        groups.get(spec.component).push({ main, spec })
      }
      return $fig.instance(masters.get(label), { ...box, props: textProps(spec) })
    }
    if (spec.kind === 'text') {
      const text = $fig.text({ ...box, characters: spec.text, textAutoResize: 'NONE', textAlignVertical: 'CENTER' })
      return expose ? text.textProp(`Text ${path.join('-')}`) : text
    }
    if (spec.kind === 'svg') return $fig.svg(spec.svg, box)
    return $fig.frame(box, children(spec).map((child, index) => layer(child, [...path, index + 1], expose)))
  }
  const root = $fig.get(section.id)
  for (const board of bundle.boards) {
    const layers = board.children.map(child => layer(child, [], false))
    root.append($fig.frame({ name: board.id, width: board.width, height: board.height,
      x: boardX, y: 32, clipsContent: true, fills: [figma.util.solidPaint('#FFFFFF')] }, layers))
    boardX += Math.ceil(board.width) + 64
  }
  for (const [name, entries] of groups) {
    let height = 0
    const width = Math.max(...entries.map(entry => entry.spec.width))
    const group = $fig.variants({ name }, entries.map(entry => entry.main))
    root.append(group)
    for (const { main, spec } of entries) {
      main.set({ x: 12, y: height + 12 })
      height += spec.height + 24
    }
    group.set({ x: shelfX, y: shelfY, width: width + 24, height })
    shelfHeight = Math.max(shelfHeight, height)
    shelfX += width + 64
  }
  root.set({ width: Math.max(section.width, shelfX + 32), height: shelfY + shelfHeight + 32 })
  await $fig.done()
}

function boardPairs() {
  return bundle.boards.map(board => {
    const frames = section.children.filter(node => node.type === 'FRAME' && node.name === board.id)
    if (frames.length !== 1) throw Error(`Board count: ${board.id}`)
    return [board, frames[0]]
  })
}

function walk(spec, node, callback, inherited = false) {
  if (!node) throw Error(`Missing node: ${spec.id}`)
  if (callback(spec, node, inherited) === false) return
  if (spec.kind === 'svg' || spec.kind === 'text') return
  if (children(spec).length !== node.children.length) throw Error(`Child count: ${spec.id}`)
  children(spec).forEach((child, index) => walk(child, node.children[index], callback, inherited || node.type === 'INSTANCE'))
}

async function painter() {
  const group = (await figma.variables.getLocalVariableCollectionsAsync()).find(item => item.name === `${title} / ${section.id}`)
  const variables = new Map()
  for (const id of group.variableIds) {
    const variable = await figma.variables.getVariableByIdAsync(id)
    variables.set(bundle.tokens[variable.name].toUpperCase(), variable)
  }
  const fonts = (await figma.listAvailableFontsAsync()).map(entry => entry.fontName)
  const paint = color => {
    const solid = figma.util.solidPaint(color), variable = variables.get(color.toUpperCase())
    return variable ? figma.variables.setBoundVariableForPaint(solid, 'color', variable) : solid
  }
  return function apply(spec, node, masterRoot) {
    const style = spec.style || {}, box = geometry(spec)
    if (masterRoot) { delete box.x; delete box.y; delete box.name }
    if (spec.kind !== 'svg') {
      const fill = spec.kind === 'text' ? style.color || style.fill || '#000000' : style.fill
      box.fills = fill ? [paint(fill)] : []
      box.strokes = style.stroke ? [paint(style.stroke)] : []
      if (style.stroke) { box.strokeWeight = style.strokeWidth ?? 1; box.strokeAlign = 'INSIDE' }
    }
    box.opacity = style.opacity ?? 1
    if (spec.kind === 'frame') {
      box.cornerRadius = style.radius || 0
      box.clipsContent = !!style.clip
    }
    if (spec.kind === 'text') {
      Object.assign(box, { fontName: resolveFont(style, fonts, bundle.fontMode), fontSize: style.fontSize ?? 16,
        letterSpacing: { unit: 'PIXELS', value: style.letterSpacing ?? 0 },
        lineHeight: style.lineHeight == null ? { unit: 'AUTO' } : { unit: 'PIXELS', value: style.lineHeight },
        textAlignHorizontal: ({ START: 'LEFT', END: 'RIGHT', JUSTIFY: 'JUSTIFIED' })[style.align] || style.align || 'LEFT',
        textAutoResize: 'NONE', textAlignVertical: 'CENTER' })
    }
    $fig.get(node.id).set(box)
  }
}

async function paintMasters() {
  const apply = await painter(), samples = new Map(), reads = []
  for (const [board, frame] of boardPairs()) walk(board, frame, (spec, node) => {
    if (spec.component) reads.push(node.getMainComponentAsync().then(main => [main, spec]))
  })
  for (const [main, spec] of await Promise.all(reads)) {
    if (main?.parent?.type !== 'COMPONENT_SET' || main.parent.parent.id !== section.id) throw Error(spec.id)
    if (!samples.has(main.id)) samples.set(main.id, spec)
  }
  for (const [id, spec] of samples) {
    const main = $fig.get(id).node
    walk(spec, main, (child, node) => {
      if (node.type === 'INSTANCE') return false
      apply(child, node, child === spec)
    })
  }
  await $fig.done()
}

async function paintBoards() {
  const apply = await painter()
  for (const [board, frame] of boardPairs()) walk(board, frame, (spec, node, inherited) => {
    if (node.type === 'INSTANCE') $fig.get(node.id).set({ props: textProps(spec) })
    else if (spec !== board && !inherited) apply(spec, node, false)
  })
  await $fig.done()
}

function matchesTracking(node, tracking) {
  const spacing = node.letterSpacing
  return spacing?.unit === 'PIXELS' && (spacing.value === tracking || spacing.value === Math.fround(tracking))
}

async function fitText() {
  const samples = new Map(), textAdjustments = [], unfittedText = []
  const result = { textAdjustments, unfittedText }
  const masters = new Set(), instances = []
  function fitEditable(spec, node) {
    if (node.type === 'INSTANCE') return false
    if (!singleLines.has(spec)) return
    const tracking = spec.style?.letterSpacing ?? 0
    const props = {}
    if (node.x !== spec.x) props.x = spec.x
    if (node.width !== spec.width) props.width = spec.width
    if (!matchesTracking(node, tracking))
      props.letterSpacing = { unit: 'PIXELS', value: tracking }
    if (Object.keys(props).length) $fig.get(node.id).set(props)
  }
  for (const [board, frame] of boardPairs()) walk(board, frame, (spec, node, inherited) => {
    if (spec.component) instances.push([spec, node])
    if (!singleLines.has(spec)) return
    if (!inherited) fitEditable(spec, node)
    const { characters, fontName, fontSize } = node
    const tracking = spec.style?.letterSpacing ?? 0
    const label = JSON.stringify([characters, fontName.family, fontName.style, fontSize, tracking])
    if (!samples.has(label)) samples.set(label, { characters, fontName, fontSize, tracking, targets: [] })
    samples.get(label).targets.push({ board: board.id, spec, node })
  })
  if (!samples.size) return result
  for (const [spec, instance] of instances) {
    const main = await instance.getMainComponentAsync()
    if (main?.parent?.parent?.id !== section.id) throw Error(`Wrong main: ${spec.id}`)
    if (masters.has(main.id)) continue
    masters.add(main.id)
    walk(spec, main, fitEditable)
  }
  const probes = [...samples.values()].map(({ characters, fontName, fontSize, tracking }) =>
    $fig.text({ characters, fontName, fontSize, letterSpacing: { unit: 'PIXELS', value: tracking }, textAutoResize: 'WIDTH_AND_HEIGHT' }))
  const host = $fig.frame({ name: 'Text measurement', visible: false }, probes)
  $fig.get(section.id).append(host)
  await $fig.done()
  const widths = probes.map(probe => probe.node.width)
  host.remove()
  await $fig.done()
  let index = 0
  for (const { targets, tracking } of samples.values()) {
    const naturalWidth = widths[index++]
    for (const { board, spec, node } of targets) {
      const source = sourceOf.get(spec), boxWidth = node.width, overflow = naturalWidth - boxWidth
      const record = { board, id: spec.id, sourceX: source.x, x: node.x, sourceWidth: source.width, boxWidth,
        naturalWidth, overflow, sourceLetterSpacing: tracking, letterSpacing: tracking }
      if (boxWidth !== source.width) textAdjustments.push(record)
      if (overflow > 0) unfittedText.push({ ...record, reason: 'insufficient-safe-width' })
      if (!matchesTracking(node, tracking))
        $fig.get(node.id).set({ letterSpacing: { unit: 'PIXELS', value: tracking } })
    }
  }
  await $fig.done()
  return result
}

async function connect() {
  const boards = new Map(), nodes = new Map()
  for (const [board, frame] of boardPairs()) {
    boards.set(board.id, frame)
    const index = new Map()
    walk(board, frame, (spec, node) => index.set(spec.id, node))
    nodes.set(board.id, index)
  }
  for (const edge of bundle.edges) {
    const source = nodes.get(edge.from).get(edge.source)
    const action = edge.action === 'BACK' ? { type: 'BACK' } : { type: 'NODE',
      destinationId: boards.get(edge.to).id, navigation: edge.action, transition: null }
    await source.setReactionsAsync([{ trigger: { type: 'ON_CLICK' }, actions: [action] }])
  }
}

async function verify() {
  const pairs = boardPairs(), boards = new Map(pairs.map(([board, frame]) => [board.id, frame.id]))
  const masters = new Map(), instanceRefs = []
  const sources = new Map(bundle.edges.map(edge => [JSON.stringify([edge.from, edge.source]), edge]))
  const fontWarnings = new Set()
  const fonts = (await figma.listAvailableFontsAsync()).map(entry => entry.fontName)
  let nodes = 0, texts = 0, instances = 0, edges = 0
  for (const [board, frame] of pairs) {
    const components = []
    walk(board, frame, (spec, node) => {
      const fail = field => { throw Error(`${board.id} / ${spec.id}: ${field}`) }
      for (const field of spec === board ? ['width', 'height'] : ['x', 'y', 'width', 'height'])
        if (spec[field] !== node[field]) fail(field)
      if (spec !== board) nodes++
      if (spec.component) components.push([spec, node])
      if (spec.kind === 'text') {
        const style = spec.style || {}, requested = `${style.fontFamily || 'Inter'} ${style.fontStyle || 'Regular'}`
        const actual = `${node.fontName.family} ${node.fontName.style}`
        if (actual !== requested) fontWarnings.add(`${requested} → ${actual}`)
        if (node.type !== 'TEXT' || node.characters !== spec.text || node.textAutoResize !== 'NONE' ||
            node.textAlignVertical !== 'CENTER' || (style.fontSize && style.fontSize !== node.fontSize) ||
            (style.lineHeight && style.lineHeight !== node.lineHeight.value) ||
            !matchesTracking(node, style.letterSpacing ?? 0) ||
            node.textAlignHorizontal !== (({ START: 'LEFT', END: 'RIGHT', JUSTIFY: 'JUSTIFIED' })[style.align] || style.align || 'LEFT') ||
            (node.fontName.family !== resolveFont(style, fonts, bundle.fontMode).family ||
             node.fontName.style !== resolveFont(style, fonts, bundle.fontMode).style)) fail('text')
        texts++
      }
      const edge = sources.get(JSON.stringify([board.id, spec.id]))
      const reactions = node.reactions || []
      if (reactions.length !== (edge ? 1 : 0)) fail('reaction count')
      if (edge) {
        const [reaction] = reactions, [action] = reaction.actions
        if (reaction.trigger?.type !== 'ON_CLICK' || reaction.actions.length !== 1 || (edge.action === 'BACK' ?
          action.type !== 'BACK' : action.type !== 'NODE' || action.navigation !== edge.action ||
          action.destinationId !== boards.get(edge.to))) fail('reaction')
        edges++
      }
    })
    for (const [spec, node] of components) {
      const main = node.type === 'INSTANCE' && await node.getMainComponentAsync()
      const set = main?.parent, axes = main?.variantProperties
      if (!axes?.Layout || axes.State !== (spec.variant || 'Default') || set.type !== 'COMPONENT_SET' ||
          set.parent.id !== section.id || set.name !== spec.component)
        throw Error(`Wrong instance: ${spec.id}`)
      masters.set(main.id, { mainId: main.id, setId: set.id, family: set.name, variant: axes.State, layout: axes.Layout })
      instanceRefs.push({ source: spec.id, instanceId: node.id, mainId: main.id })
      instances++
    }
  }
  return { ...report, sectionId: section.id, boards: Object.fromEntries(boards), nodes, texts, instances, edges,
    masters: [...masters.values()], instanceRefs, warnings: [...(bundle.warnings || []), ...fontWarnings] }
}

async function verifyTokens() {
  const tokenIds = await tokenIndex()
  let bindings = 0
  for (const [board, frame] of boardPairs()) walk(board, frame, (spec, node) => {
    const style = spec.style || {}
    for (const [field, color] of [['fills', spec.kind === 'text' ? style.color || style.fill : style.fill], ['strokes', style.stroke]]) {
      const token = color && tokenIds.get(color.toUpperCase())
      if (spec.kind === 'svg' || !token) continue
      const actual = node[field][0], expected = figma.util.solidPaint(color)
      if (actual?.boundVariables?.color?.id !== token || ['r', 'g', 'b'].some(channel =>
        Math.abs(expected.color[channel] - actual.color[channel]) > 1 / 255) ||
        Math.abs((expected.opacity ?? 1) - (actual.opacity ?? 1)) > 1 / 255) throw Error(`${spec.id} ${field} paint`)
      bindings++
    }
  })
  return { ...report, sectionId: section.id, tokens: Object.keys(bundle.tokens).length, bindings }
}

await prepare()
await tokens()
useDrawingPlan()
await structure()
await paintMasters()
await paintBoards()
const fitting = await fitText()
await connect()
return { ...await verify(), ...await verifyTokens(), ...fitting }
