import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { capture } from '../capture.mjs';

async function fixture(context, html) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mirror-stable-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const url = path.join(dir, 'index.html');
  await writeFile(url, html);
  const config = { project: 'Stable capture', viewports: [{ id: 'desktop', width: 240, height: 160 }],
    states: [{ id: 'open', url, ready: 'dialog:modal' }] };
  return { dir, config };
}

test('native dialog, backdrop and reference pixels share the settled paint', async context => {
  const { dir, config } = await fixture(context, `<style>
    dialog::backdrop { backdrop-filter:blur(4px);animation:shade .4s linear both }
    @keyframes shade { from{background:#fff} to{background:#00ff00} }
    </style><dialog>编辑 Edit</dialog><script>document.querySelector('dialog').showModal()</script>`);
  const result = await capture(config, dir);
  const [, backdrop, dialog] = result.boards[0].children;
  assert.equal(backdrop.name, '::backdrop');
  assert.deepEqual([backdrop.width, backdrop.height, backdrop.style.backdropBlur, backdrop.style.fill.toLowerCase()],
    [240, 160, 4, '#00ff00']);
  assert.equal(dialog.children[0].singleLine, true);
  assert.equal(dialog.children[0].text, '编辑 Edit');
  const png = PNG.sync.read(await readFile(path.join(dir, 'source/desktop--open.png')));
  assert.deepEqual([...png.data.slice(0, 4)], [0, 255, 0, 255]);
});

test('a perpetually animated viewport fails without publishing a baseline', async context => {
  const { dir, config } = await fixture(context, `<style>dialog{animation:pulse 2s infinite alternate}
    @keyframes pulse{from{opacity:.2}to{opacity:1}}</style><dialog>Busy</dialog>
    <script>document.querySelector('dialog').showModal()</script>`);
  await assert.rejects(capture(config, dir), /Unstable viewport.*active animations: pulse/);
  await assert.rejects(readFile(path.join(dir, 'bundle.json')), { code: 'ENOENT' });
});
