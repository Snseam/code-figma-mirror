import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';

const properties = new Map([
  ['width', 'width'], ['height', 'height'], ['border-radius', 'radius'], ['font-size', 'fontSize']
]);
const measured = value => Number.isFinite(value) && value >= 0;
const tuple = (...parts) => JSON.stringify(parts);

function bucket(index, key, value) {
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(value);
}

function indexBoards(bundle) {
  const boards = new Map();
  for (const board of bundle.boards) {
    const nodes = new Map();
    function visit(node) {
      if (typeof node?.id !== 'string' || (node.children != null && !Array.isArray(node.children))) {
        throw new TypeError('Expected a node id and an optional children array');
      }
      bucket(nodes, node.id, node);
      for (const child of node.children ?? []) visit(child);
    }
    visit(board);
    bucket(boards, board.id, nodes);
  }
  return boards;
}

function measurement(boards, { boardId, id, field }) {
  const matches = boards.get(boardId) ?? [];
  if (matches.length !== 1) return { reason: matches.length ? 'duplicate-board' : 'missing-board' };
  const nodes = matches[0].get(id) ?? [];
  if (nodes.length !== 1) return { reason: nodes.length ? 'duplicate-node' : 'missing-node' };
  const node = nodes[0];
  const value = field === 'width' || field === 'height' ? node[field] : node.style?.[field];
  return measured(value) ? { value } : { reason: 'unmeasured-field' };
}

function unescapeIdentifier(escape) {
  const digits = /^\\([a-f\d]{1,6})[ \t\r\n\f]?$/i.exec(escape);
  const code = digits ? parseInt(digits[1], 16) : escape.charCodeAt(1);
  const char = String.fromCharCode(code);
  return code < 128 && /[a-z\d_-]/i.test(char) ? char : escape;
}

function selectorKey(selector) {
  return selector.replace(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\\(?:[a-f\d]{1,6}[ \t\r\n\f]?|[\s\S])|\/\*[\s\S]*?\*\/|[ \t\r\n\f]*([>+~,])[ \t\r\n\f]*|[ \t\r\n\f]+/gi,
    (text, combinator) => {
      if (text.startsWith('/*')) return '';
      if (text.startsWith('\\')) return unescapeIdentifier(text);
      return combinator ?? (text.trim() ? text : ' ');
    }).trim();
}

function styleSource(cssPath) {
  const absolute = path.resolve(cssPath);
  let root = path.dirname(absolute);
  while (path.dirname(root) !== root && !existsSync(path.join(root, '.git'))) root = path.dirname(root);
  if (!existsSync(path.join(root, '.git'))) {
    const local = path.relative(process.cwd(), absolute);
    root = local.startsWith(`..${path.sep}`) || path.isAbsolute(local) ? path.dirname(absolute) : process.cwd();
  }
  const filename = path.relative(root, absolute).split(path.sep).join('/');
  if (/[\x00-\x1f\x7f"\\]/.test(filename)) throw new Error('Unsupported patch filename');
  const css = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(absolute));
  const sheet = postcss.parse(css, { from: absolute });
  const rules = new Map();
  sheet.walkRules(rule => {
    for (const key of new Set(rule.selectors.map(selectorKey))) bucket(rules, key, rule);
  });
  return { css, filename, rules };
}

function declarationFor(source, selector, property) {
  const rules = source.rules.get(selectorKey(selector)) ?? [];
  if (!rules.length) return { reason: 'missing-rule' };
  if (rules.some(rule => rule.parent.type !== 'root')) return { reason: 'conditional-or-nested-rule' };
  if (rules.length !== 1) return { reason: 'duplicate-rule' };
  const [rule] = rules;
  if (rule.selectors.length !== 1) return { reason: 'shared-selector-list' };
  const declarations = [];
  let conditional = false;
  rule.walkDecls(decl => {
    const name = decl.prop.replace(/\\(?:[a-f\d]{1,6}[ \t\r\n\f]?|[\s\S])/gi, unescapeIdentifier);
    if (name.toLowerCase() !== property) return;
    if (decl.parent === rule) declarations.push(decl);
    else {
      for (let parent = decl.parent; parent !== rule; parent = parent.parent) {
        if (parent.type === 'rule' && !parent.selectors.some(selector => selectorKey(selector) === '&')) return;
      }
      conditional = true;
    }
  });
  if (conditional) return { reason: 'conditional-or-nested-rule' };
  if (declarations.length !== 1) return { reason: declarations.length ? 'duplicate-declaration' : 'missing-declaration' };
  const [decl] = declarations;
  const raw = decl.raws.value?.raw ?? decl.value;
  const masked = raw.replace(/\/\*[\s\S]*?\*\//g, comment => ' '.repeat(comment.length));
  const match = /^([ \t\r\n\f]*)([+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?)(px)[ \t\r\n\f]*$/i.exec(masked);
  if (!match || !measured(Number(match[2]))) return { reason: 'non-px-value', actual: raw };
  const offset = Number(decl.source.input.hasBOM) + decl.source.start.offset +
    decl.prop.length + decl.raws.between.length + match[1].length;
  if (source.css.slice(offset, offset + match[2].length + 2) !== match[2] + match[3]) {
    return { reason: 'unresolved-source-offset' };
  }
  return { offset, length: match[2].length, value: Number(match[2]) };
}

function gitPatch(source, edits) {
  if (!edits.length) return '';
  const parts = [];
  let cursor = 0;
  for (const { offset, length, value } of edits.sort((left, right) => left.offset - right.offset)) {
    parts.push(source.css.slice(cursor, offset), String(value));
    cursor = offset + length;
  }
  parts.push(source.css.slice(cursor));
  const lines = text => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const before = lines(source.css);
  const after = lines(parts.join(''));
  const hunks = [];
  for (let index = 0; index < before.length; index++) {
    if (before[index] === after[index]) continue;
    const start = Math.max(index - 3, 0);
    const end = Math.min(index + 4, before.length);
    if (hunks.length && start <= hunks.at(-1).end) hunks.at(-1).end = end;
    else hunks.push({ start, end });
  }
  const output = [`--- a/${source.filename}\n+++ b/${source.filename}\n`];
  function emit(prefix, line) {
    output.push(prefix, line);
    if (!line.endsWith('\n')) output.push('\n\\ No newline at end of file\n');
  }
  for (const { start, end } of hunks) {
    const range = `${start + 1},${end - start}`;
    output.push(`@@ -${range} +${range} @@\n`);
    for (let index = start; index < end; index++) {
      if (before[index] === after[index]) emit(' ', before[index]);
      else {
        emit('-', before[index]);
        emit('+', after[index]);
      }
    }
  }
  return output.join('');
}

function reviewMapping(mapping, state) {
  const { boardId, id, field, selector, property } = mapping;
  if (![boardId, id, field, selector, property].every(value => typeof value === 'string' && value.trim()) ||
      properties.get(property) !== field) return { reason: 'invalid-mapping' };
  if (state.byCSS.get(tuple(selectorKey(selector), property)).length !== 1 ||
      state.byField.get(tuple(boardId, id, field)).length !== 1) return { reason: 'duplicate-mapping' };
  const original = measurement(state.base, mapping);
  if (original.reason) return { ...original, side: 'base' };
  const local = measurement(state.current, mapping);
  if (local.reason) return { ...local, side: 'current' };
  const values = { base: original.value, current: local.value };
  const rows = state.rows.get(tuple(boardId, id)) ?? [];
  if (rows.length > 1) return { ...values, reason: 'duplicate-design-row' };
  const [row] = rows;
  if (row && row.op !== 'update') return { ...values, reason: 'unsupported-design-operation', op: row.op };
  const edited = row && (Object.hasOwn(row.before ?? {}, field) || Object.hasOwn(row.after ?? {}, field));
  if (edited && (!measured(row.before?.[field]) || !measured(row.after?.[field]))) {
    return { ...values, reason: 'unmeasured-design-field' };
  }
  if (edited && row.before[field] !== original.value) {
    return { ...values, reason: 'snapshot-base-mismatch', before: row.before[field], figma: row.after[field] };
  }
  values.figma = edited ? row.after[field] : original.value;
  const localChange = values.current !== values.base;
  const designChange = values.figma !== values.base;
  if (localChange && designChange) return { ...values, reason: 'both-modified' };
  const declaration = declarationFor(state.source, selector, property);
  if (declaration.reason) return { ...values, ...declaration };
  if (declaration.value !== values.current) return { ...values, reason: 'css-value-changed', actual: declaration.value };
  if (designChange) {
    state.edits.push({ ...declaration, value: values.figma });
    return { ...values, status: 'design-only' };
  }
  if (localChange) return { ...values, status: 'code-only' };
  return null;
}

export function reviewStyles(baseBundle, currentBundle, designDiff, options = {}) {
  const changes = [];
  const conflicts = [];
  const reject = (reason, detail) => ({ changes, conflicts: [{ reason, ...detail }], patch: '' });
  if (!Array.isArray(baseBundle?.boards) || !Array.isArray(currentBundle?.boards) ||
      !Array.isArray(designDiff?.changes)) return reject('invalid-input');
  if (new Set([baseBundle.project, currentBundle.project, designDiff.project].filter(Boolean)).size > 1) {
    return reject('project-mismatch');
  }
  if (!Array.isArray(options.mappings)) return reject('invalid-mappings');
  if (typeof options.cssPath !== 'string' || !options.cssPath) return reject('missing-css-path');
  let source;
  try {
    source = styleSource(options.cssPath);
  } catch (error) {
    return reject('unreadable-css', { detail: error.message });
  }
  let base, current;
  try {
    base = indexBoards(baseBundle);
    current = indexBoards(currentBundle);
  } catch (error) {
    return reject('invalid-bundle', { detail: error.message });
  }
  const state = {
    source, edits: [], base, current,
    rows: new Map(), byCSS: new Map(), byField: new Map()
  };
  for (const row of designDiff.changes) {
    if (!row || typeof row.id !== 'string') return reject('invalid-design-row');
    if (row.scope == null || row.scope === (row.boardId === row.id ? 'board' : 'node')) {
      bucket(state.rows, tuple(row.boardId, row.id), row);
    }
  }
  const mappings = options.mappings.map(mapping => ({
    selector: typeof mapping?.selector === 'string' ? mapping.selector.trim() : '',
    property: typeof mapping?.property === 'string' ? mapping.property.trim().toLowerCase() : '',
    boardId: mapping?.boardId, id: mapping?.id, field: mapping?.field
  }));
  for (const mapping of mappings) {
    bucket(state.byCSS, tuple(selectorKey(mapping.selector ?? ''), mapping.property), mapping);
    bucket(state.byField, tuple(mapping.boardId, mapping.id, mapping.field), mapping);
  }
  for (const mapping of mappings) {
    const result = reviewMapping(mapping, state);
    if (!result) continue;
    const list = result.reason ? conflicts : changes;
    list.push({ ...mapping, ...result });
  }
  return { changes, conflicts, patch: gitPatch(source, state.edits) };
}
