import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { capture } from '../capture.mjs';
import { planUpdate } from '../plan-update.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/field-notes.json', import.meta.url));
const shape = { kind: 'frame', name: 'div', width: 40, height: 20, x: 0, y: 0 };
const frame = (id, props) => ({ ...shape, id, ...props });
const board = (id, children) => ({ id, state: id, viewport: 'desktop', width: 800, height: 600, children });
const bundle = (...boards) => ({ version: 1, project: 'fixture', tokens: {}, edges: [], warnings: [], boards });

async function temp(context) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mirror-plan-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('CLI emits a deterministic empty plan for the historical ten-board capture', async context => {
  const dir = await temp(context);
  const output = path.join(dir, 'nested', 'plan.json');
  const run = () => spawnSync(process.execPath, [cli, 'plan', fixture, fixture, '-o', output], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  const json = await readFile(output, 'utf8');
  const plan = JSON.parse(json);
  for (const key of ['tokens', 'masters', 'boards', 'nodes', 'edges', 'remappedIds', 'ambiguities', 'dirtyBoards']) {
    assert.deepEqual(plan[key], [], key);
  }
  assert.equal(plan.baseDigest, plan.nextDigest);
  assert.equal(run().status, 0);
  assert.equal(await readFile(output, 'utf8'), json);
});

test('Chromium tracks duplicate-color references, logical text and sibling insertion on desktop and phone', async context => {
  const dir = await temp(context);
  const url = path.join(dir, 'page.html');
  const config = {
    project: 'capture', tokens: { accent: '--accent', neutral: '--neutral' }, states: [{ id: 'home', url }],
    viewports: [{ id: 'phone', width: 375, height: 700 }, { id: 'desktop', width: 1024, height: 720 }]
  };
  const page = (banner, copy, color) => `<style>
    :root { --accent: ${color}; --neutral: #123456 }
    main { color: var(--neutral) } article { width: 84px; background: var(--accent); border: 1px solid var(--neutral) }
    aside { background: #123456 } .local { --accent: #123456; background: var(--accent) }
    </style><main>${banner}<article data-mirror-id="card">${copy}</article><aside>literal</aside>
    <div class="local">Scoped</div><ul><li>Alpha</li><li>Beta</li></ul></main>`;
  await writeFile(url, page('', 'Old words wrap over lines', '#123456'));
  const base = await capture(config, path.join(dir, 'base'));
  await writeFile(url, page('<header>Banner</header>', 'New longer words wrap differently across several lines', '#894321'));
  const next = await capture(config, path.join(dir, 'next'));
  const plan = planUpdate(base, next);
  assert.deepEqual(plan.ambiguities, []);
  assert.deepEqual(plan.dirtyBoards, ['phone/home', 'desktop/home']);
  assert.deepEqual(plan.tokens.map(token => token.name), ['accent']);
  for (const board of base.boards) {
    const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)];
    const nodes = board.children.flatMap(flatten);
    const card = nodes.find(node => node.stableId === 'business:card');
    assert.deepEqual(card.style.tokenRefs, { fill: 'accent', stroke: 'neutral' });
    assert.ok(card.children.length > 1);
    assert.equal(new Set(card.children.map(node => node.logicalId)).size, 1);
    assert.ok(card.children.every(node => node.style.tokenRefs.color === 'neutral'));
    for (const host of [nodes.find(node => node.name === 'aside'), nodes.find(node => node.identity?.classes?.includes('local'))]) {
      assert.equal(host.style.tokenRefs?.fill, undefined);
    }
    const ops = plan.nodes.filter(item => item.boardId === board.id);
    assert.deepEqual(ops.filter(item => ['remove', 'insert', 'reorder'].includes(item.op)).map(item => item.op), ['insert']);
    assert.equal(ops.filter(item => item.baseId === card.children[0].logicalId && item.op === 'update').length, 1);
    assert.ok(plan.remappedIds.some(item => item.baseId === card.id));
  }
});

test('retains the LCS on reorder and remaps edge sources even when positional IDs collide', () => {
  const list = order => board('home', [...order].map((letter, index) =>
    frame(`home#:root>:nth-child(${index + 1})`, { stableId: letter })));
  const base = bundle(list('ABC'), board('detail', []));
  const next = bundle(list('BCA'), board('detail', []));
  base.edges = [{ from: 'home', source: base.boards[0].children[0].id, to: 'detail', action: 'NAVIGATE' }];
  next.edges = [{ ...base.edges[0], source: next.boards[0].children[2].id }];
  let plan = planUpdate(base, next);
  assert.deepEqual(plan.nodes.map(item => [item.op, item.index]), [['reorder', 2]]);
  assert.deepEqual(plan.edges, []);
  next.edges[0].action = 'OVERLAY';
  plan = planUpdate(base, next);
  assert.deepEqual(plan.edges.map(edge => edge.op), ['update']);
  assert.deepEqual(plan.dirtyBoards, ['home']);
  next.boards[0] = list('XBC');
  next.edges[0].source = next.boards[0].children[0].id;
  assert.deepEqual(planUpdate(base, next).edges.map(edge => edge.op), ['remove', 'insert']);
});

test('reports unresolved unkeyed siblings without destructive guesses', async context => {
  const dir = await temp(context);
  const list = count => bundle(board('home', Array.from({ length: count }, (_, index) => frame(`home#:root>:nth-child(${index + 1})`))));
  const base = list(2), next = list(3);
  const input = path.join(dir, 'base.json'), incoming = path.join(dir, 'next.json'), output = path.join(dir, 'plan.json');
  await Promise.all([writeFile(input, JSON.stringify(base)), writeFile(incoming, JSON.stringify(next))]);
  const run = spawnSync(process.execPath, [cli, 'plan', input, incoming, '-o', output]);
  assert.equal(run.status, 2);
  const plan = JSON.parse(await readFile(output));
  assert.equal(plan.ambiguities.length, 1);
  assert.deepEqual(plan.nodes, []);
  assert.deepEqual(plan.dirtyBoards, ['home']);
});

test('unkeyed wrappers follow their keyed children through a reorder', () => {
  const wrappers = order => bundle(board('home', order.map((key, index) =>
    frame(`home#:root>:nth-child(${index + 1})`, { children: [frame(key, { stableId: key })] }))));
  const plan = planUpdate(wrappers(['left', 'right']), wrappers(['right', 'left']));
  assert.deepEqual(plan.ambiguities, []);
  assert.deepEqual(plan.nodes.map(item => item.op), ['reorder']);
  assert.equal(plan.remappedIds.length, 2);
});

test('upgrading a legacy named component capture adopts its compiler identity in place', () => {
  const id = 'home#:root>:nth-child(2)';
  const base = bundle(board('home', [frame(id, { name: 'Masthead', component: 'Masthead' })]));
  const next = structuredClone(base);
  next.boards[0].children[0].identity = { tag: 'header', source: 'Header.vue:Masthead:root' };
  assert.deepEqual(planUpdate(base, next).dirtyBoards, []);
});

test('plans resource lifecycles and propagates only the referenced token and component families', () => {
  const master = variant => frame('btn', { component: 'Button', variant, style: { fill: '#abc', tokenRefs: { fill: 'accent' } } });
  const base = bundle(board('home', [master('Rest')]), board('detail', [master('Rest')]),
    board('archive', [master('Old')]), board('plain', [frame('literal', { style: { fill: '#abc', tokenRefs: { fill: 'neutral' } } })]));
  base.tokens = { accent: '#AABBCC', neutral: '#AABBCC', retired: '#121212' };
  const next = structuredClone(base);
  next.boards = next.boards.filter(item => item.id !== 'archive');
  next.boards.push(board('new', [master('Active')]));
  for (const item of next.boards.filter(item => item.id !== 'plain')) item.children[0].style.fill = '#456';
  next.boards[0].children[0].width = 41;
  next.tokens = { accent: '#445566', neutral: '#AABBCC', fresh: '#343434' };
  const plan = planUpdate(base, next);
  assert.deepEqual(plan.tokens.map(item => item.op), ['update', 'retire', 'add']);
  assert.deepEqual(plan.masters.map(item => [item.variant, item.op]), [['Rest', 'update'], ['Old', 'retire'], ['Active', 'add']]);
  assert.deepEqual(plan.boards.map(item => item.op), ['remove', 'insert']);
  assert.deepEqual(plan.nodes.map(item => item.changes.map(change => change.field)), [['width']]);
  assert.deepEqual(plan.dirtyBoards, ['home', 'detail', 'new']);
});

test('rejects cross-project inputs, different raster profiles, dangling edges and duplicate explicit keys', () => {
  const valid = bundle(board('home', []));
  assert.throws(() => planUpdate(valid, { ...valid, project: 'other' }), /projects/);
  assert.throws(() => planUpdate(valid, { ...valid, rasterProfile: {} }), /profiles/);
  assert.throws(() => planUpdate(valid, { ...valid, edges: [{ from: 'missing', to: 'home', action: 'NAVIGATE' }] }), /missing/);
  assert.throws(() => planUpdate(valid, bundle(board('home', [
    frame('first', { stableId: 'duplicate' }), frame('second', { stableId: 'duplicate' })
  ]))), /Duplicate sibling identity/);
});
