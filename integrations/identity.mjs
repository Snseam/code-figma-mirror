import path from 'node:path';

export function sourceKey(filename, component, root = process.cwd()) {
  if (!filename) return null;
  const relative = path.relative(root, filename.split(/[?#]/, 1)[0]);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return `${relative.split(path.sep).join('/')}:${component}:root`;
}

export function fileComponentName(filename) {
  const parts = filename?.split(/[?#]/, 1)[0].split(/[/\\]/);
  if (!parts?.length) return null;
  const stem = parts.pop().replace(/\.[^.]+$/, '');
  const name = stem.toLowerCase() === 'index' ? parts.pop() : stem;
  if (!name || name === '<unknown>' || name === 'anonymous') return null;
  return name.split(/[-_.\s]+/).filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1)).join('') || null;
}
