import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import { review } from '../review.mjs';
import { verify } from '../verify.mjs';

async function tempDir(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ui-parity-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function board(state = 'inbox', width = 2, height = 1, viewport = 'desktop') {
  return { id: `${viewport}/${state}`, viewport, state, width, height };
}

async function capture(context, boards, extra = {}) {
  const root = await tempDir(context);
  const source = path.join(root, 'source');
  const figma = path.join(root, 'exports');
  const out = path.join(root, 'evidence');
  await Promise.all([mkdir(source), mkdir(figma)]);
  await writeFile(path.join(root, 'bundle.json'), JSON.stringify({ boards, ...extra }));
  return { root, source, figma, out, run: options => verify(root, figma, out, options) };
}

function png(width, height, pixels) {
  const image = new PNG({ width, height });
  pixels.forEach((rgba, index) => image.data.writeUInt32BE(rgba, index * 4));
  return PNG.sync.write(image);
}

async function pair(fixture, name, source, figma) {
  await Promise.all([
    writeFile(path.join(fixture.source, name), source),
    writeFile(path.join(fixture.figma, name), figma)
  ]);
}

test('verify persists independent HTML, metrics, inputs, and a correctly oriented PNG heatmap', async context => {
  const edges = [{ from: 'inbox', to: 'message', action: 'open' }];
  const warnings = ['<b>capture warning</b>'];
  const fixture = await capture(context, [board()], { edges, warnings });
  const original = png(2, 1, [0x000000ff, 0xffffff00]);
  const changed = png(2, 1, [0x010000ff, 0x00000000]);
  await pair(fixture, 'desktop--inbox.png', original, changed);
  const result = await fixture.run();
  const [item] = result.boards;
  assert.equal(result.passed, false);
  assert.deepEqual(item.issues, [{ code: 'diff-threshold-exceeded' }]);
  assert.deepEqual(result.edges, edges);
  assert.equal(result.rasterProfile, null);
  assert.deepEqual(result.warnings, warnings);
  assert.deepEqual([item.diffPixels, item.totalPixels, item.diffRatio], [1, 2, 0.5]);
  const heat = await readFile(path.join(fixture.out, item.heatmap));
  const decoded = PNG.sync.read(heat);
  assert.equal(decoded.data.readUInt32BE(0), 0xd92052ff);
  assert.equal(decoded.data.readUInt32BE(4), 0xf2f2f2ff);
  assert.deepEqual(result, JSON.parse(await readFile(path.join(fixture.out, 'report.json'), 'utf8')));
  const html = await readFile(path.join(fixture.out, 'report.html'), 'utf8');
  assert.deepEqual([...html.matchAll(/src="data:image\/png;base64,([^"]+)"/g)].map(match => Buffer.from(match[1], 'base64')),
    [original, changed, heat]);
  assert.match(html, /&lt;b&gt;capture warning&lt;\/b&gt;/);
  assert.match(html, /状态连线/);
  assert.match(html, /参考图来自原始采集/);
  assert.doesNotMatch(html, /src="(?:file:|https?:|\/|\.\.)/);
  assert.equal((await fixture.run({ maxDiffRatio: 0.5 })).passed, true);
  assert.equal((await fixture.run({ threshold: 0.49 })).passed, false);
  assert.equal((await fixture.run({ pixelTolerance: 1 })).boards[0].diffPixels, 0);
});

test('declared text and token edits are accepted only inside their measured regions', async context => {
  const text = { id: 'button/text-1@0', kind: 'text', x: 0, y: 0, width: 1, height: 1, text: 'Save changes' };
  const button = { id: 'button', kind: 'frame', x: 0, y: 0, width: 1, height: 1, style: { fill: '#18181B' }, children: [text] };
  const fixture = await capture(context, [{ ...board('open', 1, 1), children: [button] }], {
    tokens: { primary: '#18181B' },
  });
  await pair(fixture, 'desktop--open.png', png(1, 1, [0x18181bff]), png(1, 1, [0x2563ebff]));
  const change = { scope: 'token', op: 'update', id: 'primary', after: { color: '#2563EB' } };
  const result = await fixture.run({ maxDiffRatio: 0, expectedChanges: { designChanges: [change] } });
  assert.equal(result.passed, true);
  assert.deepEqual(result.boards[0].issues, []);
  assert.equal(result.boards[0].plannedPixels, 1);
  assert.equal(result.boards[0].diffPixels, 1);
  assert.equal((await fixture.run({ maxDiffRatio: 0, expectedChanges: { designChanges: [] } })).passed, false);
  assert.equal((await fixture.run({ maxDiffRatio: 1, expectedChanges: { designChanges: [] } })).boards[0].issues[0].code, 'unexpected-pixels');
  const unchanged = path.join(fixture.root, 'unchanged');
  await mkdir(unchanged);
  await writeFile(path.join(unchanged, 'desktop--open.png'), png(1, 1, [0x18181bff]));
  const missing = await verify(fixture.root, unchanged, path.join(fixture.root, 'missing'), { maxDiffRatio: 0, expectedChanges: { designChanges: [change] } });
  assert.equal(missing.boards[0].issues[0].code, 'missing-expected-pixels');

  const textFixture = await capture(context, [{ ...board('open', 2, 1), children: [
    { id: 'label', kind: 'text', x: 0, y: 0, width: 1, height: 1, text: 'Save changes' },
  ] }]);
  await pair(textFixture, 'desktop--open.png', png(2, 1, [0xffffffff, 0xffffffff]), png(2, 1, [0x000000ff, 0xffffffff]));
  const textChange = { scope: 'node', op: 'update', boardId: 'desktop/open', id: 'label', before: { text: 'Save changes' }, after: { text: 'Save profile' } };
  const textResult = await textFixture.run({ maxDiffRatio: 0, expectedChanges: { designChanges: [textChange] } });
  assert.equal(textResult.passed, true);
  assert.deepEqual(textResult.boards[0].issues, []);
});

test('edit verification uses actual baseline pixels and rejects a partially recolored button', async context => {
  const name = 'desktop--open.png';
  const button = { id: 'button', kind: 'frame', x: 0, y: 0, width: 2, height: 1, style: { fill: '#18181B' } };
  const fixture = await capture(context, [{ ...board('open', 3, 1), children: [button] }], { tokens: { primary: '#18181B' } });
  const baselineDir = path.join(fixture.root, 'original');
  await mkdir(baselineDir);
  await writeFile(path.join(baselineDir, 'design-diff.json'), JSON.stringify({ boards: [{ id: 'desktop/open', file: name }] }));
  await writeFile(path.join(baselineDir, name), png(3, 1, [0x18181bff, 0x18181bff, 0xffffffff]));
  const options = { baselineDir, expectedChanges: { designChanges: [{ scope: 'token', op: 'update', id: 'primary', after: { color: '#2563EB' } }] } };
  await pair(fixture, name, png(3, 1, [0, 0, 0]), png(3, 1, [0x2563ebff, 0x18181bff, 0xffffffff]));
  assert.equal((await fixture.run(options)).boards[0].issues[0].code, 'wrong-token-color');
  await writeFile(path.join(fixture.figma, name), png(3, 1, [0x2563ebff, 0x2563ebff, 0xffffffff]));
  assert.equal((await fixture.run(options)).passed, true);
  await writeFile(path.join(fixture.figma, name), png(3, 1, [0x2563ebff, 0x2563ebff, 0x000000ff]));
  assert.equal((await fixture.run(options)).boards[0].issues[0].code, 'unexpected-pixels');
});

test('a controlled font reference is labeled in the HTML and preserved in JSON', async context => {
  const rasterProfile = { name: 'Arimo <fixture>', fontFamily: 'Arimo', smoothing: 'antialiased', sha256: 'a'.repeat(64) };
  const fixture = await capture(context, [board()], { rasterProfile });
  const image = png(2, 1, [0x000000ff, 0xffffffff]);
  await pair(fixture, 'desktop--inbox.png', image, image);
  const report = await fixture.run();
  assert.deepEqual(report.rasterProfile, rasterProfile);
  const html = await readFile(path.join(fixture.out, 'report.html'), 'utf8');
  assert.match(html, /受控字体采集（Arimo &lt;fixture&gt;）/);
  assert.match(html, /字体 Arimo，平滑设置 antialiased/);
});

test('verify continues after missing, unreadable, or wrongly sized inputs and reports each affected side', async context => {
  const fixture = await capture(context, ['missing', 'corrupt', 'sizes', 'both-scaled', 'identity', 'alpha'].map(state => board(state)));
  const image = png(2, 1, [0x112233ff, 0x112233ff]);
  const scaled = png(1, 2, [0x112233ff, 0x112233ff]);
  await writeFile(path.join(fixture.source, 'desktop--missing.png'), image);
  await pair(fixture, 'desktop--corrupt.png', Buffer.from('broken PNG'), image);
  await pair(fixture, 'desktop--sizes.png', image, scaled);
  await pair(fixture, 'desktop--both-scaled.png', scaled, scaled);
  await pair(fixture, 'desktop--identity.png', image, image);
  await pair(fixture, 'desktop--alpha.png', image, png(2, 1, [0x112233fe, 0x112233ff]));
  const result = await fixture.run();
  const [missing, corrupt, sizes, bothScaled, identity, alpha] = result.boards;
  assert.equal(result.passed, false);
  assert.deepEqual([missing.issues[0].code, missing.issues[0].side], ['missing', 'figma']);
  assert.deepEqual([corrupt.issues[0].code, corrupt.issues[0].side], ['unreadable', 'source']);
  assert.deepEqual(sizes.issues, [{ code: 'dimension-mismatch', side: 'figma',
    actual: { width: 1, height: 2 }, expected: { width: 2, height: 1 } }]);
  assert.equal(sizes.diffRatio, null);
  assert.equal(sizes.heatmap, null);
  assert.deepEqual(bothScaled.issues.map(issue => issue.side), ['source', 'figma']);
  assert.equal(bothScaled.passed, false);
  assert.equal(identity.passed, true);
  assert.equal(alpha.diffPixels, 1);
});

test('verify cannot pass an empty manifest, ambiguous filenames, or the source file supplied as a Figma export', async context => {
  const empty = await capture(context, []);
  assert.equal((await empty.run()).passed, false);
  const fixture = await capture(context, [board('a--b', 2, 1, 'c'), board('b', 2, 1, 'c--a'), board('../traverse'), board()]);
  const filename = 'desktop--inbox.png';
  await writeFile(path.join(fixture.source, filename), png(2, 1, [0, 0]));
  await link(path.join(fixture.source, filename), path.join(fixture.figma, filename));
  const result = await fixture.run({ maxDiffRatio: 1 });
  assert.equal(result.passed, false);
  assert.deepEqual(result.boards.map(item => item.issues[0].code),
    ['ambiguous-filename', 'ambiguous-filename', 'invalid-board', 'same-input-file']);
  for (const options of [{ threshold: -1 }, { maxDiffRatio: NaN }, { maxDiffRatio: 1.1 }, { pixelTolerance: 256 }]) {
    await assert.rejects(fixture.run(options), RangeError);
  }
});

const snapshot = tokens => ({ tokens });

test('verify uses the PNG actually named by the plugin and respects missing boards even with stale exports', async context => {
  const fixture = await capture(context, [board(), board('removed')]);
  const image = png(2, 1, [0xffffffff, 0xffffffff]);
  await pair(fixture, 'desktop--inbox.png', image, png(2, 1, [0, 0]));
  await pair(fixture, 'desktop--removed.png', image, image);
  const pluginName = 'board-desktop--inbox.png';
  await writeFile(path.join(fixture.figma, pluginName), image);
  const manifestPath = path.join(fixture.figma, 'design-diff.json');
  const manifest = { boards: [
    { id: 'desktop/inbox', status: 'exported', file: pluginName },
    { id: 'desktop/removed', status: 'missing', file: null }
  ], warnings: ['font substitution'] };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await fixture.run();
  assert.equal(result.boards[0].passed, true);
  assert.equal(result.boards[0].figmaFilename, pluginName);
  assert.equal(result.boards[1].issues[0].code, 'missing');
  assert.deepEqual(result.figmaWarnings, manifest.warnings);
  manifest.boards[0].file = '../source/desktop--inbox.png';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const invalid = await fixture.run();
  assert.equal(invalid.passed, false);
  assert.equal(invalid.issues[0].code, 'invalid-export-manifest');
});

test('review distinguishes branch-only, converged, divergent, added, and removed tokens without a CSS target', () => {
  const base = snapshot({ local: '#001100', same: '#111111', both: '#111111', gone: '#111111', design: '#111111', case: '#ABCDEF' });
  const current = snapshot({ ...base.tokens, local: '#002200', same: '#222222', both: '#222222' });
  const figma = snapshot({ ...base.tokens, same: '#222222', both: '#333333', design: '#444444', fresh: '#555555', case: '#abcdef' });
  delete figma.tokens.gone;
  const result = review(base, current, figma);
  assert.equal(result.patch, '');
  assert.deepEqual(Object.fromEntries(result.changes.map(change => [change.token, change.status])),
    { design: 'design-only', fresh: 'design-only', gone: 'design-only', local: 'code-only', same: 'converged' });
  assert.deepEqual(Object.fromEntries(result.conflicts.map(conflict => [conflict.token, conflict.reason])),
    { both: 'both-modified', design: 'unmapped-token', fresh: 'token-added', gone: 'token-removed' });
  assert.throws(() => review(base, current, {}), /figmaSnapshot.tokens/);
  assert.equal(review(snapshot({}), snapshot({}), snapshot({ invalid: null })).conflicts[0].reason, 'invalid-color');
});

test('review reads plugin delta rows, retains node evidence and blocks mismatched or duplicated baseline edits', async context => {
  const root = await tempDir(context);
  const cssPath = path.join(root, 'colors.css');
  const base = snapshot({ accent: '#000000', stale: '#123456', duplicate: '#123456' });
  const tokenMap = { accent: '--accent', stale: '--stale', duplicate: '--duplicate' };
  await writeFile(cssPath, ':root { --accent: #000000; --stale: #123456; --duplicate: #123456; }\n');
  const update = (id, before, after) => ({ id, scope: 'token', op: 'update', before: { color: before }, after: { color: after } });
  const node = { id: 'label', boardId: 'desktop/home', scope: 'node', op: 'update',
    before: { text: 'Home' }, after: { text: 'Inbox' } };
  const changes = [node, update('accent', '#000000', '#ffdd00'), update('stale', '#555555', '#eeeeee'),
    update('duplicate', '#123456', '#334455'), update('duplicate', '#123456', '#667788')];
  const result = review(base, base, { version: 1, changes }, { cssPath, tokenMap });
  assert.deepEqual(result.changes[0], { ...node, status: 'design-review' });
  assert.deepEqual(result.figmaChanges, changes);
  assert.deepEqual(result.conflicts.map(item => item.reason).sort(), ['duplicate-export-token', 'snapshot-base-mismatch']);
  assert.match(result.patch, /--accent: #ffdd00/);
  assert.doesNotMatch(result.patch, /#eeeeee|#334455|#667788/);
});

test('review produces an applicable context patch, preserving CRLF, comments, quotes, same-line edits and EOF', async context => {
  const root = await tempDir(context);
  const cssPath = path.join(root, 'theme preview.css');
  const css = [
    '/* --accent: #000000; */',
    ':root { --accent: /* old */ #AbC; --paper: #000000 !important; }',
    '.note::after { content: "}; --accent: #ffffff;"; }',
    '.note { --complex: { --accent: #000000; }; }',
    '@supports (--accent: #abcdef) { body { color: var(--accent); } }',
    ...Array(7).fill('/* context */'),
    ':root { --ink: #778899 }'
  ].join('\r\n');
  await writeFile(cssPath, css);
  const base = snapshot({ accent: '#aabbcc', ink: '#778899', paper: '#000000' });
  const figma = snapshot({ accent: '#Cc8844', ink: '#112233', paper: '#334455' });
  const tokenMap = { accent: '--accent', ink: '--ink', paper: '--paper' };
  const result = review(base, base, figma, { cssPath, tokenMap });
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.patchFile, 'theme preview.css');
  assert.equal(await readFile(cssPath, 'utf8'), css);
  assert.equal(result.patch.match(/^@@ /gm).length, 2);
  const applied = spawnSync('git', ['apply', '-'], { cwd: result.patchRoot, input: result.patch, encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(await readFile(cssPath, 'utf8'), css.replace('#AbC;', '#Cc8844;')
    .replace('#000000 !important', '#334455 !important').replace('#778899 }', '#112233 }'));
});

test('review rejects ambiguous, stale, nonliteral and absent CSS declarations and exports independent safe edits', async context => {
  const root = await tempDir(context);
  const cssPath = path.join(root, 'theme.css');
  const base = snapshot(Object.fromEntries(['dup', 'alias', 'other', 'absent', 'stale', 'expression', 'valid'].map(name => [name, '#000000'])));
  const figma = snapshot(Object.fromEntries(Object.keys(base.tokens).map(name => [name, '#abcdef'])));
  const tokenMap = Object.fromEntries(Object.keys(base.tokens).map(name => [name, `--${name}`]));
  tokenMap.other = '--alias';
  const css = ':root { --dup: #000000; --stale: #111111; --expression: var(--dup); --alias: #000000; --valid: #000000; }\n@media print { :root { --dup: var(--valid); } }\n';
  await writeFile(cssPath, css);
  const result = review(base, base, figma, { cssPath, tokenMap });
  assert.deepEqual(Object.fromEntries(result.conflicts.map(item => [item.token, item.reason])), {
    absent: 'missing-declaration', alias: 'duplicate-mapping', dup: 'duplicate-declaration',
    expression: 'unsupported-css-value', other: 'duplicate-mapping', stale: 'css-value-changed'
  });
  assert.equal(result.patch.match(/#abcdef/g).length, 1);
  assert.match(result.patch, /--valid: #abcdef/);
  assert.equal(await readFile(cssPath, 'utf8'), css);
  const single = snapshot({ valid: '#000000' });
  const edited = snapshot({ valid: '#abcdef' });
  const map = { valid: '--valid' };
  assert.equal(review(single, single, edited, { tokenMap: map }).conflicts[0].reason, 'missing-css-path');
  for (const ambiguous of ['/* incomplete', ':root { --valid: #000000', ':root { --v\\61lid: #000000; }']) {
    await writeFile(cssPath, ambiguous);
    const blocked = review(single, single, edited, { cssPath, tokenMap: map });
    assert.equal(blocked.patch, '');
    assert.equal(blocked.conflicts[0].reason, 'unreadable-css');
  }
});
test('cloud snapshot without observed tokens requires a fresh token read before review', () => {
  const bundle = { project: 'sample', tokens: { accent: '#123456' } };
  const snapshot = { version: 1, project: 'sample', cloud: { tokenCoverage: { status: 'unobserved' } }, changes: [] };
  const result = review(bundle, bundle, snapshot);
  assert.equal(result.patch, '');
  assert.deepEqual(result.conflicts, [{ reason: 'tokens-not-observed' }]);
});
