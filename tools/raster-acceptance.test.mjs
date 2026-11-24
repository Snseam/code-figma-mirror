import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import { planGeometry } from '../mcp/compact.mjs';
import { transfer } from '../mcp/transfer.mjs';
import { packet, signature } from './cloud-reader.mjs';
import { geometryAudits, workflow } from './raster-acceptance.mjs';

const capture = { version: 1, project: 'Contract', edges: [], tokens: {}, warnings: [], boards: [
  { id: 'phone/open', viewport: 'phone', state: 'open', width: 20, height: 12, children: [
    { id: 'label', name: 'Label', kind: 'text', text: 'A', style: { fontSize: 4 }, x: 2.25, y: 1.5, width: 7.5, height: 5 }
  ] }
] };
const config = { fileKey: 'test-file', sessionId: 'test-session', expectedPngCount: 1,
  sourcePage: { id: '1:2' }, outputPage: { id: '1:3' }, protectedPageIds: [] };

async function setup(context) {
  const parent = path.resolve(import.meta.dirname, '../build/raster-acceptance');
  await mkdir(parent, { recursive: true });
  const temp = await mkdtemp(path.join(parent, 'test-'));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const png = PNG.sync.write(new PNG({ width: 20, height: 12 }));
  await mkdir(path.join(temp, 'source'));
  await writeFile(path.join(temp, 'source/phone--open.png'), png);
  await writeFile(path.join(temp, 'bundle.json'), JSON.stringify(capture));
  return { png, options: { config, dir: path.join(temp, 'run'), captureDir: temp } };
}

test('local preparation, single delivery of unknown writes, and immutable input', async context => {
  const { options } = await setup(context);
  const prepared = await workflow({ ...options, command: 'prepare' });
  assert.equal(prepared.status, 'prepared');
  assert.equal((await workflow({ ...options, command: 'next' })).status, 'awaiting-MCP');
  await assert.rejects(workflow({ ...options, command: 'run' }), /Unknown write outcome/);
  await writeFile(path.join(options.captureDir, 'bundle.json'), JSON.stringify({ ...capture, project: 'Changed' }));
  await assert.rejects(workflow({ ...options, command: 'prepare' }), /input or evidence changed/);
});

test('synthetic MCP and PNG replies exercise the render pipeline and both audit baselines', async context => {
  const { options, png } = await setup(context);
  const ids = { sourcePageId: '1:2', outputPageId: '1:3', transferFrameId: '1:4', sectionId: '1:5' };
  const origin = { fileKey: config.fileKey, source: '1:2', output: '1:3', frame: '1:4', section: '1:5',
    stamp: signature(JSON.stringify(capture)) };
  const batches = transfer(capture, { stagingPageId: origin.source });
  const planned = planGeometry(capture);
  const label = planned.boards[0].children[0];
  const textRow = ['1:7', '1:6', 0, 'TEXT', label.x, label.y, label.width, label.height, 'A', 4];
  const board = packet({ format: 'ui-parity-board/1', board: 'phone/open' }, 1, { ...origin, board: 'phone/open',
    frames: ['1:6'], rows: [['1:6', '1:5', 0, 'FRAME', 25, 25, 20, 12], textRow], reactions: [], instances: [] });
  const tokens = packet({ format: 'ui-parity-tokens/1' }, 1, { ...origin, collectionId: 'v1', modeId: 'm1', rows: [],
    collectionName: `UI parity v2 / Contract [1:4 ${origin.stamp}] / 1:5` });
  const calls = [];
  const getClient = async () => ({
    async call(tool, args) {
      calls.push(args.description ?? tool);
      assert.equal(args.fileKey, config.fileKey);
      assert.equal(args.sessionId, config.sessionId);
      if (tool === 'download_assets') {
        assert.deepEqual([args.nodeId, args.defaultFormat, args.defaultScale], ['1:6', 'png', 1]);
        return { structuredContent: { export: { url: 'https://figma.invalid/fixture.png' } } };
      }
      if (args.description.startsWith('Transfer')) return { ...ids, complete: true, received: batches.chunks, total: batches.chunks, sha256: batches.sha256 };
      if (args.description.startsWith('Render')) return { ...ids, stage: Number(args.description.split(' ').at(-1)) };
      if (args.description.startsWith('Read')) return { content: [{ type: 'text', text: JSON.stringify({ result: args.description.includes('tokens') ? tokens : board }) }] };
      return { ...ids, boards: { 'phone/open': '1:6' } };
    },
    close() {}
  });
  const result = await workflow({ ...options, command: 'run', getClient, fetchAsset: async () => new Response(png) });
  assert.equal(result.domAuditPassed, false);
  assert.equal(result.planAuditPassed, true);
  assert.equal(result.passed, true);
  assert.equal(calls.filter(name => name === 'download_assets').length, 1);
  const saved = async name => JSON.parse(await readFile(path.join(options.dir, name)));
  const audits = await saved('audit-dom.json');
  assert.equal(audits.tolerance, 0);
  assert(audits.issues.some(issue => issue.field === 'width' && issue.expected === 7.5 && issue.actual === label.width));
  const snapshot = await saved('figma/design-diff.json');
  const measured = snapshot.observed.geometry.find(row => row.id === 'label');
  measured.width += 1 / 64;
  const drift = geometryAudits(capture, planned, snapshot).plan;
  assert.equal(drift.passed, false);
  assert.equal(drift.maxDeviation, 1 / 64);
  snapshot.observed.geometry[0].width -= 0.25;
  assert.equal(geometryAudits(capture, planned, snapshot).plan.maxDeviation, 0.25);
  assert.deepEqual(await workflow({ ...options, command: 'run' }), result);
  const preflight = path.join(options.captureDir, 'preflight.json');
  await writeFile(preflight, JSON.stringify(config));
  const imported = path.join(options.captureDir, 'supplied');
  const sourceBundle = path.join(options.captureDir, 'transfer-input.json');
  await writeFile(sourceBundle, JSON.stringify(capture));
  await writeFile(path.join(options.captureDir, 'bundle.json'), JSON.stringify({ ...capture, rasterProfile: { name: 'visual-only' } }));
  const finish = spawnSync(process.execPath, [path.join(import.meta.dirname, 'raster-acceptance.mjs'), 'finish',
    '--frame', origin.frame, '--section', origin.section, '--preflight', preflight,
    '--bundle', sourceBundle, '--capture', options.captureDir, '--replies', path.join(options.dir, 'replies'), '--png', path.join(options.dir, 'figma'),
    '--dir', imported], { encoding: 'utf8' });
  assert.equal(finish.status, 0, finish.stderr);
  assert.equal(JSON.parse(finish.stdout).rendererChecks, 'not-run-in-finish');
  assert.notEqual(JSON.parse(finish.stdout).sourceSha256, JSON.parse(finish.stdout).visualBundleSha256);
  const dual = spawnSync(process.execPath, [path.join(import.meta.dirname, 'raster-acceptance.mjs'), 'audit',
    '--snapshot', path.join(imported, 'figma/design-diff.json'), '--bundle', sourceBundle, '--dir', imported], { encoding: 'utf8' });
  assert.equal(dual.status, 0, dual.stderr);
  assert.equal(JSON.parse(dual.stdout).domAuditPassed, false);
});
