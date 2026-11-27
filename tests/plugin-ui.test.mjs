import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

test('nested plugin UI accepts replies from the Figma editor or its parent', async context => {
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<iframe name="sandbox"></iframe>');
  await page.frame({ name: 'sandbox' }).setContent('<iframe name="plugin"></iframe>');
  const plugin = page.frame({ name: 'plugin' });
  await plugin.setContent(await readFile(new URL('../plugin/ui.html', import.meta.url), 'utf8'));

  const statuses = await plugin.evaluate(() => {
    const send = (source, origin, text) => {
      window.dispatchEvent(new MessageEvent('message', {
        source, origin, data: { pluginMessage: { type: 'done', text } },
      }));
      return document.querySelector('#status').textContent;
    };
    return [
      send(window.top, 'https://example.org', 'unexpected origin'),
      send(window, 'https://www.figma.com', 'unexpected sender'),
      send(window.top, 'https://www.figma.com', 'exported'),
      send(window.parent, 'null', 'imported'),
    ];
  });
  assert.deepEqual(statuses, ['', '', 'exported', 'imported']);
});
