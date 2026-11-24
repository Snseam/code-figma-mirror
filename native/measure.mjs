import { PNG } from 'pngjs';

export class MissingNode extends Error {}

export async function locate(scope, selector) {
  for (const part of [selector].flat()) {
    const matches = await scope.$$(part);
    if (matches.length > 1) throw new Error(`Ambiguous WXML selector ${part} (${matches.length} matches)`);
    if (!matches.length) return null;
    scope = matches[0];
  }
  return scope;
}

export function screenshotSpace(bytes, info) {
  const { width, height } = PNG.sync.read(bytes);
  const { windowWidth, windowHeight, screenWidth, screenHeight, screenTop } = info;
  if (![windowWidth, windowHeight].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('Runtime returned invalid window dimensions');
  }
  const scale = width / windowWidth;
  const matches = logicalHeight => Math.abs(height - logicalHeight * scale) <= 0.5;
  if (matches(windowHeight)) return { width, height, scale, top: 0, area: 'window' };
  if (screenWidth === windowWidth && matches(screenHeight) && Number.isFinite(screenTop) &&
      screenTop >= 0 && screenTop + windowHeight <= screenHeight + 0.5) {
    return { width, height, scale, top: screenTop, area: 'screen' };
  }
  throw new Error(`Cannot align ${width}×${height} PNG with ${windowWidth}×${windowHeight} window`);
}

const frameFields = ['background-color', 'border-top-color', 'border-top-width', 'border-top-left-radius', 'overflow'];
const textFields = ['color', 'font-size', 'font-family', 'font-style', 'font-weight', 'line-height', 'letter-spacing', 'text-align'];

function color(value) {
  if (value === 'transparent') return { alpha: 0 };
  let hex = value?.match(/^#([a-f\d]{3,4}|[a-f\d]{6}|[a-f\d]{8})$/i)?.[1];
  if (hex) {
    if (hex.length < 5) hex = [...hex].map(char => char + char).join('');
    return { rgb: `#${hex.slice(0, 6).toUpperCase()}`, alpha: hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1 };
  }
  const match = value?.match(/^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)$/i);
  if (match) {
    const channels = match.slice(1, 4).map(Number);
    const alpha = Number(match[4] ?? 1);
    if (channels.every(channel => channel <= 255) && alpha <= 1) {
      return { rgb: '#' + channels.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('').toUpperCase(), alpha };
    }
  }
}

async function measureStyle(element, node, scale, warn) {
  const fields = [...(node.kind === 'frame' ? frameFields : textFields), 'opacity'];
  const css = Object.fromEntries(await Promise.all(fields.map(async key => [key, await element.style(key)])));
  const style = {};
  function length(field, target) {
    const value = css[field];
    if (/^(?:\d+(?:\.\d+)?|\.\d+)px$/.test(value)) style[target] = parseFloat(value) * scale;
    else if (value && value !== 'normal' && value !== '0') warn(`${node.id}: unsupported ${field} ${value}`);
  }
  function paint(field, target) {
    const value = color(css[field]);
    if (value?.alpha > 0) style[target] = value.rgb;
    if (value && value.alpha < 1 && node.kind === 'text') style.opacity = (style.opacity ?? 1) * value.alpha;
    else if (value?.alpha > 0 && value.alpha < 1) warn(`${node.id}: ${field} alpha is approximated in editable IR`);
    else if (css[field] && !value) warn(`${node.id}: unsupported ${field} ${css[field]}`);
  }
  if (css.opacity != null && css.opacity !== '' && Number(css.opacity) >= 0 && Number(css.opacity) < 1) {
    style.opacity = Number(css.opacity);
  }
  if (node.kind === 'frame') {
    paint('background-color', 'fill');
    length('border-top-width', 'strokeWidth');
    if (style.strokeWidth > 0) paint('border-top-color', 'stroke');
    length('border-top-left-radius', 'radius');
    if (['hidden', 'clip', 'scroll', 'auto'].includes(css.overflow)) style.clip = true;
  } else {
    for (const field of ['font-size', 'font-family', 'font-weight', 'color']) {
      if (!css[field]) warn(`${node.id}: DevTools returned no ${field}`);
    }
    paint('color', 'color');
    length('font-size', 'fontSize');
    length('line-height', 'lineHeight');
    const spacing = css['letter-spacing'];
    if (spacing === 'normal' || spacing === '0') style.letterSpacing = 0;
    else if (/^-?(?:\d+(?:\.\d+)?|\.\d+)px$/.test(spacing)) style.letterSpacing = parseFloat(spacing) * scale;
    else if (spacing) warn(`${node.id}: unsupported letter-spacing ${spacing}`);
    if (css['font-family']) style.fontFamily = css['font-family'].split(',')[0].trim().replace(/^["']|["']$/g, '');
    const weight = Number(({ normal: 400, bold: 700 })[css['font-weight']] ?? css['font-weight']);
    const face = weight >= 700 ? 'Bold' : weight >= 600 ? 'Semi Bold' : weight >= 500 ? 'Medium' :
      weight > 0 && weight <= 300 ? 'Light' : 'Regular';
    if (css['font-weight'] || css['font-style']) {
      style.fontStyle = /italic|oblique/.test(css['font-style']) ? (face === 'Regular' ? 'Italic' : `${face} Italic`) : face;
    }
    if (['left', 'right', 'center', 'justify', 'start', 'end'].includes(css['text-align'])) {
      style.align = css['text-align'].toUpperCase();
    }
  }
  return style;
}

export async function measureNodes(rules, scope, boardId, origin, scale, warn) {
  const nodes = [];
  for (const rule of rules) {
    const id = `${boardId}#${rule.id}`;
    const element = await locate(scope, rule.selector);
    if (!element) throw new MissingNode(`${id}: missing WXML selector ${JSON.stringify(rule.selector)}`);
    const [offset, size] = await Promise.all([element.offset(), element.size()]);
    if (![offset.left, offset.top, size.width, size.height].every(Number.isFinite) || size.width <= 0 || size.height <= 0) {
      throw new Error(`${id}: invalid or empty native bounds`);
    }
    const node = {
      id, name: rule.name ?? rule.id, kind: rule.kind,
      x: (offset.left - origin.left) * scale, y: (offset.top - origin.top) * scale,
      width: size.width * scale, height: size.height * scale,
      style: await measureStyle(element, { id, kind: rule.kind }, scale, warn)
    };
    if (rule.component) node.component = rule.component;
    if (rule.kind === 'text') {
      node.text = await element.text();
      if (typeof node.text !== 'string') throw new Error(`${id}: expected native text`);
    } else if (rule.children?.length) {
      node.children = await measureNodes(rule.children, element, boardId, offset, scale, warn);
    }
    nodes.push(node);
  }
  return nodes;
}
