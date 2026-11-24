import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const template = await readFile(new URL('renderer.js', import.meta.url), 'utf8')
const planner = template.match(/^function planGeometry\([^\n]*\n[\s\S]*?^}/m)
if (!planner) throw Error('Renderer is missing its standalone geometry planner')
export const { planGeometry } = await import(`data:text/javascript,${encodeURIComponent(`export ${planner[0]}`)}`)

export function compact(bundle) {
  return JSON.stringify(bundle)
}

export function chunks(bundle, size = 420) {
  if (!Number.isSafeInteger(size) || size < 1) throw Error('Chunk size must be a positive integer')
  const points = Array.from(compact(bundle)), result = []
  for (let start = 0; start < points.length; start += size) {
    if (result.length === 10000) throw Error('Four-digit chunk index exhausted')
    result.push(`PARITYDATA|${String(result.length).padStart(4, '0')}|${points.slice(start, start + size).join('')}`)
  }
  return result
}

const stages = [
  ['validate', 'prepare'],
  ['tokens'],
  ['layoutIndex', 'geometry', 'textProps', 'boardPairs', 'structure'],
  ['geometry', 'boardPairs', 'walk', 'resolveFont', 'painter', 'paintMasters'],
  ['geometry', 'textProps', 'boardPairs', 'walk', 'resolveFont', 'painter', 'paintBoards'],
  ['boardPairs', 'walk', 'connect'],
  ['boardPairs', 'walk', 'resolveFont', 'matchesTracking', 'verify'],
  ['boardPairs', 'walk', 'tokenIndex', 'verifyTokens']
]

export async function stage(number, options = {}) {
  if (typeof number === 'string' && /^\d+$/.test(number)) number = Number(number)
  const names = number === 'fit' ? ['walk', 'boardPairs', 'matchesTracking', 'fitText'] : stages[number - 1]
  if (!names && number !== 'all') throw Error(`Stage must be all or 1–${stages.length}`)
  const defaults = { sourcePageId: '', transferFrameId: '', outputPageId: '', sectionId: '' }
  const lookup = { sourcePageName: 'sourcePageId', transferFrameName: 'transferFrameId', outputPageName: 'outputPageId' }
  const ids = { ...defaults }, requests = {}
  for (const [field, value] of Object.entries(options)) {
    if (Object.hasOwn(lookup, field)) {
      if (!value || options[lookup[field]]) throw Error(`Provide one selector for ${lookup[field]}`)
      requests[lookup[field]] = String(value)
      ids[lookup[field]] = ''
    } else if (Object.hasOwn(defaults, field) && /^\d+:\d+$/.test(value)) ids[field] = value
    else throw Error(`Invalid ${field}`)
  }
  for (const field of Object.values(lookup)) {
    if (!ids[field] && !requests[field]) throw Error(`Missing selector for ${field}`)
  }
  if (ids.sourcePageId && ids.sourcePageId === ids.outputPageId) throw Error('The output page must be independent')
  if ((number > 1 || number === 'fit') && !ids.sectionId) throw Error('Supply the sectionId returned by stage 1')
  const setup = [`const ids = ${JSON.stringify(ids)}`]
  if (Object.keys(requests).length) {
    setup.push(`const uniqueId = (nodes, name) => {
      const hits = nodes.filter(node => node.name === name)
      if (hits.length !== 1) throw Error('Expected one target named ' + name + ', found ' + hits.length)
      return hits[0].id
    }`)
    for (const field of ['sourcePageId', 'outputPageId']) if (requests[field])
      setup.push(`ids.${field} = uniqueId(figma.root.children, ${JSON.stringify(requests[field])})`)
    if (requests.transferFrameId) setup.push(`const namedSource = figma.root.children.find(node => node.id === ids.sourcePageId)
      if (!namedSource) throw Error('Missing source page')
      await namedSource.loadAsync()
      ids.transferFrameId = uniqueId(namedSource.query('FRAME').toArray(), ${JSON.stringify(requests.transferFrameId)})`)
  }
  const source = template.replace(/^const ids = .*$/m, () => setup.join('\n'))
  const [definitions] = source.split('\nawait prepare()')
  const [header, ...functions] = definitions.split(/(?=^(?:async )?function \w+\()/m)
  const planned = [3, 4, 5, 'fit', 7].includes(number)
  const dependencies = new Set([...(planned ? ['planGeometry', 'useDrawingPlan'] : []), ...(names || [])])
  const selected = functions.filter(body => dependencies.has(body.match(/function (\w+)/)[1]))
  const call = number === 'fit' ? 'return { ...report, sectionId: section.id, ...await fitText() }' :
    ['await prepare()', 'await tokens()', 'await structure()', 'await paintMasters()', 'await paintBoards()',
      'await connect()', 'return await verify()', 'return await verifyTokens()'][number - 1]
  const result = number >= 7 || number === 'fit' ? '' : `\nreturn { ...report, sectionId: section.id, stage: ${number} }`
  const body = number === 'all' ? source : [header, ...selected, planned ? 'useDrawingPlan()' : '', call + result].join('\n')
  const require = createRequire(import.meta.url)
  let compiler
  try { compiler = require.resolve('esbuild', { paths: [new URL('../integrations/', import.meta.url).pathname, import.meta.dirname] }) }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
  if (!compiler) return body
  const { code } = await require(compiler).transform(`async function renderStage() {${body}\n}`, {
    target: 'es2020', minify: true, treeShaking: false, charset: 'utf8'
  })
  return code.slice(code.indexOf('{') + 1, code.lastIndexOf('}'))
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , path, flag, size] = process.argv
  if (path === '--stage' || path === '--render') {
    const values = process.argv.slice(path === '--stage' ? 4 : 3)
    const fields = { '--source': 'sourcePageId', '--frame': 'transferFrameId', '--output': 'outputPageId', '--section': 'sectionId',
      '--source-name': 'sourcePageName', '--frame-name': 'transferFrameName', '--output-name': 'outputPageName' }
    const options = {}
    for (let index = 0; index < values.length; index += 2) {
      const field = fields[values[index]]
      if (!field || !values[index + 1]) throw Error(`Invalid option ${values[index]}`)
      options[field] = values[index + 1]
    }
    const number = path === '--render' || flag === 'all' ? 'all' : flag === 'fit' ? flag : Number(flag)
    process.stdout.write(await stage(number, options))
  } else {
    if (!path || (flag && !['--chunks', '--plan'].includes(flag))) throw Error('compact.mjs BUNDLE [--chunks [SIZE] | --plan] | --stage NUMBER')
    const bundle = JSON.parse(await readFile(path, 'utf8'))
    process.stdout.write(flag === '--chunks' ? chunks(bundle, size == null ? 420 : Number(size)).join('\n') :
      compact(flag === '--plan' ? planGeometry(bundle) : bundle))
  }
}
