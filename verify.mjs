import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';

const asText = value => typeof value === 'string' ? value : JSON.stringify(value);
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const isComponent = value => typeof value === 'string' && value.length > 0 &&
  !/[/\\\x00-\x1f]/u.test(value) && value !== '.' && value !== '..';
const percent = ratio => `${Number((ratio * 100).toFixed(5))}%`;

async function loadImage(file, side, issues) {
  try {
    const [bytes, info] = await Promise.all([readFile(file), stat(file, { bigint: true })]);
    const png = PNG.sync.read(bytes);
    return { png, bytes, inode: `${info.dev}/${info.ino}`, size: { width: png.width, height: png.height } };
  } catch (error) {
    issues.push({ code: error.code === 'ENOENT' ? 'missing' : 'unreadable', side, detail: error.message });
    return null;
  }
}

function compare(source, figma, pixelTolerance) {
  const heat = new PNG({ width: source.width, height: source.height });
  let diffPixels = 0;
  for (let offset = 0; offset < source.data.length; offset += 4) {
    const sourceAlpha = source.data[offset + 3];
    const figmaAlpha = figma.data[offset + 3];
    let delta = Math.abs(sourceAlpha - figmaAlpha);
    for (let channel = 0; channel < 3; channel++) {
      const distance = Math.abs(source.data[offset + channel] * sourceAlpha -
        figma.data[offset + channel] * figmaAlpha) / 255;
      delta = Math.max(delta, distance);
    }
    if (delta > pixelTolerance) {
      diffPixels++;
      heat.data.writeUInt32BE(0xd92052ff, offset);
    } else {
      heat.data.writeUInt32BE(0xf2f2f2ff, offset);
    }
  }
  const totalPixels = source.width * source.height;
  return { bytes: PNG.sync.write(heat), diffPixels, totalPixels, diffRatio: diffPixels / totalPixels };
}

function figure(label, bytes, size) {
  const image = bytes ? `<img alt="${label}" width="${size.width}" height="${size.height}" src="data:image/png;base64,${bytes.toString('base64')}">` : '<p>无可用图像</p>';
  const dimensions = size ? ` · ${size.width} × ${size.height}` : '';
  return `<figure><figcaption>${label}${dimensions}</figcaption>${image}</figure>`;
}

function issueText(issue) {
  const side = issue.side === 'source' ? '源页面' : 'Figma 导出';
  switch (issue.code) {
    case 'missing': return `${side}缺少 PNG`;
    case 'unreadable': return `${side} PNG 读取失败（${issue.detail}）`;
    case 'dimension-mismatch': return `${side}实际为 ${issue.actual.width} × ${issue.actual.height}，预期 ${issue.expected.width} × ${issue.expected.height}`;
    case 'diff-threshold-exceeded': return '差异像素比例超过验收阈值';
    case 'same-input-file': return '源页面和 Figma 导出指向同一文件';
    case 'ambiguous-filename': return '多个画板对应同一 PNG 文件名';
    case 'invalid-board': return '画板标识或预期尺寸无效';
    case 'invalid-export-manifest': return `Figma 导出清单无效（${issue.detail}）`;
    case 'empty-bundle': return '采集包中没有画板';
    default: return asText(issue);
  }
}

function boardSection(board, source, figma, heat) {
  const counts = board.diffRatio === null ? '未计算差异比例' :
    `差异像素 ${board.diffPixels} / ${board.totalPixels} (${percent(board.diffRatio)})`;
  return `<section><h2>${escapeHtml(board.id)}</h2><p><strong>${board.passed ? '通过' : '失败'}</strong> · 预期 ${escapeHtml(board.expected.width)} × ${escapeHtml(board.expected.height)} · ${counts}</p>
${itemList(board.issues.map(issueText))}<div class="images">${figure('源页面', source?.bytes, source?.size)}${figure('Figma 导出', figma?.bytes, figma?.size)}${figure('差异热图', heat, heat ? source.size : null)}</div></section>`;
}

function itemList(items) {
  if (!items.length) return '';
  return `<ul>${items.map(item => `<li>${escapeHtml(asText(item))}</li>`).join('')}</ul>`;
}

async function loadExportIndex(figmaDir) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(figmaDir, 'design-diff.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!Array.isArray(manifest.boards)) throw new TypeError('design-diff.json must include boards');
  const boards = new Map();
  const files = new Set();
  for (const board of manifest.boards) {
    if (boards.has(board.id)) throw new Error(`Repeated export board ${board.id}`);
    boards.set(board.id, board);
    if (board.file == null) continue;
    if (!isComponent(board.file) || !board.file.toLowerCase().endsWith('.png')) {
      throw new Error(`Invalid PNG filename for export board ${board.id}`);
    }
    const key = board.file.normalize('NFC').toLowerCase();
    if (files.has(key)) throw new Error(`Repeated export filename ${board.file}`);
    files.add(key);
  }
  return { boards, warnings: manifest.warnings ?? [] };
}

function documentHtml(report, sections) {
  const passedCount = report.boards.filter(board => board.passed).length;
  const profile = report.rasterProfile;
  const reference = profile
    ? `参考图来自受控字体采集（${escapeHtml(profile.name)}）。字体 ${escapeHtml(profile.fontFamily)}，平滑设置 ${escapeHtml(profile.smoothing)}。`
    : '参考图来自原始采集。';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>视觉验收报告</title><style>
*{box-sizing:border-box}body{margin:0;color:#192934;background:#fafbfc;font:1rem/1.55 system-ui,sans-serif}
main{max-inline-size:100rem;margin-inline:auto;padding:clamp(1rem,3vw,3rem);overflow-wrap:anywhere}
h1,h2,figure{margin:0}section{border-block-start:1px solid #cbd4db;padding-block:1.5rem}
p{max-inline-size:80ch}
.images{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,19rem),1fr));gap:1rem}
figcaption{font-weight:600;margin-block-end:.5rem}figure img{display:block;inline-size:100%;block-size:auto;border:1px solid #ccd3d8}
</style></head><body><main><h1>视觉验收${report.passed ? '通过' : '失败'}</h1>
<p>通过 ${passedCount} / ${report.boards.length} 个画板。允许差异比例 ${percent(report.maxDiffRatio)}，单像素通道容差 ${report.pixelTolerance} / 255。热图用红色标出超过通道容差的像素。</p>
<p>${reference}</p>
${itemList(report.issues.map(issueText))}${sections.join('\n')}
${report.warnings.length ? `<section><h2>采集警告</h2>${itemList(report.warnings)}</section>` : ''}
${report.figmaWarnings.length ? `<section><h2>Figma 导出警告</h2>${itemList(report.figmaWarnings)}</section>` : ''}
${report.edges.length ? `<section><h2>状态连线</h2>${itemList(report.edges)}</section>` : ''}
</main></body></html>\n`;
}

export async function verify(captureDir, figmaDir, outDir, options = {}) {
  const maxDiffRatio = options.maxDiffRatio ?? options.threshold ?? 0;
  const pixelTolerance = options.pixelTolerance ?? 0;
  if (!Number.isFinite(maxDiffRatio) || maxDiffRatio < 0 || maxDiffRatio > 1) {
    throw new RangeError('maxDiffRatio must be a number from 0 to 1');
  }
  if (!Number.isInteger(pixelTolerance) || pixelTolerance < 0 || pixelTolerance > 255) {
    throw new RangeError('pixelTolerance must be an integer from 0 to 255');
  }
  const bundle = JSON.parse(await readFile(path.join(captureDir, 'bundle.json'), 'utf8'));
  if (!Array.isArray(bundle.boards)) throw new TypeError('bundle.boards must be an array');
  const report = {
    passed: false, maxDiffRatio, pixelTolerance, boards: [], edges: bundle.edges ?? [],
    rasterProfile: bundle.rasterProfile ?? null,
    warnings: bundle.warnings ?? [], figmaWarnings: [], issues: bundle.boards.length ? [] : [{ code: 'empty-bundle' }]
  };
  let exports;
  try {
    exports = await loadExportIndex(figmaDir);
    report.figmaWarnings = exports?.warnings ?? [];
  } catch (error) {
    report.issues.push({ code: 'invalid-export-manifest', detail: error.message });
    exports = { boards: new Map() };
  }
  const filenames = new Map();
  for (const { viewport, state } of bundle.boards) {
    const key = `${viewport}--${state}.png`.normalize('NFC').toLowerCase();
    filenames.set(key, (filenames.get(key) ?? 0) + 1);
  }
  await mkdir(path.join(outDir, 'heatmaps'), { recursive: true });
  const sections = [];
  for (const { id, width, height, viewport, state } of bundle.boards) {
    const filename = `${viewport}--${state}.png`;
    const board = {
      id, viewport, state, filename, expected: { width, height }, source: null, figma: null,
      diffRatio: null, diffPixels: null, totalPixels: null, heatmap: null, issues: [], passed: false
    };
    report.boards.push(board);
    if (!isComponent(viewport) || !isComponent(state) || id !== `${viewport}/${state}` ||
        !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
      board.issues.push({ code: 'invalid-board' });
    }
    if (filenames.get(filename.normalize('NFC').toLowerCase()) > 1) {
      board.issues.push({ code: 'ambiguous-filename' });
    }
    if (board.issues.length) {
      sections.push(boardSection(board));
      continue;
    }
    const exported = exports?.boards.get(id);
    board.figmaFilename = exports ? exported?.file ?? null : filename;
    const source = await loadImage(path.join(captureDir, 'source', filename), 'source', board.issues);
    let figma = null;
    if (!board.figmaFilename || exported?.status === 'missing') {
      board.issues.push({ code: 'missing', side: 'figma', detail: 'No PNG exported for this board' });
    } else {
      figma = await loadImage(path.join(figmaDir, board.figmaFilename), 'figma', board.issues);
    }
    for (const [side, image] of [['source', source], ['figma', figma]]) {
      if (!image) continue;
      board[side] = image.size;
      if (image.size.width !== width || image.size.height !== height) {
        board.issues.push({ code: 'dimension-mismatch', side, actual: image.size, expected: board.expected });
      }
    }
    let heat;
    if (source && figma && source.inode === figma.inode) {
      board.issues.push({ code: 'same-input-file' });
    } else if (source && figma && source.size.width === figma.size.width && source.size.height === figma.size.height) {
      const { bytes, ...metrics } = compare(source.png, figma.png, pixelTolerance);
      Object.assign(board, metrics);
      heat = bytes;
      board.heatmap = `heatmaps/${filename}`;
      await writeFile(path.join(outDir, board.heatmap), heat);
      if (board.diffRatio > maxDiffRatio) board.issues.push({ code: 'diff-threshold-exceeded' });
    }
    board.passed = board.issues.length === 0;
    sections.push(boardSection(board, source, figma, heat));
  }
  report.passed = report.issues.length === 0 && report.boards.every(board => board.passed);
  await Promise.all([
    writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(path.join(outDir, 'report.html'), documentHtml(report, sections))
  ]);
  return report;
}
