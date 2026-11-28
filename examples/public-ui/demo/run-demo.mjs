#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from '../../../audit.mjs';
import { review } from '../../../review.mjs';
import { verify } from '../../../verify.mjs';
import { checkEdits } from './check-edits.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const outDir = path.resolve(root, process.argv[2] || 'build/public-ui-demo');
const bundleFile = path.join(outDir, 'bundle.json');
const originalDir = path.join(outDir, 'original-figma');
const editedDir = path.join(outDir, 'figma');
const expected = JSON.parse(readFileSync(path.join(here, 'expected-changes.json'), 'utf8'));
const expectedPatch = readFileSync(path.join(here, 'expected-tokens.patch'), 'utf8');
const scenario = JSON.parse(readFileSync(path.join(here, 'scenarios.json'), 'utf8'));

function run(args) {
  console.log(`\n$ node ${args.join(' ')}`);
  const res = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) throw Error(`Command failed with exit code ${res.status}`);
}

function check(condition, message) {
  if (!condition) throw Error(message);
}

if (!existsSync(bundleFile)) {
  run(['cli.mjs', 'capture', path.relative(root, path.join(here, 'scenarios.json')), outDir, '--font-evidence']);
}
run(['cli.mjs', 'inspect', bundleFile]);

if (!existsSync(path.join(originalDir, 'design-diff.json'))) {
  console.log('\nIn Figma Desktop, open Plugins → Development → UI Parity · 本地同步.');
  console.log(`1. Import ${bundleFile}`);
  console.log(`2. Before editing, export the ZIP and extract it into ${originalDir}`);
  console.log('3. Change this revision’s primary #18181B → #2563EB and the Save button instance’s Label on desktop/open to Save profile.');
  console.log(`4. Export again into ${editedDir}`);
  console.log(`5. Re-run: node examples/public-ui/demo/run-demo.mjs ${path.relative(root, outDir)}`);
  process.exit(2);
}

const sourceSha256 = createHash('sha256').update(readFileSync(bundleFile)).digest('hex');
const original = JSON.parse(readFileSync(path.join(originalDir, 'design-diff.json'), 'utf8'));
const bundle = JSON.parse(readFileSync(bundleFile, 'utf8'));
const profile = JSON.parse(readFileSync(path.resolve(here, scenario.rasterProfile), 'utf8'));
check(bundle.project === scenario.project && bundle.rasterProfile?.sha256 === profile.sha256 &&
  bundle.rasterProfile.smoothing === profile.smoothing, 'Use the controlled Public UI demo capture');
check(bundle.boards.map(board => board.id).sort().join(',') === 'desktop/closed,desktop/open', 'Expected both demo boards');
for (const board of bundle.boards) {
  const file = path.join(outDir, 'source', `${board.id.replace('/', '--')}.png`);
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  check(board.captureIntegrity?.beforeSha256 === digest && board.captureIntegrity.afterSha256 === digest, `Source PNG mismatch on ${board.id}`);
  check(board.fontEvidence?.length && board.fontEvidence.every(run => run.fonts.length &&
    run.fonts.every(font => font.isCustomFont && font.familyName === profile.fontFamily)), `Missing Arimo glyph evidence on ${board.id}`);
}
check(original.sourceSha256 === sourceSha256, 'Original export must match the saved bundle SHA-256');
const baselineAudit = audit(bundle, original);
const baselineVisual = await verify(outDir, originalDir, path.join(outDir, 'baseline'), { pixelTolerance: 16, maxDiffRatio: 0.01 });
await writeFile(path.join(outDir, 'baseline/audit.json'), JSON.stringify(baselineAudit, null, 2));
check(baselineAudit.passed && baselineVisual.passed, 'Original import must pass before intentional edits are accepted');
check(original.changes.length === 0 && original.warnings.length === 0, 'Original export contains changes or warnings');
console.log('\nOriginal baseline: audit passed, 2/2 boards passed');

if (!existsSync(path.join(editedDir, 'design-diff.json'))) {
  console.log(`\nEdited export is missing: ${editedDir}`);
  console.log('Apply the two intended edits in Figma, export that page, then re-run this command.');
  process.exit(2);
}
const edited = JSON.parse(readFileSync(path.join(editedDir, 'design-diff.json'), 'utf8'));
check(edited.sourceSha256 === sourceSha256, 'Edited export must match the saved bundle SHA-256');

checkEdits(bundle, original, edited, expected);
const checked = audit(bundle, edited, 1, expected);
await writeFile(path.join(outDir, 'audit.json'), JSON.stringify(checked, null, 2));
check(checked.passed, 'Edited export contains unexpected structural changes');
const visual = await verify(outDir, editedDir, path.join(outDir, 'visual'), {
  pixelTolerance: 16, baselineDir: originalDir, expectedChanges: expected, expectedChangesDir: here
});
check(visual.passed, `Edited export failed pixel verification. See ${path.join(outDir, 'visual', 'report.json')}`);
console.log('\nEdited design: all structural and pixel changes match the declaration');

const reviewed = review(bundle, bundle, edited, {
  tokenMap: scenario.tokens,
  cssPath: path.join(here, 'theme.css'),
});
check(reviewed.conflicts.length === 0, 'Patch review found conflicts');
check(reviewed.patch === expectedPatch, 'Generated patch does not match the declared CSS change');
await mkdir(path.join(outDir, 'review'), { recursive: true });
await Promise.all([
  writeFile(path.join(outDir, 'review', 'review.json'), JSON.stringify(reviewed, null, 2)),
  writeFile(path.join(outDir, 'review', 'tokens.patch'), reviewed.patch),
]);
const patchCheck = spawnSync('git', ['apply', '--check', path.join(outDir, 'review', 'tokens.patch')], { cwd: root, stdio: 'inherit' });
check(patchCheck.status === 0, 'git apply --check failed for the generated patch');
console.log('\nPassed: original baseline, declared design edits, and reviewable CSS patch.');
console.log(`Patch checked, not applied: ${path.join(outDir, 'review', 'tokens.patch')}`);
