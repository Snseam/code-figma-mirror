export function signature(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return `${text.length}/${hash >>> 0}`;
}

export async function readSection(figma, request) {
  const { source, frame, output, section } = request;
  const sourcePage = figma.root.children.find(node => node.id === source);
  const outputPage = figma.root.children.find(node => node.id === output);
  if (!sourcePage || !outputPage || source === output) throw Error('Expected distinct source and output pages');
  await Promise.all([sourcePage.loadAsync(), outputPage.loadAsync()]);
  const transfer = await figma.getNodeByIdAsync(frame);
  let owner = transfer;
  while (owner && owner.type !== 'PAGE') owner = owner.parent;
  if (transfer?.type !== 'FRAME' || owner?.id !== source) throw Error('Wrong transfer frame or source page');
  const pieces = transfer.query('TEXT').map(node => node.characters).filter(text => text.startsWith('PARITYDATA|')).sort();
  if (!pieces.length) throw Error('Missing PARITYDATA');
  const json = pieces.map((text, index) => {
    const prefix = `PARITYDATA|${String(index).padStart(4, '0')}|`;
    if (!text.startsWith(prefix)) throw Error(`Missing or repeated transfer chunk ${index}`);
    return text.slice(prefix.length);
  }).join('');
  const stamp = signature(json);
  if (stamp !== request.stamp) throw Error('Transfer does not match local bundle');
  const bundle = JSON.parse(json);
  const target = outputPage.children.find(node => node.id === section);
  if (target?.type !== 'SECTION' || target.name !== `UI parity v2 / ${bundle.project} [${frame} ${stamp}]`) {
    throw Error('Wrong output section, transfer frame or source signature');
  }
  let fileKey = null;
  try { fileKey = figma.fileKey ?? null; } catch {}
  return { target, bundle, origin: { stamp, source, frame, output, section, fileKey } };
}

export async function readBoard(figma, request) {
  const { board, part } = request;
  const { target, bundle, origin } = await readSection(figma, request);
  const frames = bundle.boards.map(spec => {
    const matches = target.children.filter(node => node.type === 'FRAME' && node.name === spec.id);
    if (matches.length !== 1) throw Error(`Missing or repeated board ${spec.id}`);
    return matches[0];
  });
  if (target.children.filter(node => node.type === 'FRAME').length !== frames.length) throw Error('Unexpected board frame in output section');
  const position = bundle.boards.findIndex(spec => spec.id === board);
  if (position < 0) throw Error(`Unknown source board ${board}`);
  const rows = [], instances = [], reactions = [];
  async function walk(spec, node, index, inherited) {
    const slot = rows.length;
    const { id, type, x, y, width, height } = node;
    if (![x, y, width, height].every(Number.isFinite)) throw Error(`Unreadable geometry for ${spec.id}`);
    const row = [id, node.parent.id, index, type, x, y, width, height];
    if (type === 'TEXT') row.push(node.characters, Number.isFinite(node.fontSize) ? node.fontSize : 'MIXED');
    else if ('cornerRadius' in node) row.push(Number.isFinite(node.cornerRadius) ? node.cornerRadius : 'MIXED');
    if (bundle.fontMode && type === 'TEXT') row.push(node.fontName?.family ?? null, node.fontName?.style ?? null, node.hasMissingFont === true);
    rows.push(row);
    if (type === 'INSTANCE') {
      const main = await node.getMainComponentAsync();
      const group = main?.parent;
      const tuple = [slot, main?.id ?? null];
      if (group?.type === 'COMPONENT_SET') {
        const axes = main.variantProperties;
        tuple.push(group.id, group.name, axes?.State ?? null, axes?.Layout ?? null);
      }
      instances.push(tuple);
    }
    if ('reactions' in node) {
      for (const reaction of node.reactions) {
        const actions = reaction.actions ?? (reaction.action ? [reaction.action] : []);
        reactions.push([slot, reaction.trigger, actions]);
      }
    }
    if (spec.kind === 'svg') return;
    const children = 'children' in node ? node.children : [];
    const expected = spec.children || [];
    if (children.length !== expected.length) throw Error(`Cannot map child count at ${board} / ${spec.id}`);
    const named = new Map();
    children.forEach((child, at) => {
      if (!named.has(child.name)) named.set(child.name, []);
      named.get(child.name).push(at);
    });
    const indices = expected.map(child => named.get(child.name)?.shift() ?? -1);
    const unmatched = indices.indexOf(-1);
    if (unmatched !== -1) {
      const child = expected[unmatched];
      if (indices.lastIndexOf(-1) !== unmatched || expected.filter(other => other.name === child.name).length > 1 ||
          (!inherited && type !== 'INSTANCE' && child.kind !== 'text')) {
        throw Error(`Ambiguous child mapping at ${board} / ${spec.id}`);
      }
      const actual = children.findIndex((item, at) => !indices.includes(at));
      if (expected.some(other => other.name === children[actual].name)) throw Error(`Repeated layer name at ${board} / ${spec.id}`);
      indices[unmatched] = actual;
    }
    for (let offset = 0; offset < expected.length; offset++) {
      const actual = indices[offset];
      await walk(expected[offset], children[actual], actual, inherited || type === 'INSTANCE');
    }
  }
  await walk(bundle.boards[position], frames[position], target.children.findIndex(node => node.id === frames[position].id), false);
  return packet({ format: 'ui-parity-board/1', board }, part, {
    ...origin, board, frames: frames.map(node => node.id), rows, instances, reactions
  });
}

export async function readTokens(figma, request) {
  const { target, origin } = await readSection(figma, request);
  const name = `${target.name} / ${target.id}`;
  const matches = (await figma.variables.getLocalVariableCollectionsAsync()).filter(group => group.name === name);
  if (matches.length !== 1) throw Error(`Expected one section token collection, found ${matches.length}: ${name}`);
  const [group] = matches;
  const modeId = group.defaultModeId;
  if (!modeId || !group.id) throw Error('Missing collection or default mode ID');
  const ids = [...group.variableIds], rows = [];
  for (const id of ids) {
    const variable = await figma.variables.getVariableByIdAsync(id);
    if (!variable || variable.id !== id || variable.variableCollectionId !== group.id || variable.resolvedType !== 'COLOR') {
      throw Error(`Unreadable COLOR variable ${id} in ${name}`);
    }
    const value = variable.valuesByMode[modeId];
    if (!value || !['r', 'g', 'b'].every(channel => Number.isFinite(value[channel]))) {
      throw Error(`Expected a literal default-mode color for ${variable.name} (${id})`);
    }
    const channels = [value.r, value.g, value.b];
    if ('a' in value && value.a !== 1) channels.push(value.a);
    if (!channels.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 1)) {
      throw Error(`Invalid color channel for ${variable.name} (${id})`);
    }
    const color = '#' + channels.map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
    rows.push([id, variable.name, color]);
  }
  const currentIds = group.variableIds;
  if (ids.length !== currentIds.length || ids.some((id, index) => id !== currentIds[index]) ||
      group.defaultModeId !== modeId) throw Error('Collection changed during token read');
  return packet({ format: 'ui-parity-tokens/1' }, request.part, {
    ...origin, collectionId: group.id, collectionName: name, modeId, rows
  });
}

export function packet(header, part, value) {
  const body = JSON.stringify(value);
  const parts = [];
  let piece = '', bytes = 0;
  for (const char of body) {
    const code = char.codePointAt(0);
    const size = char === '"' || char === '\\' ? 2 : code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
    if (bytes + size > 6000) { parts.push(piece); piece = ''; bytes = 0; }
    piece += char;
    bytes += size;
  }
  parts.push(piece);
  if (part < 1 || part > parts.length) throw Error(`${header.board ?? 'Token snapshot'} has ${parts.length} parts`);
  return { ...header, part, parts: parts.length, seal: signature(body), data: parts[part - 1] };
}
