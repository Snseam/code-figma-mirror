import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import { chunks, compact, stage } from './compact.mjs'
import { transfer } from './transfer.mjs'

const inbox = new URL('../tests/fixtures/field-notes.json', import.meta.url)
const bundle = JSON.parse(await readFile(inbox, 'utf8'))
const small = { version: 1, project: 'test', boards: [], note: '中文 '.repeat(35) }
const options = { stagingPageId: '2:1', chunkSize: 32, batchSize: 2 }

function host() {
  let serial = 0
  let pending = []
  const nodes = new Map()
  function node(type, parent, values) {
    const item = { id: `5:${++serial}`, type, parent, ...values }
    if (type !== 'TEXT') item.children = []
    parent?.children.push(item)
    nodes.set(item.id, item)
    return item
  }
  const page = node('PAGE', null, { id: '2:1', async loadAsync() {} })
  const output = node('PAGE', null, { id: '2:2', async loadAsync() {} })
  const figma = { root: { children: [output, page] }, currentPage: output,
    async setCurrentPageAsync(target) { this.currentPage = target },
    async getNodeByIdAsync(id) { return nodes.get(id) } }
  const $fig = {
    get(id) { return {
      append(plan) { plan.parent = nodes.get(id) },
      set(values) { pending.push({ update: nodes.get(id), values }) }
    } },
    async done() {
      const queue = pending
      pending = []
      for (const plan of queue) {
        if ($fig.failAt === 0) { delete $fig.failAt; throw Error('interrupted flush') }
        if ($fig.failAt > 0) $fig.failAt--
        if (plan.update) Object.assign(plan.update, plan.values)
        else plan.node = node(plan.type, plan.parent, plan.values)
      }
    }
  }
  for (const [method, type] of [['frame', 'FRAME'], ['text', 'TEXT'], ['section', 'SECTION']]) {
    $fig[method] = values => {
      const plan = { type, values, parent: figma.currentPage }
      pending.push(plan)
      return plan
    }
  }
  const context = vm.createContext({ figma, $fig, injected: false })
  return { page, output, node, figma, $fig, context,
    run: code => vm.runInContext(`(async () => {${code}\n})()`, context) }
}

test('real inbox transfers to native TEXT and the existing renderer accepts its receipt', async () => {
  const { scripts, sha256 } = transfer(bundle, { stagingPageId: options.stagingPageId })
  const canvas = host()
  const expected = chunks(bundle)
  assert.equal(sha256, createHash('sha256').update(compact(bundle)).digest('hex'))
  let receipt
  for (const code of scripts) {
    assert.ok(Buffer.byteLength(code) <= 8192)
    assert.doesNotMatch(code, /pluginData/i)
    receipt = await canvas.run(code)
    assert.equal(receipt.complete, receipt.received === expected.length)
    assert.equal(receipt.sha256, sha256)
  }
  assert.equal(receipt.complete, true)
  assert.equal(canvas.page.children.length, 1)
  const [frame] = canvas.page.children
  assert.equal(receipt.transferFrameId, frame.id)
  assert.equal(receipt.sourcePageId, canvas.page.id)
  assert.deepEqual(frame.children.map(child => child.characters), expected)
  assert.ok(frame.children.every(child => child.type === 'TEXT' && child.parent === frame))
  assert.deepEqual(canvas.output.children, [])
  const originalIds = frame.children.map(child => child.id)
  for (const code of scripts.toReversed()) assert.equal((await canvas.run(code)).added, 0)
  assert.deepEqual(frame.children.map(child => child.id), originalIds)
  frame.query = () => frame.children
  const result = await canvas.run(await stage(1, { sourcePageId: receipt.sourcePageId, transferFrameId: receipt.transferFrameId, outputPageId: canvas.output.id }))
  assert.equal(result.chunks, expected.length)
  assert.equal(result.sectionId, canvas.output.children[0].id)
})

test('all bundle fields remain JSON text including source-shaped strings and Unicode', async () => {
  const text = '"}); globalThis.injected=true; // ` ${globalThis.injected=true} \\\n</script>\u2028\u2029😀'
  const data = { ...small, project: text, note: text.repeat(80) }
  const { scripts } = transfer(data, { ...options, chunkSize: 181, batchSize: 99 })
  const canvas = host()
  for (const code of scripts) {
    assert.doesNotMatch(code, /<\/script>|\u2028|\u2029/)
    assert.ok(Buffer.byteLength(code) <= 8192)
    await canvas.run(code)
  }
  assert.equal(canvas.context.injected, false)
  assert.deepEqual(canvas.page.children[0].children.map(child => child.characters), chunks(data, 181))
})

test('requires an explicitly selected empty page; rejects a decoy, a duplicate, or a moved frame', async () => {
  const { scripts } = transfer(small, options)
  assert.throws(() => transfer(small), /staging-page/)
  await assert.rejects(host().run(transfer(small, { stagingPageId: '99:1' }).scripts[0]), /not found/)
  const busy = host()
  busy.node('FRAME', busy.page, { name: 'UI Parity · Transfer' })
  await assert.rejects(busy.run(scripts[0]), /dedicated/i)
  assert.deepEqual(busy.page.children[0].children, [])
  const canvas = host()
  await canvas.run(scripts[0])
  const [original] = canvas.page.children
  const copy = canvas.node('FRAME', canvas.page, { name: original.name })
  await assert.rejects(canvas.run(scripts[1]), /conflict/)
  original.parent = canvas.output
  canvas.output.children.push(original)
  canvas.page.children = [copy]
  await assert.rejects(canvas.run(scripts[1]), /conflict/)
  canvas.page.children = []
  await assert.rejects(canvas.run(scripts[1]), /First batch/)
  assert.equal(original.children.length, 2)
  assert.equal(copy.children.length, 0)
})

test('checks actual text, signed names and continuity of all preceding chunks before appending', async () => {
  const { scripts } = transfer(small, options)
  for (const edit of [
    (canvas, frame) => { frame.children[0].characters += '!' },
    (canvas, frame) => { frame.children[0].name = 'Chunk 0000 deadbeef' },
    (canvas, frame) => { frame.children.pop() },
    (canvas, frame) => { frame.children.push(frame.children[0]) },
    (canvas, frame) => { canvas.node('FRAME', frame, {}) }
  ]) {
    const canvas = host()
    await canvas.run(scripts[0])
    const [frame] = canvas.page.children
    edit(canvas, frame)
    const ids = frame.children.map(child => child.id)
    await assert.rejects(canvas.run(scripts[1]), /chunk|child/i)
    assert.deepEqual(frame.children.map(child => child.id), ids)
  }
  const canvas = host()
  await assert.rejects(canvas.run(scripts[1]), /First batch/)
  await canvas.run(scripts[0])
  await assert.rejects(canvas.run(scripts[2]), /earlier batch/)
  await assert.rejects(canvas.run(transfer({ ...small, project: 'different' }, options).scripts[0]), /conflict/)
  await canvas.run(scripts[1])
  canvas.page.children[0].children.at(-1).characters += 'later edit'
  await assert.rejects(canvas.run(scripts[0]), /signature conflict/)
})

test('resumes an interruption between frame creation and assigning its self-identifying name', async () => {
  const canvas = host()
  canvas.$fig.failAt = 1
  const [code] = transfer(small, options).scripts
  await assert.rejects(canvas.run(code), /interrupted/)
  const [frame] = canvas.page.children
  const receipt = await canvas.run(code)
  assert.equal(receipt.transferFrameId, frame.id)
  assert.equal(frame.name, `UI Parity · Transfer / ${canvas.page.id} / ${receipt.sha256} / 32×${receipt.total} / ${frame.id}`)
  assert.equal((await canvas.run(code)).added, 0)
})

test('replays a partially flushed batch and revalidates it on a lost response', async () => {
  const { scripts } = transfer(small, options)
  const canvas = host()
  const { transferFrameId } = await canvas.run(scripts[0])
  canvas.$fig.failAt = 1
  await assert.rejects(canvas.run(scripts[1]), /interrupted/)
  const [frame] = canvas.page.children
  const ids = frame.children.map(child => child.id)
  const receipt = await canvas.run(scripts[1])
  assert.equal(receipt.added, 1)
  assert.equal(receipt.transferFrameId, transferFrameId)
  assert.deepEqual(frame.children.slice(0, ids.length).map(child => child.id), ids)
  assert.equal((await canvas.run(scripts[1])).added, 0)
})

test('CLI prints a plan or a single runnable batch and rejects invalid selectors', async () => {
  const cli = fileURLToPath(new URL('transfer.mjs', import.meta.url))
  const run = (...args) => spawnSync(process.execPath, [cli, fileURLToPath(inbox), ...args], { encoding: 'utf8' })
  const args = ['--staging-page', options.stagingPageId]
  const plan = JSON.parse(run(...args).stdout)
  assert.ok(plan.batches > 1 && plan.chunks === chunks(bundle).length)
  assert.equal(plan.scripts, undefined)
  const first = run(...args, '--batch', '1')
  assert.equal(first.status, 0)
  assert.equal((await host().run(first.stdout)).complete, false)
  for (const values of [[], ['--staging-page', 'current'], [...args, '--batch', '0'], [...args, '--batch', '99'], [...args, '--batch-size', '-1']]) {
    const result = run(...values)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
  }
})
