import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import plugin from './plugin/code.js';

function digest(value) {
  const json = JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  });
  return createHash('sha256').update(json).digest('hex');
}

function group(items, keyOf) {
  const result = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(item);
  }
  return result;
}

function compareMaps(before, after, visit) {
  for (const key of new Set([...before.keys(), ...after.keys()])) visit(key, before.get(key), after.get(key));
}

function legacyKey(id, boardId) {
  if (!id.startsWith(`${boardId}#`)) return `id:${id}`;
  const path = id.slice(boardId.length + 1);
  if (path === ':root') return 'document';
  if (path.includes('>:nth-child(') || /\/text-\d+(?:@\d+)?$/.test(path)) return null;
  if (path.startsWith('#')) return `dom:${path.slice(1)}`;
  return `native:${path}`;
}

function colorKey(hex) {
  const expanded = hex.length < 6 ? '#' + [...hex.slice(1)].map(digit => digit.repeat(2)).join('') : hex;
  return expanded.toUpperCase().replace(/^(#.{6})FF$/, '$1');
}

function indexBundle(bundle) {
  const edges = plugin.validate(bundle);
  const boards = new Map();
  const masters = new Map();
  const tokens = new Map(Object.entries(bundle.tokens));
  const byColor = group([...tokens.keys()], name => colorKey(tokens.get(name)));
  for (const board of bundle.boards) {
    const dependencies = new Set();
    const components = new Set();
    const logicalIds = new Map([[board.id, board.id]]);
    const lineNumbers = new Map();
    function layer(spec) {
      const { id, stableId, identity, logicalId, children, style, ...value } = spec;
      if (style) {
        const { tokenRefs, ...properties } = style;
        for (const field of ['color', 'fill', 'stroke']) {
          const ref = tokenRefs?.[field];
          if (ref != null) {
            if (!tokens.has(ref) || properties[field] == null) throw Error(`Invalid token reference ${id} / ${field}: ${ref}`);
            dependencies.add(ref);
            if (colorKey(tokens.get(ref)) === colorKey(properties[field])) properties[field] = { token: ref };
          } else if (properties[field]) {
            for (const possible of byColor.get(colorKey(properties[field])) ?? []) dependencies.add(possible);
          }
        }
        value.style = properties;
      }
      const node = { id, key: stableId ?? legacyKey(id, board.id), identity, value, children: siblings(children) };
      const content = value.kind === 'text' ? value.text :
        node.children.map(child => [child.key, child.identity?.source, child.value.kind, child.content]);
      node.content = digest(content);
      logicalIds.set(id, id);
      if (spec.component && !spec.figmaKey) {
        const family = JSON.stringify([spec.component, spec.variant || 'Default']);
        components.add(family);
        if (!masters.has(family)) masters.set(family, new Map());
        function definition(child, root) {
          const fields = { ...child.value };
          if (root) {
            delete fields.x;
            delete fields.y;
          }
          return [fields, child.children.map(item => definition(item, false))];
        }
        const signature = digest(definition(node, true));
        if (!masters.get(family).has(signature)) masters.get(family).set(signature, { boardId: board.id, id });
      }
      return node;
    }
    function siblings(specs = []) {
      const nodes = [];
      for (const spec of specs) {
        const fragment = !spec.stableId && spec.kind === 'text' && /^(.*\/text-(\d+))@\d+$/.exec(spec.id);
        if (!fragment) {
          nodes.push(layer(spec));
          continue;
        }
        const id = spec.logicalId ?? fragment[1];
        const slot = fragment[2];
        let text = nodes.at(-1);
        if (text?.id !== id) {
          text = { id, key: null, identity: { tag: '#text', slot }, children: [], value: { kind: 'text', text: '', lines: [] } };
          nodes.push(text);
        }
        lineNumbers.set(spec.id, text.value.lines.length);
        text.value.lines.push(layer(spec).value);
        text.value.text += spec.text;
        logicalIds.set(spec.id, id);
      }
      const keys = new Set();
      for (const node of nodes) {
        if (node.key && keys.has(node.key)) throw Error(`Duplicate sibling identity ${node.key} on ${board.id}`);
        if (node.key) keys.add(node.key);
        if (!node.content) node.content = digest(node.value.text);
      }
      return nodes;
    }
    const { id, children, fontEvidence, ...value } = board;
    boards.set(id, { id, value, children: siblings(children), dependencies, components, logicalIds, lineNumbers });
  }
  return { boards, masters, tokens, edges };
}

function alignSiblings(before, after, ambiguous) {
  const matches = new Map();
  const used = new Set();
  function match(old, next) {
    matches.set(next, old);
    used.add(old);
  }
  const anchored = new Map(before.filter(node => node.key).map(node => [node.key, node]));
  for (const next of after) {
    const old = anchored.get(next.key);
    if (old && old.value.kind === next.value.kind) match(old, next);
  }
  const legacyNodes = before.filter(node => !node.identity && !node.key);
  if (legacyNodes.length) {
    const name = node => JSON.stringify([node.value.kind, node.value.component, node.value.name]);
    const incoming = group(after.filter(node => node.identity && !matches.has(node)), name);
    for (const [key, old] of group(legacyNodes, name)) {
      const candidates = incoming.get(key);
      if (old.length === 1 && candidates?.length === 1 && (old[0].id === candidates[0].id || old[0].content === candidates[0].content)) {
        match(old[0], candidates[0]);
      }
    }
  }
  const loose = nodes => nodes.filter(node => !node.key);
  function signature(node) {
    const { kind, component } = node.value;
    return JSON.stringify([kind, component, node.identity?.source, node.identity?.tag ?? (kind === 'text' ? '#text' : node.value.name)]);
  }
  const oldGroups = group(loose(before).filter(node => !used.has(node)), signature);
  for (const [key, nextGroup] of group(loose(after).filter(node => !matches.has(node)), signature)) {
    const oldGroup = oldGroups.get(key) ?? [];
    for (const hint of [
      node => JSON.stringify([node.identity?.classes, node.identity?.role, node.content]),
      node => node.content,
      node => JSON.stringify([node.identity?.classes, node.identity?.role, node.identity?.slot])
    ]) {
      const oldHints = group(oldGroup.filter(node => !used.has(node)), hint);
      for (const [value, candidates] of group(nextGroup.filter(node => !matches.has(node)), hint)) {
        const previous = oldHints.get(value);
        if (previous?.length === 1 && candidates.length === 1) match(previous[0], candidates[0]);
      }
    }
    const previous = oldGroup.filter(node => !used.has(node));
    const incoming = nextGroup.filter(node => !matches.has(node));
    if (!previous.length || !incoming.length) continue;
    if (previous.length === 1 && incoming.length === 1) match(previous[0], incoming[0]);
    else if (previous.length === incoming.length && previous.every((node, index) => isDeepStrictEqual(node, incoming[index]))) {
      previous.forEach((node, index) => match(node, incoming[index]));
    } else ambiguous(previous, incoming);
  }
  return matches;
}

function stationary(nodes, matches, before) {
  const positions = new Map(before.map((node, index) => [node, index]));
  const tails = [];
  const parent = new Map();
  for (const node of nodes) {
    if (!matches.has(node)) continue;
    const index = positions.get(matches.get(node));
    let low = 0, high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (tails[middle].index < index) low = middle + 1;
      else high = middle;
    }
    parent.set(node, tails[low - 1]?.node);
    tails[low] = { index, node };
  }
  const result = new Set();
  for (let node = tails.at(-1)?.node; node; node = parent.get(node)) result.add(node);
  return result;
}

function fields(before, after) {
  const changes = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'style') {
      for (const change of fields(before.style ?? {}, after.style ?? {})) changes.push({ ...change, field: `style.${change.field}` });
      continue;
    }
    if (!isDeepStrictEqual(before[key], after[key])) {
      changes.push({ field: key, before: before[key] ?? null, after: after[key] ?? null });
    }
  }
  return changes;
}

export function planUpdate(baseBundle, nextBundle) {
  if (baseBundle.project !== nextBundle.project) throw Error('Cannot plan across different projects');
  if (!isDeepStrictEqual(baseBundle.rasterProfile, nextBundle.rasterProfile)) throw Error('Capture raster profiles differ');
  const base = indexBundle(baseBundle);
  const next = indexBundle(nextBundle);
  const plan = { version: 1, kind: 'mirror-update-plan', project: nextBundle.project,
    baseDigest: digest(baseBundle), nextDigest: digest(nextBundle),
    tokens: [], masters: [], boards: [], nodes: [], edges: [], remappedIds: [], ambiguities: [], dirtyBoards: [] };
  const dirty = new Set();
  function propagate(field, key) {
    for (const set of [base, next]) {
      for (const board of set.boards.values()) if (board[field].has(key)) dirty.add(board.id);
    }
  }
  compareMaps(base.tokens, next.tokens, (name, before, after) => {
    if (before === after) return;
    plan.tokens.push({ op: !before ? 'add' : !after ? 'retire' : 'update', name, before: before ?? null, after: after ?? null });
    propagate('dependencies', name);
  });
  compareMaps(base.masters, next.masters, (key, before, after) => {
    const signatures = variants => variants && [variants.keys().next().value, [...variants.keys()].sort()];
    if (isDeepStrictEqual(signatures(before), signatures(after))) return;
    const [component, variant] = JSON.parse(key);
    plan.masters.push({ op: !before ? 'add' : !after ? 'retire' : 'update', component, variant,
      sources: [...(after?.values() ?? [])] });
    propagate('components', key);
  });
  const nextToBase = new Map();
  compareMaps(base.boards, next.boards, (boardId, before, after) => {
    if (!before || !after) {
      plan.boards.push({ op: before ? 'remove' : 'insert', boardId });
      dirty.add(boardId);
      return;
    }
    const changes = fields(before.value, after.value);
    if (changes.length) {
      dirty.add(boardId);
      plan.boards.push({ op: 'update', boardId, changes });
    }
    const mapped = new Map([[boardId, boardId]]);
    nextToBase.set(boardId, mapped);
    function walk(oldNodes, nextNodes, parentId) {
      const unresolved = new Set();
      const matches = alignSiblings(oldNodes, nextNodes, (old, incoming) => {
        dirty.add(boardId);
        for (const item of [...old, ...incoming]) unresolved.add(item);
        plan.ambiguities.push({ boardId, parentId, before: old.map(node => node.id), after: incoming.map(node => node.id) });
      });
      const used = new Set(matches.values());
      const fixed = stationary(nextNodes, matches, oldNodes);
      const emit = operation => {
        dirty.add(boardId);
        plan.nodes.push({ boardId, parentId, ...operation });
      };
      for (const old of oldNodes) if (!used.has(old) && !unresolved.has(old)) emit({ op: 'remove', baseId: old.id });
      nextNodes.forEach((node, index) => {
        if (unresolved.has(node)) return;
        const old = matches.get(node);
        if (!old) return emit({ op: 'insert', nextId: node.id, index });
        mapped.set(node.id, old.id);
        const ids = { baseId: old.id, nextId: node.id };
        if (node.id !== old.id) plan.remappedIds.push({ boardId, ...ids });
        if (!fixed.has(node)) emit({ op: 'reorder', ...ids, index });
        const changes = fields(old.value, node.value);
        if (changes.length) emit({ op: 'update', ...ids, changes });
        walk(old.children, node.children, node.id);
      });
    }
    walk(before.children, after.children, boardId);
  });
  function edgeIndex(index, incoming) {
    return new Map(index.edges.map(edge => {
      const board = index.boards.get(edge.from);
      const id = board.logicalIds.get(edge.source);
      const mapped = incoming ? nextToBase.get(edge.from)?.get(id) : id;
      return [JSON.stringify([edge.from, mapped === undefined ? 'next' : 'base', mapped ?? id, board.lineNumbers.get(edge.source)]), edge];
    }));
  }
  compareMaps(edgeIndex(base, false), edgeIndex(next, true), (_key, before, after) => {
    if (before && after && before.to === after.to && before.action === after.action) return;
    plan.edges.push({ op: !before ? 'insert' : !after ? 'remove' : 'update', before: before ?? null, after: after ?? null });
    dirty.add((after ?? before).from);
  });
  plan.dirtyBoards = [...next.boards.keys()].filter(id => dirty.has(id));
  return plan;
}
