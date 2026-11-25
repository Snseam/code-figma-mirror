import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { chromium } from 'playwright';
import { collectDOM, cropViewport, stateFingerprint, traceTokenRefs } from './capture-dom.mjs';

const actionTimeout = 8000;
const matchTimeout = 3500;

function pageURL(value) {
  if (typeof value !== 'string' || !value.trim()) throw TypeError('state.url must be a file or HTTP(S) URL');
  const base = pathToFileURL(process.cwd() + path.sep);
  const url = new URL(value, base);
  if (!['file:', 'http:', 'https:'].includes(url.protocol)) throw Error(`Unsupported state URL protocol ${url.protocol}`);
  return url.href;
}

function validate(config) {
  if (typeof config.project !== 'string' || !config.project.trim()) throw TypeError('project must be a nonempty name');
  for (const [label, list] of [['viewports', config.viewports], ['states', config.states]]) {
    if (!Array.isArray(list) || !list.length) throw TypeError(`${label} must be a nonempty array`);
    const ids = new Set();
    for (const { id } of list) {
      if (typeof id !== 'string' || !id.trim() || /[/\\\u0000-\u001F<>:"|?*]/.test(id) || ids.has(id)) {
        throw TypeError(`${label} must have unique filename-safe IDs (found ${id})`);
      }
      ids.add(id);
    }
  }
  const files = new Set();
  for (const { id, width, height } of config.viewports) {
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) throw RangeError(`Invalid viewport ${id}`);
    for (const state of config.states) {
      const name = `${id}--${state.id}.png`.normalize('NFC').toLowerCase();
      if (files.has(name)) throw Error(`Conflicting screenshot filename ${name}`);
      files.add(name);
    }
  }
  for (const state of config.states) {
    pageURL(state.url);
    for (const step of state.steps ?? []) {
      const click = typeof step.click === 'string' && !('fill' in step);
      const fill = typeof step.fill === 'string' && typeof step.value === 'string' && !('click' in step);
      if (!click && !fill) throw TypeError(`State ${state.id} requires {click} or {fill,value} steps`);
    }
  }
  for (const fixture of config.routes ?? []) {
    if (typeof fixture.url !== 'string' || !fixture.url || !Object.hasOwn(fixture, 'json') ||
      !Number.isInteger(fixture.status ?? 200) || (fixture.status ?? 200) < 200 || (fixture.status ?? 200) > 599) {
      throw TypeError('routes require {url, status?, json}');
    }
  }
}

async function loadRasterProfile(profile) {
  if (profile === undefined) return;
  if (!profile || typeof profile.name !== 'string' || !profile.name.trim() || profile.fontFamily !== 'Arimo' ||
      profile.smoothing !== 'antialiased' || !/^[0-9a-f]{64}$/.test(profile.sha256) ||
      typeof profile.fontFile !== 'string' || !profile.fontFile) {
    throw TypeError('rasterProfile requires name, fontFamily Arimo, smoothing antialiased, SHA-256 and a local fontFile');
  }
  const bytes = await readFile(profile.fontFile);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== profile.sha256) throw Error(`Raster font SHA-256 mismatch: ${sha256}`);
  return { metadata: { name: profile.name, fontFamily: profile.fontFamily, sha256, smoothing: profile.smoothing },
    base64: bytes.toString('base64') };
}

async function checkCaptureDestination(outDir, profile) {
  let previous;
  try { previous = JSON.parse(await readFile(path.join(outDir, 'bundle.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && !isDeepStrictEqual(previous.rasterProfile, profile)) {
    throw Error('Capture baseline differs. Use a separate output directory for each raster profile and the original.');
  }
  if (profile) {
    const source = path.join(outDir, 'source');
    try {
      if ((await lstat(source)).isSymbolicLink() || (!previous && (await readdir(source)).length)) {
        throw Error('Existing reference images require a separate raster capture directory');
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function openState(browser, viewport, state, routes, raster, run) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1,
    reducedMotion: 'reduce', ...(routes.length && { serviceWorkers: 'block' })
  });
  try {
    context.setDefaultTimeout(actionTimeout);
    if (raster) {
      await context.addInitScript(({ base64 }) => {
        const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
        document.fonts.add(new FontFace('Arimo', bytes.buffer, { weight: '400 700' }));
        const sheet = new CSSStyleSheet();
        sheet.replaceSync('*, ::before, ::after { font-family: Arimo, sans-serif !important; -webkit-font-smoothing: antialiased !important; }');
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }, { base64: raster.base64 });
    }
    for (const fixture of routes) {
      await context.route(fixture.url, route => route.fulfill({ status: fixture.status ?? 200, json: fixture.json }));
    }
    const page = await context.newPage();
    const images = new Map();
    page.on('response', response => {
      if (response.request().resourceType() === 'image') images.set(response.url().split('#')[0], response);
    });
    const response = await page.goto(pageURL(state.url), { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (response && response.status() >= 400) throw Error(`Document returned HTTP ${response.status()}`);
    for (const step of state.steps ?? []) {
      if ('click' in step) await page.locator(step.click).click();
      else await page.locator(step.fill).fill(step.value);
    }
    if (state.ready) await page.locator(`css:light=${state.ready}`).filter({ visible: true }).first().waitFor({ state: 'visible' });
    if (raster) {
      await page.evaluate(async () => {
        const faces = await document.fonts.load('400 16px Arimo');
        const candidates = [...document.fonts].filter(face => face.family.replace(/["']/g, '').toLowerCase() === 'arimo');
        if (faces.length !== 1 || candidates.length !== 1 || faces[0].status !== 'loaded' ||
            getComputedStyle(document.documentElement).webkitFontSmoothing !== 'antialiased') {
          throw Error('Controlled Arimo font is unavailable or ambiguous, or antialiased smoothing is unavailable');
        }
      });
    }
    const ready = await page.evaluate(async () => {
      const visibleImages = [...document.images].filter(image => {
        const rect = image.getBoundingClientRect();
        return rect.width && rect.height && rect.top < innerHeight && rect.bottom > 0 &&
          rect.left < innerWidth && rect.right > 0;
      });
      const loaded = Promise.allSettled([document.fonts.ready, ...visibleImages.map(image => image.decode())])
        .then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
      let timer;
      try { return await Promise.race([loaded, new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]); }
      finally { clearTimeout(timer); }
    });
    return await run(page, ready, images);
  } finally { await context.close(); }
}

async function svgResources(page, images) {
  const sources = await page.evaluate(() => [...new Set([...document.images].map(image => image.currentSrc).filter(Boolean))]);
  const entries = [];
  for (const src of sources) {
    const response = images.get(src.split('#')[0]);
    const embedded = /^data:image\/svg\+xml([^,]*),([\s\S]*)$/i.exec(src);
    try {
      if (embedded && embedded[2].length <= 2_000_000) {
        const text = /;base64/i.test(embedded[1]) ? Buffer.from(embedded[2], 'base64').toString('utf8') : decodeURIComponent(embedded[2]);
        entries.push([src, text]);
      } else if (response && !src.includes('#') && (/\.svg(?:\?|$)/i.test(src) ||
        /^image\/svg\+xml/i.test(response.headers()['content-type'] ?? ''))) {
        const body = await response.body();
        if (body.length <= 2_000_000) entries.push([src, body.toString('utf8')]);
      }
    } catch { entries.push([src, '']); }
  }
  return Object.fromEntries(entries);
}

async function renderedFonts(page, boardId, children) {
  const hosts = new Map();
  function collect(node) {
    if (node.kind === 'text') {
      const match = /^(.*)\/text-\d+@\d+$/u.exec(node.id.slice(boardId.length + 1));
      if (match) {
        const selector = match[1];
        if (!hosts.has(selector)) hosts.set(selector, []);
        hosts.get(selector).push(node.id);
      }
    }
    for (const child of node.children || []) collect(child);
  }
  children.forEach(collect);
  const client = await page.context().newCDPSession(page);
  try {
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    const { root } = await client.send('DOM.getDocument');
    const result = [];
    for (const [selector, layers] of hosts) {
      const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw Error(`Font evidence host disappeared: ${selector}`);
      const { fonts } = await client.send('CSS.getPlatformFontsForNode', { nodeId });
      result.push({ selector, layers, fonts });
    }
    return result;
  } finally {
    await client.detach();
  }
}

async function readBoard(page, config, viewport, state, id, ready, images, stage) {
  const selectors = [...new Set((config.edges ?? []).filter(edge => edge.from === state.id).map(edge => edge.selector))];
  const dom = await page.evaluate(collectDOM, {
    boardId: id, components: config.components ?? [], tokenVariables: config.tokens ?? {},
    edgeSelectors: selectors, svgImages: await svgResources(page, images)
  });
  const signature = await page.evaluate(stateFingerprint);
  const url = page.url();
  const screenshot = await page.screenshot({ type: 'png', scale: 'css', fullPage: false, caret: 'hide' });
  if (dom.crops.length) {
    const pixels = new Map(await page.evaluate(cropViewport, {
      screenshot: screenshot.toString('base64'), crops: dom.crops
    }));
    function attach(nodes) {
      for (const node of nodes) {
        if (pixels.has(node.id)) node.data = pixels.get(node.id);
        if (node.children) attach(node.children);
      }
    }
    attach(dom.children);
  }
  const filename = `${viewport.id}--${state.id}.png`;
  await writeFile(path.join(stage, filename), screenshot);
  if (!ready) dom.warnings.push('Timed out waiting for visible images, fonts or paint.');
  const assertions = await page.evaluate(stateFingerprint, {
    selectors: [...new Set(config.states.map(item => item.ready).filter(Boolean))]
  });
  const board = { id, state: state.id, viewport: viewport.id, width: viewport.width, height: viewport.height, children: dom.children };
  if (config.fontEvidence || config.rasterProfile) board.fontEvidence = await renderedFonts(page, id, dom.children);
  if (config.rasterProfile) {
    const mismatch = await page.evaluate(selectors => selectors.find(selector => {
      const style = getComputedStyle(document.querySelector(selector));
      const family = style.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
      return style.webkitFontSmoothing !== 'antialiased' || family.toLowerCase() !== 'arimo';
    }), board.fontEvidence.map(host => host.selector));
    if (mismatch) throw Error(`Raster text style mismatch at ${mismatch}`);
    for (const { selector, fonts } of board.fontEvidence) {
      if (!fonts.length || fonts.some(font => !font.isCustomFont || font.familyName !== 'Arimo')) {
        throw Error(`Raster font mismatch at ${selector}: ${JSON.stringify(fonts)}`);
      }
    }
  }
  if (dom.tokenSites.length) {
    const refs = await page.evaluate(traceTokenRefs, {
      sites: dom.tokenSites, variables: config.tokens, tokens: dom.tokens
    });
    const byId = new Map();
    for (const [id, field, name] of refs) {
      if (!byId.has(id)) byId.set(id, {});
      byId.get(id)[field] = name;
    }
    function attachRefs(node) {
      const refs = byId.get(node.id);
      if (refs && Object.keys(refs).every(field => node.style[field])) node.style.tokenRefs = refs;
      node.children?.forEach(attachRefs);
    }
    board.children.forEach(attachRefs);
  }
  return {
    board,
    url, signature, assertions, sources: new Map(dom.sources), tokens: dom.tokens, warnings: dom.warnings, filename
  };
}

async function waitForState(page, snapshot, assertion) {
  const handle = await page.waitForFunction(stateFingerprint, {
    url: snapshot.url, signature: snapshot.signature, assertion
  }, { polling: 100, timeout: matchTimeout });
  await handle.dispose();
}

function uniqueAssertion(snapshot, all, selector) {
  if (!selector || !snapshot.assertions.includes(selector)) return undefined;
  return all.some(other => other !== snapshot && other.url === snapshot.url && other.assertions.includes(selector))
    ? undefined : selector;
}

async function verifyEdge(browser, config, viewport, states, snapshots, edge, raster) {
  const from = snapshots.get(edge.from);
  const to = snapshots.get(edge.to);
  if (!from || !to) throw Error('unknown source or destination state');
  const action = String(edge.action ?? 'NAVIGATE').toUpperCase();
  if (!['NAVIGATE', 'OVERLAY', 'BACK'].includes(action)) throw Error(`unknown action ${action}`);
  const source = from.sources.get(edge.selector);
  if (!source) throw Error('selector did not identify a unique exported node in the source viewport');
  const all = [...snapshots.values()];
  const originAssertion = uniqueAssertion(from, all, states.get(edge.from).ready);
  const targetAssertion = uniqueAssertion(to, all, states.get(edge.to).ready);
  return openState(browser, viewport, states.get(edge.from), config.routes ?? [], raster, async page => {
    try { await waitForState(page, from, originAssertion); }
    catch { throw Error('replayed source did not match its captured URL and DOM or ready selector'); }
    const before = await page.evaluate(stateFingerprint);
    const alreadyVisible = targetAssertion && (await page.evaluate(stateFingerprint, { selectors: [targetAssertion] })).length;
    const alreadyMatched = page.url() === to.url && before === to.signature;
    const locator = page.locator(`css:light=${edge.selector}`).and(page.locator(`css:light=${source.path}`));
    await locator.click();
    if (alreadyMatched) throw Error('destination already matched before click');
    try { await waitForState(page, to, alreadyVisible ? undefined : targetAssertion); }
    catch { throw Error('click did not reach the captured destination URL and DOM or newly visible ready selector'); }
    return { from: from.board.id, to: to.board.id, source: source.id, action };
  });
}

/**
 * Chromium viewport capture. Relative state URLs resolve against process.cwd().
 * ready is a document CSS selector checked after click/fill steps. Each state
 * and edge runs in a fresh context. routes use Playwright URL globs and JSON.
 * Edges target the same tab and viewport and must match the captured final URL
 * plus its visible DOM fingerprint or a newly visible distinguishing ready selector.
 * Inline SVG primitives and simple standalone SVG images remain vectors. Raster media, native controls and
 * unsupported SVG use PNG. Frame styles cover solid paints and basic typography.
 * The screenshot retains complex CSS, pseudo-elements and stacking effects.
 */
export async function capture(config, outDir) {
  validate(config);
  const raster = await loadRasterProfile(config.rasterProfile);
  const bundle = { version: 1, project: config.project, boards: [], edges: [], tokens: {}, warnings: [] };
  if (raster) bundle.rasterProfile = raster.metadata;
  const tokens = new Map();
  const states = new Map(config.states.map(state => [state.id, state]));
  await mkdir(outDir, { recursive: true });
  const lock = path.join(outDir, '.capture-lock');
  await mkdir(lock);
  let stage;
  const files = [];
  try {
    await checkCaptureDestination(outDir, raster?.metadata);
    stage = await mkdtemp(path.join(outDir, '.capture-'));
    const browser = await chromium.launch();
    try {
      for (const viewport of config.viewports) {
        const snapshots = new Map();
        for (const state of config.states) {
          const id = `${viewport.id}/${state.id}`;
          let snapshot;
          try {
            snapshot = await openState(browser, viewport, state, config.routes ?? [], raster,
              (page, ready, images) => readBoard(page, config, viewport, state, id, ready, images, stage));
          } catch (cause) { throw Error(`Could not capture ${id}: ${cause.message}`, { cause }); }
          snapshots.set(state.id, snapshot);
          bundle.boards.push(snapshot.board);
          files.push(snapshot.filename);
          for (const message of snapshot.warnings) bundle.warnings.push(`${id}: ${message}`);
          for (const [name, value] of Object.entries(snapshot.tokens)) {
            if (!tokens.has(name)) tokens.set(name, value);
            else if (tokens.get(name) !== value) bundle.warnings.push(`${id}: token ${name} is ${value}, kept first value ${tokens.get(name)}.`);
          }
        }
        const wired = new Set();
        for (const edge of config.edges ?? []) {
          try {
            const verified = await verifyEdge(browser, config, viewport, states, snapshots, edge, raster);
            if (wired.has(verified.source)) throw Error('source already has a verified click action');
            wired.add(verified.source);
            bundle.edges.push(verified);
          } catch (error) {
            bundle.warnings.push(`${viewport.id}: edge ${edge.from} -> ${edge.to} (${edge.selector}): ${error.message.split('\n')[0]}`);
          }
        }
      }
    } finally { await browser.close(); }
    bundle.tokens = Object.fromEntries(tokens);
    await writeFile(path.join(stage, 'bundle.json'), JSON.stringify(bundle, null, 2) + '\n');
    const source = path.join(outDir, 'source');
    await mkdir(source, { recursive: true });
    for (const file of files) await rename(path.join(stage, file), path.join(source, file));
    await rename(path.join(stage, 'bundle.json'), path.join(outDir, 'bundle.json'));
    return bundle;
  } finally {
    try { if (stage) await rm(stage, { recursive: true, force: true }); }
    finally { await rm(lock, { recursive: true }); }
  }
}
