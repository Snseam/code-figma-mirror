import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import { inventory } from '../cli.mjs';
import figmaPlugin from '../plugin/code.js';
import { captureWithStub } from './capture.mjs';
import { validateConfig } from './config.mjs';
import { screenshotSpace } from './measure.mjs';

const sample = JSON.parse(await readFile(new URL('./example.json', import.meta.url)));
const config = () => ({ ...structuredClone(sample), timeoutMs: 25 });
const windowInfo = { windowWidth: 40, windowHeight: 50, screenWidth: 40, screenHeight: 65, screenTop: 10 };

function png(width, height) {
  const image = new PNG({ width, height });
  image.data.fill(180);
  return PNG.sync.write(image);
}

async function outputFor(context) {
  const root = await mkdtemp(path.join(import.meta.dirname, '.stub-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, 'out');
}

function double(options = {}) {
  const events = [];
  const image = options.image ?? png(80, 130);
  let page;
  let title;
  let expanded;
  const styles = {
    'background-color': 'rgb(0, 17, 255)', opacity: '0.8', 'border-top-width': '1px',
    'border-top-color': '#abc', 'border-top-left-radius': '6px', overflow: 'hidden',
    'font-family': '"Test Sans", sans-serif', 'font-weight': '600', 'font-style': 'italic',
    'font-size': '12px', 'line-height': '18px', 'letter-spacing': '-0.75px', color: 'rgba(32, 64, 96, 0.5)', 'text-align': 'center'
  };
  function query(scope, selector) {
    const allowed = {
      page: ['#card', '#field', '#toggle', '#expanded', '#collapsed'],
      '#card': ['#title', '#toggle', '#detail'],
      '#toggle': ['#expanded', '#collapsed']
    };
    if (!allowed[scope]?.includes(selector) || selector === options.missing) return [];
    if ((selector === '#expanded' || selector === '#detail') && !expanded) return [];
    if (selector === '#collapsed' && expanded) return [];
    const element = {
      $$: child => query(selector, child),
      offset: () => selector === '#card' ? { left: 3, top: 11 } : { left: 5, top: 18 },
      size: () => ({ width: 20, height: 10 }),
      style: field => styles[field] ?? '',
      text: () => selector === '#title' ? title : selector,
      input(value) { events.push(['input', value]); },
      tap() {
        events.push(['tap', selector]);
        if (options.nextRoute) page = makePage(options.nextRoute);
        if (!options.noTap) expanded = !expanded;
      }
    };
    return selector === options.ambiguous ? [element, element] : [element];
  }
  function makePage(url) {
    const [pathname, queryString] = url.split('?');
    return {
      path: pathname.slice(1), query: Object.fromEntries(new URLSearchParams(queryString)),
      async setData(data) { title = data.title; expanded = data.expanded; events.push(['data', title]); },
      $$: selector => query('page', selector), scrollTop: () => 7
    };
  }
  const program = {
    systemInfo: () => ({ platform: options.platform ?? 'devtools' }),
    evaluate(fn) { assert.match(fn.toString(), /wx\.getWindowInfo\(\)/); return windowInfo; },
    reLaunch(url) { events.push(['reLaunch', url]); expanded = false; return page = makePage(url); },
    currentPage: () => page,
    screenshot() { events.push(['screenshot']); return image.toString('base64'); },
    disconnect() { events.push(['disconnect']); }
  };
  const sdk = {
    connect({ wsEndpoint }) {
      events.push(['connect', wsEndpoint]);
      if (options.offline) throw new Error('unavailable');
      return program;
    }
  };
  return { sdk, events, image };
}

test('stub run produces compatible IR, actual supplied bytes and explicit synthetic provenance', async context => {
  const out = await outputFor(context);
  const stub = double();
  const settings = config();
  settings.viewports.push({ ...settings.viewports[0], id: 'tablet', wsEndpoint: 'ws://localhost:9421', width: 40 });
  await captureWithStub(settings, out, stub.sdk);
  const bundle = JSON.parse(await readFile(path.join(out, 'bundle.json')));
  const evidence = JSON.parse(await readFile(path.join(out, 'evidence.json')));
  assert.equal(evidence.source, 'contract-stub');
  assert.match(bundle.warnings.join(' '), /synthetic/);
  assert.equal(evidence.boards.length, 4);
  assert.equal(inventory(bundle).edges, 4);
  assert.deepEqual(figmaPlugin.validate(bundle), bundle.edges);
  assert.deepEqual(bundle.edges[0], { from: 'phone/closed', to: 'phone/open', source: 'phone/closed#toggle', action: 'NAVIGATE' });
  assert.deepEqual(bundle.tokens, {});
  const board = bundle.boards[0];
  assert.deepEqual([board.width, board.height], [80, 130]);
  const frame = board.children[0];
  assert.deepEqual([frame.x, frame.y, frame.width, frame.height], [6, 28, 40, 20]);
  assert.deepEqual(frame.style, { fill: '#0011FF', strokeWidth: 2, stroke: '#AABBCC', radius: 12, clip: true, opacity: 0.8 });
  const title = frame.children[0];
  assert.deepEqual([title.x, title.y, title.text], [4, 14, '白桦叶']);
  assert.deepEqual(title.style, {
    fontFamily: 'Test Sans', fontSize: 24, lineHeight: 36, letterSpacing: -1.5, color: '#204060', align: 'CENTER',
    fontStyle: 'Semi Bold Italic', opacity: 0.4
  });
  assert.equal(frame.children[1].component, '展开按钮');
  for (const item of evidence.boards) assert.deepEqual(await readFile(path.join(out, item.file)), stub.image);
  assert.equal(stub.events.filter(([event]) => event === 'disconnect').length, 2);
  assert.deepEqual(stub.events.slice(0, 4), [
    ['connect', 'ws://127.0.0.1:9420'], ['reLaunch', '/pages/sample/index'], ['data', '白桦叶'], ['screenshot']
  ]);
});

test('reacquires current page after tap and waits for final path/query', async context => {
  const out = await outputFor(context);
  const settings = config();
  const state = settings.states[1];
  settings.states = [state];
  settings.edges = [];
  state.expectPath = '/pages/detail/index?item=leaf';
  state.steps.unshift({ action: 'waitFor', selector: '#field' }, { action: 'input', selector: '#field', value: 'leaf' });
  state.steps.push({ action: 'waitForPage', path: state.expectPath });
  const stub = double({ nextRoute: state.expectPath });
  const bundle = await captureWithStub(settings, out, stub.sdk);
  assert.equal(bundle.boards.length, 1);
  assert.ok(stub.events.some(([action, value]) => action === 'input' && value === 'leaf'));
});

test('PNG coordinate space supports window-only screenshots and rejects unaligned or damaged images', () => {
  assert.deepEqual(screenshotSpace(png(80, 100), windowInfo), { width: 80, height: 100, scale: 2, top: 0, area: 'window' });
  assert.throws(() => screenshotSpace(png(80, 105), windowInfo), /Cannot align/);
  assert.throws(() => screenshotSpace(png(80, 130), { ...windowInfo, screenTop: undefined }), /Cannot align/);
  assert.throws(() => screenshotSpace(Buffer.from('not a PNG'), windowInfo));
});

for (const [label, options, message] of [
  ['offline', { offline: true }, /DEVTOOLS_NOT_CONNECTED/],
  ['phone', { platform: 'ios' }, /DEVICE_SCREENSHOT_UNSUPPORTED/],
  ['unknown runtime', { platform: 'web' }, /UNSUPPORTED_RUNTIME/],
  ['missing child', { missing: '#detail' }, /phone\/open.*missing WXML/],
  ['ambiguous selector', { ambiguous: '#title' }, /Ambiguous WXML/],
  ['invalid screenshot', { image: Buffer.from('broken') }, /phone\/closed/]
]) {
  test(`${label} produces no partial native results`, async context => {
    const out = await outputFor(context);
    const stub = double(options);
    await assert.rejects(captureWithStub(config(), out, stub.sdk), message);
    assert.deepEqual(await readdir(path.dirname(out)), []);
    if (!options.offline) assert.deepEqual(stub.events.at(-1), ['disconnect']);
    if (options.platform) assert.equal(stub.events.length, 2);
  });
}

test('a no-op tap cannot create an edge between states seeded with different data', async context => {
  const settings = config();
  settings.states[1].data.expanded = true;
  settings.states[1].steps = [];
  const out = await outputFor(context);
  await assert.rejects(captureWithStub(settings, out, double({ noTap: true }).sdk), /waiting for edge/);
  assert.deepEqual(await readdir(path.dirname(out)), []);
});

test('a matching target route and ready marker with different rendered text rejects the edge', async context => {
  const settings = config();
  settings.states[1].data.title = '柳叶';
  const out = await outputFor(context);
  await assert.rejects(captureWithStub(settings, out, double().sdk), /waiting for edge phone\/closed/);
  assert.deepEqual(await readdir(path.dirname(out)), []);
});

test('rejects unsafe IDs, HTML, phantom edges, ambiguous targets and viewport mismatches', async context => {
  for (const edit of [
    settings => { settings.states[0].id = '../output'; },
    settings => { settings.states[0].url = './example.html'; },
    settings => { settings.edges[0].source = 'unknown'; },
    settings => { settings.edges[0].to = 'unknown'; },
    settings => { settings.edges.push(settings.edges[0]); },
    settings => { settings.states[0].selectors[0].children[0].id = 'toggle'; }
  ]) {
    const settings = config();
    edit(settings);
    assert.throws(() => validateConfig(settings), /Invalid config/);
  }
  const out = await outputFor(context);
  const same = config();
  same.states[1] = { ...structuredClone(same.states[0]), id: 'open' };
  await assert.rejects(captureWithStub(same, out, double().sdk), /target already matches/);
  const mismatch = config();
  mismatch.viewports[0].height = 80;
  await assert.rejects(captureWithStub(mismatch, out, double().sdk), /expected window height 80, observed 50/);
});

test('preserves existing output', async context => {
  const root = path.dirname(await outputFor(context));
  const marker = path.join(root, 'prior');
  await writeFile(marker, 'keep');
  const stub = double();
  await assert.rejects(captureWithStub(config(), root, stub.sdk), /new or empty/);
  assert.deepEqual(stub.events, []);
  assert.equal(await readFile(marker, 'utf8'), 'keep');
});
