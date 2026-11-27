export function stateFingerprint(expected) {
  function visibleSelector(selector) {
    return [...document.querySelectorAll(selector)].some(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 &&
        element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    });
  }
  if (expected?.selectors) return expected.selectors.filter(visibleSelector);
  if (expected && expected.url !== location.href) return false;
  if (expected?.assertion && visibleSelector(expected.assertion)) return true;
  const records = [];
  const visit = element => {
    const tag = element.localName;
    if (['script', 'style', 'template', 'noscript', 'head'].includes(tag)) return;
    const css = getComputedStyle(element);
    if (css.display === 'none' || css.contentVisibility === 'hidden' || Number(css.opacity) === 0) return;
    const visible = css.visibility === 'visible';
    if (visible) {
      const attributes = ['id', 'class', 'role', 'aria-label', 'aria-expanded', 'aria-selected',
        'aria-pressed', 'aria-current', 'aria-hidden', 'data-state', 'data-variant', 'open', 'href',
        'src', 'd', 'fill', 'stroke', 'style'].map(key => element.getAttribute(key));
      const value = ['input', 'textarea', 'select'].includes(tag)
        ? (element.type === 'password' ? Boolean(element.value) : element.value) : undefined;
      records.push([tag, ...attributes, element.checked, value, element.disabled]);
    }
    for (const child of element.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) visit(child);
      else if (visible && child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
        records.push(child.textContent.replace(/\s+/g, ' ').trim());
      }
    }
    if (visible) records.push(null);
  };
  if (document.documentElement) visit(document.documentElement);
  const signature = JSON.stringify([document.title, records]);
  return expected ? signature === expected.signature : signature;
}

export function collectDOM({ boardId, components, tokenVariables, edgeSelectors, svgImages }) {
  const warnings = new Set();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const paint = canvas.getContext('2d', { willReadFrequently: true });
  const colors = new Map();
  const hex = value => Math.round(value).toString(16).padStart(2, '0').toUpperCase();
  function color(value) {
    if (colors.has(value)) return colors.get(value);
    if (!value || !CSS.supports('color', value)) return undefined;
    paint.fillStyle = value;
    const normalized = paint.fillStyle;
    let result;
    if (/^#[0-9a-f]{6}$/i.test(normalized)) result = normalized.toUpperCase();
    else {
      const rgb = normalized.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
      if (rgb) {
        const alpha = Math.round(Number(rgb[4] ?? 1) * 255);
        result = `#${hex(rgb[1])}${hex(rgb[2])}${hex(rgb[3])}${alpha === 255 ? '' : hex(alpha)}`;
      } else {
        paint.clearRect(0, 0, 1, 1);
        paint.fillRect(0, 0, 1, 1);
        const [red, green, blue, alpha] = paint.getImageData(0, 0, 1, 1).data;
        result = `#${hex(red)}${hex(green)}${hex(blue)}${alpha === 255 ? '' : hex(alpha)}`;
      }
    }
    colors.set(value, result);
    return result;
  }

  const viewport = new DOMRect(0, 0, innerWidth, innerHeight);
  function intersect(rect, clip) {
    const left = Math.max(rect.left, clip.left);
    const top = Math.max(rect.top, clip.top);
    const width = Math.min(rect.right, clip.right) - left;
    const height = Math.min(rect.bottom, clip.bottom) - top;
    return width > 0 && height > 0 ? new DOMRect(left, top, width, height) : null;
  }
  function bounds(rect, parent) {
    return { x: rect.x - parent.x, y: rect.y - parent.y, width: rect.width, height: rect.height };
  }
  function frameStyle(css, rect) {
    const style = {};
    const fill = color(css.backgroundColor);
    if (fill && !(fill.length === 9 && fill.endsWith('00'))) style.fill = fill;
    const border = ['Top', 'Right', 'Bottom', 'Left'].find(side => parseFloat(css[`border${side}Width`]) > 0);
    if (border) {
      style.stroke = color(css[`border${border}Color`]);
      style.strokeWidth = parseFloat(css[`border${border}Width`]);
      if (['Top', 'Right', 'Bottom', 'Left'].some(side =>
        css[`border${side}Width`] !== css[`border${border}Width`] ||
        css[`border${side}Color`] !== css[`border${border}Color`] ||
        css[`border${side}Style`] !== 'solid')) warnings.add('Nonuniform or patterned borders are approximated.');
    }
    const corners = [css.borderTopLeftRadius, css.borderTopRightRadius, css.borderBottomRightRadius, css.borderBottomLeftRadius];
    if (corners.some(corner => parseFloat(corner) > 0)) {
      const [horizontal, vertical = horizontal] = corners[0].split(' ');
      const length = (value, size) => parseFloat(value) * (value.endsWith('%') ? size / 100 : 1);
      const radius = Math.min(length(horizontal, rect.width), length(vertical, rect.height), rect.width / 2, rect.height / 2);
      if (Number.isFinite(radius)) style.radius = radius;
      if (new Set(corners).size > 1 || length(horizontal, rect.width) !== length(vertical, rect.height)) {
        warnings.add('Asymmetric corner radii are approximated.');
      }
    }
    if (Number(css.opacity) < 1) style.opacity = Number(css.opacity);
    const blur = /^blur\(([\d.]+)px\)$/.exec(css.backdropFilter);
    if (blur) style.backdropBlur = Number(blur[1]);
    else if (css.backdropFilter && css.backdropFilter !== 'none') warnings.add(`Unsupported backdrop-filter: ${css.backdropFilter}`);
    if (css.overflowX !== 'visible' || css.overflowY !== 'visible') style.clip = true;
    return style;
  }
  function textStyle(css) {
    const weight = Number(css.fontWeight);
    const face = weight >= 700 ? 'Bold' : weight >= 600 ? 'Semi Bold' : weight >= 500 ? 'Medium'
      : weight <= 300 ? 'Light' : 'Regular';
    const italic = /italic|oblique/.test(css.fontStyle);
    const logicalStart = css.direction === 'rtl' ? 'right' : 'left';
    const physical = css.textAlign.replace(/^-webkit-/, '');
    const align = ['left', 'right', 'center', 'justify'].includes(physical) ? physical
      : physical === 'end' ? (logicalStart === 'left' ? 'right' : 'left') : logicalStart;
    const fontSize = parseFloat(css.fontSize);
    const spacing = css.letterSpacing;
    let letterSpacing;
    if (spacing === 'normal') letterSpacing = 0;
    else if (spacing.endsWith('px')) letterSpacing = parseFloat(spacing);
    else if (spacing.endsWith('%')) letterSpacing = parseFloat(spacing) * fontSize / 100;
    else warnings.add(`Unsupported computed letter-spacing: ${spacing}`);
    return {
      fontFamily: css.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, ''),
      fontStyle: italic ? (face === 'Regular' ? 'Italic' : `${face} Italic`) : face,
      fontSize, ...(Number.isFinite(letterSpacing) ? { letterSpacing } : {}),
      ...(Number.isFinite(parseFloat(css.lineHeight)) ? { lineHeight: parseFloat(css.lineHeight) } : {}),
      ...(Number.isFinite(weight) ? { fontWeight: weight } : {}),
      color: color(css.color), align: align.toUpperCase()
    };
  }
  function textNodes(text, key, css, parent, clip) {
    const range = document.createRange();
    range.selectNodeContents(text);
    if (!intersect(range.getBoundingClientRect(), clip)) return [];
    const result = [];
    function emit(value, rect, offset) {
      if (!intersect(rect, clip)) return;
      if (['normal', 'nowrap', 'pre-line'].includes(css.whiteSpace)) value = value.replace(/[ \t\n\r\f]+/g, ' ');
      if (css.textTransform === 'uppercase') value = value.toLocaleUpperCase();
      if (css.textTransform === 'lowercase') value = value.toLocaleLowerCase();
      if (!value) return;
      result.push({ id: `${boardId}#${key}@${offset}`, name: value.trim().slice(0, 64) || 'Space',
        kind: 'text', ...bounds(rect, parent), singleLine: true, text: value, style: textStyle(css) });
    }
    if (range.getClientRects().length === 1) {
      emit(text.data, range.getBoundingClientRect(), 0);
      return result;
    }
    let lineTop;
    let start = 0;
    let offset = 0;
    function finish(end) {
      range.setStart(text, start);
      range.setEnd(text, end);
      emit(text.data.slice(start, end), range.getBoundingClientRect(), start);
    }
    for (const character of text.data) {
      range.setStart(text, offset);
      range.setEnd(text, offset + character.length);
      const rect = range.getBoundingClientRect();
      if (rect.height && lineTop !== undefined && Math.abs(rect.top - lineTop) > 1) {
        finish(offset);
        start = offset;
      }
      if (rect.height) lineTop = rect.top;
      offset += character.length;
    }
    finish(offset);
    return result;
  }

  function svgMarkup(root, dimensions, external = false) {
    const tags = new Set('svg g defs symbol use path rect circle ellipse line polyline polygon title desc text tspan clipPath mask linearGradient radialGradient stop'.split(' '));
    const attrs = new Set('id x y dx dy x1 x2 y1 y2 cx cy r rx ry fx fy fr width height viewBox preserveAspectRatio d points pathLength transform gradientUnits gradientTransform spreadMethod offset maskUnits maskContentUnits clipPathUnits textLength lengthAdjust rotate'.split(' '));
    const props = 'color fill fill-opacity fill-rule stroke stroke-opacity stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset opacity clip-path clip-rule mask-image stop-color stop-opacity font-family font-size font-weight font-style text-anchor dominant-baseline visibility display'.split(' ');
    const all = [root, ...root.querySelectorAll('*')];
    const ids = new Set(all.map(item => item.id).filter(Boolean));
    function reference(value) {
      if (value.startsWith('#') && ids.has(value.slice(1))) return value;
      const url = new URL(value, document.baseURI);
      const current = new URL(location.href);
      current.hash = '';
      const fragment = url.hash;
      url.hash = '';
      if (!fragment || url.href !== current.href || !ids.has(decodeURIComponent(fragment.slice(1)))) {
        throw Error('external or unresolved SVG resource');
      }
      return fragment;
    }
    function clone(source) {
      if (!tags.has(source.localName)) throw Error(`unsupported SVG element ${source.localName}`);
      const copy = document.createElementNS('http://www.w3.org/2000/svg', source.localName);
      for (const attr of source.attributes) {
        if (attrs.has(attr.name)) copy.setAttribute(attr.name, attr.value);
        else if (attr.localName === 'href') copy.setAttribute('href', reference(attr.value));
        else if (external && !props.includes(attr.name) && !['xmlns', 'xmlns:xlink', 'version', 'class', 'role',
          'focusable', 'mask'].includes(attr.name) && !attr.name.startsWith('aria-') && !attr.name.startsWith('data-')) {
          throw Error(`unsupported SVG attribute ${attr.name}`);
        }
      }
      const css = external ? null : getComputedStyle(source);
      if (css && (css.filter !== 'none' || css.mixBlendMode !== 'normal')) throw Error('SVG filter or blend mode');
      if (css && !source.hasAttribute('transform') && css.transform !== 'none') throw Error('CSS-transformed SVG');
      for (const prop of props) {
        if (!external && source === root && prop === 'opacity') continue;
        let value = css ? css.getPropertyValue(prop) : source.getAttribute(prop === 'mask-image' ? 'mask' : prop);
        if (!value || value === 'none' && prop === 'mask-image') continue;
        if (value.includes('url(')) value = value.replace(/url\(["']?([^"')]+)["']?\)/g,
          (_, url) => `url(${reference(url)})`);
        if (['color', 'fill', 'stroke', 'stop-color'].includes(prop) && value.toLowerCase() !== 'currentcolor') {
          value = color(value) ?? value;
        }
        copy.setAttribute(prop === 'mask-image' ? 'mask' : prop, value);
      }
      for (const child of source.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE) copy.append(clone(child));
        if (child.nodeType === Node.TEXT_NODE) copy.append(document.createTextNode(child.data));
      }
      return copy;
    }
    const copy = clone(root);
    if (external && !root.hasAttribute('viewBox')) {
      const width = root.getAttribute('width');
      const height = root.getAttribute('height');
      if (![width, height].every(value => /^\d+(?:\.\d+)?(?:px)?$/.test(value) && parseFloat(value) > 0)) {
        throw Error('SVG has no intrinsic viewBox or pixel dimensions');
      }
      copy.setAttribute('viewBox', `0 0 ${parseFloat(width)} ${parseFloat(height)}`);
    }
    copy.setAttribute('width', String(dimensions.width));
    copy.setAttribute('height', String(dimensions.height));
    return new XMLSerializer().serializeToString(copy);
  }

  const tokenEntries = [];
  const rootCSS = getComputedStyle(document.documentElement);
  const rootFill = color(rootCSS.backgroundColor);
  for (const [name, variable] of Object.entries(tokenVariables)) {
    const value = rootCSS.getPropertyValue(variable).trim();
    if (value && color(value)) tokenEntries.push([name, color(value)]);
    else if (value) warnings.add(`Non-color root token ${name} (${variable}) was omitted.`);
    else warnings.add(`Missing root token ${name} (${variable}).`);
  }
  const metadata = new Map();
  for (const rule of components) {
    for (const element of document.querySelectorAll(rule.selector)) {
      if (!metadata.has(element)) metadata.set(element, rule);
    }
  }
  const sources = [];
  const exported = new Map();
  const crops = [];
  const topLayers = document.querySelectorAll('dialog:modal, :popover-open');
  const topLayer = topLayers.length === 1 ? topLayers[0] : null;
  if (topLayers.length > 1) warnings.add('Multiple top-layer elements retain approximate DOM stacking order.');
  let topLayerPath;
  function visit(element, path, parentRect, clip, lifted = false) {
    const tag = element.localName;
    if (['script', 'style', 'template', 'head', 'noscript', 'link', 'meta'].includes(tag)) return [];
    const css = getComputedStyle(element);
    if (css.display === 'none' || Number(css.opacity) === 0) return [];
    if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) path = `#${CSS.escape(element.id)}`;
    if (element === topLayer && !lifted) { topLayerPath = path; return []; }
    const isRoot = element === document.documentElement;
    const rect = isRoot ? viewport : element.getBoundingClientRect();
    const visible = intersect(rect, clip);
    const represented = visible && css.visibility === 'visible';
    const id = `${boardId}#${path}`;
    const children = [];
    let node;
    if (represented) {
      const rule = metadata.get(element);
      const component = rule?.name ?? element.dataset.component;
      const variant = rule?.variant ?? element.dataset.variant;
      const figmaKey = rule?.figmaKey ?? element.dataset.figmaKey;
      const name = [component, element.getAttribute('aria-label'), element.getAttribute('alt'), element.id, tag]
        .find(value => value?.trim());
      node = { id, name, kind: 'frame', ...bounds(rect, parentRect), style: frameStyle(css, rect),
        ...(component && { component }), ...(variant && { variant }), ...(figmaKey && { figmaKey }) };
      exported.set(element, { id, path });
      if (isRoot && !node.style.fill) {
        node.style.fill = document.body && color(getComputedStyle(document.body).backgroundColor) || '#FFFFFF';
        if (node.style.fill.endsWith('00') && node.style.fill.length === 9) node.style.fill = '#FFFFFF';
      }
      if (element === document.body && rootFill?.length === 9 && rootFill.endsWith('00')) delete node.style.fill;
      if (isRoot) node.style.clip = true;
      function raster(reason) {
        const left = Math.max(0, Math.floor(visible.left));
        const top = Math.max(0, Math.floor(visible.top));
        const crop = new DOMRect(left, top, Math.ceil(visible.right) - left, Math.ceil(visible.bottom) - top);
        Object.assign(node, { kind: 'image', ...bounds(crop, parentRect), style: {} });
        crops.push({ id, x: left, y: top, width: crop.width, height: crop.height });
        warnings.add(`${path} captured as rendered PNG (${reason}).`);
        return [node];
      }
      if (tag === 'svg') {
        try {
          node.svg = svgMarkup(element, rect);
          node.kind = 'svg';
          return [node];
        } catch (error) { return raster(error.message); }
      }
      if (tag === 'img' || tag === 'canvas') {
        if (tag === 'img' && (!element.naturalWidth || css.objectFit !== 'fill' || css.filter !== 'none')) {
          return raster('unavailable image, object-fit or CSS filter');
        }
        const intrinsicWidth = tag === 'img' ? element.naturalWidth : element.width;
        const intrinsicHeight = tag === 'img' ? element.naturalHeight : element.height;
        if (tag === 'img' && !Object.hasOwn(svgImages, element.currentSrc) &&
          Math.abs(rect.width - rect.height * intrinsicWidth / intrinsicHeight) > 1) {
          return raster('stretched bitmap');
        }
        if (node.style.strokeWidth || node.style.fill || ['Top', 'Right', 'Bottom', 'Left'].some(side => parseFloat(css[`padding${side}`]) > 0)) {
          return raster('CSS box around image content');
        }
        if (tag === 'img' && Object.hasOwn(svgImages, element.currentSrc)) {
          try {
            const root = new DOMParser().parseFromString(svgImages[element.currentSrc], 'image/svg+xml').documentElement;
            if (root.localName !== 'svg') throw Error('invalid SVG document');
            node.svg = svgMarkup(root, rect, true);
            node.kind = 'svg';
            return [node];
          } catch (error) { return raster(error.message); }
        }
        try {
          let source = element;
          if (tag === 'img') {
            if (element.naturalWidth * element.naturalHeight > 16777216) return raster('large source image');
            source = document.createElement('canvas');
            source.width = element.naturalWidth;
            source.height = element.naturalHeight;
            source.getContext('2d').drawImage(element, 0, 0);
          }
          const encoded = source.toDataURL('image/png');
          if (!encoded.startsWith('data:image/png;base64,')) return raster('empty pixel buffer');
          node.data = encoded.slice('data:image/png;base64,'.length);
          node.kind = 'image';
          if (tag === 'img' && /(?:\.svg(?:[?#]|$)|^data:image\/svg\+xml)/i.test(element.currentSrc)) {
            warnings.add(`${path} SVG image resource was decoded as PNG.`);
          }
          return [node];
        } catch { return raster('pixel readback unavailable'); }
      }
      if (['input', 'textarea', 'select', 'video', 'iframe', 'object', 'embed', 'progress', 'meter'].includes(tag)
        || element.shadowRoot) return raster(`native ${tag} or shadow content`);
      if (css.backgroundImage !== 'none' || css.boxShadow !== 'none' || css.filter !== 'none'
        || css.transform !== 'none' || css.clipPath !== 'none' || css.zIndex !== 'auto') {
        warnings.add(`${path} has CSS painting or transforms approximated by the editable frame.`);
      }
      if (['::before', '::after'].some(pseudo => !['none', 'normal'].includes(getComputedStyle(element, pseudo).content))) {
        warnings.add(`${path} has generated pseudo-element content visible in the reference screenshot.`);
      }
    }
    let childClip = clip;
    if (!isRoot && css.display !== 'contents' && (css.overflowX !== 'visible' || css.overflowY !== 'visible')) {
      const left = css.overflowX === 'visible' ? clip.left : rect.left;
      const top = css.overflowY === 'visible' ? clip.top : rect.top;
      childClip = intersect(new DOMRect(left, top, css.overflowX === 'visible' ? clip.width : rect.width,
        css.overflowY === 'visible' ? clip.height : rect.height), clip);
    }
    if (childClip && css.contentVisibility !== 'hidden') {
      const origin = represented ? rect : parentRect;
      let sibling = 0;
      let textIndex = 0;
      for (const child of element.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          children.push(...visit(child, `${path}>:nth-child(${++sibling})`, origin, childClip));
        } else if (child.nodeType === Node.TEXT_NODE && css.visibility === 'visible') {
          children.push(...textNodes(child, `${path}/text-${++textIndex}`, css, origin, childClip));
        }
      }
    }
    if (!represented) return children;
    node.children = children;
    return [node];
  }
  const children = visit(document.documentElement, ':root', viewport, viewport);
  if (topLayerPath) {
    const backdrop = getComputedStyle(topLayer, '::backdrop');
    if (backdrop.display !== 'none' && backdrop.visibility === 'visible') {
      if (backdrop.position === 'fixed' && ['left', 'right', 'top', 'bottom'].every(side => backdrop[side] === '0px')
        && backdrop.transform === 'none' && backdrop.backgroundImage === 'none') {
        children.push({ id: `${boardId}#${topLayerPath}::backdrop`, name: '::backdrop', kind: 'frame',
          ...bounds(viewport, viewport), style: frameStyle(backdrop, viewport), children: [] });
      } else warnings.add(`${topLayerPath} has unsupported native backdrop geometry or paint.`);
    }
    children.push(...visit(topLayer, topLayerPath, viewport, viewport, true));
  }
  for (const selector of edgeSelectors) {
    try {
      const matches = document.querySelectorAll(selector);
      if (matches.length === 1 && exported.has(matches[0])) sources.push([selector, exported.get(matches[0])]);
    } catch { warnings.add(`Invalid edge CSS selector ${selector}.`); }
  }
  return { children, crops, sources, tokens: Object.fromEntries(tokenEntries), warnings: [...warnings] };
}

export async function cropViewport({ screenshot, crops }) {
  const bytes = Uint8Array.from(atob(screenshot), character => character.charCodeAt(0));
  const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  try {
    return crops.map(({ id, x, y, width, height }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(image, x, y, width, height, 0, 0, width, height);
      return [id, canvas.toDataURL('image/png').slice('data:image/png;base64,'.length)];
    });
  } finally { image.close(); }
}
