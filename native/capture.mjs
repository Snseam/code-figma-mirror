#!/usr/bin/env node
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { prepareConfig } from './config.mjs';
import { captureFontRun } from '../font-run.mjs';
import { locate, measureNodes, MissingNode, screenshotSpace } from './measure.mjs';

async function until(probe, description, timeout) {
  const deadline = Date.now() + timeout;
  do {
    const result = await probe();
    if (result) return result;
    if (Date.now() >= deadline) break;
    await delay(Math.min(80, deadline - Date.now()));
  } while (true);
  throw new Error(`Timed out waiting for ${description}`);
}

function onRoute(page, route) {
  if (!page) return false;
  const [pathname, query] = route.split(/\?(.*)/s);
  return `/${page.path}` === pathname &&
    [...new URLSearchParams(query)].every(([key, value]) => page.query?.[key] === value);
}

async function observedPage(program, state) {
  const page = await program.currentPage();
  if (!onRoute(page, state.expectPath ?? state.path)) return null;
  if (state.ready && !await locate(page, state.ready)) return null;
  for (const [field, expected] of Object.entries(state.expectContext ?? {})) {
    if (await page.data(field) !== expected) return null;
  }
  return page;
}

async function enter(program, state, timeout) {
  const first = await program.reLaunch(state.path);
  if (!onRoute(first, state.path)) throw new Error(`reLaunch did not reach ${state.path}`);
  if (state.data) await first.setData(state.data);
  for (const step of state.steps ?? []) {
    if (step.action === 'waitForPage') {
      await until(async () => onRoute(await program.currentPage(), step.path), step.path, timeout);
    } else {
      const element = await until(async () => {
        const page = await program.currentPage();
        return page && locate(page, step.selector);
      }, JSON.stringify(step.selector), timeout);
      if (step.action === 'tap') await element.tap();
      if (step.action === 'input') await element.input(step.value);
    }
  }
  return until(() => observedPage(program, state), `${state.id} route and ready selector`, timeout);
}

async function captureBoard(program, viewport, state, stage, bundle, evidence, timeout) {
  const id = `${viewport.id}/${state.id}`;
  const page = await enter(program, state, timeout);
  const info = await program.evaluate(() => wx.getWindowInfo());
  for (const [key, observed] of [['width', info.windowWidth], ['height', info.windowHeight]]) {
    if (viewport[key] !== undefined && viewport[key] !== observed) {
      throw new Error(`${id}: expected window ${key} ${viewport[key]}, observed ${observed}`);
    }
  }
  const scrollTop = await page.scrollTop();
  if (!Number.isFinite(scrollTop)) throw new Error(`${id}: invalid page scroll position`);
  const encoded = await program.screenshot();
  if (typeof encoded !== 'string' || !encoded.length) throw new Error(`${id}: no DevTools screenshot`);
  const bytes = Buffer.from(encoded, 'base64');
  const space = screenshotSpace(bytes, info);
  const children = await measureNodes(state.selectors, page, id, { left: 0, top: scrollTop - space.top },
    space.scale, warning => bundle.warnings.push(warning));
  if (bundle.fontMode === 'controlled') {
    function checkFont(node) {
      if (node.kind === 'text' && node.style.fontFamily !== bundle.controlledFontFamily) {
        throw Error(`${node.id}: expected native fixture font ${bundle.controlledFontFamily}, measured ${node.style.fontFamily}`);
      }
      node.children?.forEach(checkFont);
    }
    children.forEach(checkFont);
  }
  if (!(await observedPage(program, state)) || await page.scrollTop() !== scrollTop) {
    throw new Error(`${id}: page or scroll position changed during capture`);
  }
  const filename = `${viewport.id}--${state.id}.png`;
  await writeFile(path.join(stage, 'source', filename), bytes);
  const board = { id, viewport: viewport.id, state: state.id, width: space.width, height: space.height, children };
  bundle.boards.push(board);
  evidence.boards.push({ id, path: page.path, file: `source/${filename}`, windowWidth: info.windowWidth,
    windowHeight: info.windowHeight, scrollTop, screenshot: space, sceneDataApplied: state.data !== undefined });
  return { board, space };
}

async function matchesCapture(program, state, { board, space }) {
  const page = await observedPage(program, state);
  if (!page) return false;
  const origin = { left: 0, top: await page.scrollTop() - space.top };
  try {
    const nodes = await measureNodes(state.selectors, page, board.id, origin, space.scale, () => {});
    return isDeepStrictEqual(nodes, board.children);
  } catch (error) {
    if (error instanceof MissingNode) return false;
    throw error;
  }
}

async function captureViewport(sdk, viewport, config, plan, stage, bundle, evidence) {
  let program;
  try {
    program = await sdk.connect({ wsEndpoint: viewport.wsEndpoint });
  } catch (error) {
    throw new Error(`DEVTOOLS_NOT_CONNECTED (${viewport.id}): ${error.message}`);
  }
  try {
    const info = await program.systemInfo();
    if (['ios', 'android', 'ohos', 'harmonyos'].includes(info.platform)) {
      throw new Error(`DEVICE_SCREENSHOT_UNSUPPORTED: ${info.platform} client. The official screenshot API requires the DevTools simulator.`);
    }
    if (info.platform !== 'devtools') throw new Error(`UNSUPPORTED_RUNTIME: ${info.platform}`);
    const timeout = config.timeoutMs ?? 8000;
    const snapshots = new Map();
    for (const state of config.states) {
      try {
        snapshots.set(state.id, await captureBoard(program, viewport, state, stage, bundle, evidence, timeout));
      } catch (error) {
        throw new Error(`${viewport.id}/${state.id}: ${error.message}`, { cause: error });
      }
    }
    const states = new Map(config.states.map(state => [state.id, state]));
    async function replay(edge, expected, stacked) {
      const from = `${viewport.id}/${edge.from}`;
      const target = states.get(expected);
      const origin = states.get(edge.from);
      await until(() => matchesCapture(program, origin, snapshots.get(edge.from)), `edge source ${from}`, timeout);
      if ((!stacked || edge.samePage) && await matchesCapture(program, target, snapshots.get(expected))) {
        throw new Error(`${from} -> ${expected}: target already matches before the tap`);
      }
      const before = stacked || edge.samePage ? await program.pageStack() : null;
      const source = await locate(await program.currentPage(), plan.selectors.get(edge.from).get(edge.source));
      if (!source) throw new Error(`${from}: edge source ${edge.source} missing during replay`);
      await source.tap();
      await until(async () => {
        if (before) {
          const after = await program.pageStack();
          const back = edge.action === 'BACK';
          const retained = back ? before.slice(0, -1) : before;
          const expectedDepth = edge.samePage ? before.length : before.length + (back ? -1 : 1);
          if (!after.length || after.length !== expectedDepth ||
              !retained.every((page, index) => page === after[index])) return false;
        }
        return matchesCapture(program, target, snapshots.get(expected));
      }, `edge ${from}#${edge.source} -> ${expected}`, timeout);
    }
    for (const edge of plan.independent) {
      await enter(program, states.get(edge.from), timeout);
      await replay(edge, edge.to, false);
    }
    for (const scenario of plan.scenarios) {
      await enter(program, states.get(scenario.entry), timeout);
      const steps = [];
      for (const { edge, expected } of scenario.steps) {
        await replay(edge, expected, true);
        steps.push({ from: edge.from, source: edge.source, action: edge.action ?? 'NAVIGATE', to: expected,
          checkedFields: Object.keys(states.get(expected).expectContext ?? {}) });
      }
      evidence.scenarios.push({ viewport: viewport.id, id: scenario.id, entry: scenario.entry, steps });
    }
    for (const edge of config.edges ?? []) {
      const from = `${viewport.id}/${edge.from}`;
      bundle.edges.push({ from, to: edge.action === 'BACK' ? null : `${viewport.id}/${edge.to}`,
        source: `${from}#${edge.source}`, action: edge.action ?? 'NAVIGATE' });
    }
  } finally {
    program.disconnect();
  }
}

async function officialSdk() {
  try {
    return (await import('miniprogram-automator')).default;
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes("package 'miniprogram-automator'")) throw error;
    throw new Error('AUTOMATOR_NOT_INSTALLED: npm install --prefix native --no-save --package-lock=false miniprogram-automator@0.13.0');
  }
}

async function run(config, output, loadSdk, source) {
  const plan = prepareConfig(config);
  if (config.fontMode === 'controlled') {
    if (typeof config.controlledFontFamily !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(config.controlledFontFamily)) {
      throw Error('Native controlled mode requires controlledFontFamily');
    }
    config = { ...config, states: config.states.map(state => ({
      ...state, data: { ...state.data, mirrorFontFamily: config.controlledFontFamily }
    })) };
  }
  const destination = path.resolve(output);
  const existing = await lstat(destination).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (existing && (!existing.isDirectory() || (await readdir(destination)).length)) {
    throw new Error(`Output must be a new or empty directory: ${destination}`);
  }
  const sdk = await loadSdk();
  const bundle = { version: 1, project: config.project, boards: [], edges: [], tokens: {}, warnings: [
    source === 'contract-stub' ? 'Contract stub: all measurements and screenshots are synthetic.' :
      'Source: WeChat DevTools native Mini Program simulator.'
  ] };
  const evidence = { source, boards: [] };
  if (config.fontMode) {
    bundle.fontMode = config.fontMode;
    if (config.fontMode === 'controlled') bundle.controlledFontFamily = config.controlledFontFamily;
    bundle.warnings.push('Native DevTools reports declared font families; per-glyph font evidence is unavailable.');
  }
  if (plan.scenarios.length) evidence.scenarios = [];
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(path.join(parent, '.wx-capture-'));
  try {
    await mkdir(path.join(stage, 'source'));
    for (const viewport of config.viewports) {
      await captureViewport(sdk, viewport, config, plan, stage, bundle, evidence);
    }
    for (const [file, data] of [['bundle.json', bundle], ['evidence.json', evidence]]) {
      await writeFile(path.join(stage, file), JSON.stringify(data, null, 2) + '\n');
    }
    await rename(stage, destination);
    return bundle;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export const capture = (config, output) => captureFontRun(config, output,
  (settings, dir) => run(settings, dir, officialSdk, 'wechat-devtools-simulator'));
export const captureWithStub = (config, output, stub) => captureFontRun(config, output,
  (settings, dir) => run(settings, dir, () => stub, 'contract-stub'));

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { positionals, values } = parseArgs({ allowPositionals: true, options: {
      'font-mode': { type: 'string' }, 'font-family': { type: 'string' }
    } });
    if (positionals.length !== 2) throw new Error('Usage: node native/capture.mjs <config.json> <output> [--font-mode original|controlled] [--font-family <family>]');
    const config = JSON.parse(await readFile(positionals[0], 'utf8'));
    if (values['font-mode'] !== undefined) config.fontMode = values['font-mode'];
    if (values['font-family'] !== undefined) {
      if (config.fontMode !== 'controlled') throw Error('--font-family requires controlled mode');
      config.controlledFontFamily = values['font-family'];
    }
    const bundle = await capture(config, positionals[1]);
    console.log(`wechat-devtools-simulator: ${bundle.boards.length} boards, ${bundle.edges.length} verified edges`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
