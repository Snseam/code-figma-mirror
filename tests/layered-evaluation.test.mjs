import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { audit } from '../audit.mjs';
import { verify } from '../verify.mjs';

function solidPng(width, height, [r, g, b, a = 255]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
  }
  return png;
}

function baseBundle(extraTextProps = {}) {
  return {
    version: 1,
    project: 'layered-test',
    tokens: {},
    components: [{ id: 'btn', name: 'Button', variants: ['primary'] }],
    edges: [],
    boards: [{
      id: 'desktop/home',
      viewport: 'desktop',
      state: 'home',
      width: 200,
      height: 100,
      captureIntegrity: {
        beforeSha256: 'abc',
        afterSha256: 'abc',
        animationsBefore: 0,
        animationsAfter: 0,
        resourcesReady: true
      },
      children: [
        {
          id: 'desktop/home#label/text-1@0',
          kind: 'text',
          name: 'Title',
          x: 10,
          y: 10,
          width: 60,
          height: 20,
          text: 'Hello',
          singleLine: true,
          style: { align: 'LEFT' },
          ...extraTextProps
        },
        {
          id: 'desktop/home#sibling',
          kind: 'frame',
          name: 'Box',
          x: 80,
          y: 10,
          width: 40,
          height: 20,
          style: { fill: '#ffffff' }
        }
      ]
    }]
  };
}

test('audit separates valid single-line textFit compensation from outer layout issues and lineCount mismatches', () => {
  const bundle = baseBundle();
  const validSnapshot = {
    project: 'layered-test',
    boards: [{ id: 'desktop/home', width: 200, height: 100, status: 'exported' }],
    observed: {
      geometry: [
        { boardId: 'desktop/home', id: 'desktop/home', x: 0, y: 0, width: 200, height: 100, type: 'FRAME' },
        {
          boardId: 'desktop/home',
          id: 'desktop/home#label/text-1@0',
          x: 10,
          y: 10,
          width: 63,
          height: 20,
          type: 'TEXT',
          text: 'Hello',
          lineCount: 1,
          textFit: { x: 10, width: 63, height: 20 }
        },
        { boardId: 'desktop/home', id: 'desktop/home#sibling', x: 80, y: 10, width: 40, height: 20, type: 'FRAME' }
      ],
      instances: [],
      componentLinks: [],
      edges: []
    }
  };
  const ok = audit(bundle, validSnapshot);
  assert.equal(ok.passed, true);
  assert.equal(ok.boardMetrics['desktop/home'].rawGeometryIssues, 1);
  assert.equal(ok.boardMetrics['desktop/home'].compensatedFields, 1);
  assert.equal(ok.boardMetrics['desktop/home'].layoutIssues, 0);
  assert.equal(ok.boardMetrics['desktop/home'].matchedLines, 1);

  const wrappedSnapshot = structuredClone(validSnapshot);
  wrappedSnapshot.observed.geometry[1].lineCount = 2;
  wrappedSnapshot.observed.geometry[1].textFit = { x: 10, width: 85, height: 20 };
  const bad = audit(bundle, wrappedSnapshot);
  assert.equal(bad.passed, false);
  assert.ok(bad.issues.some(issue => issue.issue === 'line-count-mismatch'));
  assert.ok(bad.issues.some(issue => issue.issue === 'invalid-text-fit'));
  assert.ok(bad.boardMetrics['desktop/home'].layoutIssues > 0);
});

test('verify records captureIntegrity, perceptual SSIM/DeltaE76, and ROI metrics while preserving pixel gate', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'layered-verify-'));
  const sourceDir = path.join(root, 'source');
  const figmaDir = path.join(root, 'figma');
  const outDir = path.join(root, 'out');
  await Promise.all([mkdir(sourceDir), mkdir(figmaDir)]);

  const bundle = baseBundle();
  await writeFile(path.join(root, 'bundle.json'), JSON.stringify(bundle));
  const srcPng = solidPng(200, 100, [255, 255, 255]);
  const figPng = solidPng(200, 100, [255, 255, 255]);
  for (let y = 10; y < 20; y++) {
    for (let x = 10; x < 20; x++) {
      const idx = (y * 200 + x) * 4;
      figPng.data[idx] = 200;
      figPng.data[idx + 1] = 200;
      figPng.data[idx + 2] = 200;
    }
  }
  await writeFile(path.join(sourceDir, 'desktop--home.png'), PNG.sync.write(srcPng));
  await writeFile(path.join(figmaDir, 'desktop--home.png'), PNG.sync.write(figPng));
  await writeFile(path.join(figmaDir, 'design-diff.json'), JSON.stringify({
    boards: [{ id: 'desktop/home', file: 'desktop--home.png' }]
  }));

  const report = await verify(root, figmaDir, outDir, { pixelTolerance: 16, maxDiffRatio: 0.01 });
  assert.equal(report.passed, true);
  const [board] = report.boards;
  assert.equal(board.captureIntegrity.status, 'verified');
  assert.ok(board.ssim8 > 0.9 && board.ssim8 < 1);
  assert.ok(board.meanDeltaE76 > 0);
  assert.equal(board.roiSummary.total, 1);
  assert.equal(board.roiSummary.affected, 1);
  assert.equal(board.roiSummary.worst[0].id, 'desktop/home#label/text-1@0');
  const html = await readFile(path.join(outDir, 'report.html'), 'utf8');
  assert.match(html, /采集完整性：verified/);
  assert.match(html, /SSIM/);
});
