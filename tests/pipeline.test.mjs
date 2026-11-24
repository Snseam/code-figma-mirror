import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { capture } from '../capture.mjs';
import { loadScenarios, inventory } from '../cli.mjs';
import { audit } from '../audit.mjs';

test('captures resolved tracking for inherited, negative and normal text', async context => {
  const dir = await mkdtemp(path.join(tmpdir(), 'parity-spacing-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const url = path.join(dir, 'spacing.html');
  await writeFile(url, '<main style="font-size:20px;letter-spacing:.12em"><p>Wide</p><p style="letter-spacing:-.5px">Tight</p><p style="letter-spacing:normal">Normal</p></main>');
  const result = await capture({ project: 'Spacing', viewports: [{ id: 'phone', width: 375, height: 700 }],
    states: [{ id: 'sample', url, ready: 'main' }] }, path.join(dir, 'capture'));
  const measured = {};
  function collect(layer) {
    if (layer.kind === 'text') measured[layer.text] = layer.style.letterSpacing;
    layer.children?.forEach(collect);
  }
  result.boards[0].children.forEach(collect);
  assert.deepEqual(measured, { Wide: 2.4, Tight: -0.5, Normal: 0 });
});

test('captures responsive UI, component instances and only observed transitions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'parity-capture-'));
  try {
    const config = await loadScenarios(fileURLToPath(new URL('../examples/inbox/scenarios.json', import.meta.url)));
    config.states = config.states.slice(0, 2);
    config.fontEvidence = true;
    config.edges = config.edges.slice(0, 2);
    config.edges.push({ from: 'open', to: 'closed', selector: '#does-not-exist' });
    const bundle = await capture(config, dir);
    assert.ok(!Object.hasOwn(bundle, 'rasterProfile'));
    const stats = inventory(bundle);
    assert.equal(stats.boards, 4);
    assert.equal(stats.edges, 4);
    assert.ok(stats.componentOccurrences > 4);
    assert.equal(stats.tokens, 6);
    assert.ok(stats.warnings.some(text => text.includes('#does-not-exist')));
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'bundle.json'), 'utf8')), bundle);
    for (const board of bundle.boards) {
      const title = board.fontEvidence.find(host => host.layers.some(id => id.includes('##app>:nth-child(1)/text-')));
      assert.ok(title.fonts.some(font => font.postScriptName && font.glyphCount > 0));
      const bytes = await readFile(path.join(dir, 'source', `${board.viewport}--${board.state}.png`));
      assert.equal(bytes.readUInt32BE(16), board.width);
      assert.equal(bytes.readUInt32BE(20), board.height);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('structural audit rejects flattened text, geometry drift and missing instances or links', () => {
  const layer = { id: 'button', kind: 'frame', component: 'Button', x: 5, y: 3, width: 50, height: 20,
    children: [{ id: 'label', kind: 'text', x: 1, y: 0, width: 48, height: 20 }] };
  const board = { id: 'phone/home', width: 375, height: 812, children: [layer] };
  const edge = { from: board.id, source: 'button', to: board.id, action: 'BACK' };
  const bundle = { version: 1, project: 'sample', boards: [board], edges: [edge] };
  const observed = { edges: [{ ...edge, to: null }], instances: [{ boardId: board.id, id: 'button', mainId: '2:1' }],
    geometry: [{ ...layer, type: 'INSTANCE', boardId: board.id }, { ...layer.children[0], type: 'TEXT', boardId: board.id }] };
  const snapshot = { project: 'sample', boards: [board], observed };
  assert.equal(audit(bundle, snapshot).passed, true);
  const edited = structuredClone(snapshot);
  Object.assign(edited.observed.geometry[1], { text: 'changed', parentId: board.id });
  edited.observed.geometry.push({ ...edited.observed.geometry[0], id: 'unmapped' });
  edited.observed.instances.push({ boardId: board.id, id: 'unmapped', mainId: '2:1' });
  edited.boards.push({ ...board, id: 'phone/extra' });
  edited.changes = [{ scope: 'design', op: 'add', boardId: board.id, id: 'figma:2:9' }];
  assert.deepEqual(new Set(audit(bundle, edited).issues.map(item => item.issue)),
    new Set(['text-mismatch', 'wrong-parent', 'unexpected-layer', 'unexpected-instance', 'unexpected-board', 'added-design-layer']));
  observed.geometry[1].type = 'RECTANGLE';
  observed.geometry[0].width = 75;
  observed.edges = [];
  observed.instances = [];
  const result = audit(bundle, snapshot);
  assert.equal(result.passed, false);
  assert.deepEqual(new Set(result.issues.map(item => item.issue)), new Set(['geometry-mismatch', 'missing-reaction', 'text-not-editable', 'missing-component-instance']));
});
