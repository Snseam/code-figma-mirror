import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { verify } from '../../verify.mjs';

const output = process.argv[2];
if (!output) throw Error('Pass an output directory for the visual reports');
const results = JSON.parse(await readFile(new URL('./results.json', import.meta.url), 'utf8'));
const temp = await mkdtemp(path.join(tmpdir(), 'public-ui-pixels-'));
try {
  for (const [project, boards] of Object.entries(Object.groupBy(results.boards, row => row.project))) {
    const captureDir = path.join(temp, project);
    const referenceDir = path.join(captureDir, 'source');
    const exportDir = path.join(captureDir, 'figma');
    await Promise.all([mkdir(referenceDir, { recursive: true }), mkdir(exportDir, { recursive: true })]);
    const specs = [];
    for (const row of boards) {
      const strip = PNG.sync.read(await readFile(new URL(row.evidence, import.meta.url)));
      assert.equal(strip.width, row.width * 3);
      assert.equal(strip.height, row.height);
      const [viewport, state] = row.board.split('/');
      for (const [index, dest, digest] of [[0, referenceDir, row.sourcePixelSHA256], [1, exportDir, row.figmaPixelSHA256]]) {
        const panel = new PNG({ width: row.width, height: row.height });
        PNG.bitblt(strip, panel, index * row.width, 0, row.width, row.height, 0, 0);
        assert.equal(createHash('sha256').update(panel.data).digest('hex'), digest, `${project}/${row.board} panel ${index}`);
        await writeFile(path.join(dest, `${viewport}--${state}.png`), PNG.sync.write(panel));
      }
      specs.push({ id: row.board, width: row.width, height: row.height, viewport, state });
    }
    await writeFile(path.join(captureDir, 'bundle.json'), JSON.stringify({ version: 1, project, boards: specs }));
    const reportDir = path.join(output, project);
    const report = await verify(captureDir, exportDir, reportDir, results);
    for (const [index, board] of report.boards.entries()) {
      assert.equal(board.diffPixels, boards[index].diffPixels, `${project}/${board.id} changed pixel count`);
    }
    if (!report.passed) process.exitCode = 2;
    console.log(`${project}: ${report.boards.filter(board => board.passed).length}/${boards.length} passed · ${reportDir}/report.html`);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
