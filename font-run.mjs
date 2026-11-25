import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export async function captureFontRun(config, destination, capture) {
  if (config.fontMode === undefined) return capture(config, destination);
  if (!['original', 'controlled'].includes(config.fontMode)) throw Error('Expected fontMode original or controlled');
  const parent = path.dirname(path.resolve(destination));
  const existing = await readdir(destination).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  if (existing.length) throw Error('Choose a new run directory to preserve existing font references');
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(path.join(parent, '.font-run-'));
  try {
    const { rasterProfile, controlledFontFamily, ...source } = config;
    const original = await capture({ ...source, fontMode: 'original' }, path.join(stage, 'original'));
    const result = config.fontMode === 'controlled' ? await capture(config, path.join(stage, 'controlled')) : original;
    await rename(stage, destination);
    return result;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
