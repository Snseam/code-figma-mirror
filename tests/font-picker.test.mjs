import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

test('the plugin chooses the corresponding capture with the keyboard and keeps single-file import available', async context => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mirror-font-picker-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  for (const mode of ['original', 'controlled']) {
    await mkdir(path.join(dir, mode));
    await writeFile(path.join(dir, mode, 'bundle.json'), JSON.stringify({ fontMode: mode }));
  }
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 420, height: 560 } });
  await page.goto(new URL('../plugin/ui.html', import.meta.url).href);
  await page.evaluate(() => {
    window.imports = [];
    window.addEventListener('message', event => {
      if (event.data?.pluginMessage?.type === 'import') {
        window.imports.push(JSON.parse(event.data.pluginMessage.text).fontMode ?? 'legacy');
        window.postMessage({ pluginMessage: { type: 'done', text: 'OK' } }, '*');
      }
    });
  });
  await page.locator('#directory').setInputFiles(dir);
  const original = page.getByRole('radio', { name: '严格对齐原字体' });
  assert.equal(await original.isChecked(), true);
  await original.focus();
  await page.keyboard.press('ArrowRight');
  assert.deepEqual(await page.evaluate(() => window.imports), []);
  const submit = page.getByRole('button', { name: '导入项目' });
  await submit.click();
  await page.waitForFunction(() => window.imports.length === 1);
  await original.check();
  await submit.click();
  await page.waitForFunction(() => window.imports.length === 2);
  await page.locator('#file').setInputFiles({ name: 'bundle.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await submit.click();
  await page.waitForFunction(() => window.imports.length === 3);
  assert.deepEqual(await page.evaluate(() => window.imports), ['controlled', 'original', 'legacy']);
});
