import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PNG } from 'pngjs';
import { audit } from '../audit.mjs';
import { planGeometry, stage } from '../mcp/compact.mjs';
import { transfer } from '../mcp/transfer.mjs';
import { verify } from '../verify.mjs';
import { check, decode, merge, requestCode, tokenRequestCode } from './cloud-export.mjs';
import { openFigmaClient } from './figma-tool-client.mjs';

const base = path.resolve(import.meta.dirname, '..');
const area = path.join(base, 'build/raster-acceptance');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const nativeId = value => typeof value === 'string' && /^\d+:\d+$/.test(value);
const boardIndex = data => data.boards.map(({ id, viewport, state, width, height }) => ({ id, viewport, state, width, height }));

async function optional(file) {
  try { return await readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function keep(file, value) {
  const bytes = Buffer.from(value);
  const prior = await optional(file);
  if (prior) {
    assert(prior.equals(bytes), `Run input or evidence changed: ${file}. Use a separate run directory.`);
    return;
  }
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, bytes, { flag: 'wx' });
    await link(temp, file);
  } finally { await rm(temp, { force: true }); }
}

export function toolValue(reply) {
  if (typeof reply === 'string') return toolValue(JSON.parse(reply));
  assert(reply && !reply.isError && !reply.error, 'MCP returned an error; inspect the saved receipt');
  if (reply.structuredContent != null) return toolValue(reply.structuredContent);
  if (Object.hasOwn(reply, 'result')) return toolValue(reply.result);
  if (Array.isArray(reply) || Array.isArray(reply.content)) {
    const entries = (reply.content ?? reply).filter(entry => entry.type === 'text');
    assert.equal(entries.length, 1, 'Expected one JSON text return from Figma');
    return toolValue(entries[0].text);
  }
  return reply;
}

export function geometryAudits(bundle, plan, snapshot) {
  function exact(reference, baseline) {
    const result = audit(reference, snapshot, 0);
    const roots = new Map(snapshot.observed.geometry.filter(row => row.id === row.boardId).map(row => [row.id, row]));
    for (const board of reference.boards) {
      const root = roots.get(board.id);
      if (!root) { result.issues.push({ boardId: board.id, issue: 'missing-board-geometry' }); continue; }
      for (const field of ['width', 'height']) {
        if (board[field] === root[field]) continue;
        result.issues.push({ issue: 'board-geometry-mismatch', boardId: board.id, field, expected: board[field], actual: root[field] });
        if (Number.isFinite(root[field])) result.maxDeviation = Math.max(result.maxDeviation, Math.abs(board[field] - root[field]));
      }
    }
    return { ...result, baseline, passed: result.issues.length === 0 };
  }
  return {
    dom: exact(bundle, 'captured DOM'),
    plan: exact(plan, 'renderer planGeometry')
  };
}

async function saveAudits(dir, bundle, plan, snapshot) {
  const audits = geometryAudits(bundle, plan, snapshot);
  for (const [name, report] of Object.entries(audits)) await keep(path.join(dir, `audit-${name}.json`), json(report));
  return audits;
}

async function evaluate({ captureDir, dir, bytes, plan, packets, canvas, fileKey, pngDir }) {
  const bundle = JSON.parse(bytes);
  const visualBytes = await readFile(path.join(captureDir, 'bundle.json'));
  assert.deepEqual(boardIndex(JSON.parse(visualBytes)), boardIndex(bundle), 'Visual and structure board inventories differ');
  const { context } = decode(bundle, packets);
  assert(context.fileKey === fileKey && Object.keys(canvas).every(key => context[key] === canvas[key]), 'Unexpected readback origin');
  const structure = check(bundle, packets, 0, canvas);
  await keep(path.join(dir, 'cloud-check-dom.json'), json(structure));
  assert.equal(structure.tokenCoverage.status, 'observed', 'Missing token readback');
  const snapshot = await merge(bytes, packets, pngDir);
  const figmaDir = path.join(dir, 'figma');
  await mkdir(figmaDir, { recursive: true });
  if (path.resolve(pngDir) !== path.resolve(figmaDir)) {
    for (const board of snapshot.boards) await keep(path.join(figmaDir, board.file), await readFile(path.join(pngDir, board.file)));
  }
  await keep(path.join(figmaDir, 'design-diff.json'), json(snapshot));
  const audits = await saveAudits(dir, bundle, plan, snapshot);
  const semanticIssues = structure.issues.filter(issue => !['x', 'y', 'width', 'height'].includes(issue.field) || issue.id === issue.boardId);
  const visual = await verify(captureDir, figmaDir, path.join(dir, 'visual'), { pixelTolerance: 16, maxDiffRatio: 0.01 });
  const strict = await verify(captureDir, figmaDir, path.join(dir, 'strict'), { pixelTolerance: 0, maxDiffRatio: 0 });
  return { fileKey, canvas, sourceSha256: sha(bytes), visualBundleSha256: sha(visualBytes),
    pngCount: snapshot.boards.length, domAuditPassed: audits.dom.passed, planAuditPassed: audits.plan.passed,
    semanticIssues, visualPassed: visual.passed, strictPixelPassed: strict.passed,
    passed: audits.plan.passed && semanticIssues.length === 0 && visual.passed };
}

export async function workflow({ command, captureDir, sourceBundle = path.join(captureDir, 'bundle.json'), config, dir, readback, getClient, fetchAsset = fetch }) {
  assert(['prepare', 'next', 'run'].includes(command), 'Use prepare, next or run');
  const { fileKey, sessionId, expectedPngCount } = config;
  const source = (readback ? config.sourcePage : config.stagingPage ?? config.sourcePage)?.id, output = config.outputPage?.id;
  assert(fileKey && sessionId && nativeId(source) && nativeId(output) && source !== output, 'Incomplete preflight');
  if (readback) assert(nativeId(config.transferFrameId) && nativeId(config.sectionId), 'Readback requires frame and section IDs');
  else {
    assert(!config.sectionId, 'This preflight already has an output section. Select --readback or supply a fresh preflight.');
    assert(![source, output].some(id => config.protectedPageIds?.includes(id)), 'Protected page in write path');
  }
  const bytes = await readFile(sourceBundle), bundle = JSON.parse(bytes);
  const visualBytes = await readFile(path.join(captureDir, 'bundle.json'));
  assert.deepEqual(boardIndex(JSON.parse(visualBytes)), boardIndex(bundle), 'Visual and structure board inventories differ');
  assert(Number.isSafeInteger(expectedPngCount) && expectedPngCount > 0);
  assert.equal(bundle.boards.length, expectedPngCount, 'Preflight board count differs from capture');
  const boardNames = bundle.boards.map(board => {
    assert([board.viewport, board.state].every(name => /^[\w-]+$/.test(name)), `Unsafe PNG name for ${board.id}`);
    return `${board.viewport}--${board.state}.png`;
  });
  assert.equal(new Set(boardNames).size, boardNames.length, 'Duplicate PNG names');
  const plan = planGeometry(bundle);
  const { scripts, ...batches } = readback ? { scripts: [] } : transfer(bundle, { stagingPageId: source });
  const refs = { fileKey, sessionId };
  await Promise.all(['requests', 'receipts', 'replies', 'figma'].map(name => mkdir(path.join(dir, name), { recursive: true })));
  const hashes = await Promise.all(boardNames.map(async name => sha(await readFile(path.join(captureDir, 'source', name)))));
  const canvas = { source, output };
  if (readback) Object.assign(canvas, { frame: config.transferFrameId, section: config.sectionId });
  await keep(path.join(dir, 'manifest.json'), json({ ...refs, mode: readback ? 'readback' : 'render', canvas: { ...canvas },
    captureDir, sourceBundle, visualBundleSha256: sha(visualBytes), sourceSha256: sha(bytes), planSha256: sha(json(plan)),
    rendererSha256: sha(await readFile(path.join(base, 'mcp/renderer.js'))), batches: readback ? null : batches,
    expectedPngCount, sourcePngSha256: Object.fromEntries(boardNames.map((name, index) => [name, hashes[index]])) }));
  await keep(path.join(dir, 'render-plan.json'), json(plan));
  function use(code, description, write = false) {
    return { tool: 'use_figma', arguments: { ...refs, description, code,
      skillNames: write ? 'figma-use,figma-generate-design' : 'figma-use' } };
  }
  const batchRequests = scripts.map((code, index) => use(code, `Transfer capture batch ${index + 1}/${scripts.length}`, true));
  const batchLabel = index => `transfer-${String(index + 1).padStart(3, '0')}`;
  if (!readback) {
    for (const [index, request] of batchRequests.entries()) {
      await keep(path.join(dir, 'requests', `${batchLabel(index)}.json`), json(request));
    }
  }
  if (command === 'prepare') {
    if (readback) {
      for (const [index, spec] of bundle.boards.entries()) {
        await keep(path.join(dir, 'requests', `board-${index + 1}-1.json`),
          json(use(requestCode(bundle, spec.id, canvas), `Read ${spec.id} part 1`)));
      }
      await keep(path.join(dir, 'requests/tokens-1.json'), json(use(tokenRequestCode(bundle, canvas), 'Read tokens part 1')));
    }
    return { status: 'prepared', batches: readback ? null : batches, boards: expectedPngCount, dir };
  }
  let client, waiting;
  async function invoke(label, request, write = false) {
    const requestFile = path.join(dir, 'requests', `${label}.json`);
    const receipt = path.join(dir, 'receipts', `${label}.json`);
    await keep(requestFile, json(request));
    const saved = await optional(receipt);
    if (saved) return toolValue(JSON.parse(saved));
    const marker = `${receipt}.sent`;
    if (write && await optional(marker)) throw Error(`Unknown write outcome. Inspect the Figma page and recover ${receipt} before resuming.`);
    if (command === 'next') {
      if (write) await writeFile(marker, sha(json(request)), { flag: 'wx' });
      waiting = { status: 'awaiting-MCP', request: requestFile, receipt };
      throw Error('awaiting-MCP');
    }
    client ??= await getClient();
    if (write) {
      await writeFile(marker, sha(json(request)), { flag: 'wx' });
    }
    const response = await client.call(request.tool, request.arguments);
    await keep(receipt, json(response));
    return toolValue(response);
  }
  try {
    if (!readback) {
      let previous = 0;
      for (const [index, request] of batchRequests.entries()) {
        const result = await invoke(batchLabel(index), request, true);
        assert(result.sourcePageId === source && nativeId(result.transferFrameId) && result.sha256 === batches.sha256 &&
          result.total === batches.chunks && Number.isSafeInteger(result.received) &&
          result.received >= previous && result.received <= result.total &&
          (canvas.frame === undefined || canvas.frame === result.transferFrameId), 'Wrong transfer receipt');
        canvas.frame = result.transferFrameId;
        previous = result.received;
        if (index === scripts.length - 1) assert(result.complete === true && previous === result.total, 'Incomplete transfer');
      }
      for (const number of [1, 2, 3, 4, 5, 'fit', 6]) {
        const ids = { sourcePageId: source, transferFrameId: canvas.frame, outputPageId: output };
        if (canvas.section) ids.sectionId = canvas.section;
        const receipt = await invoke(`render-${number}`, use(await stage(number, ids), `Render stage ${number}`, true), true);
        assert(nativeId(receipt.sectionId) && (!canvas.section || canvas.section === receipt.sectionId) &&
          Object.keys(ids).every(key => receipt[key] === ids[key]) &&
          (number === 'fit' || receipt.stage === number), `Unexpected renderer receipt for stage ${number}`);
        canvas.section = receipt.sectionId;
      }
    }
    const packets = [];
    for (const board of [...bundle.boards.map(spec => spec.id), null]) {
      const label = board === null ? 'tokens' : `board-${bundle.boards.findIndex(spec => spec.id === board) + 1}`;
      let parts = 1;
      for (let part = 1; part <= parts; part++) {
        const args = { ...canvas, part };
        const code = board === null ? tokenRequestCode(bundle, args) : requestCode(bundle, board, args);
        const packet = await invoke(`${label}-${part}`, use(code, `Read ${board ?? 'tokens'} part ${part}`));
        assert(packet.part === part && (part === 1 || packet.parts === parts) &&
          Number.isSafeInteger(packet.parts) && packet.parts >= part && (board === null
          ? packet.format === 'ui-parity-tokens/1' : packet.format === 'ui-parity-board/1' && packet.board === board), 'Wrong readback packet');
        parts = packet.parts;
        packets.push(packet);
        await keep(path.join(dir, 'replies', `${label}-${part}.json`), json(packet));
      }
    }
    const { boards, context } = decode(bundle, packets);
    assert(context.fileKey === fileKey && Object.keys(canvas).every(key => canvas[key] === context[key]), 'Unexpected readback origin');
    const exports = [];
    for (const [index, { board }] of boards.entries()) {
      const args = { ...refs, nodeId: board.figmaId, defaultFormat: 'png', defaultScale: 1 };
      const asset = await invoke(`png-${index + 1}`, { tool: 'download_assets', arguments: args });
      assert(typeof asset.export?.url === 'string' && new URL(asset.export.url).protocol === 'https:', 'Missing HTTPS node export');
      const file = boardNames[index], target = path.join(dir, 'figma', file);
      const record = await optional(path.join(dir, 'receipts', `png-${index + 1}.sha256`));
      let png = record && await readFile(target);
      if (record) assert.equal(sha(png), record.toString(), `Cached PNG changed: ${file}`);
      else {
        const response = await fetchAsset(asset.export.url);
        assert(response.ok, `PNG ${file} download returned ${response.status}. Refresh its read-only export receipt.`);
        png = Buffer.from(await response.arrayBuffer());
        const image = PNG.sync.read(png);
        assert.equal(image.width, Math.ceil(board.width), `Wrong export width for ${board.id}`);
        assert.equal(image.height, Math.ceil(board.height), `Wrong export height for ${board.id}`);
        await keep(target, png);
        await keep(path.join(dir, 'receipts', `png-${index + 1}.sha256`), sha(png));
      }
      exports.push({ boardId: board.id, nodeId: board.figmaId, file, sha256: sha(png) });
    }
    await keep(path.join(dir, 'exports.json'), json(exports));
    const evidence = await evaluate({ captureDir, dir, bytes, plan, packets, canvas, fileKey, pngDir: path.join(dir, 'figma') });
    const ids = { sourcePageId: source, transferFrameId: canvas.frame, outputPageId: output, sectionId: canvas.section };
    for (const number of [7, 8]) {
      const result = await invoke(`verify-${number}`, use(await stage(number, ids), `Inspect renderer stage ${number}`));
      assert(Object.keys(ids).every(key => result[key] === ids[key]), `Wrong stage ${number} origin`);
      if (number === 7) assert(boards.every(({ board }) => result.boards?.[board.id] === board.figmaId), 'Wrong verified board map');
    }
    const result = { status: 'evaluated', ...evidence, rendererChecks: [7, 8] };
    await keep(path.join(dir, 'result.json'), json(result));
    return result;
  } catch (error) {
    if (waiting) return waiting;
    throw error;
  } finally { client?.close(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { positionals, values } = parseArgs({ allowPositionals: true, options: {
      capture: { type: 'string' }, bundle: { type: 'string' }, preflight: { type: 'string' }, dir: { type: 'string' },
      server: { type: 'string' }, readback: { type: 'boolean' }, snapshot: { type: 'string' },
      replies: { type: 'string' }, png: { type: 'string' }, frame: { type: 'string' }, section: { type: 'string' }
    } });
    assert(positionals.length === 1, 'Use prepare|next|run|finish or audit --snapshot design-diff.json');
    const captureDir = path.resolve(values.capture ?? path.join(area, 'capture'));
    const sourceBundle = path.resolve(values.bundle ?? path.join(captureDir, 'bundle.json'));
    const dir = path.resolve(values.dir ?? path.join(area, 'workflow'));
    if (positionals[0] === 'audit') {
      assert(values.snapshot, 'Pass --snapshot for a merged cloud export');
      const bytes = await readFile(sourceBundle);
      const snapshot = JSON.parse(await readFile(values.snapshot));
      assert.equal(snapshot.sourceSha256, sha(bytes), 'Snapshot was merged against different source bytes');
      const bundle = JSON.parse(bytes), plan = planGeometry(bundle);
      await mkdir(dir, { recursive: true });
      await keep(path.join(dir, 'render-plan.json'), json(plan));
      const audits = await saveAudits(dir, bundle, plan, snapshot);
      console.log(json({ dir, domAuditPassed: audits.dom.passed, planAuditPassed: audits.plan.passed }));
      if (!audits.plan.passed) process.exitCode = 2;
    } else if (positionals[0] === 'finish') {
      const bytes = await readFile(sourceBundle), bundle = JSON.parse(bytes);
      const cfg = JSON.parse(await readFile(values.preflight ?? path.join(area, 'cloud/preflight.json')));
      assert.equal(bundle.boards.length, cfg.expectedPngCount);
      const canvas = { source: cfg.sourcePage.id, output: cfg.outputPage.id,
        frame: values.frame ?? cfg.transferFrameId, section: values.section ?? cfg.sectionId };
      assert(Object.values(canvas).every(nativeId), 'Pass the native transfer --frame and render --section from this run');
      const replies = values.replies ?? path.join(area, 'cloud/replies');
      const files = (await readdir(replies)).filter(name => name.endsWith('.json')).sort();
      const packets = await Promise.all(files.map(async name => JSON.parse(await readFile(path.join(replies, name)))));
      const plan = planGeometry(bundle);
      await mkdir(dir, { recursive: true });
      await keep(path.join(dir, 'render-plan.json'), json(plan));
      const evidence = await evaluate({ captureDir, dir, bytes, plan, packets, canvas, fileKey: cfg.fileKey,
        pngDir: values.png ?? path.join(area, 'cloud/png') });
      const result = { status: 'evaluated-supplied-files', ...evidence, rendererChecks: 'not-run-in-finish' };
      await keep(path.join(dir, 'result.json'), json(result));
      console.log(json(result));
      if (!result.passed) process.exitCode = 2;
    } else {
      const result = await workflow({ command: positionals[0], captureDir, sourceBundle, dir, readback: values.readback,
        config: JSON.parse(await readFile(values.preflight ?? path.join(area, 'cloud/preflight.json'))),
        getClient: () => openFigmaClient(base, values.server) });
      console.log(json(result));
      if (result.passed === false) process.exitCode = 2;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
