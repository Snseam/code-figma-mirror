import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PNG } from 'pngjs';
import plugin from '../plugin/code.js';
import { packet, readBoard, readSection, readTokens, signature } from './cloud-reader.mjs';

const canvasFields = ['source', 'frame', 'output', 'section'];
const idsUsage = canvasFields.map(key => `--${key} ID`).join(' ');
const usage = `node tools/cloud-export.mjs requests BUNDLE JS_DIR ${idsUsage}
node tools/cloud-export.mjs request BUNDLE BOARD ${idsUsage} [--part 2]
node tools/cloud-export.mjs tokens BUNDLE ${idsUsage} [--part 2]
node tools/cloud-export.mjs decode BUNDLE REPLIES_DIR
node tools/cloud-export.mjs check BUNDLE REPLIES_DIR ${idsUsage} [--geometry-tolerance 1]
node tools/cloud-export.mjs merge BUNDLE REPLIES_DIR [--png-dir ACTUAL_PNG_DIR] [--out design-diff.json]
node cli.mjs audit BUNDLE design-diff.json audit.json`;

const assert = (condition, message) => { if (!condition) throw Error(message); };
const isId = value => typeof value === 'string' && value.length > 0;
const isPageId = value => typeof value === 'string' && /^\d+:\d+$/.test(value);

function validateCanvas(options) {
  assert(canvasFields.every(key => isPageId(options?.[key])) && options.source !== options.output,
    `Supply explicit canvas IDs: ${idsUsage} (source and output must be distinct)`);
}

function makeRequest(reader, bundle, options, args) {
  validateCanvas(options);
  const { source, frame, output, section, part = 1 } = options;
  assert(Number.isSafeInteger(part) && part >= 1, 'part must be a positive integer');
  const request = { source, frame, output, section, part, stamp: signature(JSON.stringify(bundle)), ...args };
  return `${signature}\n${readSection}\n${packet}\n${reader}\nreturn await ${reader.name}(figma, ${JSON.stringify(request)});\n`;
}

export function requestCode(bundle, board, options) {
  assert(bundle.boards.some(spec => spec.id === board), `Unknown board ${board}`);
  return makeRequest(readBoard, bundle, options, { board });
}

export function tokenRequestCode(bundle, options) {
  return makeRequest(readTokens, bundle, options);
}

function unwrap(value) {
  if (typeof value === 'string') return unwrap(JSON.parse(value));
  if (value?.format === 'ui-parity-board/1' || value?.format === 'ui-parity-tokens/1') return value;
  if (value && Object.hasOwn(value, 'result')) return unwrap(value.result);
  const content = Array.isArray(value) ? value : value?.content;
  if (content?.length === 1 && content[0].type === 'text') return unwrap(content[0].text);
  throw Error('Expected a JSON board or token packet returned by use_figma');
}

function unpack(packets) {
  const groups = new Map();
  for (const input of packets) {
    const { format, board, part, parts, data, seal } = unwrap(input);
    const tokenPacket = format === 'ui-parity-tokens/1', key = tokenPacket ? null : board;
    const label = tokenPacket ? 'token snapshot' : board;
    assert((tokenPacket ? board === undefined : isId(board)) && Number.isSafeInteger(parts) && Number.isSafeInteger(part) &&
      part >= 1 && part <= parts && typeof data === 'string' && isId(seal), 'Malformed export packet');
    if (!groups.has(key)) groups.set(key, { parts, seal, label, pieces: new Map() });
    const group = groups.get(key);
    assert(group.parts === parts && group.seal === seal, `Mixed reads of ${label}`);
    assert(!group.pieces.has(part), `Duplicate ${label} part ${part}`);
    group.pieces.set(part, data);
  }
  const boards = [];
  let tokens;
  for (const [key, group] of groups) {
    assert(group.pieces.size === group.parts, `Incomplete ${group.label} (${group.pieces.size}/${group.parts} parts)`);
    const text = Array.from({ length: group.parts }, (_, index) => group.pieces.get(index + 1)).join('');
    assert(signature(text) === group.seal, `Corrupt packet ${group.label}`);
    const body = JSON.parse(text);
    if (key === null) {
      assert(body && typeof body === 'object' && !Array.isArray(body), 'Malformed token snapshot');
      tokens = body;
    }
    else {
      assert(body.board === key, `Mislabeled board packet ${key}`);
      boards.push(body);
    }
  }
  return { boards, tokens };
}

function sourceTree(board) {
  const entries = [];
  function visit(spec, parent, index) {
    entries.push({ spec, parent, index });
    (spec.children || []).forEach((child, offset) => visit(child, spec, offset));
  }
  visit(board, null, 0);
  return entries;
}

function decodeBoard(bundle, packet, expectedEdges) {
  const { board: boardId, rows, frames } = packet;
  const boardIndex = bundle.boards.findIndex(board => board.id === boardId);
  assert(boardIndex >= 0, `Unknown board ${boardId}`);
  const board = bundle.boards[boardIndex], tree = sourceTree(board);
  assert(Array.isArray(rows) && rows.length === tree.length && rows[0]?.[0] === frames[boardIndex], `Wrong row count or root for ${boardId}`);
  const nodeIds = new Map(rows.map(([native], slot) => [native, tree[slot].spec.id]));
  assert(nodeIds.size === rows.length, `Duplicate native ID in ${boardId}`);
  const destinations = new Map(frames.map((native, index) => [native, bundle.boards[index].id]));
  const observed = { geometry: [], instances: [], edges: [], reactions: [] };
  const warnings = [], baseline = [], measured = [];
  for (const [slot, row] of rows.entries()) {
    const [figmaId, parentNative, index, type, x, y, width, height, detail, fontSize] = row;
    const { spec, parent, index: oldIndex } = tree[slot];
    assert(isId(figmaId) && isId(type) && Number.isSafeInteger(index) && index >= 0 &&
      [x, y, width, height].every(Number.isFinite) &&
      (parent ? nodeIds.has(parentNative) : parentNative === packet.section), `Invalid native evidence for ${spec.id}`);
    const ref = { boardId, id: spec.id, figmaId, scope: parent ? 'node' : 'board' };
    const geometry = { boardId, id: spec.id, figmaId, x, y, width, height, type };
    const before = { width: spec.width, height: spec.height }, after = { width, height };
    if (parent) {
      geometry.parentId = nodeIds.get(parentNative);
      const parentRef = id => ({ scope: id === boardId ? 'board' : 'node', boardId, id });
      Object.assign(before, { x: spec.x, y: spec.y, parent: parentRef(parent.id), index: oldIndex });
      Object.assign(after, { x, y, parent: parentRef(geometry.parentId), index });
    }
    if (spec.kind !== 'svg') {
      before.type = spec.component || spec.figmaKey ? 'INSTANCE' : spec.kind === 'text' ? 'TEXT' : 'FRAME';
      after.type = type;
    }
    if (spec.kind === 'text') before.text = spec.text;
    if (type === 'TEXT') {
      assert(typeof detail === 'string' && (Number.isFinite(fontSize) || fontSize === 'MIXED'), `Unreadable text for ${spec.id}`);
      geometry.text = detail;
      after.text = detail;
      if (spec.style?.fontSize != null) { before.fontSize = spec.style.fontSize; after.fontSize = fontSize; }
    } else if (spec.style?.radius != null && detail !== undefined) {
      before.radius = spec.style.radius;
      after.radius = detail;
    }
    observed.geometry.push(geometry);
    baseline.push({ ...ref, value: before });
    measured.push({ ...ref, value: after });
  }
  const instanceSlots = new Set();
  for (const [slot, mainId, setId, family, variant, layout] of packet.instances) {
    const geometry = observed.geometry[slot];
    assert(Number.isInteger(slot) && geometry?.type === 'INSTANCE' && !instanceSlots.has(slot) &&
      (mainId === null || isId(mainId)), `Invalid instance in ${boardId}`);
    instanceSlots.add(slot);
    const record = { boardId, id: geometry.id, mainId };
    if (setId !== undefined) {
      assert(isId(mainId) && isId(setId) && isId(family) && [variant, layout].every(axis => axis === null || isId(axis)), 'Invalid component set evidence');
      Object.assign(record, { setId, family, variant, layout });
    }
    const { spec } = tree[slot];
    if (spec.component && setId) {
      Object.assign(baseline[slot].value, { component: spec.component, variant: spec.variant || 'Default' });
      Object.assign(measured[slot].value, { component: family, variant });
    }
    if (!mainId) warnings.push(`Unresolved main component: ${boardId} / ${geometry.id}`);
    observed.instances.push(record);
  }
  assert(instanceSlots.size === observed.geometry.filter(row => row.type === 'INSTANCE').length, `Missing instance evidence in ${boardId}`);
  const expectedById = new Map(expectedEdges.filter(edge => edge.from === boardId).map(edge => [edge.source, edge]));
  const actionFor = edge => edge.action === 'BACK' ? { type: 'BACK' } : { type: 'NODE', navigation: edge.action, destinationId: edge.to };
  for (const [slot, trigger, actions] of packet.reactions) {
    const source = observed.geometry[slot]?.id;
    assert(Number.isInteger(slot) && source && Array.isArray(actions), `Invalid reaction in ${boardId}`);
    observed.reactions.push({ from: boardId, source, trigger, actions });
    const comparable = [];
    for (const action of actions) {
      if (trigger?.type === 'ON_CLICK' && (action.type === 'BACK' ||
          (action.type === 'NODE' && ['NAVIGATE', 'OVERLAY'].includes(action.navigation)))) {
        const edge = { from: boardId, source, action: action.type === 'BACK' ? 'BACK' : action.navigation,
          to: action.type === 'BACK' ? null : destinations.get(action.destinationId) ?? null };
        observed.edges.push(edge);
        comparable.push(actionFor(edge));
      } else comparable.push(action);
    }
    (measured[slot].value.reactions ??= []).push({ trigger, actions: comparable });
  }
  for (const row of baseline) {
    const edge = expectedById.get(row.id);
    if (edge) row.value.reactions = [{ trigger: { type: 'ON_CLICK' }, actions: [actionFor(edge)] }];
  }
  return { board: { id: boardId, viewport: board.viewport, state: board.state, figmaId: frames[boardIndex],
    file: null, status: 'measured', width: rows[0][6], height: rows[0][7] },
    changes: plugin.diffRows(baseline, measured), observed, warnings };
}

function decodeTokens(bundle, body, context) {
  assert([...canvasFields, 'stamp', 'fileKey'].every(key => body[key] === context[key]), 'Token snapshot belongs to a different canvas or bundle');
  const collectionName = `UI parity v2 / ${bundle.project} [${context.frame} ${context.stamp}] / ${context.section}`;
  assert(body.collectionName === collectionName && isId(body.collectionId) && isId(body.modeId) && Array.isArray(body.rows),
    'Invalid section token collection or mode');
  const names = new Map(), nativeIds = new Set();
  const measured = body.rows.map(row => {
    assert(Array.isArray(row) && row.length === 3, 'Malformed color variable row');
    const [figmaId, id, color] = row;
    assert(isId(figmaId) && isId(id) && typeof color === 'string' && /^#[\da-f]{6}([\da-f]{2})?$/i.test(color),
      'Invalid color variable evidence');
    assert(!nativeIds.has(figmaId) && !names.has(id), `Duplicate color variable: ${id}`);
    nativeIds.add(figmaId);
    names.set(id, figmaId);
    return { scope: 'token', boardId: null, id, figmaId, value: { color: color.toUpperCase() } };
  });
  const baseline = Object.entries(bundle.tokens).map(([id, literal]) => {
    let color = literal.toUpperCase();
    if (color.length < 6) color = '#' + [...color.slice(1)].map(channel => channel + channel).join('');
    if (color.length === 9 && color.endsWith('FF')) color = color.slice(0, 7);
    return { scope: 'token', boardId: null, id, figmaId: names.get(id) ?? null, value: { color } };
  });
  return { coverage: { status: 'observed', collectionId: body.collectionId, collectionName, modeId: body.modeId, count: measured.length },
    tokens: Object.fromEntries(measured.map(row => [row.id, row.value.color])), changes: plugin.diffRows(baseline, measured) };
}

export function decode(bundle, packets, complete = true) {
  const expectedEdges = plugin.validate(bundle);
  const stamp = signature(JSON.stringify(bundle)), { boards: bodies, tokens } = unpack(packets);
  assert(bodies.length > 0, 'No board packets');
  let context;
  const boards = new Map(), nativeIds = new Set();
  for (const body of bodies) {
    const { fileKey, source, frame, output, section, frames } = body;
    assert(stamp === body.stamp && [source, frame, output, section].every(isPageId) && source !== output, 'Wrong bundle or canvas identifiers');
    assert(Array.isArray(frames) && frames.length === bundle.boards.length && frames.every(isId) &&
      new Set(frames).size === frames.length, 'Invalid board frame index');
    const origin = { fileKey, source, frame, output, section, frames, stamp };
    assert(!context || JSON.stringify(context) === JSON.stringify(origin), 'Mixed output sections, files or board frames');
    context = origin;
    const result = decodeBoard(bundle, body, expectedEdges);
    for (const row of result.observed.geometry) {
      assert(!nativeIds.has(row.figmaId), `Repeated native layer ${row.figmaId}`);
      nativeIds.add(row.figmaId);
    }
    boards.set(body.board, result);
  }
  const missing = bundle.boards.filter(spec => !boards.has(spec.id)).map(spec => spec.id);
  assert(!complete || !missing.length, `Missing board packets: ${missing.join(', ')}`);
  const tokenSnapshot = tokens === undefined ? { coverage: { status: 'unobserved' }, changes: [] } : decodeTokens(bundle, tokens, context);
  return { context, missing, boards: bundle.boards.map(spec => boards.get(spec.id)).filter(Boolean), tokenSnapshot };
}

export function check(bundle, packets, tolerance = 1, expectedCanvas) {
  validateCanvas(expectedCanvas);
  assert(Number.isFinite(tolerance) && tolerance >= 0, 'Expected a non-negative geometry tolerance');
  const { boards, context, tokenSnapshot } = decode(bundle, packets);
  assert(canvasFields.every(key => context[key] === expectedCanvas[key]), 'Packets do not match the requested canvas IDs');
  const issues = [], sets = new Map(), mainByVariant = new Map(), variantByMain = new Map(), familyBySet = new Map();
  for (const { id, op, before, after } of tokenSnapshot.changes) issues.push({ issue: 'token-change', id, op, before, after });
  const geometryFields = new Set(['x', 'y', 'width', 'height']);
  for (const item of boards) {
    for (const { boardId, id, before, after } of item.changes) {
      for (const field of Object.keys(after)) {
        if (geometryFields.has(field) && Math.abs(before[field] - after[field]) <= tolerance) continue;
        issues.push({ boardId, id, field, expected: before[field], actual: after[field] });
      }
    }
    const source = bundle.boards.find(board => board.id === item.board.id);
    const specs = new Map(sourceTree(source).map(({ spec }) => [spec.id, spec]));
    for (const instance of item.observed.instances) {
      const { boardId, id, setId, mainId, variant, layout } = instance, spec = specs.get(id);
      const family = spec.component ?? spec.figmaKey;
      const identity = JSON.stringify([family, spec.variant || 'Default', layout ?? null]);
      function track(map, key, value, field) {
        if (!map.has(key)) map.set(key, value);
        if (map.get(key) !== value) issues.push({ boardId, id, field, expected: map.get(key), actual: value });
      }
      if (!mainId) { issues.push({ boardId, id, issue: 'unresolved-main' }); continue; }
      if (setId) {
        if (!variant || !layout) issues.push({ boardId, id, issue: 'missing-renderer-variant-axes' });
        track(familyBySet, setId, family, 'setFamily');
      }
      track(sets, family, setId ?? null, 'setId');
      track(mainByVariant, identity, mainId, 'mainId');
      track(variantByMain, mainId, identity, 'mainVariant');
    }
  }
  const count = key => boards.reduce((total, item) => total + item.observed[key].length, 0);
  return { passed: issues.length === 0, tolerance, boards: boards.length, geometry: count('geometry'),
    instances: count('instances'), edges: count('edges'), tokenCoverage: tokenSnapshot.coverage, issues };
}

async function attachPng(board, pluginFile, pngDir, entries, used) {
  const names = [...new Set([pluginFile, `${board.viewport}--${board.state}.png`])].filter(name => entries.has(name));
  assert(names.length === 1 && !used.has(names[0]), `Expected one distinct actual PNG for ${board.id}: ${pluginFile} or ${board.viewport}--${board.state}.png`);
  const [file] = names;
  const { width, height } = PNG.sync.read(await readFile(path.join(pngDir, file)));
  assert(width === Math.ceil(board.width) && height === Math.ceil(board.height), `1× PNG bounds mismatch for ${board.id}: ${width}×${height} vs ${board.width}×${board.height}`);
  used.add(file);
  return { ...board, file, status: 'exported', width, height };
}

export async function merge(bytes, packets, pngDir) {
  const bundle = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  const { context, boards, tokenSnapshot } = decode(bundle, packets);
  const { frames, ...cloud } = context;
  cloud.tokenCoverage = tokenSnapshot.coverage;
  const manifest = [], used = new Set(), filenames = plugin.boardFiles(bundle.boards);
  const entries = pngDir && new Set(await readdir(pngDir));
  for (const [index, item] of boards.entries()) {
    manifest.push(pngDir ? await attachPng(item.board, filenames[index], pngDir, entries, used) : item.board);
  }
  return { version: 1, project: bundle.project, revision: null, sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    pageId: context.output, cloud, boards: manifest, ...(tokenSnapshot.tokens ? { tokens: tokenSnapshot.tokens } : {}),
    changes: [...boards.flatMap(item => item.changes), ...tokenSnapshot.changes],
    observed: Object.fromEntries(['geometry', 'instances', 'edges', 'reactions'].map(key =>
      [key, boards.flatMap(item => item.observed[key])])),
    warnings: [...bundle.warnings, ...boards.flatMap(item => item.warnings),
      ...(tokenSnapshot.tokens ? [] : ['Color tokens were not observed. Collect the optional tokens request before reviewing token changes.'])] };
}

async function main(args) {
  const [command, ...rest] = args;
  if (!command || command === '--help') return console.log(usage);
  const generating = ['requests', 'request', 'tokens'].includes(command);
  const flags = generating ? [...canvasFields, ...(command === 'requests' ? [] : ['part'])] :
    command === 'merge' ? ['png-dir', 'out'] : command === 'check' ? [...canvasFields, 'geometry-tolerance'] : [];
  const { positionals, values } = parseArgs({ args: rest, allowPositionals: true,
    options: Object.fromEntries(flags.map(flag => [flag, { type: 'string' }])) });
  assert((generating || ['decode', 'merge', 'check'].includes(command)) && positionals.length === (command === 'tokens' ? 1 : 2), usage);
  if (generating || command === 'check') validateCanvas(values);
  const [filename, target] = positionals;
  const bytes = await readFile(filename);
  const bundle = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (generating) {
    plugin.validate(bundle);
    const options = { ...values, part: Number(values.part ?? 1) };
    if (command === 'request') return process.stdout.write(requestCode(bundle, target, options));
    if (command === 'tokens') return process.stdout.write(tokenRequestCode(bundle, options));
    const scripts = bundle.boards.map(board => requestCode(bundle, board.id, values));
    await mkdir(target, { recursive: true });
    for (const [index, code] of scripts.entries()) {
      const file = path.join(target, `${String(index + 1).padStart(3, '0')}.js`);
      await writeFile(file, code);
      console.log(`${file}\t${bundle.boards[index].id}`);
    }
    return;
  }
  const files = (await readdir(target)).filter(name => name.endsWith('.json')).sort();
  const packets = await Promise.all(files.map(async name => JSON.parse(await readFile(path.join(target, name), 'utf8'))));
  if (command === 'check') {
    const result = check(bundle, packets, Number(values['geometry-tolerance'] ?? 1), values);
    if (!result.passed) process.exitCode = 2;
    return console.log(JSON.stringify(result, null, 2));
  }
  const result = command === 'decode' ? decode(bundle, packets, false) : await merge(bytes, packets, values['png-dir']);
  if (values.out) {
    const temp = `${values.out}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(values.out), { recursive: true });
    try {
      await writeFile(temp, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
      await rename(temp, values.out);
    } finally {
      await rm(temp, { force: true });
    }
    return console.log(`${result.boards.length} boards → ${values.out}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
