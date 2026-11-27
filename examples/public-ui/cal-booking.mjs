import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const out = process.argv[2];
if (!out) throw Error('Pass a directory for the generated scenarios.json');
const viewport = { width: 1280, height: 900 };
const url = 'https://cal.com/rick/get-rick-rolled';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const day = page.locator('button[data-testid=day][data-disabled=false][aria-pressed=false]').first();
  await day.waitFor();
  const dayLabel = await day.getAttribute('aria-label');
  const daySelector = `button[data-testid=day][aria-label=${JSON.stringify(dayLabel)}]`;
  await day.click();
  const settledPanel = '[data-testid=booker-container] > [style*="opacity: 1;"][style*="transform: none"]';
  const time = page.locator(`${settledPanel} button[data-testid=time][data-disabled=false][aria-label^=${JSON.stringify(dayLabel + ' at ')}]`).first();
  await time.waitFor();
  const timeSelector = `button[data-time=${JSON.stringify(await time.getAttribute('data-time'))}]`;
  const config = {
    project: 'cal-public-booking', viewports: [{ id: 'desktop', ...viewport }],
    states: [
      { id: 'calendar', url, ready: daySelector },
      { id: 'times', url, steps: [{ click: daySelector }], ready: `${settledPanel} ${timeSelector}` },
      { id: 'details', url, steps: [{ click: daySelector }, { click: `${settledPanel} ${timeSelector}` }], ready: `${settledPanel} form input[name=name]` }
    ],
    components: [
      { selector: 'button[data-testid=day][aria-pressed=true]', name: 'Calendar Day', variant: 'Selected' },
      { selector: 'button[data-testid=day][data-disabled=true]', name: 'Calendar Day', variant: 'Disabled' },
      { selector: 'button[data-testid=day]', name: 'Calendar Day', variant: 'Available' },
      { selector: 'button[data-testid=time]', name: 'Time Slot' }
    ],
    edges: [
      { from: 'calendar', to: 'times', selector: daySelector },
      { from: 'times', to: 'details', selector: timeSelector }
    ]
  };
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'scenarios.json'), JSON.stringify(config, null, 2));
  console.log(`Selected ${daySelector} and ${timeSelector}`);
} finally {
  await browser.close();
}
