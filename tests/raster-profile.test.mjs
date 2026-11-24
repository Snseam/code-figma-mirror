import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { capture } from '../capture.mjs';
import { loadScenarios } from '../cli.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const profilePath = fileURLToPath(new URL('../examples/inbox/raster-profile.json', import.meta.url));
const profile = JSON.parse(await readFile(profilePath, 'utf8'));
const run = promisify(execFile);

async function fixture(context) {
  const dir = await mkdtemp(path.join(tmpdir(), 'parity-raster-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const scenarios = path.join(dir, 'scenarios.json');
  await writeFile(path.join(dir, 'page.html'), '<main style="font-family:serif"><b>Field notes</b><p>Sample</p></main>');
  await writeFile(scenarios, JSON.stringify({
    project: 'Raster', states: [{ id: 'open', url: './page.html', ready: 'main' }],
    viewports: [{ id: 'phone', width: 375, height: 700 }]
  }));
  return { dir, scenarios, out: path.join(dir, 'capture') };
}

test('resolves the profile and font relative to their declaring files and checks bytes before capture', async context => {
  const { dir, scenarios, out } = await fixture(context);
  const localProfile = path.join(dir, 'profile.json');
  await writeFile(localProfile, JSON.stringify({ ...profile, fontFile: 'font.ttf' }));
  const input = JSON.parse(await readFile(scenarios, 'utf8'));
  await writeFile(scenarios, JSON.stringify({ ...input, rasterProfile: 'profile.json' }));
  const config = await loadScenarios(scenarios);
  assert.equal(config.rasterProfile.fontFile, path.join(dir, 'font.ttf'));
  assert.deepEqual(config, await loadScenarios(scenarios, localProfile));
  await assert.rejects(capture(config, out), { code: 'ENOENT' });
  await writeFile(config.rasterProfile.fontFile, 'unexpected font bytes');
  await assert.rejects(capture(config, out), /Raster font SHA-256 mismatch/);
  await assert.rejects(access(out), { code: 'ENOENT' });

  const { rasterProfile, ...original } = config;
  await capture(original, out);
  const outputs = ['source/phone--open.png', 'bundle.json'];
  const readOutputs = () => Promise.all(outputs.map(file => readFile(path.join(out, file))));
  const before = await readOutputs();
  rasterProfile.sha256 = createHash('sha256').update('unexpected font bytes').digest('hex');
  await assert.rejects(capture(config, out), /separate output directory/);
  assert.deepEqual(await readOutputs(), before);
});

test('CLI repeats the controlled PNG with verified Arimo glyphs and preserves the controlled baseline', async context => {
  const fontFile = process.env.UI_PARITY_ARIMO_TTF ?? path.resolve(path.dirname(profilePath), profile.fontFile);
  try { await access(fontFile); }
  catch (error) {
    if (error.code !== 'ENOENT' || process.env.UI_PARITY_ARIMO_TTF) throw error;
    return context.skip('Pinned Arimo fixture missing. See examples/inbox/raster-capture.md.');
  }
  const { dir, scenarios, out } = await fixture(context);
  const localProfile = path.join(dir, 'profile.json');
  await writeFile(localProfile, JSON.stringify({ ...profile, fontFile }));
  const args = [cli, 'capture', scenarios, out, '--raster-profile', localProfile];
  await run(process.execPath, args);
  const bundleFile = path.join(out, 'bundle.json');
  const imageFile = path.join(out, 'source/phone--open.png');
  const baseline = await readFile(bundleFile, 'utf8');
  const image = await readFile(imageFile);
  const bundle = JSON.parse(baseline);
  const { fontFile: _localPath, ...metadata } = profile;
  assert.deepEqual(bundle.rasterProfile, metadata);
  const fonts = bundle.boards[0].fontEvidence.flatMap(host => host.fonts);
  assert.deepEqual(new Set(fonts.map(font => font.postScriptName)), new Set(['Arimo-Regular', 'Arimo-Bold']));
  assert.ok(fonts.every(font => font.isCustomFont && font.glyphCount > 0));
  await run(process.execPath, args);
  await assert.rejects(capture(await loadScenarios(scenarios), out), /separate output directory/);
  await writeFile(path.join(dir, 'page.html'), '<main style="-webkit-font-smoothing:auto !important">Wrong smoothing</main>');
  await assert.rejects(run(process.execPath, args), /Raster text style mismatch/);
  assert.equal(await readFile(bundleFile, 'utf8'), baseline);
  assert.deepEqual(await readFile(imageFile), image);
});
