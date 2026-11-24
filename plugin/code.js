"use strict";

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function isName(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function rgb(hex) {
  const value = parseInt(expandColor(hex).slice(1, 7), 16);
  return { r: (value >> 16) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255 };
}

function expandColor(hex) {
  requireValue(typeof hex === "string" && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex), `无效颜色 ${hex}`);
  return (hex.length <= 5 ? "#" + hex.slice(1).replace(/./g, digit => digit + digit) : hex).toUpperCase();
}

function rgba(hex) {
  const expanded = expandColor(hex);
  return Object.assign(rgb(expanded), { a: expanded.length === 9 ? parseInt(expanded.slice(7), 16) / 255 : 1 });
}

function hexColor(color, alpha) {
  const channels = [color.r, color.g, color.b];
  if (alpha != null && alpha < 1) channels.push(alpha);
  return "#" + channels.map(channel => ("0" + Math.round(channel * 255).toString(16)).slice(-2)).join("").toUpperCase();
}

function colorKey(hex) {
  const expanded = expandColor(hex);
  return expanded.length === 9 && expanded.endsWith("FF") ? expanded.slice(0, 7) : expanded;
}

function validate(input) {
  requireValue(input && input.version === 1 && isName(input.project), "需要 version: 1 和 project 项目名");
  requireValue(Array.isArray(input.boards) && input.boards.length, "boards 至少需要一个画板");
  requireValue(Array.isArray(input.edges) && Array.isArray(input.warnings), "edges、warnings 需要是数组");
  requireValue(input.tokens && typeof input.tokens === "object" && !Array.isArray(input.tokens), "tokens 需要是颜色字典");
  for (const name of Object.keys(input.tokens)) {
    requireValue(isName(name), "变量名为空");
    expandColor(input.tokens[name]);
  }
  const boards = new Map();
  function dimensions(spec) {
    for (const key of ["width", "height"]) {
      requireValue(Number.isFinite(spec[key]) && spec[key] > 0, `${spec.id} 的 ${key} 必须大于零`);
    }
  }
  function visit(node, ids, boardId) {
    requireValue(node && isName(node.id) && !ids.has(node.id), `${boardId} 内节点 ID 缺失或重复 ${node && node.id}`);
    ids.add(node.id);
    requireValue(["frame", "text", "svg", "image"].includes(node.kind), `${node.id} 的 kind 无效`);
    requireValue(isName(node.name) && Number.isFinite(node.x) && Number.isFinite(node.y), `${node.id} 缺少名称或坐标`);
    dimensions(node);
    const style = node.style || {};
    for (const field of ["fill", "stroke", "color"]) if (style[field] != null) rgb(style[field]);
    for (const field of ["radius", "strokeWidth", "opacity", "fontSize", "lineHeight"]) {
      if (style[field] != null) requireValue(Number.isFinite(style[field]) && style[field] >= 0, `${node.id} 的 ${field} 无效`);
    }
    requireValue(style.opacity == null || style.opacity <= 1, `${node.id} 的 opacity 超出 0–1`);
    requireValue(style.letterSpacing == null || Number.isFinite(style.letterSpacing), `${node.id} 的 letterSpacing 无效`);
    requireValue(node.children == null || (Array.isArray(node.children) && (!node.children.length || node.kind === "frame")), `${node.id} 的 children 无效`);
    for (const child of node.children || []) visit(child, ids, boardId);
  }
  for (const board of input.boards) {
    requireValue(board && isName(board.id) && !boards.has(board.id), `画板 ID 缺失或重复 ${board && board.id}`);
    requireValue(isName(board.viewport) && isName(board.state) && Array.isArray(board.children), `${board.id} 的 viewport、state 或 children 无效`);
    dimensions(board);
    const ids = new Set([board.id]);
    for (const node of board.children) visit(node, ids, board.id);
    boards.set(board.id, ids);
  }
  const edges = [];
  const clicks = new Set();
  for (const edge of input.edges) {
    requireValue(edge && ["NAVIGATE", "OVERLAY", "BACK"].includes(edge.action), "原型 action 无效");
    const starts = boards.has(edge.from) ? input.boards.filter(board => board.id === edge.from) : input.boards.filter(board => board.state === edge.from);
    requireValue(starts.length, `找不到原型起点 ${edge.from}`);
    for (const board of starts) {
      const source = edge.source || board.id;
      requireValue(boards.get(board.id).has(source), `${board.id} 找不到原型节点 ${source}`);
      const targets = boards.has(edge.to) ? [edge.to] : input.boards.filter(other => other.viewport === board.viewport && other.state === edge.to).map(other => other.id);
      requireValue(edge.action === "BACK" || targets.length === 1, `${board.id} 原型目标不唯一或不存在 ${edge.to}`);
      const key = JSON.stringify([board.id, source]);
      requireValue(!clicks.has(key), `${board.id} / ${source} 有多个点击动作`);
      clicks.add(key);
      edges.push({ from: board.id, source, action: edge.action, to: edge.action === "BACK" ? null : targets[0] });
    }
  }
  return edges;
}

function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function diffRows(baseline, current) {
  const keyOf = row => JSON.stringify([row.scope, row.boardId, row.id]);
  const previous = new Map(baseline.map(row => [keyOf(row), row]));
  const result = [];
  function change(row, op, before, after) {
    result.push({ boardId: row.boardId, id: row.id, scope: row.scope, figmaId: row.figmaId, op, before, after });
  }
  for (const row of current) {
    const key = keyOf(row);
    const old = previous.get(key);
    previous.delete(key);
    if (!old) {
      change(row, "add", null, row.value);
      continue;
    }
    const before = Object.create(null);
    const after = Object.create(null);
    for (const field of new Set(Object.keys(old.value).concat(Object.keys(row.value)))) {
      if (stable(old.value[field]) === stable(row.value[field])) continue;
      before[field] = old.value[field] == null ? null : old.value[field];
      after[field] = row.value[field] == null ? null : row.value[field];
    }
    if (Object.keys(after).length) change(row, "update", before, after);
  }
  for (const row of previous.values()) change(row, "remove", row.value, null);
  return result;
}

function boardFiles(boards) {
  const used = new Set();
  return boards.map(board => {
    const stem = board.id.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "--").replace(/[. ]+$/g, "").slice(0, 80) || "board";
    let name = "board-" + stem;
    let suffix = 1;
    while (used.has(name.normalize("NFC").toLowerCase())) name = "board-" + stem + "-" + (++suffix);
    used.add(name.normalize("NFC").toLowerCase());
    return name + ".png";
  });
}

function saveBaseline(page, data) {
  const text = JSON.stringify(data);
  const size = 12000;
  const count = Math.ceil(text.length / size);
  const slot = page.getPluginData("slot") === "A" ? "B" : "A";
  for (let index = 0; index < count; index++) {
    page.setPluginData(slot + index, JSON.stringify(text.slice(index * size, (index + 1) * size)));
  }
  page.setPluginData(slot + "count", String(count));
  page.setPluginData("slot", slot);
}

function readBaseline(page) {
  const slot = page.getPluginData("slot");
  const count = Number(page.getPluginData(slot ? slot + "count" : "parts"));
  requireValue(count > 0, "页面缺少导入基线");
  let text = "";
  for (let index = 0; index < count; index++) text += JSON.parse(page.getPluginData((slot || "part") + index));
  return JSON.parse(text);
}

function variantMatches(component, variant) {
  const values = component.variantProperties || {};
  return component.name === variant || values.State === variant || Object.values(values).includes(variant);
}

function componentFamilyKey(spec) {
  return JSON.stringify([spec.component || spec.name, spec.variant || "Default"]);
}

function componentOccurrences(boards) {
  const occurrences = new Map();
  function visit(spec) {
    if (spec.component || spec.figmaKey) {
      const key = componentFamilyKey(spec);
      if (!occurrences.has(key)) occurrences.set(key, []);
      occurrences.get(key).push(spec);
    }
    for (const child of spec.children || []) visit(child);
  }
  for (const board of boards) board.children.forEach(visit);
  return occurrences;
}

function createRenderer(api, page, input, warnings, variables, occurrences) {
  const fonts = new Map();
  const componentRefs = new Map();
  const groups = new Map();
  const refs = new Map();
  const byBoard = new Map();
  const building = new Set();
  let shelf = null;

  function warn(id, message) { warnings.add(`${id} · ${message}`); }
  function register(boardId, spec, node, scope) {
    if (boardId == null) return;
    refs.set(node.id, { scope, boardId, id: spec.id, kind: spec.kind || "board" });
    byBoard.get(boardId).set(spec.id, node);
  }
  function paint(hex) {
    const color = rgba(hex);
    const solid = { type: "SOLID", color: { r: color.r, g: color.g, b: color.b } };
    const variable = variables.get(colorKey(hex));
    if (!variable && color.a < 1) solid.opacity = color.a;
    return variable ? api.variables.setBoundVariableForPaint(solid, "color", variable) : solid;
  }
  async function load(font) {
    const key = JSON.stringify(font);
    if (!fonts.has(key)) fonts.set(key, api.loadFontAsync(font));
    return fonts.get(key);
  }
  async function resolveFont(requested, id) {
    const candidates = [requested];
    if (requested.family.toLowerCase() === "arial") candidates.push({ family: "Arimo", style: requested.style });
    candidates.push({ family: "Inter", style: requested.style }, { family: "Inter", style: "Regular" });
    const tried = new Set();
    for (const font of candidates) {
      const label = `${font.family} ${font.style}`;
      if (tried.has(label)) continue;
      tried.add(label);
      try { await load(font); } catch (error) { continue; }
      if (font !== requested) warn(id, `字体 ${requested.family} ${requested.style} 不可用，使用 ${label}`);
      return font;
    }
    throw new Error(`${id} 无可用字体，已尝试 ${Array.from(tried).join("、")}`);
  }
  async function setText(node, spec, generated) {
    const style = spec.style || {};
    const existing = node.fontName;
    if (existing === api.mixed && !style.fontFamily && !style.fontStyle) {
      for (const font of node.getRangeAllFontNames(0, node.characters.length)) await load(font);
    } else {
      const requested = {
        family: style.fontFamily || (existing !== api.mixed && existing.family) || "Inter",
        style: style.fontStyle || (existing !== api.mixed && existing.style) || "Regular"
      };
      const font = await resolveFont(requested, spec.id);
      if (existing === api.mixed || existing.family !== font.family || existing.style !== font.style) node.fontName = font;
    }
    if (spec.text != null && node.characters !== spec.text) node.characters = spec.text;
    if (style.fontSize != null) node.fontSize = style.fontSize;
    if (style.letterSpacing != null) node.letterSpacing = { unit: "PIXELS", value: style.letterSpacing };
    if (style.lineHeight != null) node.lineHeight = { unit: "PIXELS", value: style.lineHeight };
    if (style.align) {
      const align = String(style.align).toUpperCase();
      node.textAlignHorizontal = ({ START: "LEFT", END: "RIGHT", JUSTIFY: "JUSTIFIED" })[align] || align;
    }
    const fontSize = node.fontSize;
    const tightLine = node.characters.length > 0 && !/[\r\n\u2028\u2029]/.test(node.characters)
      && Number.isFinite(fontSize) && spec.height <= fontSize * 1.35 + 1;
    if ((generated || tightLine) && node.textAutoResize !== "NONE") node.textAutoResize = "NONE";
    if (tightLine) {
      if (node.textAlignVertical !== "CENTER") node.textAlignVertical = "CENTER";
    } else if (generated && node.textAlignVertical !== "TOP") node.textAlignVertical = "TOP";
  }
  function decorate(node, spec, defaultFill) {
    const style = spec.style || {};
    const fill = spec.kind === "text" ? style.color || style.fill : style.fill;
    if (fill && spec.kind !== "image") node.fills = [paint(fill)];
    else if (defaultFill && spec.kind === "frame") node.fills = [];
    if (style.stroke) node.strokes = [paint(style.stroke)];
    if (style.strokeWidth != null) node.strokeWeight = style.strokeWidth;
    if (style.radius != null && "cornerRadius" in node) node.cornerRadius = style.radius;
    if (style.opacity != null) node.opacity = style.opacity;
    if ("clipsContent" in node && (style.clip != null || defaultFill && spec.kind === "frame")) node.clipsContent = !!style.clip;
  }
  function size(node, spec) {
    if (node.width !== spec.width || node.height !== spec.height) node.resize(spec.width, spec.height);
  }
  function place(node, spec) {
    size(node, spec);
    node.x = spec.x;
    node.y = spec.y;
    node.name = spec.name;
  }
  async function native(spec, parent, boardId) {
    let node;
    if (spec.kind === "text") node = api.createText();
    else if (spec.kind === "image") node = api.createRectangle();
    else if (spec.kind === "svg" && spec.svg) node = api.createNodeFromSvg(spec.svg);
    else node = api.createFrame();
    parent.appendChild(node);
    if (spec.kind === "text") {
      await setText(node, spec, true);
    }
    if (spec.kind === "image") {
      if (spec.data) {
        requireValue(/^iVBORw0KGgo/.test(spec.data), `${spec.id} 需要 raw base64 PNG`);
        const image = api.createImage(api.base64Decode(spec.data));
        node.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FIT" }];
      } else {
        node.fills = spec.style && spec.style.fill ? [paint(spec.style.fill)] : [];
        warn(spec.id, "缺少 PNG 数据，保留图片位置");
      }
    }
    if (spec.kind === "svg" && !spec.svg) { node.fills = []; warn(spec.id, "缺少 SVG，保留位置"); }
    if (spec.kind === "svg" && spec.svg) {
      for (const child of node.children) if ("constraints" in child) child.constraints = { horizontal: "SCALE", vertical: "SCALE" };
    }
    decorate(node, spec, true);
    place(node, spec);
    register(boardId, spec, node, "node");
    for (const child of spec.children || []) await render(child, node, boardId);
    return node;
  }
  function getShelf() {
    if (!shelf) {
      shelf = api.createFrame();
      page.appendChild(shelf);
      shelf.name = "Local components";
      shelf.fills = [];
      shelf.clipsContent = false;
      shelf.x = 0;
      shelf.y = Math.max.apply(null, input.boards.map(board => board.height)) + 160;
    }
    return shelf;
  }
  async function localMain(spec) {
    const family = spec.component || spec.name;
    const variant = spec.variant || "Default";
    if (!groups.has(family)) groups.set(family, new Map());
    const group = groups.get(family);
    if (group.has(variant)) return group.get(variant);
    const key = componentFamilyKey(spec);
    requireValue(!building.has(key), `${spec.id} 组件 ${family}/${variant} 递归引用`);
    building.add(key);
    const main = api.createComponent();
    getShelf().appendChild(main);
    main.name = variant.includes("=") ? variant : "State=" + variant;
    main.resize(spec.width, spec.height);
    main.fills = [];
    main.clipsContent = false;
    if (spec.kind === "frame") decorate(main, spec, true);
    const shape = stable(localShape(spec));
    const uses = [componentLayers(spec)];
    for (const candidate of occurrences.get(key)) {
      if (candidate !== spec && stable(localShape(candidate)) === shape) uses.push(componentLayers(candidate));
    }
    const layouts = [];
    for (let index = 0; index < uses[0].length; index++) {
      const positions = new Map();
      for (const layers of uses) {
        const layer = layers[index];
        const signature = geometryKey(layer);
        if (positions.has(signature)) continue;
        const childIndex = main.children.length;
        const node = spec.kind === "frame" ? await render(layer, main, null) : await native(layer, main, null);
        node.constraints = { horizontal: "MIN", vertical: "MIN" };
        node.visible = positions.size === 0;
        positions.set(signature, childIndex);
      }
      layouts.push(positions);
    }
    const entry = { main, spec, shape, layouts, local: true };
    group.set(variant, entry);
    building.delete(key);
    return entry;
  }
  function selectVariant(set, variant) {
    const matches = variant ? set.children.filter(node => node.type === "COMPONENT" && variantMatches(node, variant)) : [set.defaultVariant];
    requireValue(matches.length === 1 && matches[0] && !matches[0].removed, `找不到唯一变体 ${variant || "（默认）"}`);
    return matches[0];
  }
  async function referencedMain(spec) {
    const key = JSON.stringify([spec.figmaKey, spec.variant || ""]);
    if (!componentRefs.has(key)) {
      let main;
      const nodeId = /^[0-9]+:[0-9]+$/.test(spec.figmaKey);
      if (nodeId) {
        const source = await api.getNodeByIdAsync(spec.figmaKey);
        requireValue(source && !source.removed && !source.remote, `当前文件中找不到可用的本地组件 ${spec.figmaKey}`);
        requireValue(source.type === "COMPONENT" || source.type === "COMPONENT_SET", `${spec.figmaKey} 的节点类型为 ${source.type}，需要 COMPONENT 或 COMPONENT_SET`);
        main = source.type === "COMPONENT_SET" ? selectVariant(source, spec.variant) : source;
      } else {
        try { main = await api.importComponentByKeyAsync(spec.figmaKey); }
        catch (componentError) { main = selectVariant(await api.importComponentSetByKeyAsync(spec.figmaKey), spec.variant); }
      }
      if (spec.variant && !variantMatches(main, spec.variant)) {
        const set = main.parent;
        if (set && set.type === "COMPONENT_SET") main = selectVariant(set, spec.variant);
        else requireValue(!nodeId, `${spec.figmaKey} 无匹配变体 ${spec.variant}`);
      }
      componentRefs.set(key, { main, local: false });
    }
    return componentRefs.get(key);
  }
  function compatible(spec, node) {
    if (spec.component || spec.figmaKey) return node.type === "INSTANCE";
    if (spec.kind === "text") return node.type === "TEXT";
    if (spec.kind === "image") return "fills" in node && node.type !== "TEXT";
    return "children" in node;
  }
  function localShape(spec) {
    const value = Object.assign({}, spec);
    for (const field of ["id", "text", "name", "x", "y", "width", "height"]) delete value[field];
    value.children = (spec.children || []).map(localShape);
    return value;
  }
  function componentLayers(spec) {
    return spec.kind === "frame" ? spec.children || [] : [Object.assign({}, spec, { x: 0, y: 0 })];
  }
  function geometryKey(layer) {
    function box(node) {
      return [node.x, node.y, node.width, node.height, (node.children || []).map(box)];
    }
    return JSON.stringify(box(layer));
  }
  function selectLayout(instance, spec, entry) {
    const enabled = new Set(componentLayers(spec).map((layer, index) => {
      const childIndex = entry.layouts[index].get(geometryKey(layer));
      requireValue(childIndex !== undefined, `${spec.id} 找不到采集几何对应的主组件子层`);
      return childIndex;
    }));
    instance.children.forEach((child, index) => {
      const visible = enabled.has(index);
      if (child.visible !== visible) child.visible = visible;
    });
  }
  function checkGeometry(node, spec, local) {
    const fields = ["x", "y", "width", "height"];
    const offsets = fields.filter(field => Math.abs(node[field] - spec[field]) > 0.01);
    if (!offsets.length) return;
    const message = offsets.map(field => `${field}=${node[field]}（采集 ${spec[field]}）`).join("，");
    requireValue(!local, `${spec.id} 主组件子层几何不匹配：${message}`);
    warn(spec.id, `引用组件保留原生布局：${message}`);
  }
  async function bindChildren(spec, node, entry, pairs) {
    const children = spec.children || [];
    const targets = entry.local ? node.children.filter(layer => layer.visible) : node.children || [];
    const used = new Set();
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      let target;
      if (entry.local) target = targets[index];
      else {
        const candidates = targets.filter(item => !used.has(item.id) && compatible(child, item));
        const named = candidates.filter(item => item.name === child.name);
        target = named.length === 1 ? named[0] : candidates.length === 1 ? candidates[0] : null;
      }
      requireValue(target && compatible(child, target), `${child.id} 无法匹配唯一实例子层`);
      used.add(target.id);
      pairs.push([child, target]);
      if (child.kind === "text") {
        const textNode = target.type === "TEXT" ? target : target.findOne(item => item.type === "TEXT" && item.visible);
        requireValue(textNode, `${child.id} 缺文字层`);
        await setText(textNode, child, entry.local);
      } else if (child.children) await bindChildren(child, target, child.figmaKey ? { local: false } : entry, pairs);
      checkGeometry(target, child, entry.local);
    }
  }
  async function render(spec, parent, boardId) {
    if (!spec.component && !spec.figmaKey) return native(spec, parent, boardId);
    let entry;
    let instance;
    if (spec.figmaKey) {
      try {
        const reference = await referencedMain(spec);
        instance = reference.main.createInstance();
        entry = reference;
      } catch (error) { warn(spec.id, `组件引用 ${spec.figmaKey} 失败，使用本地主组件 (${error.message})`); }
    }
    if (!entry) {
      entry = await localMain(spec);
      instance = entry.main.createInstance();
    }
    parent.appendChild(instance);
    const pairs = [];
    try {
      if (entry.local) {
        requireValue(entry.shape === stable(localShape(spec)), `${spec.id} 与同名变体的结构或样式不同`);
        selectLayout(instance, spec, entry);
      }
      place(instance, spec);
      if (!entry.local && spec.kind === "frame") decorate(instance, spec, false);
      if (spec.kind === "text") {
        const matches = entry.local ? instance.children.filter(item => item.visible && item.type === "TEXT") : instance.findAll(item => item.type === "TEXT");
        requireValue(matches.length === 1, `${spec.id} 无法唯一定位库文字层`);
        await setText(matches[0], spec, entry.local);
        checkGeometry(matches[0], Object.assign({}, spec, { x: 0, y: 0 }), entry.local);
      } else await bindChildren(spec, instance, entry, pairs);
    } catch (error) {
      instance.remove();
      warn(spec.id, `保留为可编辑独立节点 (${error.message})`);
      return native(spec, parent, boardId);
    }
    register(boardId, spec, instance, "node");
    for (const [child, target] of pairs) register(boardId, child, target, "node");
    return instance;
  }
  function arrangeMasters() {
    if (!shelf) return;
    let left = 0;
    let maxHeight = 1;
    for (const [family, variants] of groups) {
      const mains = Array.from(variants.values(), entry => entry.main);
      let top = 20;
      let width = 1;
      for (const main of mains) {
        main.x = 20;
        main.y = top;
        top += main.height + 24;
        width = Math.max(width, main.width);
      }
      const explicit = Array.from(variants.values()).some(entry => entry.spec.variant);
      const group = mains.length > 1 || explicit ? api.combineAsVariants(mains, shelf) : mains[0];
      if (group.type === "COMPONENT_SET") {
        let offset = 20;
        for (const main of mains) { main.x = 20; main.y = offset; offset += main.height + 24; }
        group.resize(width + 40, top);
      }
      group.name = family;
      group.x = left;
      group.y = 0;
      left += group.width + 48;
      maxHeight = Math.max(maxHeight, group.height);
    }
    shelf.resize(left, maxHeight);
  }
  async function draw(edges) {
    let left = 0;
    const startingPoints = new Map();
    for (const board of input.boards) {
      const frame = api.createFrame();
      page.appendChild(frame);
      frame.name = board.id;
      frame.resize(board.width, board.height);
      frame.x = left;
      frame.y = 0;
      frame.clipsContent = true;
      left += board.width + 96;
      byBoard.set(board.id, new Map());
      register(board.id, board, frame, "board");
      if (!startingPoints.has(board.viewport)) startingPoints.set(board.viewport, { nodeId: frame.id, name: board.viewport });
      for (const child of board.children) await render(child, frame, board.id);
    }
    arrangeMasters();
    for (const edge of edges) {
      const node = byBoard.get(edge.from).get(edge.source);
      const action = edge.action === "BACK" ? { type: "BACK" } : {
        type: "NODE", navigation: edge.action, destinationId: byBoard.get(edge.to).get(edge.to).id, transition: null
      };
      requireValue(node && typeof node.setReactionsAsync === "function", `${edge.from} / ${edge.source} 不支持原型点击`);
      await node.setReactionsAsync([{ trigger: { type: "ON_CLICK" }, actions: [action] }]);
    }
    page.flowStartingPoints = Array.from(startingPoints.values());
  }
  return { draw, refs, byBoard };
}

function reactionActions(reaction) {
  return reaction.actions || (reaction.action ? [reaction.action] : []);
}

function describeNode(api, node, ref, refs, trackSpacing) {
  const value = { name: node.name, type: node.type };
  const fields = {
    x: "x", y: "y", width: "width", height: "height", visible: "visible", locked: "locked",
    opacity: "opacity", rotation: "rotation", cornerRadius: "radius", clipsContent: "clip",
    strokeWeight: "strokeWidth", textAlignHorizontal: "align", fontSize: "fontSize",
    characters: "text", layoutMode: "layoutMode", effects: "effects", vectorPaths: "vectorPaths"
  };
  for (const field of Object.keys(fields)) {
    if (field in node) value[fields[field]] = node[field] === api.mixed ? "MIXED" : node[field];
  }
  for (const [field, name] of [["fills", node.type === "TEXT" ? "color" : "fill"], ["strokes", "stroke"]]) {
    if (!(field in node)) continue;
    const paints = node[field];
    if (paints === api.mixed) { value[name] = "MIXED"; continue; }
    if (paints.length === 1 && paints[0].type === "SOLID") value[name] = hexColor(paints[0].color, paints[0].opacity);
    if (paints.length) value[field] = paints;
  }
  if (node.type === "TEXT") {
    if (node.fontName !== api.mixed) {
      value.fontFamily = node.fontName.family;
      value.fontStyle = node.fontName.style;
    }
    const height = node.lineHeight;
    value.lineHeight = height === api.mixed ? "MIXED" : height.unit === "PIXELS" ? height.value : height;
    const spacing = trackSpacing ? node.letterSpacing : null;
    if (spacing != null) value.letterSpacing = spacing === api.mixed ? "MIXED" : spacing.unit === "PIXELS" ? spacing.value : spacing;
    if ([node.fontName, node.fontSize, node.fills, height, spacing].includes(api.mixed)) {
      const fields = ["fontName", "fontSize", "fills", "lineHeight"];
      if (trackSpacing) fields.push("letterSpacing");
      value.segments = node.getStyledTextSegments(fields);
    }
  }
  if (node.type === "INSTANCE") {
    value.properties = node.componentProperties;
    if (ref.kind === "text") {
      const inner = node.findOne(item => item.type === "TEXT");
      if (inner) value.text = inner.characters;
    }
  }
  if ("reactions" in node && node.reactions.length) {
    value.reactions = node.reactions.map(reaction => ({
      trigger: reaction.trigger,
      actions: reactionActions(reaction).map(action => {
        const dest = refs.get(action.destinationId);
        return dest ? Object.assign({}, action, { destinationId: dest.id, destinationBoardId: dest.boardId }) : action;
      })
    }));
  }
  return value;
}

async function capture(api, page, refs, tokenGroup, trackSpacing, observed) {
  const rows = [];
  const liveBoards = new Map();
  async function walk(node, parent, owner, index, activeBoard) {
    const known = refs.get(node.id);
    if (known && known.scope === "board") {
      activeBoard = known.id;
      liveBoards.set(node.id, activeBoard);
    }
    const ref = known || { scope: "design", boardId: activeBoard, id: "figma:" + node.id };
    const value = describeNode(api, node, ref, refs, trackSpacing);
    let main = null;
    if (node.type === "INSTANCE") {
      main = await node.getMainComponentAsync();
      value.mainComponentKey = main ? main.key : null;
    }
    if (observed && known && known.boardId === activeBoard) {
      const { x, y, width, height, type } = value;
      const geometry = { boardId: activeBoard, id: known.id, x, y, width, height, type };
      if (type === "TEXT") geometry.text = value.text;
      if (known.scope === "node" && parent && parent.scope !== "design") geometry.parentId = parent.id;
      observed.geometry.push(geometry);
      if (type === "INSTANCE") observed.instances.push({ boardId: activeBoard, id: known.id, mainId: main ? main.id : null });
      for (const reaction of node.reactions || []) {
        if (!reaction.trigger || reaction.trigger.type !== "ON_CLICK") continue;
        for (const action of reactionActions(reaction)) {
          if (action.type === "BACK") {
            observed.edges.push({ from: activeBoard, source: known.id, action: "BACK", to: null });
          } else if (action.type === "NODE" && ["NAVIGATE", "OVERLAY"].includes(action.navigation)) {
            observed.edges.push({ from: activeBoard, source: known.id, action: action.navigation, to: action.destinationId });
          }
        }
      }
    }
    value.parent = parent ? { scope: parent.scope, boardId: parent.boardId, id: parent.id } : null;
    value.index = index;
    if (owner && !known) value.ownerId = owner.id;
    rows.push(Object.assign({ figmaId: node.id, value }, ref));
    if ("children" in node) {
      const children = node.children;
      for (let position = 0; position < children.length; position++) await walk(children[position], ref, known || owner, position, activeBoard);
    }
  }
  const roots = page.children;
  for (let index = 0; index < roots.length; index++) await walk(roots[index], null, null, index, null);
  if (observed) {
    for (const edge of observed.edges) edge.to = liveBoards.get(edge.to) || null;
  }
  if (tokenGroup) {
    const group = await api.variables.getVariableCollectionByIdAsync(tokenGroup.id);
    if (group) {
      for (const variableId of group.variableIds) {
        const variable = await api.variables.getVariableByIdAsync(variableId);
        if (!variable) continue;
        const mode = variable.valuesByMode[group.defaultModeId];
        rows.push({
          scope: "token", boardId: null, id: tokenGroup.names[variableId] || "figma:" + variableId, figmaId: variableId,
          value: { name: variable.name, color: mode && "r" in Object(mode) ? hexColor(mode, mode.a) : null, valuesByMode: variable.valuesByMode }
        });
      }
    }
  }
  return JSON.parse(JSON.stringify(rows));
}

function sameProject(page, project) {
  return page.getPluginData("project") === project && page.getPluginData("owner") === page.id && !!(page.getPluginData("slot") || page.getPluginData("parts"));
}

function loadRefs(data) {
  return new Map(data.refs);
}

function tokenContract(input) {
  const names = Object.keys(input.tokens).sort();
  if (!names.length) return null;
  const colors = new Map();
  for (const name of names) {
    const hex = colorKey(input.tokens[name]);
    if (colors.has(hex)) return null;
    colors.set(hex, name);
  }
  const sites = [];
  function normalize(spec, board) {
    const result = Object.assign({}, spec);
    if (spec.style) {
      result.style = Object.assign({}, spec.style);
      for (const field of ["color", "fill", "stroke"]) {
        if (!spec.style[field]) continue;
        const token = colors.get(colorKey(spec.style[field]));
        if (token == null) continue;
        result.style[field] = ["variable", token];
        sites.push({ board, id: spec.id, field, token });
      }
    }
    if (spec.children) result.children = spec.children.map(child => normalize(child, board));
    return result;
  }
  const shape = stable(Object.assign({}, input, { tokens: names, boards: input.boards.map(board => normalize(board, board.id)) }));
  return shape.length <= 1500000 ? { shape, sites } : null;
}

async function designProof(api, page, tokenGroup) {
  if (!tokenGroup) return null;
  try {
    const group = await api.variables.getVariableCollectionByIdAsync(tokenGroup.id);
    if (!group || group.modes.length !== 1) return null;
    const roots = [];
    let total = 0;
    for (const node of page.children) {
      const exported = await node.exportAsync({ format: "JSON_REST_V1" });
      if (!exported || !exported.document || exported.document.id !== node.id) return null;
      const serialized = stable(exported);
      total += serialized.length;
      if (total > 1500000) return null;
      roots.push(serialized);
    }
    const variables = [];
    for (const id of group.variableIds) {
      const variable = await api.variables.getVariableByIdAsync(id);
      if (!variable) return null;
      variables.push([id, variable.name, variable.description, variable.resolvedType, variable.scopes, variable.codeSyntax, variable.hiddenFromPublishing, variable.valuesByMode]);
    }
    return stable([
      page.name, page.backgrounds, page.guides, page.flowStartingPoints, page.prototypeBackgrounds, page.explicitVariableModes,
      group.name, group.modes, group.hiddenFromPublishing, variables, roots
    ]);
  } catch (error) { return null; }
}

async function updateTokens(api, page, data, input, digest, contract) {
  if (!data.incremental || !contract || data.incremental.shape !== contract.shape || !data.incremental.proof) return false;
  const names = Object.keys(input.tokens).filter(name => colorKey(input.tokens[name]) !== colorKey(data.incremental.tokens[name]));
  if (!names.length) return false;
  if (await designProof(api, page, data.tokenGroup) !== data.incremental.proof) return false;
  const refs = loadRefs(data);
  const current = await capture(api, page, refs, data.tokenGroup, data.trackSpacing);
  if (diffRows(data.rows, current).length) return false;
  const rows = new Map(current.map(row => [JSON.stringify([row.scope, row.boardId, row.id]), row]));
  const tokenIds = new Map(Object.entries(data.tokenGroup.names).map(([id, name]) => [name, id]));
  for (const site of contract.sites) {
    if (!names.includes(site.token)) continue;
    const row = rows.get(JSON.stringify(["node", site.board, site.id]));
    if (!row || (site.field === "color" && row.value.type !== "TEXT")) return false;
    const paints = row.value[site.field === "stroke" ? "strokes" : "fills"];
    const binding = paints && paints.length === 1 && paints[0].boundVariables && paints[0].boundVariables.color;
    if (!binding || binding.id !== tokenIds.get(site.token)) return false;
  }
  const group = await api.variables.getVariableCollectionByIdAsync(data.tokenGroup.id);
  const edits = [];
  for (const name of names) {
    const variable = await api.variables.getVariableByIdAsync(tokenIds.get(name));
    if (!variable || variable.variableCollectionId !== group.id || variable.resolvedType !== "COLOR") return false;
    edits.push({ variable, before: variable.valuesByMode[group.defaultModeId], after: rgba(input.tokens[name]) });
  }
  const applied = [];
  const oldSlot = page.getPluginData("slot");
  try {
    for (const edit of edits) {
      edit.variable.setValueForMode(group.defaultModeId, edit.after);
      applied.push(edit);
    }
    const next = Object.assign({}, data, {
      digest, rows: await capture(api, page, refs, data.tokenGroup, data.trackSpacing),
      incremental: { shape: contract.shape, tokens: input.tokens, proof: await designProof(api, page, data.tokenGroup) }
    });
    saveBaseline(page, next);
    page.setPluginData("digest", digest);
  } catch (error) {
    for (const edit of applied.reverse()) edit.variable.setValueForMode(group.defaultModeId, edit.before);
    page.setPluginData("slot", oldSlot);
    page.setPluginData("digest", data.digest);
    throw error;
  }
  return true;
}

async function importProject(api, input, digest) {
  const edges = validate(input);
  const occurrences = componentOccurrences(input.boards);
  const supportsLayout = page => !occurrences.size || page.getPluginData("instanceLayout") === "1";
  const project = input.project;
  const pages = api.root.children.filter(page => sameProject(page, project));
  pages.sort((left, right) => Number(right.getPluginData("revision")) - Number(left.getPluginData("revision")));
  const matches = digest ? pages.filter(page => page.getPluginData("digest") === digest && supportsLayout(page)) : [];
  requireValue(matches.length <= 1, `项目 ${project} 有多个相同源文件的版本页，请核对页面 ${matches.map(page => page.id).join(", ")}`);
  if (matches.length) {
    const page = matches[0];
    await api.setCurrentPageAsync(page);
    const data = readBaseline(page);
    const changes = diffRows(data.rows, await capture(api, page, loadRefs(data), data.tokenGroup, data.trackSpacing));
    return { page: page.name, reused: true, warnings: data.warnings, changes: changes.length, revision: data.revision };
  }
  const previous = api.currentPage;
  const prior = pages[0];
  const contract = tokenContract(input);
  if (prior && contract && supportsLayout(prior)) {
    await prior.loadAsync();
    const data = readBaseline(prior);
    if (await updateTokens(api, prior, data, input, digest, contract)) {
      await api.setCurrentPageAsync(prior);
      return { page: prior.name, reused: true, tokenUpdate: true, revision: data.revision, changes: 0, warnings: data.warnings };
    }
  }
  const revision = prior ? Number(prior.getPluginData("revision")) + 1 : 1;
  const page = api.createPage();
  const warnings = new Set(input.warnings.map(item => typeof item === "string" ? item : JSON.stringify(item)));
  let group = null;
  try {
    page.name = `UI Parity · ${project} · r${revision}`;
    await api.setCurrentPageAsync(page);
    const colors = new Map();
    const names = Object.create(null);
    const duplicates = new Set();
    if (Object.keys(input.tokens).length) {
      group = api.variables.createVariableCollection(page.name);
      for (const name of Object.keys(input.tokens)) {
        const hex = colorKey(input.tokens[name]);
        let variable;
        try { variable = api.variables.createVariable(name, group, "COLOR"); }
        catch (error) {
          const alias = "Token " + (Object.keys(names).length + 1) + " - " + name.replace(/[^a-zA-Z0-9_-]/g, "_");
          variable = api.variables.createVariable(alias, group, "COLOR");
          warnings.add(`变量 ${name} 在 Figma 中使用名称 ${alias}`);
        }
        variable.setValueForMode(group.defaultModeId, rgba(hex));
        names[variable.id] = name;
        if (colors.has(hex)) duplicates.add(hex);
        colors.set(hex, variable);
      }
      for (const hex of duplicates) {
        colors.delete(hex);
        warnings.add(`${hex} 对应多个变量，保留字面颜色`);
      }
    }
    const renderer = createRenderer(api, page, input, warnings, colors, occurrences);
    await renderer.draw(edges);
    const tokenGroup = group ? { id: group.id, names } : null;
    const files = boardFiles(input.boards);
    const boards = input.boards.map((board, index) => ({
      id: board.id, state: board.state, viewport: board.viewport, file: files[index], figmaId: renderer.byBoard.get(board.id).get(board.id).id
    }));
    const rows = await capture(api, page, renderer.refs, tokenGroup, true);
    const data = { version: 1, revision, digest, project, boards, refs: Array.from(renderer.refs), rows, tokenGroup, trackSpacing: true, warnings: Array.from(warnings) };
    if (contract) {
      const proof = await designProof(api, page, tokenGroup);
      if (proof) data.incremental = { shape: contract.shape, tokens: input.tokens, proof };
    }
    requireValue(!api.root.children.some(other => sameProject(other, project) && Number(other.getPluginData("revision")) >= revision), `项目 ${project} 在导入期间已更新，请重试`);
    saveBaseline(page, data);
    page.setPluginData("project", project);
    page.setPluginData("revision", String(revision));
    page.setPluginData("digest", digest);
    page.setPluginData("instanceLayout", "1");
    page.setPluginData("owner", page.id);
    return { page: page.name, reused: false, revision, changes: 0, warnings: data.warnings };
  } catch (error) {
    if (api.currentPage.id === page.id) await api.setCurrentPageAsync(previous);
    if (!page.removed) page.remove();
    if (group) group.remove();
    throw error;
  }
}

async function exportProject(api, sendFile) {
  const page = api.currentPage;
  requireValue(page.getPluginData("owner") === page.id, "请打开由本插件导入的项目版本页");
  const data = readBaseline(page);
  const refs = loadRefs(data);
  const observed = { edges: [], instances: [], geometry: [] };
  const current = await capture(api, page, refs, data.tokenGroup, data.trackSpacing, observed);
  const changes = diffRows(data.rows, current);
  const present = new Set(current.filter(row => row.scope === "board").map(row => row.figmaId));
  const boards = [];
  function belongsToPage(node) {
    while (node && !node.removed && node.type !== "PAGE") node = node.parent;
    return node && !node.removed && node.id === page.id;
  }
  for (const board of data.boards) {
    if (!present.has(board.figmaId)) {
      boards.push(Object.assign({}, board, { file: null, status: "missing" }));
      continue;
    }
    const node = await api.getNodeByIdAsync(board.figmaId);
    const changedPage = `${board.id} 在导出期间被移动或删除，请重新导出`;
    requireValue(belongsToPage(node), changedPage);
    const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 }, useAbsoluteBounds: true, colorProfile: "SRGB" });
    requireValue(belongsToPage(node), changedPage);
    requireValue(bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80, `${board.id} PNG 导出失败`);
    const dimension = offset => bytes[offset] * 16777216 + bytes[offset + 1] * 65536 + bytes[offset + 2] * 256 + bytes[offset + 3];
    boards.push(Object.assign({}, board, { width: dimension(16), height: dimension(20), status: "exported" }));
    sendFile(board.file, "image/png", bytes);
  }
  const report = {
    version: 1, project: data.project, revision: data.revision, sourceSha256: data.digest,
    pageId: page.id, boards, changes, observed, warnings: data.warnings
  };
  sendFile("design-diff.json", "application/json", JSON.stringify(report, null, 2));
  return report;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { validate, diffRows, boardFiles, importProject, exportProject, saveBaseline, readBaseline };
}

if (typeof figma !== "undefined") {
  figma.showUI(__html__, { width: 420, height: 560, themeColors: true });
  let busy = false;
  figma.ui.onmessage = async message => {
    if (busy) return;
    busy = true;
    const send = payload => figma.ui.postMessage(payload);
    try {
      if (message.type === "import") {
        requireValue(/^[a-f0-9]{64}$/.test(message.digest), "缺少源文件 SHA-256");
        const result = await importProject(figma, JSON.parse(message.text.replace(/^\uFEFF/, "")), message.digest);
        const status = result.tokenUpdate ? "已原位更新颜色变量，保留画板和实例 ID" : result.reused ? `已打开已有版本，保留 ${result.changes} 项设计差异` : "已创建独立版本页";
        send({ type: "done", text: `${result.page}\n${status}`, warnings: result.warnings });
      } else if (message.type === "export") {
        const report = await exportProject(figma, (name, mime, content) => send({ type: "file", name, mime, content }));
        send({ type: "done", text: `${report.project} · r${report.revision} · ${report.pageId}\n${report.boards.filter(board => board.file).length} 张 PNG，${report.changes.length} 项设计差异`, warnings: report.warnings });
      }
    } catch (error) {
      send({ type: "error", text: error.message || String(error) });
    } finally { busy = false; }
  };
}
