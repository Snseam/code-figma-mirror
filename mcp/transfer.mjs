import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { chunks } from './compact.mjs'

function fingerprint(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619)
  return (hash >>> 0).toString(16).padStart(8, '0')
}

async function writeBatch(figma, $fig, request, fingerprint) {
  const { stagingPageId, sha256, chunkSize, total, start, parts, root } = request
  const page = figma.root.children.find(node => node.type === 'PAGE' && node.id === stagingPageId)
  if (!page) throw Error('Staging page ID not found')
  await page.loadAsync()
  if (figma.currentPage.id !== page.id) await figma.setCurrentPageAsync(page)
  if (figma.currentPage.id !== page.id) throw Error('Staging page switch failed')

  const title = `UI Parity · Transfer / ${page.id} / ${sha256} / ${chunkSize}×${total}`
  let frame = page.children[0]
  if (!frame) {
    if (start !== 0) throw Error('First batch requires an empty dedicated staging page')
    const created = $fig.frame({ name: title, x: 0, y: 0,
      width: 640 * Math.ceil(total / 100), height: 18 * Math.min(total, 100), clipsContent: true })
    await $fig.done()
    frame = created.node
    if (!frame || figma.currentPage.id !== page.id || page.children.length !== 1 ||
        page.children[0].id !== frame.id || frame.parent.id !== page.id)
      throw Error('Staging frame creation conflict')
  }
  if (start === 0 && page.children.length === 1 && frame.type === 'FRAME' && frame.parent.id === page.id &&
      frame.name === title && frame.children.length === 0) {
    $fig.get(frame.id).set({ name: `${title} / ${frame.id}` })
    await $fig.done()
  }
  function inspect() {
    if (figma.currentPage.id !== page.id || page.children.length !== 1 || !frame || frame.removed ||
        page.children[0].id !== frame.id || frame.type !== 'FRAME' || frame.parent.id !== page.id ||
        frame.name !== `${title} / ${frame.id}`) throw Error('Dedicated staging page, frame or bundle conflict')
    const found = new Map()
    for (const child of frame.children) {
      const match = child.type === 'TEXT' && /^PARITYDATA\|([0-9]{4})\|/.exec(child.characters)
      if (!match || child.parent.id !== frame.id) throw Error('Unexpected staging child')
      const index = Number(match[1])
      if (index >= total || found.has(index)) throw Error('Unexpected or duplicate chunk ' + index)
      found.set(index, child)
    }
    let expected = root
    for (let index = 0; index < found.size; index++) {
      const child = found.get(index)
      if (!child) throw Error('Missing chunk ' + index)
      const name = /^Chunk ([0-9]{4}) ([0-9a-f]{8})$/.exec(child.name)
      if (!name || Number(name[1]) !== index || fingerprint(child.characters + '|' + name[2]) !== expected)
        throw Error('Chunk signature conflict at ' + index)
      const part = parts[index - start]
      if (part && (child.characters !== part[0] || name[2] !== part[1])) throw Error('Chunk content conflict at ' + index)
      expected = name[2]
    }
    if (found.size < start) throw Error('Missing earlier batch chunk ' + found.size)
    return found.size
  }
  const before = inspect()
  const end = start + parts.length
  const parent = $fig.get(frame.id)
  for (let index = before; index < end; index++) {
    const [characters, next] = parts[index - start]
    parent.append($fig.text({ name: 'Chunk ' + characters.slice(11, 15) + ' ' + next, characters,
      x: Math.floor(index / 100) * 640, y: index % 100 * 18, width: 600, height: 18, textAutoResize: 'NONE' }))
  }
  if (before < end) await $fig.done()
  const received = inspect()
  if (received < end) throw Error('Chunk missing after flush')
  return { sourcePageId: page.id, transferFrameId: frame.id, sha256, added: Math.max(0, end - before), received, total, complete: received === total }
}

function jsonLiteral(value) {
  return JSON.stringify(value).replace(/[<\u2028\u2029]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
}

function script(request) {
  return `return await (${writeBatch.toString()})(figma, $fig, ${jsonLiteral(request)}, ${fingerprint.toString()})`
}

export function transfer(bundle, { stagingPageId, chunkSize = 420, batchSize = 8 } = {}) {
  if (typeof stagingPageId !== 'string' || !/^\d+:\d+$/.test(stagingPageId)) throw Error('Specify --staging-page with the dedicated page ID')
  if (bundle?.version !== 1 || typeof bundle.project !== 'string' || !Array.isArray(bundle.boards)) throw Error('Expected a v1 capture bundle')
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw Error('Batch size must be a positive integer')
  const pieces = chunks(bundle, chunkSize)
  const hash = createHash('sha256')
  for (const piece of pieces) hash.update(piece.slice(16))
  const sha256 = hash.digest('hex')
  const total = pieces.length
  const links = Array(total + 1)
  links[total] = '00000000'
  for (let index = total - 1; index >= 0; index--) links[index] = fingerprint(pieces[index] + '|' + links[index + 1])
  const scripts = []
  for (let start = 0; start < total;) {
    const request = { stagingPageId, sha256, chunkSize, total, start, root: links[0], parts: [] }
    let bytes = Buffer.byteLength(script(request))
    for (let index = start; index < total && request.parts.length < batchSize; index++) {
      const piece = [pieces[index], links[index + 1]]
      bytes += Buffer.byteLength(jsonLiteral(piece)) + (request.parts.length ? 1 : 0)
      if (bytes > 8192) break
      request.parts.push(piece)
    }
    if (!request.parts.length) throw Error('One chunk exceeds the 8192-byte script budget; reduce --chunk-size')
    scripts.push(script(request))
    start += request.parts.length
  }
  return { stagingPageId, sha256, chunks: total, batches: scripts.length, scripts }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [file, ...args] = process.argv.slice(2)
    const options = new Map()
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index]
      if (!['--staging-page', '--batch', '--batch-size', '--chunk-size'].includes(flag) || !args[index + 1] || options.has(flag))
        throw Error('Invalid or repeated option ' + flag)
      options.set(flag, args[index + 1])
    }
    if (!file) throw Error('Usage: node mcp/transfer.mjs BUNDLE --staging-page ID [--batch NUMBER]')
    const bundle = JSON.parse(await readFile(file, 'utf8'))
    const { scripts, ...plan } = transfer(bundle, { stagingPageId: options.get('--staging-page'),
      chunkSize: Number(options.get('--chunk-size') ?? 420), batchSize: Number(options.get('--batch-size') ?? 8) })
    if (options.has('--batch')) {
      const index = Number(options.get('--batch')) - 1
      if (!Number.isSafeInteger(index) || index < 0 || index >= scripts.length) throw Error(`Select batch 1–${scripts.length}`)
      process.stdout.write(scripts[index])
    } else console.log(JSON.stringify(plan))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
