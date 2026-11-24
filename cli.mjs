#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const usage = `node cli.mjs capture <scenarios.json> <capture-dir> [--font-evidence] [--raster-profile <profile.json>]
node cli.mjs inspect <bundle.json>
node cli.mjs audit <bundle.json> <design-diff.json> <audit.json> [--geometry-tolerance 1]
node cli.mjs verify <capture-dir> <figma-png-dir> <report-dir> [--pixel-tolerance 16] [--max-diff-ratio 0.01]
node cli.mjs review <base.json> <current.json> <figma-snapshot.json> <out-dir> [--css theme.css] [--scenarios scenarios.json]
node cli.mjs review-styles <base.json> <current.json> <figma-snapshot.json> <out-dir> --css theme.css --mappings mappings.json`;
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

export async function loadScenarios(file, rasterProfileFile) {
  const config = await readJson(file);
  const base = pathToFileURL(path.resolve(file));
  if (!Array.isArray(config.states) || !config.states.length) throw new Error('Expected at least one state');
  for (const state of config.states) {
    const target = new URL(state.url, base);
    if (!['http:', 'https:', 'file:'].includes(target.protocol)) throw new Error(`Unsupported URL in ${state.id}`);
    state.url = target.href;
  }
  if (rasterProfileFile !== undefined || config.rasterProfile !== undefined) {
    const profilePath = rasterProfileFile !== undefined ? path.resolve(rasterProfileFile)
      : typeof config.rasterProfile === 'string' ? path.resolve(path.dirname(file), config.rasterProfile) : undefined;
    const profile = profilePath ? await readJson(profilePath) : config.rasterProfile;
    if (!profile || typeof profile.fontFile !== 'string' || !profile.fontFile.trim()) {
      throw Error('rasterProfile requires a local fontFile');
    }
    config.rasterProfile = { ...profile, fontFile: path.resolve(path.dirname(profilePath ?? file), profile.fontFile) };
  }
  return config;
}

export function inventory(bundle) {
  if (bundle.version !== 1 || !bundle.boards?.length) throw new Error('Expected a version 1 bundle with boards');
  const boards = new Map();
  const components = new Map();
  let layers = 0;
  let occurrences = 0;
  for (const board of bundle.boards) {
    if (boards.has(board.id)) throw new Error(`Duplicate board ${board.id}`);
    const ids = new Set();
    boards.set(board.id, ids);
    const visit = node => {
      if (!node.id || ids.has(node.id)) throw new Error(`Duplicate or missing node ID in ${board.id}: ${node.id}`);
      ids.add(node.id);
      layers++;
      if (node.component) {
        if (!components.has(node.component)) components.set(node.component, new Set());
        components.get(node.component).add(node.variant || 'Default');
        occurrences++;
      }
      for (const child of node.children || []) visit(child);
    };
    board.children.forEach(visit);
  }
  for (const edge of bundle.edges || []) {
    if (!boards.get(edge.from)?.has(edge.source) || !boards.has(edge.to)) {
      throw new Error(`Unresolved edge ${edge.from} / ${edge.source} → ${edge.to}`);
    }
  }
  return {
    project: bundle.project, boards: boards.size, layers, componentOccurrences: occurrences,
    components: Object.fromEntries(Array.from(components, ([name, variants]) => [name, [...variants]])),
    edges: bundle.edges.length, tokens: Object.keys(bundle.tokens || {}).length, warnings: bundle.warnings || []
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') {
    console.log(usage);
    return;
  }
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    'pixel-tolerance': { type: 'string' }, 'max-diff-ratio': { type: 'string' }, 'font-evidence': { type: 'boolean' },
    'geometry-tolerance': { type: 'string' }, 'raster-profile': { type: 'string' },
    css: { type: 'string' }, scenarios: { type: 'string' }, mappings: { type: 'string' }
  } });
  const arity = { capture: 2, inspect: 1, verify: 3, review: 4, 'review-styles': 4, audit: 3 };
  if (positionals.length !== arity[command]) throw new Error(usage);
  const [first, second, third, fourth] = positionals;
  if (command === 'inspect') return console.log(JSON.stringify(inventory(await readJson(first)), null, 2));
  if (command === 'capture') {
    const { capture } = await import('./capture.mjs');
    const config = await loadScenarios(first, values['raster-profile']);
    if (values['font-evidence']) config.fontEvidence = true;
    const result = await capture(config, path.resolve(second));
    const stats = inventory(result);
    console.log(JSON.stringify(stats, null, 2));
    if (stats.edges !== (config.edges || []).length * config.viewports.length) process.exitCode = 2;
  } else if (command === 'audit') {
    const { audit } = await import('./audit.mjs');
    const result = audit(await readJson(first), await readJson(second), Number(values['geometry-tolerance'] ?? 1));
    await mkdir(path.dirname(third), { recursive: true });
    await writeFile(third, JSON.stringify(result, null, 2));
    console.log(`${result.matchedInstances} component instances · ${result.matchedEdges} matching reactions · ${result.issues.length} issues`);
    if (!result.passed) process.exitCode = 2;
  } else if (command === 'verify') {
    const { verify } = await import('./verify.mjs');
    const options = {};
    if (values['pixel-tolerance'] !== undefined) options.pixelTolerance = Number(values['pixel-tolerance']);
    if (values['max-diff-ratio'] !== undefined) options.maxDiffRatio = Number(values['max-diff-ratio']);
    const report = await verify(first, second, third, options);
    console.log(`${report.boards.filter(board => board.passed).length}/${report.boards.length} passed · ${path.resolve(third, 'report.html')}`);
    if (!report.passed) process.exitCode = 2;
  } else if (command === 'review' || command === 'review-styles') {
    const styles = command === 'review-styles';
    if (styles && (!values.css || !values.mappings)) throw new Error('review-styles requires --css and --mappings');
    const review = styles ? (await import('./style-review.mjs')).reviewStyles : (await import('./review.mjs')).review;
    const options = { cssPath: values.css };
    if (values.scenarios) options.tokenMap = (await readJson(values.scenarios)).tokens;
    if (styles) options.mappings = await readJson(values.mappings);
    const [base, current, snapshot] = await Promise.all([first, second, third].map(readJson));
    const result = review(base, current, snapshot, options);
    await mkdir(fourth, { recursive: true });
    await Promise.all([
      writeFile(path.join(fourth, styles ? 'style-review.json' : 'review.json'), JSON.stringify(result, null, 2)),
      writeFile(path.join(fourth, styles ? 'styles.patch' : 'tokens.patch'), result.patch || '')
    ]);
    console.log(`${result.changes.length} changes · ${result.conflicts.length} conflicts · ${path.resolve(fourth)}`);
    if (result.conflicts.length) process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
