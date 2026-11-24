import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PNG } from 'pngjs';
import { chunks } from '../mcp/compact.mjs';
import { review } from '../review.mjs';
import { check, decode, merge, requestCode, tokenRequestCode } from './cloud-export.mjs';
import { signature } from './cloud-reader.mjs';

const cli = fileURLToPath(new URL('cloud-export.mjs', import.meta.url));
const section = '3:40';
const canvas = { source: '4:1', frame: '4:9', output: '7:13', section };
const canvasArgs = Object.entries(canvas).flatMap(([key, value]) => [`--${key}`, value]);
const execute = (code, figma) => new (async () => {}).constructor('figma', code)(figma);
const bundle = {
  version: 1, project: 'Source', tokens: { accent: '#123456', paper: '#FFFFFF' }, warnings: [],
  boards: ['phone', 'desktop'].map(viewport => ({
    id: `${viewport}/open`, viewport, state: 'open', width: 80, height: 40,
    children: [{ id: 'button', name: 'Button', kind: 'frame', component: 'Button', x: 3, y: 4, width: 30, height: 20,
      children: [{ id: 'label', name: 'Caption', kind: 'text', text: '源🙂', style: { fontSize: 12 },
        x: 1, y: 2, width: 20, height: 15 }] }]
  })),
  edges: [{ from: 'phone/open', source: 'button', action: 'OVERLAY', to: 'desktop/open' },
    { from: 'desktop/open', source: 'desktop/open', action: 'BACK', to: null }]
};

function host(edit = () => {}) {
  const source = { type: 'PAGE', id: canvas.source, async loadAsync() {} };
  const output = { type: 'PAGE', id: canvas.output, async loadAsync() {} };
  const pieces = chunks(bundle, 75).reverse().map(characters => ({ characters }));
  const transfer = { type: 'FRAME', id: canvas.frame, parent: source, query: () => pieces };
  const group = { type: 'COMPONENT_SET', id: '9:8', name: 'Button' };
  const target = { type: 'SECTION', id: section, name: `UI parity v2 / Source [${canvas.frame} ${signature(JSON.stringify(bundle))}]` };
  output.children = [target];
  target.children = bundle.boards.map((board, index) => {
    const id = `${index + 4}:1`;
    const main = { type: 'COMPONENT', id: `${index + 8}:42`, parent: group,
      variantProperties: { State: 'Default', Layout: `L${index + 1}` } };
    const root = { id, type: 'FRAME', name: board.id, x: 100 + index * 120, y: 10, width: 80, height: 40,
      parent: target, reactions: index ? [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'BACK' }] }] : [] };
    const button = { id: `${id}1`, type: 'INSTANCE', name: 'Button', x: 3, y: 4, width: 30, height: 20, parent: root,
      getMainComponentAsync: async () => main, reactions: index ? [] : [{ trigger: { type: 'ON_CLICK' },
        action: { type: 'NODE', navigation: 'OVERLAY', destinationId: '5:1' } }] };
    const text = { id: `I${id};9:3`, type: 'TEXT', name: 'Inherited name', characters: '源🙂', fontSize: 12,
      x: 1, y: 2, width: 20, height: 15, parent: button };
    button.children = [text];
    root.children = [button];
    edit({ root, button, text, main, index, target, pieces });
    Object.freeze(text);
    Object.freeze(button.children);
    Object.freeze(button);
    Object.freeze(root.children);
    return Object.freeze(root);
  });
  Object.freeze(target.children);
  Object.freeze(target);
  return { root: { children: [source, output] }, getNodeByIdAsync: async id => id === transfer.id && transfer };
}

async function readAll(figma) {
  const packets = [];
  for (const board of bundle.boards) {
    const run = part => execute(requestCode(bundle, board.id, { ...canvas, part }), figma);
    const first = await run(1);
    packets.push(first);
    for (let part = 2; part <= first.parts; part++) packets.push(await run(part));
  }
  return packets;
}

function colorHost(edit = () => {}) {
  const figma = host();
  const target = figma.root.children[1].children[0];
  const group = { id: 'VariableCollectionId:7:20', name: `${target.name} / ${target.id}`, defaultModeId: 'source-mode', variableIds: [] };
  const values = [{ r: 0, g: 0.5, b: 1, a: 1 }, { r: 1, g: 1, b: 1 }];
  const variables = ['accent', 'paper'].map((name, index) => ({
    name, id: `VariableID:7:${index}`, variableCollectionId: group.id, resolvedType: 'COLOR',
    valuesByMode: { dark: { r: 0, g: 0, b: 0 }, 'source-mode': values[index] }
  }));
  const groups = [{ id: 'unrelated', name: target.name, variableIds: ['never-read'] }, group];
  edit({ group, groups, variables });
  group.variableIds = variables.map(variable => variable.id);
  figma.variables = { getLocalVariableCollectionsAsync: async () => groups,
    getVariableByIdAsync: async id => {
      assert.notEqual(id, 'never-read');
      return variables.find(variable => variable.id === id);
    } };
  return figma;
}

test('CLI token reply merges with board packets and real review proposes the measured CSS change', async context => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ui-parity-tokens-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bundle.json'), cssPath = path.join(dir, 'theme.css'), replies = path.join(dir, 'replies');
  await Promise.all([writeFile(file, JSON.stringify(bundle)), writeFile(cssPath, ':root { --accent: #123456; }\n'), mkdir(replies)]);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  const code = run('tokens', file, ...canvasArgs);
  assert.equal(code.status, 0, code.stderr);
  assert.match(run('tokens', file, '--section', section).stderr, /explicit canvas IDs/);
  const token = await execute(code.stdout, colorHost());
  const boards = await readAll(host());
  for (const [index, value] of [...boards, { result: token }].entries()) {
    await writeFile(path.join(replies, `${index}.json`), JSON.stringify(value));
  }
  const merged = run('merge', file, replies);
  assert.equal(merged.status, 0, merged.stderr);
  const snapshot = JSON.parse(merged.stdout);
  assert.deepEqual(snapshot.tokens, { accent: '#0080FF', paper: '#FFFFFF' });
  assert.equal(snapshot.cloud.tokenCoverage.count, 2);
  assert.deepEqual(snapshot.changes, [{ boardId: null, id: 'accent', figmaId: 'VariableID:7:0', scope: 'token',
    op: 'update', before: { color: '#123456' }, after: { color: '#0080FF' } }]);
  const reviewed = review(bundle, bundle, snapshot, { cssPath, tokenMap: { accent: '--accent' } });
  assert.deepEqual(reviewed.conflicts, []);
  assert.match(reviewed.patch, /\+:root \{ --accent: #0080FF; \}/);
  assert.equal(review(bundle, { ...bundle, tokens: { ...bundle.tokens, accent: '#999999' } }, snapshot).conflicts[0].reason, 'both-modified');
  const checked = run('check', file, replies, ...canvasArgs);
  assert.equal(checked.status, 2);
  assert.equal(JSON.parse(checked.stdout).issues[0].issue, 'token-change');
  assert.throws(() => decode(bundle, [...boards, token, token]), /Duplicate token snapshot/);
  const wrongFile = await execute(code.stdout, { ...colorHost(), fileKey: 'different-file' });
  assert.throws(() => decode(bundle, [...boards, wrongFile]), /different canvas/);
});

test('complete collection distinguishes additions, removals, empty, unchanged and translucent colors', async () => {
  const boards = await readAll(host());
  const snapshot = async edit => {
    const reply = await execute(tokenRequestCode(bundle, canvas), colorHost(edit));
    return merge(Buffer.from(JSON.stringify(bundle)), [reply, ...boards]);
  };
  const empty = await snapshot(({ variables }) => { variables.length = 0; });
  assert.deepEqual(empty.tokens, {});
  assert.deepEqual(empty.changes.map(row => [row.id, row.op, row.figmaId]), [['accent', 'remove', null], ['paper', 'remove', null]]);
  const renamed = await snapshot(({ variables }) => {
    variables[1].name = 'surface';
    variables[1].valuesByMode['source-mode'].a = 0.5;
  });
  assert.equal(renamed.tokens.surface, '#FFFFFF80');
  assert.deepEqual(renamed.changes.map(row => row.op), ['update', 'add', 'remove']);
  const unchanged = await snapshot(({ variables }) => {
    variables[0].valuesByMode['source-mode'] = { r: 0x12 / 255, g: 0x34 / 255, b: 0x56 / 255 };
  });
  assert.deepEqual(unchanged.tokens, bundle.tokens);
  assert.deepEqual(unchanged.changes, []);
});

test('unreadable values, ambiguous collections and partial evidence cannot become a token snapshot', async () => {
  const code = tokenRequestCode(bundle, canvas);
  const read = edit => execute(code, colorHost(edit));
  await assert.rejects(read(({ group, groups }) => { groups.push(group); }), /one section token collection/);
  await assert.rejects(read(({ group }) => { group.name = 'Another section'; }), /one section token collection/);
  await assert.rejects(read(({ variables }) => { variables[0].variableCollectionId = 'elsewhere'; }), /Unreadable COLOR/);
  await assert.rejects(read(({ variables }) => { variables[0].valuesByMode['source-mode'] = { type: 'VARIABLE_ALIAS', id: 'alias' }; }), /literal default-mode/);
  await assert.rejects(read(({ variables }) => { delete variables[1].valuesByMode['source-mode']; }), /literal default-mode/);
  const duplicate = await read(({ variables }) => { variables[1].name = variables[0].name; });
  const boards = await readAll(host());
  assert.throws(() => decode(bundle, [...boards, duplicate]), /Duplicate color variable/);
  const longName = '颜色'.repeat(1600);
  const figma = colorHost(({ variables }) => { variables[1].name = longName; });
  const first = await execute(code, figma);
  assert.ok(first.parts > 1);
  assert.throws(() => decode(bundle, [...boards, first]), /Incomplete token snapshot/);
  const parts = [first];
  for (let part = 2; part <= first.parts; part++) parts.push(await execute(tokenRequestCode(bundle, { ...canvas, part }), figma));
  assert.equal(decode(bundle, [...parts.reverse(), ...boards]).tokenSnapshot.tokens[longName], '#FFFFFF');
});

test('generated code returns actual node, parent, main and destinations on frozen boards', async () => {
  const packets = await readAll(host());
  const snapshot = await merge(Buffer.from(JSON.stringify(bundle)), packets.reverse());
  assert.deepEqual(snapshot.changes, []);
  assert.deepEqual(snapshot.observed.edges, bundle.edges);
  assert.deepEqual(snapshot.observed.instances, bundle.boards.map((board, index) => ({
    boardId: board.id, id: 'button', mainId: `${index + 8}:42`, setId: '9:8', family: 'Button', variant: 'Default', layout: `L${index + 1}`
  })));
  assert.deepEqual(snapshot.observed.geometry[2], { boardId: 'phone/open', id: 'label', figmaId: 'I4:1;9:3',
    parentId: 'button', type: 'TEXT', x: 1, y: 2, width: 20, height: 15, text: '源🙂' });
  assert.equal(snapshot.observed.geometry[0].x, 100);
  assert.equal(snapshot.boards[0].status, 'measured');
  assert.equal(check(bundle, packets, 1, canvas).passed, true);
  assert.deepEqual(snapshot.cloud.tokenCoverage, { status: 'unobserved' });
  assert.equal(Object.hasOwn(snapshot, 'tokens'), false);
  assert.match(snapshot.warnings.join(' '), /tokens were not observed/);
});

test('preserves actual design drift, unavailable masters, unknown destinations and non-click actions', async () => {
  const packets = await readAll(host(({ root, button, text, index }) => {
    if (index) return;
    text.characters = ' \n"🙂"\t';
    text.fontSize = 13;
    text.parent = root;
    button.width += 2;
    button.getMainComponentAsync = async () => null;
    button.reactions[0].action.destinationId = '99:99';
    button.reactions.push({ trigger: { type: 'ON_HOVER' }, actions: [{ type: 'CLOSE' }] });
  }));
  const result = decode(bundle, packets).boards[0];
  assert.equal(result.observed.instances[0].mainId, null);
  assert.equal(result.observed.edges[0].to, null);
  assert.equal(result.observed.reactions[0].actions[0].destinationId, '99:99');
  assert.equal(result.observed.reactions[1].trigger.type, 'ON_HOVER');
  const change = result.changes.find(item => item.id === 'label');
  assert.equal(change.after.text, ' \n"🙂"\t');
  assert.equal(change.after.fontSize, 13);
  assert.deepEqual(change.after.parent, { scope: 'board', boardId: 'phone/open', id: 'phone/open' });
  assert.equal(check(bundle, packets, 1, canvas).passed, false);
  const swapped = await readAll(host(({ main }) => { main.variantProperties.Layout = 'L1'; }));
  assert.ok(check(bundle, swapped, 1, canvas).issues.some(issue => issue.field === 'mainId'));
});

test('splits Unicode losslessly and rejects missing, duplicate, corrupt or mixed return packets', async () => {
  const text = '🦉\n"\\'.repeat(2400);
  const packets = await readAll(host(node => { if (!node.index) node.text.characters = text; }));
  assert.ok(packets[0].parts > 1);
  assert.ok(packets.every(packet => Buffer.byteLength(JSON.stringify(packet)) < 6400));
  assert.equal(decode(bundle, [...packets].reverse()).boards[0].observed.geometry[2].text, text);
  assert.throws(() => decode(bundle, packets.slice(1)), /Incomplete/);
  assert.throws(() => decode(bundle, [...packets, packets[0]]), /Duplicate/);
  assert.throws(() => decode(bundle, packets.map((item, index) => index ? item : { ...item, data: 'oops' })), /Corrupt/);
  assert.throws(() => decode(bundle, packets.slice(0, -1)), /Missing board/);
  const other = await readAll(host(node => { node.text.characters = '锚'.repeat(4000); }));
  assert.throws(() => decode(bundle, [other[0], ...packets.slice(1)]), /Mixed reads/);
  const changed = structuredClone(bundle);
  changed.boards[1].width++;
  assert.throws(() => decode(changed, packets), /Wrong bundle/);
});

test('wrong canvas and ambiguous layer structures refuse ID assignment', async () => {
  const code = requestCode(bundle, 'phone/open', canvas);
  await assert.rejects(execute(code, host(({ pieces, index }) => { if (!index) pieces.push(pieces[0]); })), /chunk/);
  await assert.rejects(execute(code, host(({ target }) => { target.name = 'Other output'; })), /section/);
  await assert.rejects(execute(code, host(({ root }) => { root.children = []; })), /child count/);
});

test('CLI generates runnable requests and merges a one-to-one PNG manifest after decoding', async context => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ui-parity-cloud-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'bundle.json'), scripts = path.join(dir, 'js'), replies = path.join(dir, 'replies');
  const images = path.join(dir, 'png');
  await Promise.all([mkdir(replies), mkdir(images), writeFile(input, JSON.stringify(bundle, null, 2))]);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.match(run('requests', input, scripts, '--section', section).stderr, /explicit canvas IDs/);
  assert.equal(run('requests', input, scripts, ...canvasArgs).status, 0);
  const figma = host();
  const png = PNG.sync.write(new PNG({ width: 80, height: 40 }));
  for (const [index, board] of bundle.boards.entries()) {
    const single = run('request', input, board.id, ...canvasArgs);
    const code = await readFile(path.join(scripts, `00${index + 1}.js`), 'utf8');
    assert.equal(single.stdout, code);
    const packet = await execute(code, figma);
    const wrapped = { content: [{ type: 'text', text: JSON.stringify({ result: packet }) }] };
    await writeFile(path.join(replies, `${index}.json`), JSON.stringify(wrapped));
    await writeFile(path.join(images, `${board.viewport}--open.png`), png);
  }
  assert.equal(JSON.parse(run('decode', input, replies).stdout).boards.length, 2);
  assert.match(run('check', input, replies).stderr, /explicit canvas IDs/);
  assert.match(run('check', input, replies, ...canvasArgs, '--output', '42:42').stderr, /requested canvas IDs/);
  assert.equal(JSON.parse(run('check', input, replies, ...canvasArgs).stdout).passed, true);
  const command = (...args) => run('merge', input, replies, '--png-dir', images, ...args);
  const result = command();
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.deepEqual(snapshot.boards.map(board => [board.status, board.file]), [['exported', 'phone--open.png'], ['exported', 'desktop--open.png']]);
  assert.match(snapshot.sourceSha256, /^[a-f0-9]{64}$/);
  const manifest = path.join(images, 'design-diff.json');
  assert.equal(command('--out', manifest).status, 0);
  assert.deepEqual(JSON.parse(await readFile(manifest)), snapshot);
  await writeFile(path.join(images, 'phone--open.png'), PNG.sync.write(new PNG({ width: 81, height: 40 })));
  assert.match(command('--out', manifest).stderr, /bounds mismatch/);
  assert.deepEqual(JSON.parse(await readFile(manifest)), snapshot);
  await rm(path.join(images, 'phone--open.png'));
  assert.match(command().stderr, /distinct actual PNG/);
  const different = await readAll(host(({ text }) => { text.characters = ''; }));
  await writeFile(path.join(replies, '0.json'), JSON.stringify(different[0]));
  assert.equal(run('check', input, replies, ...canvasArgs).status, 2);
});
