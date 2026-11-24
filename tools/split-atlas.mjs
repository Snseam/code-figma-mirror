import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';

const [atlasFile, boundsFile, outDir] = process.argv.slice(2);
if (!atlasFile || !boundsFile || !outDir) throw new Error('Usage: node tools/split-atlas.mjs <actual-figma.png> <bounds.json> <out-dir>');
const atlas = PNG.sync.read(await readFile(atlasFile));
const layout = JSON.parse(await readFile(boundsFile, 'utf8'));
if (layout.width !== atlas.width || layout.height !== atlas.height) throw new Error('Expected a 1× Figma render of the specified bounds');
const output = new Map();
for (const { id, x, y, width, height } of layout.boards) {
  if (!/^[\w-]+\/[\w-]+$/u.test(id)) throw new Error(`Unsupported board ID: ${id}`);
  if (![x, y, width, height].every(Number.isSafeInteger) || width < 1 || height < 1 ||
      x < 0 || y < 0 || x + width > atlas.width || y + height > atlas.height) throw new Error(`Invalid Figma bounds for ${id}`);
  const filename = `${id.replace('/', '--')}.png`;
  if (output.has(filename)) throw new Error(`Duplicate board ${id}`);
  const board = new PNG({ width, height });
  PNG.bitblt(atlas, board, x, y, width, height, 0, 0);
  output.set(filename, PNG.sync.write(board));
}
await mkdir(outDir, { recursive: true });
for (const [name, bytes] of output) await writeFile(path.join(outDir, name), bytes);
console.log(`Extracted ${output.size} unscaled Figma renders`);
