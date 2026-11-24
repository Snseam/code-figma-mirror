import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const color = /^#[0-9a-f]{6}$/i;
const variable = /^--[a-zA-Z0-9_-]+$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function readInput(input) {
  return typeof input === 'string' ? JSON.parse(readFileSync(input, 'utf8')) : input;
}

function figmaTokens(snapshot, base, conflicts) {
  if (record(snapshot?.tokens)) return snapshot.tokens;
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.changes)) {
    throw new TypeError('figmaSnapshot.tokens must be a name-to-color object or a version 1 design-diff export is required');
  }
  const tokens = Object.assign(Object.create(null), base.tokens);
  const seen = new Set();
  for (const { scope, id, op, before, after } of snapshot.changes) {
    if (scope !== 'token') continue;
    if (seen.has(id)) {
      conflicts.push({ token: id, reason: 'duplicate-export-token' });
      continue;
    }
    seen.add(id);
    const original = Object.hasOwn(base.tokens, id) ? base.tokens[id] : undefined;
    const colorChanged = after && Object.hasOwn(after, 'color');
    const needsOldColor = op === 'remove' || (op === 'update' && colorChanged);
    const oldColorMatches = before && Object.hasOwn(before, 'color') &&
      String(before.color).toUpperCase() === String(original).toUpperCase();
    if (op === 'add' ? original !== undefined : original === undefined || (needsOldColor && !oldColorMatches)) {
      conflicts.push({ token: id, reason: 'snapshot-base-mismatch', base: original ?? null, before });
      continue;
    }
    if (op === 'remove') delete tokens[id];
    else if (op === 'add' || op === 'update') {
      if (op === 'add' || colorChanged) tokens[id] = after?.color ?? null;
    } else {
      conflicts.push({ token: id, reason: 'unknown-export-operation', op });
    }
  }
  return tokens;
}

function scanDeclarations(css) {
  const declarations = new Map();
  const masked = css.replace(/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\\r\n\f])*"|'(?:\\[\s\S]|[^'\\\r\n\f])*'|\/\*|["'\\]/g, match => {
    if (match.startsWith('/*') && match.endsWith('*/')) return ' '.repeat(match.length);
    if (match.length > 1 && match[0] !== '/') return '~'.repeat(match.length);
    throw new Error('Unterminated comment/string or escaped CSS identifier');
  });
  let depth = 0;
  let start = 0;
  const groups = [];
  function finish(end) {
    if (depth === 0) return;
    const text = masked.slice(start, end);
    const declaration = /^[ \t\r\n\f]*(--[a-zA-Z0-9_-]+)[ \t\r\n\f]*:[ \t\r\n\f]*/.exec(text);
    if (!declaration) return;
    const name = declaration[1];
    const offset = start + declaration[0].length;
    const literal = /^(#[a-f0-9]{6}|#[a-f0-9]{3})[ \t\r\n\f]*(?:![ \t\r\n\f]*important[ \t\r\n\f]*)?$/i.exec(masked.slice(offset, end))?.[1];
    const value = literal?.length === 4 ? '#' + [...literal.slice(1)].map(char => char + char).join('') : literal;
    if (!declarations.has(name)) declarations.set(name, []);
    declarations.get(name).push({ offset, literal, value: value?.toUpperCase() });
  }
  for (const match of masked.matchAll(/[()[\]{};]/g)) {
    const mark = match[0];
    const index = match.index;
    if (mark === '(' || mark === '[') {
      groups.push(mark === '(' ? ')' : ']');
    } else if (groups.length) {
      if (mark === '{') groups.push('}');
      else if (mark !== ';' && groups.pop() !== mark) throw new Error('Unbalanced CSS component value');
    } else if (mark === '{') {
      if (/^[ \t\r\n\f]*--[^\s:;{}]+[ \t\r\n\f]*:/.test(masked.slice(start, index))) {
        groups.push('}');
      } else {
        depth++;
        start = index + 1;
      }
    } else if (mark === ';' || mark === '}') {
      finish(index);
      start = index + 1;
      if (mark === '}' && --depth < 0) throw new Error('Unexpected closing brace');
    } else {
      throw new Error('Unexpected closing delimiter');
    }
  }
  if (groups.length || depth) throw new Error('Unbalanced CSS block');
  return declarations;
}

function patchTarget(file) {
  const absolute = path.resolve(file);
  const directory = path.dirname(absolute);
  let root = directory;
  while (!existsSync(path.join(root, '.git')) && path.dirname(root) !== root) root = path.dirname(root);
  if (path.dirname(root) === root) {
    const relative = path.relative(process.cwd(), absolute);
    root = relative === '..' || relative.startsWith(`..${path.sep}`) ? directory : process.cwd();
  }
  const filename = path.relative(root, absolute).split(path.sep).join('/');
  if (/[\x00-\x1f"\\\x7f]/.test(filename)) throw new Error('Unsupported character in CSS patch filename');
  return { root, filename };
}

function unifiedPatch(css, edits, filename) {
  if (!edits.length) return '';
  let cursor = 0;
  const parts = [];
  for (const { offset, literal, next } of edits.sort((left, right) => left.offset - right.offset)) {
    parts.push(css.slice(cursor, offset), next);
    cursor = offset + literal.length;
  }
  parts.push(css.slice(cursor));
  const lines = text => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const before = lines(css);
  const after = lines(parts.join(''));
  const hunks = [];
  for (let index = 0; index < before.length; index++) {
    if (before[index] === after[index]) continue;
    const start = Math.max(0, index - 3);
    const end = Math.min(index + 4, before.length);
    const previous = hunks.at(-1);
    if (previous && previous.end >= start) previous.end = end;
    else hunks.push({ start, end });
  }
  const output = [`--- a/${filename}\n`, `+++ b/${filename}\n`];
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

export function review(baseBundle, currentBundle, figmaSnapshot, options = {}) {
  const base = readInput(baseBundle);
  const current = readInput(currentBundle);
  const figma = readInput(figmaSnapshot);
  if (!record(base?.tokens) || !record(current?.tokens)) throw new TypeError('Expected base and current token dictionaries');
  if (figma?.cloud?.tokenCoverage?.status === 'unobserved') {
    return { changes: [], conflicts: [{ reason: 'tokens-not-observed' }], patch: '', patchRoot: null,
      patchFile: null, warnings: figma.warnings ?? [] };
  }
  const conflicts = [];
  const designTokens = figmaTokens(figma, base, conflicts);
  const blockedTokens = new Set(conflicts.map(conflict => conflict.token));
  if (new Set([base.project, current.project, figma.project].filter(Boolean)).size > 1) {
    return { changes: [], conflicts: [{ reason: 'project-mismatch', base: base.project, current: current.project,
      figma: figma.project }], patch: '', patchRoot: null, patchFile: null, warnings: figma.warnings ?? [] };
  }
  const tokenMap = options.tokenMap ?? {};
  if (!record(tokenMap)) throw new TypeError('tokenMap must map token names to CSS custom properties');
  const owners = new Map();
  for (const [token, name] of Object.entries(tokenMap)) {
    if (!owners.has(name)) owners.set(name, []);
    owners.get(name).push(token);
  }
  let css, target, declarations, cssError;
  if (options.cssPath) {
    try {
      target = patchTarget(options.cssPath);
      css = readFileSync(options.cssPath, 'utf8');
      declarations = scanDeclarations(css);
    } catch (error) {
      cssError = error.message;
    }
  }
  const changes = (figma.changes ?? []).filter(row => row.scope !== 'token' ||
    (row.op === 'update' && !Object.hasOwn(row.after ?? {}, 'color')))
    .map(row => ({ ...row, status: 'design-review' }));
  const edits = [];
  const inputs = [base.tokens, current.tokens, designTokens];
  const names = new Set(inputs.flatMap(tokens => Object.keys(tokens)));
  for (const token of [...names].sort()) {
    if (blockedTokens.has(token)) continue;
    const values = inputs.map(tokens => Object.hasOwn(tokens, token) ? tokens[token] : null);
    const invalid = inputs.some((tokens, index) => Object.hasOwn(tokens, token) &&
      (typeof values[index] !== 'string' || !color.test(values[index])));
    const [original, local, design] = values.map(value => typeof value === 'string' ? value.toUpperCase() : value);
    const entry = { token, base: values[0], current: values[1], figma: values[2] };
    if (invalid) {
      conflicts.push({ ...entry, reason: 'invalid-color' });
      continue;
    }
    if (original === local && local === design) continue;
    if (local !== original && design !== original && local !== design) {
      conflicts.push({ ...entry, reason: 'both-modified' });
      continue;
    }
    const status = local === design ? 'converged' : design === original ? 'code-only' : 'design-only';
    changes.push({ ...entry, status });
    if (status !== 'design-only') continue;
    const name = Object.hasOwn(tokenMap, token) ? tokenMap[token] : null;
    const conflict = (reason, detail = {}) => conflicts.push({ ...entry, variable: name, reason, ...detail });
    if (local === null || design === null) conflict(design === null ? 'token-removed' : 'token-added');
    else if (typeof name !== 'string' || !variable.test(name)) conflict('unmapped-token');
    else if (owners.get(name).length !== 1) conflict('duplicate-mapping', { tokens: owners.get(name) });
    else if (!options.cssPath) conflict('missing-css-path');
    else if (cssError) conflict('unreadable-css', { detail: cssError });
    else {
      const matches = declarations.get(name) ?? [];
      if (!matches.length) conflict('missing-declaration');
      else if (matches.length > 1) conflict('duplicate-declaration', { count: matches.length });
      else if (!matches[0].literal) conflict('unsupported-css-value');
      else if (matches[0].value !== local) conflict('css-value-changed', { actual: matches[0].value });
      else edits.push({ ...matches[0], next: entry.figma });
    }
  }
  return {
    changes, conflicts, patch: unifiedPatch(css, edits, target?.filename),
    patchRoot: target?.root ?? null, patchFile: target?.filename ?? null,
    warnings: figma.warnings ?? [], figmaChanges: figma.changes ?? []
  };
}
