import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';

function rgba(hex) {
  if (typeof hex !== 'string' || !/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(hex)) return null;
  const digits = hex.length <= 5 ? hex.slice(1).replace(/./g, digit => digit + digit) : hex.slice(1);
  return Number.parseInt(digits.padEnd(8, 'f'), 16);
}

export function pixelDistance(before, after) {
  if (before === after) return 0;
  const oldAlpha = before & 255, newAlpha = after & 255;
  let distance = Math.abs(oldAlpha - newAlpha);
  for (const shift of [24, 16, 8]) {
    const oldChannel = (before >>> shift) & 255, newChannel = (after >>> shift) & 255;
    distance = Math.max(distance, Math.abs(oldChannel * oldAlpha - newChannel * newAlpha) / 255);
  }
  return distance;
}

function bounds(node, x, y) {
  if (![x, y, node.width, node.height].every(Number.isFinite) || node.width <= 0 || node.height <= 0) {
    throw Error(`Invalid expected change bounds for ${node.id}`);
  }
  return { left: Math.floor(x), top: Math.floor(y), right: Math.ceil(x + node.width), bottom: Math.ceil(y + node.height) };
}

export async function expectedRegions(bundle, manifest, referenceDir, issues) {
  const regions = new Map(bundle.boards.map(board => [board.id, []]));
  const texts = new Map();
  const fills = new Map();
  const changes = manifest.designChanges;
  if (!Array.isArray(changes)) {
    issues.push({ code: 'unresolved-expected-change', reason: 'Missing designChanges array' });
    return regions;
  }
  for (const change of changes) {
    if (change?.scope !== 'token') continue;
    const from = rgba(bundle.tokens?.[change.id]), to = rgba(change.after?.color);
    if (change.op !== 'update' || from === null || to === null || from === to ||
        (change.before && rgba(change.before.color) !== from)) {
      issues.push({ code: 'unresolved-expected-change', id: change.id });
    } else if (fills.has(from)) {
      issues.push({ code: 'unresolved-expected-change', id: change.id, reason: 'Ambiguous source fill' });
    } else fills.set(from, { from, to, id: change.id });
  }
  const unmatchedFills = new Set(fills.keys());
  for (const board of bundle.boards) {
    const boardTexts = new Map();
    texts.set(board.id, boardTexts);
    function visit(node, parentX, parentY, background) {
      const x = parentX + node.x, y = parentY + node.y;
      if (node.kind === 'frame' && node.style?.fill) {
        const fill = rgba(node.style.fill);
        if (fills.has(fill)) {
          regions.get(board.id).push({ ...bounds(node, x, y), ...fills.get(fill) });
          unmatchedFills.delete(fill);
        }
        if (fill !== null && (fill & 255) !== 0) background = fill;
      }
      if (node.kind === 'text') {
        boardTexts.set(node.id, { text: node.text, id: node.id, ...bounds(node, x, y),
          ink: rgba(node.style?.color ?? node.style?.fill ?? '#000'), background,
          editedBackground: fills.get(background)?.to ?? background });
      }
      for (const child of node.children ?? []) visit(child, x, y, background);
    }
    for (const child of board.children ?? []) visit(child, 0, 0, 0xffffffff);
  }
  for (const fill of unmatchedFills) issues.push({ code: 'unresolved-expected-change', id: fills.get(fill).id });
  for (const change of changes) {
    if (change?.scope === 'token') continue;
    if (change?.scope !== 'node' || change.op !== 'update' || typeof change.before?.text !== 'string' ||
        typeof change.after?.text !== 'string' || !change.after.text.trim() || change.before.text === change.after.text ||
        (change.propagatesTo !== undefined && !Array.isArray(change.propagatesTo))) {
      issues.push({ code: 'unresolved-expected-change', id: change?.id });
      continue;
    }
    let reference;
    if (change.referencePng !== undefined) {
      try {
        if (typeof change.referencePng !== 'string' || !/^[\w.-]+\.png$/i.test(change.referencePng)) throw Error('Expected a PNG filename');
        reference = PNG.sync.read(await readFile(path.join(referenceDir, change.referencePng)));
      } catch (error) {
        issues.push({ code: 'invalid-text-reference', id: change.id, detail: error.message });
        continue;
      }
    }
    for (const link of [change, ...(change.propagatesTo ?? [])]) {
      const { boardId, id } = link ?? {};
      const target = texts.get(boardId)?.get(id);
      if (!target || target.text !== change.before.text || target.ink === null) {
        issues.push({ code: 'unresolved-expected-change', boardId, id });
      } else if (reference && (reference.width !== target.right - target.left || reference.height !== target.bottom - target.top)) {
        issues.push({ code: 'invalid-text-reference', boardId, id, detail: 'Size differs from text bounds' });
      } else regions.get(boardId).push({ ...target, reference });
    }
  }
  return regions;
}

function matchesRecolor(before, after, from, to) {
  if (before === from && after === to) return true;
  if ((before & 255) !== (after & 255) || (from & 255) !== 255 || (to & 255) !== 255) return false;
  let lower = 0, upper = 1;
  for (const shift of [24, 16, 8]) {
    const oldPaint = (from >>> shift) & 255, newPaint = (to >>> shift) & 255;
    const oldPixel = (before >>> shift) & 255, delta = ((after >>> shift) & 255) - oldPixel;
    if (oldPaint > 0) upper = Math.min(upper, (oldPixel + 1) / oldPaint);
    if (oldPaint < 255) upper = Math.min(upper, (256 - oldPixel) / (255 - oldPaint));
    const step = newPaint - oldPaint;
    if (!step) {
      if (Math.abs(delta) > 2) return false;
    } else {
      const first = (delta - 2) / step, last = (delta + 2) / step;
      lower = Math.max(lower, Math.min(first, last));
      upper = Math.min(upper, Math.max(first, last));
    }
  }
  return lower <= upper;
}

export function expectedPixelMask(regions, source, edited, tolerance, issues) {
  const mask = new Uint8Array(source.width * source.height);
  function pixels(region, inspect) {
    for (let y = Math.max(0, region.top); y < Math.min(source.height, region.bottom); y++) {
      for (let x = Math.max(0, region.left); x < Math.min(source.width, region.right); x++) {
        const index = y * source.width + x;
        if (inspect(index, source.data.readUInt32BE(index * 4), edited.data.readUInt32BE(index * 4), x, y)) return true;
      }
    }
  }
  for (const text of regions.filter(region => region.ink !== undefined)) {
    let visible = false, changed = false, mismatches = 0;
    pixels(text, (index, before, after, x, y) => {
      if (text.reference) {
        const offset = ((y - text.top) * text.reference.width + x - text.left) * 4;
        if (pixelDistance(after, text.reference.data.readUInt32BE(offset)) > tolerance) {
          mismatches++;
          return;
        }
      }
      if (before === text.background && after === text.editedBackground) return;
      if (!matchesRecolor(text.background, before, text.background, text.ink) ||
          !matchesRecolor(text.editedBackground, after, text.editedBackground, text.ink)) return;
      if (pixelDistance(after, text.editedBackground) > tolerance) visible = true;
      if (pixelDistance(before, after) > tolerance && !matchesRecolor(before, after, text.background, text.editedBackground)) changed = true;
      mask[index] = 1;
    });
    if (mismatches) issues.push({ code: 'text-raster-mismatch', id: text.id, count: mismatches });
    if (!visible || !changed) issues.push({ code: 'missing-expected-pixels', bounds: { id: text.id } });
  }
  for (const fill of regions.filter(region => region.from !== undefined)) {
    const visible = pixels(fill, (_index, before) => before === fill.from);
    if (!visible) continue;
    let changed = false, wrongFill = false;
    pixels(fill, (index, before, after) => {
      if (before === fill.from) {
        if (after === fill.to) changed = true;
        else if (mask[index] !== 1) wrongFill = true;
      }
      if (mask[index] === 0 && matchesRecolor(before, after, fill.from, fill.to)) mask[index] = 2;
    });
    if (!changed) issues.push({ code: 'missing-expected-pixels', bounds: { id: fill.id } });
    if (wrongFill) issues.push({ code: 'wrong-token-color', expected: `#${(fill.to >>> 8).toString(16).padStart(6, '0')}` });
  }
  return mask;
}
