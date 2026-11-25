import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import { inventory } from '../cli.mjs';
import plugin from '../plugin/code.js';
import { captureWithStub } from './capture.mjs';
import { validateConfig } from './config.mjs';

const fixture = JSON.parse(await readFile(new URL('./return-context.json', import.meta.url)));
const settings = () => ({ ...structuredClone(fixture), timeoutMs: 30 });

function catalogRuntime(fault) {
  let stack = [];
  const reads = [];
  function pageAt(route) {
    const page = { path: route, query: {}, filter: 'all', scrollTop: () => 0,
      data(field) { reads.push(field); return page[field]; } };
    const elements = route === 'pages/catalog/index'
      ? { page: ['#filter', '#open', '#stone'], '#filter': ['#filter-label'], '#open': ['#leaf-title'] }
      : { page: ['#description', '#back'], '#back': ['#back-label'] };
    function query(scope, selector) {
      if (!elements[scope]?.includes(selector) || (selector === '#stone' && page.filter !== 'all')) return [];
      return [{
        $$: child => query(selector, child), text: () => selector,
        offset: () => ({ left: 0, top: 0 }), size: () => ({ width: 10, height: 10 }), style: () => '',
        tap() {
          if (selector === '#filter') page.filter = page.filter === 'all' ? 'leaves' : 'all';
          if (selector === '#open') stack.push(pageAt('pages/leaf/index'));
          if (selector === '#back' && fault !== 'no-op') {
            stack.pop();
            if (fault === 'reset-filter') stack.at(-1).filter = 'all';
            if (fault === 'new-instance') stack[stack.length - 1] = pageAt('pages/catalog/index');
          }
        }
      }];
    }
    page.$$ = selector => query('page', selector);
    return page;
  }
  function connect({ wsEndpoint }) {
    const [width, height] = new URL(wsEndpoint).port === '9421' ? [768, 1024] : [375, 667];
    const encoded = PNG.sync.write(new PNG({ width, height })).toString('base64');
    return {
      systemInfo: () => ({ platform: 'devtools' }), screenshot: () => encoded,
      evaluate: () => ({ windowWidth: width, windowHeight: height }), disconnect() {},
      reLaunch(url) { stack = [pageAt(url.slice(1))]; return stack[0]; },
      currentPage: () => stack.at(-1), pageStack: () => [...stack]
    };
  }
  return { reads, connect };
}

async function outputFor(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'native-return-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, 'capture');
}

test('two continuous paths share one Figma BACK and record distinct observed destinations', async context => {
  const output = await outputFor(context);
  const runtime = catalogRuntime();
  const config = settings();
  Object.assign(config.viewports[0], { width: 375, height: 667 });
  config.viewports.push({ id: 'tablet', wsEndpoint: 'ws://localhost:9421', width: 768, height: 1024 });
  const bundle = await captureWithStub(config, output, runtime);
  assert.equal(inventory(bundle).edges, 10);
  assert.deepEqual(plugin.validate(bundle), bundle.edges);
  assert.deepEqual(bundle.edges.filter(edge => edge.action === 'BACK').map(edge => edge.to), [null, null]);
  assert.deepEqual([...new Set(runtime.reads)], ['filter']);
  const evidence = JSON.parse(await readFile(path.join(output, 'evidence.json')));
  assert.equal(evidence.source, 'contract-stub');
  assert.deepEqual(evidence.scenarios.map(scenario => [scenario.viewport, scenario.id, ...scenario.steps.map(step => step.to)]), [
    ['phone', 'from-all', 'detail', 'all'], ['phone', 'from-leaves', 'leaves', 'detail', 'leaves'],
    ['tablet', 'from-all', 'detail', 'all'], ['tablet', 'from-leaves', 'leaves', 'detail', 'leaves']
  ]);
  for (const scenario of evidence.scenarios) assert.deepEqual(scenario.steps.at(-1).checkedFields, ['filter']);
});

for (const [fault, target] of [['reset-filter', 'leaves'], ['no-op', 'all'], ['new-instance', 'all']]) {
  test(`${fault} fails even with identical PNGs, and publishes no partial capture`, async context => {
    const output = await outputFor(context);
    await assert.rejects(captureWithStub(settings(), output, catalogRuntime(fault)),
      new RegExp(`edge phone/detail#back -> ${target}`));
    assert.deepEqual(await readdir(path.dirname(output)), []);
  });
}

test('rejects an unreachable step, an untested or root BACK, and non-scalar context', () => {
  for (const change of [
    config => { config.scenarios[0].steps = ['missing']; },
    config => { delete config.scenarios; },
    config => { config.scenarios[0] = { id: 'root', entry: 'detail', steps: ['back'] }; },
    config => { config.edges.at(-1).to = 'all'; },
    config => { config.states[0].expectContext = { filter: {} }; }
  ]) {
    const config = settings();
    change(config);
    assert.throws(() => validateConfig(config), /Invalid config/);
  }
});
