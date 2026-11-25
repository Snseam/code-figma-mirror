import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PNG } from 'pngjs'
import { chunks, planGeometry, stage as renderStage } from './compact.mjs'
import { audit } from '../audit.mjs'
import { check, merge } from '../tools/cloud-export.mjs'
import { readBoard, signature } from '../tools/cloud-reader.mjs'

const bundle = JSON.parse(await readFile(new URL('../tests/fixtures/field-notes.json', import.meta.url)))
const fixtureIds = { sourcePageId: '101:1', outputPageId: '102:1', transferFrameId: '101:2' }
const stage = (number, options) => renderStage(number, { ...fixtureIds, ...options })
const raw = await stage('all')
const compile = code => new (async () => {}).constructor('figma', '$fig', code)

function canvas(data = bundle) {
  const source = { type: 'PAGE', id: fixtureIds.sourcePageId, name: 'Transfer page', children: [], async loadAsync() {} }
  const output = { type: 'PAGE', id: fixtureIds.outputPageId, name: 'Acceptance', children: [], async loadAsync() {} }
  const pieces = chunks(data).reverse().map(characters => ({ characters }))
  const transfer = { type: 'FRAME', id: fixtureIds.transferFrameId, name: 'Transport', parent: source, query: () => pieces }
  source.children.push(transfer)
  source.query = () => ({ toArray: () => source.children })
  const nodes = new Map(), collections = [], variables = new Map()
  let serial = 0
  const next = () => `20:${++serial}`
  function rgba(hex) {
    const channels = [1, 3, 5, 7].map(offset => parseInt(hex.slice(offset, offset + 2) || 'ff', 16) / 255)
    return Object.fromEntries(['r', 'g', 'b', 'a'].map((field, index) => [field, channels[index]]))
  }
  const figma = {
    root: { children: [source, output] }, currentPage: source, async setCurrentPageAsync(page) { this.currentPage = page },
    async getNodeByIdAsync(id) { return id === transfer.id ? transfer : nodes.get(id)?.node },
    async listAvailableFontsAsync() { return ['Bold', 'Regular'].map(style => ({ fontName: { family: 'Arimo', style } })) },
    util: { rgba, solidPaint: color => ({ type: 'SOLID', color: rgba(color) }) },
    variables: { getLocalVariableCollectionsAsync: async () => collections, getVariableByIdAsync: async id => variables.get(id),
      setBoundVariableForPaint: (paint, field, variable) => ({ ...paint, boundVariables: { [field]: { id: variable.id } } }) }
  }
  function nodePlan(type, values = {}, children = []) {
    assert.equal(figma.currentPage, output)
    const node = { type, parent: output, id: next(), name: type, x: 0, y: 0, width: 100, height: 100,
      reactions: [], async setReactionsAsync(items) { this.reactions = items } }
    if (type !== 'TEXT') node.children = []
    output.children.push(node)
    const plan = { node, id: node.id, textProp(name) { node.property = name; return plan },
      remove() {
        node.parent.children = node.parent.children.filter(child => child !== node)
        function drop(item) { nodes.delete(item.id); item.children?.forEach(drop) }
        drop(node)
      },
      append(child) {
        const item = child.node, parent = item.parent
        parent.children = parent.children.filter(other => other !== item)
        item.parent = node
        node.children.push(item)
        return plan
      },
      set(props) {
        for (const [field, value] of Object.entries(props)) {
          for (let parent = node.parent; parent; parent = parent.parent)
            if (parent.type === 'INSTANCE') assert.ok(!['x', 'y', 'width', 'height', 'relativeTransform'].includes(field), `forbidden ${field} in instance`)
          if (node.type === 'INSTANCE') assert.ok(!['fills', 'strokes'].includes(field), 'instance paint override')
          if (field === 'props') {
            function apply(child) {
              if (child.type === 'INSTANCE') return
              if (child.property in value) child.characters = value[child.property]
              child.children?.forEach(apply)
            }
            node.children.forEach(apply)
          } else if (['fills', 'strokes'].includes(field)) {
            node[field] = value.map(paint => paint.color?.id ?
              { ...paint, boundVariables: { color: { id: paint.color.id } } } : paint)
          } else node[field] = value
        }
        return plan
      } }
    nodes.set(plan.id, plan)
    children.forEach(child => plan.append(child))
    plan.set(values)
    if (type === 'TEXT' && values.textAutoResize === 'WIDTH_AND_HEIGHT') {
      const widths = { Surveys: 125, 'Field notes': 85, 'View survey': 81, 'Back to surveys': 108, Closed: 47, Open: 37,
        'The samples are catalogued and ready for review.': 356 }
      node.width = (widths[node.characters] || 1) + (values.letterSpacing?.value || 0) * (node.characters.length - 1)
    }
    return plan
  }
  function clone(from) {
    const plan = nodePlan(from.type)
    for (const field of ['name', 'property', 'characters', 'getMainComponentAsync'])
      if (field in from) plan.node[field] = from[field]
    for (const field of ['fontName', 'fontSize', 'lineHeight', 'textAlignHorizontal', 'textAlignVertical', 'textAutoResize', 'fills', 'strokes', 'constraints'])
      Object.defineProperty(plan.node, field, { get: () => from[field], configurable: true })
    let trackingOverride
    Object.defineProperty(plan.node, 'letterSpacing', {
      get: () => trackingOverride ?? from.letterSpacing, set: value => { trackingOverride = value }
    })
    for (const [position, size, direction] of [['x', 'width', 'horizontal'], ['y', 'height', 'vertical']]) {
      const delta = () => plan.node.parent[size] - from.parent[size]
      const mode = () => from.constraints?.[direction]
      Object.defineProperty(plan.node, position, { get: () => from[position] + (mode() === 'MAX' ? delta() : 0) })
      Object.defineProperty(plan.node, size, { get: () => from[size] + (mode() === 'STRETCH' ? Math.round(delta()) : 0) })
    }
    from.children?.forEach(child => plan.append(clone(child)))
    return plan
  }
  const builder = {
    async done() {}, get: id => nodes.get(id),
    instance(main, values) {
      const plan = nodePlan('INSTANCE', {}, main.node.children.map(clone))
      plan.node.getMainComponentAsync = async () => main.node
      for (const field of ['fills', 'strokes']) Object.defineProperty(plan.node, field, { get: () => main.node[field] })
      return plan.set(values)
    },
    getVarCollection: name => collections.find(group => group.name === name),
    varCollection({ name }) {
      const group = { name, variableIds: [], defaultModeId: 'Source',
        getVar(name) { return this.variableIds.map(id => variables.get(id)).find(variable => variable.name === name) },
        colorVar({ name, values }) {
          const variable = { id: next(), name, resolvedType: 'COLOR', valuesByMode: { Source: rgba(values.Source) } }
          this.variableIds.push(variable.id)
          variables.set(variable.id, variable)
          return variable
        } }
      collections.push(group)
      return group
    } }
  for (const [method, type] of Object.entries({ section: 'SECTION', component: 'COMPONENT', variants: 'COMPONENT_SET', frame: 'FRAME', text: 'TEXT' }))
    builder[method] = (props, children) => nodePlan(type, props, children)
  builder.variants = (props, mains) => {
    for (const main of mains) main.node.variantProperties = Object.fromEntries(main.node.name.split(', ').map(axis => axis.split('=')))
    return nodePlan('COMPONENT_SET', props, mains)
  }
  return { figma, source, output, pieces, collections, nodes, transfer, run: code => compile(code)(figma, builder) }
}

test('fixed-width single lines retain their anchors, Range vertical bounds and explicit or default zero tracking', async () => {
  const style = { fontFamily: 'Arimo', fontSize: 16, lineHeight: 20 }
  const children = ['LEFT', 'CENTER', 'RIGHT', 'END'].map((align, index) => ({
    id: align, name: align, kind: 'text', text: 'Surveys', x: 10.5, y: 0.25 + index * 20, width: 124.5, height: 17,
    style: { ...style, align, ...(index ? { letterSpacing: 0 } : {}) }
  }))
  const data = { ...bundle, boards: [{ id: 'board', width: 160, height: 100, children }], edges: [], tokens: {} }
  const before = structuredClone(data)
  const expected = planGeometry(data).boards[0].children
  assert.deepEqual(data, before)
  assert.deepEqual(expected.map(node => node.x), [10.5, 8.25, 6, 6])
  const context = canvas(data), result = await context.run(raw)
  const frame = context.nodes.get(result.boards.board).node, options = { sectionId: result.sectionId }
  const verify = await stage('7', options), fit = await stage('fit', options)
  for (const [index, node] of frame.children.entries()) {
    assert.deepEqual([node.x, node.width, node.y, node.height], [expected[index].x, 129, children[index].y, 17])
    for (const value of [-0.001, Number.MIN_VALUE, null]) {
      node.letterSpacing = { unit: 'PIXELS', value }
      await assert.rejects(context.run(verify), /text/)
    }
    node.letterSpacing = { unit: 'PERCENT', value: 0 }
    await assert.rejects(context.run(verify), /text/)
    node.x = children[index].x
    node.width = children[index].width
    await context.run(fit)
    assert.deepEqual([node.x, node.width, node.letterSpacing], [expected[index].x, 129, { unit: 'PIXELS', value: 0 }])
  }
  await context.run(verify)
  frame.children[1].x += 1 / 1024
  await assert.rejects(context.run(verify), /CENTER: x/)
})

test('single-line safety margins respect parent and neighboring boxes and preserve multiline geometry', () => {
  const label = (id, x, y, align, extra = {}) => ({
    id, name: id, kind: 'text', text: 'Label', x, y, width: 10, height: 12, style: { align, lineHeight: 15 }, ...extra
  })
  const children = [label('left', 0, 0, 'LEFT'), label('right', 14, 0, 'RIGHT'), label('parent', 29, 20, 'CENTER'),
    label('newline', 3, 40, 'LEFT', { text: 'A\nB' }), label('tall', 3, 70, 'LEFT', { height: 30 }),
    label('justified', 3, 110, 'JUSTIFIED')]
  const [board] = planGeometry({ boards: [{ width: 40, height: 150, children }] }).boards
  assert.deepEqual(board.children.map(node => [node.x, node.width]), [[0, 12], [12, 12], [28, 12], [3, 10], [3, 10], [3, 10]])
})

test('snapped absolute edges rebase nested components and preserve fractional descendant anchors', async () => {
  const label = { kind: 'text', name: 'label', text: 'Example', x: 2.25, y: 1.625, width: 10.5, height: 12,
    style: { align: 'CENTER', fontFamily: 'Arimo' } }
  const outer = (index, x) => ({
    id: `outer-${index}`, name: 'Outer', kind: 'frame', component: 'Outer', x, y: 2.375, width: 51.5, height: 30.375,
    style: { fill: '#FFFFFF' }, children: [{ id: `inner-${index}`, name: 'Inner', component: 'Inner', kind: 'frame',
      x: 0.375, y: 0.375, width: 24.625, height: 18.25, style: { stroke: '#202020' },
      children: [{ ...label, id: `label-${index}` }] }]
  })
  const roots = [outer(0, 0.25), outer(1, 64.75), outer(2, 128.25)]
  const data = { ...bundle, boards: [{ id: 'b', width: 256, height: 100, children: [
    { kind: 'frame', id: 'wrapper', name: 'wrapper', x: 0.125, y: 0.125, width: 240.5, height: 80, children: roots }
  ] }], edges: [], tokens: {} }
  const context = canvas(data), rendered = await context.run(raw)
  const wrapper = context.nodes.get(rendered.boards.b).node.children[0]
  assert.equal(wrapper.x, 0.125)
  for (const [index, outerNode] of wrapper.children.entries()) {
    const [inner] = outerNode.children, [text] = inner.children
    const sourceLeft = 0.125 + roots[index].x
    const outerLeft = wrapper.x + outerNode.x, innerLeft = outerLeft + inner.x
    assert.equal(outerNode.type, 'INSTANCE')
    assert.equal(inner.type, 'INSTANCE')
    assert.equal(outerLeft, Math.round(sourceLeft))
    assert.equal(outerLeft + outerNode.width, Math.round(sourceLeft + roots[index].width))
    assert.equal(innerLeft, Math.round(sourceLeft + 0.375))
    assert.equal(innerLeft + inner.width, Math.round(sourceLeft + 0.375 + 24.625))
    assert.equal(innerLeft + text.x + text.width / 2, sourceLeft + 0.375 + label.x + label.width / 2)
    assert.equal(wrapper.y + outerNode.y + inner.y + text.y, 0.125 + 2.375 + 0.375 + label.y)
    assert.equal(text.height, label.height)
  }
  for (const family of ['Outer', 'Inner']) {
    const refs = rendered.instanceRefs.filter(ref => ref.source.startsWith(family.toLowerCase()))
    assert.equal(refs[0].mainId, refs[2].mainId)
    assert.notEqual(refs[0].mainId, refs[1].mainId)
  }
})

test('explicit font modes disallow renderer fallback and include live faces in the merged export', async () => {
  const layer = { id: 'label', name: 'Label', kind: 'text', text: 'Sample', x: 0, y: 0, width: 80, height: 20,
    style: { fontFamily: 'Arimo', fontStyle: 'Regular', fontSize: 16 } }
  const board = { id: 'phone/home', viewport: 'phone', state: 'home', width: 100, height: 40, children: [layer] }
  const data = { ...bundle, fontMode: 'original', boards: [board], tokens: {}, edges: [] }
  const context = canvas(data), rendered = await context.run(raw)
  const origin = { source: context.source.id, frame: context.transfer.id, output: context.output.id,
    section: rendered.sectionId, stamp: signature(JSON.stringify(data)), part: 1, board: board.id }
  const snapshot = await merge(Buffer.from(JSON.stringify(data)), [await readBoard(context.figma, origin)])
  assert.deepEqual(snapshot.observed.fonts, [{ boardId: board.id, id: layer.id, family: 'Arimo', style: 'Regular', missing: false }])
  data.fontMode = 'controlled'
  layer.style.fontFamily = 'Unavailable'
  await assert.rejects(canvas(data).run(raw), /Missing font: Unavailable Regular/)
})

test('unpainted descendants retain the original local precision when their ancestors did not move', () => {
  const leaf = { kind: 'frame', x: 0.1, y: 0.2, width: 1, height: 1 }
  const parent = { kind: 'frame', x: 150.125, y: 700.25, width: 10, height: 10, children: [leaf] }
  const input = { boards: [{ width: 200, height: 800, children: [parent] }] }
  assert.deepEqual(planGeometry(input), input)
})

test('exported readback passes the independent zero-tolerance plan and reports raw geometry differences', async testContext => {
  const context = canvas(), rendered = await context.run(raw)
  const origin = { source: context.source.id, frame: context.transfer.id, output: context.output.id,
    section: rendered.sectionId, stamp: signature(JSON.stringify(bundle)), part: 1 }
  const fixture = fileURLToPath(new URL('../tests/fixtures/field-notes.json', import.meta.url))
  const cli = fileURLToPath(new URL('compact.mjs', import.meta.url))
  const plan = JSON.parse(execFileSync(process.execPath, [cli, fixture, '--plan'], { encoding: 'utf8' }))
  assert.deepEqual(plan, planGeometry(bundle))
  const pngDir = await mkdtemp(join(tmpdir(), 'parity-render-manifest-'))
  testContext.after(() => rm(pngDir, { recursive: true, force: true }))
  const pngs = new Map()
  for (const { viewport, state, width, height } of bundle.boards) {
    const size = `${width}x${height}`
    if (!pngs.has(size)) pngs.set(size, PNG.sync.write(new PNG({ width, height })))
    await writeFile(join(pngDir, `${viewport}--${state}.png`), pngs.get(size))
  }
  const packets = await Promise.all(bundle.boards.map(board => readBoard(context.figma, { ...origin, board: board.id })))
  const snapshot = await merge(Buffer.from(JSON.stringify(bundle)), packets, pngDir)
  const rawAudit = audit(bundle, snapshot, 0), plannedAudit = audit(plan, snapshot, 0)
  assert.equal(rawAudit.passed, false)
  assert.ok(rawAudit.issues.every(row => row.issue === 'geometry-mismatch'))
  assert.equal(new Set(rawAudit.issues.map(row => JSON.stringify([row.boardId, row.id]))).size, 86)
  assert.equal(rawAudit.maxDeviation, 4.96875)
  assert.equal(check(bundle, packets, 0, origin).passed, false)
  assert.equal(plannedAudit.passed, true)
  assert.deepEqual([plannedAudit.maxDeviation, plannedAudit.matchedLayers, plannedAudit.matchedInstances,
    plannedAudit.matchedEdges], [0, 180, 36, 16])
  const text = snapshot.observed.geometry.find(row => row.type === 'TEXT')
  text.x += 1 / 1024
  assert.deepEqual(audit(plan, snapshot, 0).issues, [{ issue: 'geometry-mismatch', boardId: text.boardId,
    id: text.id, field: 'x', expected: text.x - 1 / 1024, actual: text.x }])
})

test('font fallback measures source tracking separately and preserves editable tracking on overflow and replay', async () => {
  const texts = [2, -0.5].map((letterSpacing, index) => ({
    id: `text-${index}`, name: 'Surveys', kind: 'text', text: 'Surveys', x: 0, y: index * 40,
    width: 120, height: 36, style: { fontFamily: 'Arial', fontStyle: 'Bold', fontSize: 32, letterSpacing }
  }))
  const context = canvas({ ...bundle, boards: [{ id: 'phone', width: 375, height: 700, children: texts }], edges: [], tokens: {} })
  const rendered = await context.run(raw)
  assert.deepEqual(rendered.unfittedText.map(row => [row.naturalWidth, row.boxWidth, row.sourceLetterSpacing, row.reason]),
    [[137, 124, 2, 'insufficient-safe-width']])
  const frame = context.nodes.get(rendered.boards.phone).node
  assert.deepEqual(frame.children.map(node => node.letterSpacing.value), [2, -0.5])
  const rerun = await context.run(await stage('fit', { sectionId: rendered.sectionId }))
  assert.deepEqual(rerun.unfittedText, rendered.unfittedText)
})

test('single call and independent staged calls match the public benchmark', async () => {
  const first = canvas(), result = await first.run(raw)
  assert.deepEqual([Object.keys(result.boards).length, result.nodes, result.texts, result.instances, result.edges,
    result.tokens, result.bindings], [10, 180, 66, 36, 16, 6, 130])
  assert.deepEqual(result.warnings.sort(), ['Arial Bold → Arimo Bold', 'Arial Regular → Arimo Regular'])
  const other = canvas(), { sectionId } = await other.run(await stage(1))
  let geometry, tokens, fitting
  for (let number = 2; number <= 8; number++) {
    const actual = await other.run(await stage(number, { sectionId }))
    if (number === 5) fitting = await other.run(await stage('fit', { sectionId }))
    if (number === 7) geometry = actual
    if (number === 8) tokens = actual
  }
  assert.deepEqual({ ...geometry, ...tokens, ...fitting }, result)
  const mastheads = result.masters.filter(master => master.family === 'Masthead')
  assert.equal(mastheads.length, 2)
  assert.equal(new Set(mastheads.map(master => master.setId)).size, 1)
  const title = result.textAdjustments.find(row => row.sourceWidth === 124.53125)
  assert.equal(title.naturalWidth, 125)
  assert.equal(title.boxWidth, 129)
  assert.equal(title.letterSpacing, 0)
  const quarry = result.textAdjustments.find(row => row.id === 'desktop/quarry##detail-quarry>:nth-child(2)/text-1@0')
  assert.equal(quarry.sourceWidth, 354.875)
  assert.equal(quarry.overflow, -3)
  assert.equal(quarry.letterSpacing, 0)
  assert.deepEqual(result.unfittedText, [])
  const count = other.nodes.size
  await assert.rejects(other.run(raw), /existing section/)
  await other.run(await stage('all', { sectionId }))
  assert.equal(other.nodes.size, count)
  assert.equal(other.collections.length, 1)
  assert.deepEqual(other.source.children, [other.transfer])
  const board = other.nodes.get(result.boards['phone/open']).node
  const paper = board.children[0]
  paper.fills = [{ ...paper.fills[0], color: { r: 0, g: 0, b: 0 } }]
  await assert.rejects(other.run(await stage(8, { sectionId })), /fills paint/)
})

test('CLI --stage all renders with page and frame names in another file', async () => {
  const context = canvas()
  context.source.id = '88:11'
  context.output.id = '88:22'
  context.transfer.id = '88:33'
  const cli = fileURLToPath(new URL('compact.mjs', import.meta.url))
  const script = execFileSync(process.execPath, [cli, '--stage', 'all', '--source-name', context.source.name,
    '--frame-name', context.transfer.name, '--output-name', context.output.name], { encoding: 'utf8' })
  const proof = await context.run(script)
  assert.equal(proof.outputPageId, '88:22')
  assert.equal(proof.transferFrameId, '88:33')
  assert.equal(proof.edges, 16)
  const ambiguous = canvas()
  ambiguous.source.children.push({ name: ambiguous.transfer.name, id: '8:9' })
  await assert.rejects(ambiguous.run(script), /found 2/)
  assert.equal(ambiguous.nodes.size, 0)
})

test('Tab and Action share compatible masters and fit restores horizontal geometry on the owning main', async () => {
  const context = canvas(), result = await context.run(raw)
  const masters = new Map(result.masters.map(master => [master.mainId, master]))
  const tabs = new Map(), actions = new Map()
  for (const ref of result.instanceRefs) {
    const master = masters.get(ref.mainId)
    if (!['Tab', 'Action'].includes(master.family)) continue
    const root = context.nodes.get(ref.instanceId).node, text = root.children[0]
    const widths = { Open: 40, Closed: 51, 'View survey': 85, 'Back to surveys': 112 }
    assert.equal(text.width, widths[text.characters])
    const group = master.family === 'Tab' ? tabs : actions
    const label = `${master.variant}/${text.characters}`
    assert.equal(group.get(label) ?? master.mainId, master.mainId)
    group.set(label, master.mainId)
  }
  assert.equal(new Set(tabs.values()).size, 4)
  assert.equal(new Set(actions.values()).size, 2)
  const back = context.nodes.get(actions.get('Default/Back to surveys')).node
  back.children[0].width = 106.6875
  const fitting = await context.run(await stage('fit', { sectionId: result.sectionId }))
  const buttons = fitting.textAdjustments.filter(record => record.sourceWidth === 107.40625)
  assert.equal(buttons.length, 6)
  for (const record of buttons) {
    assert.equal(record.boxWidth, 112)
    assert.equal(record.overflow, -4)
    assert.equal(record.letterSpacing, 0)
  }
})

test('stretch signatures reuse whole-pixel resizes and ignore the unconstrained axis', async () => {
  const data = { ...bundle, edges: [], tokens: {} }
  const sizes = [[100.1, 40.25], [164.1, 41.75], [100.5, 40.25], [100.1, 40.25]]
  data.boards = [{ id: 'sample', width: 700, height: 600, children: sizes.flatMap(([width, height], index) =>
    ['Horizontal', 'Vertical'].map(component => {
      const horizontal = component === 'Horizontal'
      const frame = (id, x, y, width, height) => ({ id, name: id, kind: 'frame', x, y, width, height })
      const root = frame(`${component}${index}`, 0, 0, horizontal ? width : height, horizontal ? height : width)
      const inner = frame(`${root.id}-frame`, 4, 4, horizontal ? width - 8 : 12, horizontal ? 12 : width - 8)
      inner.children = [frame(`${root.id}-leaf`, 1, 1, inner.width - 2, inner.height - 2)]
      return { ...root, component, children: [inner] }
    })) }]
  const proofs = (await canvas(data).run(raw)).instanceRefs
  for (const family of ['Horizontal', 'Vertical']) {
    const ids = proofs.filter(ref => ref.source.startsWith(family)).map(ref => ref.mainId)
    assert.equal(ids[0], ids[1])
    assert.notEqual(ids[0], ids[2])
    assert.equal(ids[0], ids[3])
  }
})

test('wrong page, wrong transfer, wrong section, corrupt chunks and unsupported PNG stop before writes', async () => {
  for (const field of Object.keys(fixtureIds)) {
    const incomplete = { ...fixtureIds }
    delete incomplete[field]
    await assert.rejects(renderStage('all', incomplete), new RegExp(`Missing selector for ${field}`))
  }
  const context = canvas()
  await assert.rejects(context.run(await stage('all', { outputPageId: '99:9' })), /distinct/)
  await assert.rejects(context.run(await stage('all', { transferFrameId: '88:8' })), /transfer frame/)
  context.transfer.parent = context.output
  await assert.rejects(context.run(raw), /transfer frame/)
  context.transfer.parent = context.source
  await assert.rejects(context.run(await stage(2, { sectionId: '99:9' })), /Wrong section/)
  context.pieces.push(context.pieces[0])
  await assert.rejects(context.run(raw), /repeated chunk/)
  context.pieces.pop()
  context.pieces.pop()
  await assert.rejects(context.run(raw), /chunk/)
  assert.equal(context.nodes.size, 0)
  const input = structuredClone(bundle)
  input.boards.at(-1).children[0].kind = 'image'
  const image = canvas(input)
  await assert.rejects(image.run(raw), /PNG\/image unsupported/)
  assert.equal(image.nodes.size, 0)
  assert.equal(image.collections.length, 0)
})
