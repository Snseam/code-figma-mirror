import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { reviewStyles } from '../style-review.mjs';
import plugin from '../plugin/code.js';

const boardId = 'desktop/inbox';
const fields = { width: 'width', height: 'height', radius: 'border-radius', fontSize: 'font-size' };
const mapping = (field, selector = '.card', id = 'card', board = boardId) =>
  ({ selector, property: fields[field], boardId: board, id, field });
const update = (before, after, id = 'card', board = boardId) =>
  ({ boardId: board, id, scope: 'node', op: 'update', before, after });
const design = (...changes) => ({ version: 1, project: 'mail', changes });

function bundle() {
  const children = [{ id: 'card', width: 100, height: 32, style: { radius: 8 },
    children: [{ id: 'title', width: 70, height: 18, style: { fontSize: 14 } }] }];
  return { project: 'mail', boards: [
    { id: boardId, width: 1440, height: 900, children },
    { id: 'phone/inbox', width: 375, height: 812, children: structuredClone(children) }
  ] };
}

async function fixture(context, css) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'style-review-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'styles');
  await mkdir(directory);
  const cssPath = path.join(directory, 'inbox theme.css');
  await writeFile(cssPath, css);
  function git(args, input) {
    const result = spawnSync('git', args, { cwd: root, input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  git(['init', '--quiet']);
  return {
    root, cssPath, git,
    review(diff, mappings, current = bundle(), base = bundle()) {
      return reviewStyles(base, current, diff, { cssPath, mappings });
    }
  };
}

test('four measured fields from plugin diffRows yield a standalone, source-preserving Git patch', async context => {
  const selector = '.card > .title';
  const css = ['\uFEFF/* UTF-8 样式 */', '.card { width: 100px; HEIGHT: 32PX; border-radius: 8px; }',
    ...Array(7).fill('/* preserve context */'),
    `${selector} { font-size /* source */ : /* measured */ 14.0px /* note */ !important; }`].join('\r\n');
  const target = await fixture(context, css);
  const row = (id, value) => ({ scope: 'node', boardId, id, figmaId: id, value });
  const rows = plugin.diffRows([row('card', { width: 100, height: 32, radius: 8 }), row('title', { fontSize: 14 })],
    [row('card', { width: 123.75, height: 40, radius: 0 }), row('title', { fontSize: 16.5 })]);
  const result = target.review(design(...rows), [
    mapping('width'), mapping('height'), mapping('radius'), mapping('fontSize', '.card>.title', 'title')
  ]);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.changes.map(item => [item.field, item.base, item.current, item.figma, item.status]), [
    ['width', 100, 100, 123.75, 'design-only'], ['height', 32, 32, 40, 'design-only'],
    ['radius', 8, 8, 0, 'design-only'], ['fontSize', 14, 14, 16.5, 'design-only']
  ]);
  assert.match(result.patch, /^--- a\/styles\/inbox theme\.css\n\+\+\+ b\/styles\/inbox theme\.css\n/);
  assert.equal(result.patch.match(/^@@ /gm).length, 2);
  target.git(['apply', '--check', '-'], result.patch);
  assert.equal(await readFile(target.cssPath, 'utf8'), css);
  target.git(['apply', '-'], result.patch);
  assert.equal(await readFile(target.cssPath, 'utf8'), css.replace('100px', '123.75px').replace('32PX', '40PX')
    .replace('8px', '0px').replace('14.0px', '16.5px'));
});

test('current-only edits are reviewable, divergent and converged dual edits are excluded, other fields still patch', async context => {
  const css = '.card { width: 120px; height: 42px; border-radius: 8px; }\n.title { font-size: 15px; }\n';
  const target = await fixture(context, css);
  const current = bundle();
  Object.assign(current.boards[0].children[0], { width: 120, height: 42 });
  current.boards[0].children[0].children[0].style.fontSize = 15;
  const diff = design(update({ width: 100, radius: 8 }, { width: 130, radius: 9 }),
    update({ fontSize: 14 }, { fontSize: 15 }, 'title'));
  const result = target.review(diff, [mapping('width'), mapping('height'), mapping('radius'), mapping('fontSize', '.title', 'title')], current);
  assert.deepEqual(result.conflicts.map(item => [item.field, item.reason]), [['width', 'both-modified'], ['fontSize', 'both-modified']]);
  assert.deepEqual(result.changes.map(item => [item.field, item.status]), [['height', 'code-only'], ['radius', 'design-only']]);
  target.git(['apply', '--check', '-'], result.patch);
  target.git(['apply', '-'], result.patch);
  assert.equal(await readFile(target.cssPath, 'utf8'), css.replace('radius: 8px', 'radius: 9px'));
});

test('selectors, declarations, shared lists, and conditional or nested overrides must be unambiguous', async context => {
  const target = await fixture(context, '');
  const cases = [
    ['.card{width:100px}.card{height:8px}', 'duplicate-rule'],
    ['.card{width:100px}@media print{.card {width:100px}}', 'conditional-or-nested-rule'],
    ['@supports(display:grid){.card{width:100px}}', 'conditional-or-nested-rule'],
    ['.card{width:100px;@container (width>30px) {width:90px}}', 'conditional-or-nested-rule'],
    ['.card{width:100px;@media print{&{width:90px}}}', 'conditional-or-nested-rule'],
    ['.card{width:100px;w\\69 dth:3em}', 'duplicate-declaration'],
    ['.card{width:100px}.c\\61 rd{width:90px}', 'duplicate-rule'],
    ['.card,.sibling{width:100px}', 'shared-selector-list'],
    ['.card,.other{width:1px}.card{width:100px}', 'duplicate-rule'],
    ['.card[data-content=".card"]{width:100px}', 'missing-rule'],
    ['.card{min-width:100px}', 'missing-declaration']
  ];
  for (const [css, reason] of cases) {
    await writeFile(target.cssPath, css);
    const result = target.review(design(update({ width: 100 }, { width: 125 })), [mapping('width')]);
    assert.equal(result.patch, '', css);
    assert.equal(result.conflicts[0].reason, reason, css);
  }
  await writeFile(target.cssPath, '.card{width:100px;.child{width:2em}}');
  const safe = target.review(design(update({ width: 100 }, { width: 125 })), [mapping('width')]);
  assert.deepEqual(safe.conflicts, []);
  target.git(['apply', '--check', '-'], safe.patch);
});

test('only a literal CSS px value matching the current measurement is eligible', async context => {
  const target = await fixture(context, '');
  for (const value of ['calc(100px)', 'var(--width)', '100%', '0', '100px 100px', '-1px', '100/**/px',
    '100px /*one*/ + 3px /*two*/ !important', '"100px"', '1e999px', 'auto', 'initial']) {
    const css = `.card{width:${value}}`;
    await writeFile(target.cssPath, css);
    const result = target.review(design(update({ width: 100 }, { width: 125 })), [mapping('width')]);
    assert.equal(result.patch, '', css);
    assert.equal(result.conflicts[0].reason, 'non-px-value', css);
    assert.equal(await readFile(target.cssPath, 'utf8'), css);
  }
  await writeFile(target.cssPath, '.card{width:100.01px}');
  const drift = target.review(design(update({ width: 100 }, { width: 125 })), [mapping('width')]);
  assert.equal(drift.conflicts[0].reason, 'css-value-changed');
  assert.equal(drift.conflicts[0].actual, 100.01);
  assert.equal(drift.patch, '');
});

test('mapping must identify one board, one nested node, one field and one declaration', async context => {
  const target = await fixture(context, '.card { width:100px; } .other {width: 100px;}');
  const delta = update({ width: 100 }, { width: 125 });
  for (const maps of [
    [mapping('width'), mapping('width', ' .card ', 'title')],
    [mapping('width'), mapping('width', '.other')]
  ]) {
    const result = target.review(design(delta), maps);
    assert.deepEqual(result.conflicts.map(item => item.reason), ['duplicate-mapping', 'duplicate-mapping']);
    assert.equal(result.patch, '');
  }
  const invalid = target.review(design(delta), [{ ...mapping('width'), property: 'font-size' }, null]);
  assert.deepEqual(invalid.conflicts.map(item => item.reason), ['invalid-mapping', 'invalid-mapping']);
  const phone = update({ width: 100 }, { width: 111 }, 'card', 'phone/inbox');
  const safe = target.review(design(delta, phone, { ...delta, scope: 'design' }), [mapping('width')]);
  assert.equal(safe.changes[0].figma, 125);
  assert.deepEqual(safe.conflicts, []);
  assert.deepEqual(target.review(design(phone), [mapping('width')]), { changes: [], conflicts: [], patch: '' });
  for (const [change, reason] of [
    [current => current.boards.shift(), 'missing-board'],
    [current => current.boards.push(current.boards[0]), 'duplicate-board'],
    [current => current.boards[0].children.pop(), 'missing-node'],
    [current => current.boards[0].children.push(current.boards[0].children[0]), 'duplicate-node'],
    [current => { current.boards[0].children[0].width = '100px'; }, 'unmeasured-field']
  ]) {
    const current = bundle();
    change(current);
    const result = target.review(design(delta), [mapping('width')], current);
    assert.equal(result.conflicts[0].reason, reason);
    assert.equal(result.patch, '');
  }
});

test('design provenance, sparse diff rows and the original measurement gate generated edits', async context => {
  const target = await fixture(context, '.card{width:100px}');
  const delta = update({ width: 100 }, { width: 125 });
  for (const [diff, reason] of [
    [{ ...design(delta), project: 'other-project' }, 'project-mismatch'],
    [design(delta, delta), 'duplicate-design-row'],
    [design(update({ width: 99.9 }, { width: 125 })), 'snapshot-base-mismatch'],
    [design(update({}, { width: 125 })), 'unmeasured-design-field'],
    [design(update({ width: 100 }, {})), 'unmeasured-design-field'],
    [design(update({ width: 100 }, { width: 'MIXED' })), 'unmeasured-design-field'],
    [design(update({ width: 100 }, { width: -10 })), 'unmeasured-design-field'],
    [design({ ...delta, op: 'remove' }), 'unsupported-design-operation']
  ]) {
    const result = target.review(diff, [mapping('width')]);
    assert.equal(result.conflicts[0].reason, reason);
    assert.equal(result.patch, '');
  }
  const unchanged = target.review(design(update({ height: 32 }, { height: 64 })), [mapping('width')]);
  assert.deepEqual(unchanged, { changes: [], conflicts: [], patch: '' });
  await writeFile(target.cssPath, '.card{width:100px');
  assert.equal(target.review(design(delta), [mapping('width')]).conflicts[0].reason, 'unreadable-css');
});

test('review-styles CLI writes an applicable patch and replaces it with a conflict report on source drift', async context => {
  const css = '.title { font-size: 14px; }\n';
  const target = await fixture(context, css);
  const inputs = {
    'base.json': bundle(),
    'current.json': bundle(),
    'design-diff.json': design(update({ fontSize: 14 }, { fontSize: 16 }, 'title')),
    'mappings.json': [mapping('fontSize', '.title', 'title')]
  };
  await Promise.all(Object.entries(inputs).map(([name, data]) =>
    writeFile(path.join(target.root, name), JSON.stringify(data))));
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const output = path.join(target.root, 'review output');
  async function run(expectedExit) {
    const result = spawnSync(process.execPath, [
      cli, 'review-styles', 'base.json', 'current.json', 'design-diff.json', output,
      '--css', target.cssPath, '--mappings', 'mappings.json'
    ], { cwd: target.root, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, expectedExit, result.stderr);
    const report = JSON.parse(await readFile(path.join(output, 'style-review.json'), 'utf8'));
    const patch = await readFile(path.join(output, 'styles.patch'), 'utf8');
    assert.equal(patch, report.patch);
    return report;
  }

  const clean = await run(0);
  assert.deepEqual(clean.conflicts, []);
  assert.deepEqual(clean.changes, [{ ...inputs['mappings.json'][0], base: 14, current: 14, figma: 16, status: 'design-only' }]);
  assert.match(clean.patch, /^\+\.title \{ font-size: 16px; \}$/m);
  target.git(['apply', '--check', '-'], clean.patch);
  assert.equal(await readFile(target.cssPath, 'utf8'), css);

  const drifted = '.title { font-size: 15px; }\n';
  await writeFile(target.cssPath, drifted);
  const conflict = await run(2);
  assert.deepEqual(conflict.conflicts, [{ ...inputs['mappings.json'][0], base: 14, current: 14, figma: 16,
    reason: 'css-value-changed', actual: 15 }]);
  assert.deepEqual(conflict.changes, []);
  assert.equal(conflict.patch, '');
  assert.equal(await readFile(target.cssPath, 'utf8'), drifted);
});
