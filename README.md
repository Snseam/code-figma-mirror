# Code Figma Mirror

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](package.json)
[![Platform](https://img.shields.io/badge/runtime-Web%20%7C%20WeChat%20Mini--Program-0ea5e9.svg)](native/README.md)

English | [简体中文](README.zh-CN.md)

Code Figma Mirror is a deterministic code-to-Figma and Figma-to-code mirror, sync, and UI parity engine for running frontend applications. You declare viewports, UI states, and the interactions between them; the live runtime supplies measured geometry, computed styles, component identities, and reference screenshots, while Figma receives editable variables, component instances, and prototype links whose rendered output can be audited and verified back against the source, with three-way diffing to sync design edits back into reviewable CSS patches.

## Why it exists

- **Runtime truth over static AST guessing**: Reads actual `BoundingBox`, computed styles, and font evidence from Playwright/Chromium (or WeChat DevTools) rather than guessing layout from static JSX/CSS.
- **Editable Figma reconstruction**: Generates Figma Variables, Component Sets, Instances, Auto Layout frames, and prototype transitions instead of flat screenshots or detached rectangles.
- **Closed-loop parity verification**: Audits structural geometry, text editability, component references, and click destinations (`audit`), and compares source vs. Figma PNGs pixel-by-pixel (`verify`).
- **Asymmetric 3-way reverse sync**: Compares `base`, `current` code, and `figma` snapshots to detect conflicts and emit reviewable CSS token/style patches (`review`, `review-styles`) without blindly overwriting business logic.

## Quick start

Requires **Node.js >= 22**. From a clone of this repository:

```sh
npm ci
npx playwright install chromium
npm run demo
node cli.mjs inspect build/inbox/bundle.json
```

The **Field notes** example ([examples/inbox/scenarios.json](examples/inbox/scenarios.json)) captures an open list, a closed list, and three detail views on both phone (`375×700`) and desktop (`1024×720`). It produces 10 boards, 36 component occurrences, 16 replayed transitions, 6 color tokens, and 10 source PNGs in `build/inbox/source/`.

1. **Build the mirror in Figma.**
   - **Desktop Plugin** ([plugin/README.md](plugin/README.md)): Create a development plugin in Figma Desktop, copy `plugin/manifest.json`, `plugin/code.js`, and `plugin/ui.html`, replace the placeholder ID in `manifest.json`, import via **Plugins → Development**, and load `build/inbox/bundle.json`.
   - **Figma MCP** ([mcp/README.md](mcp/README.md)): Use the transfer and render commands against your staging and output page IDs.
2. **Test the prototype.** Open the phone flow, switch lists, open a detail view, and navigate back. Inspect any card to verify it is linked to its main component.
3. **Audit and verify what Figma rendered.** Export the ZIP from the plugin (or collect node readbacks and 1× PNGs via [tools/cloud-export.md](tools/cloud-export.md)) into `build/figma/`, then run:

```sh
node cli.mjs audit build/inbox/bundle.json build/figma/design-diff.json build/audit.json
node cli.mjs verify build/inbox build/figma build/visual
```

`audit` checks geometry (default tolerance: `1` logical px), editable text, component references, and click destinations. `verify` generates `build/visual/report.html` with source, export, and diff heatmaps. Both exit with code `2` when mismatches are found.

## Architecture

### Font alignment

Use `capture --font-mode original` to record the source fonts. Use `capture --font-mode controlled --raster-profile <profile.json>` to capture both the original and a shared-font experiment in a new run directory. In the desktop plugin, select that directory and choose the baseline to import. Both modes require the requested Figma family and style. Verification checks live text-layer fonts and the source bundle digest as well as pixels. Each mode gets its own report. See the [capture commands, Noto Sans SC preset, and evidence limits](examples/inbox/raster-capture.md#字体方案).

| Path | Role |
| --- | --- |
| `cli.mjs`, `capture.mjs`, `capture-dom.mjs` | Playwright scenario runner, DOM/style/geometry/transition extractor |
| `audit.mjs`, `verify.mjs` | Structural readback audit and pixel-level PNG diff report |
| `review.mjs`, `style-review.mjs` | Three-way (`base` / `current` / `figma`) token and style patch generator |
| [`plugin/`](plugin/README.md) | Figma Desktop plugin for importing bundles, building components/flows, and exporting `design-diff.json` |
| [`mcp/`](mcp/README.md) | Figma MCP renderer, compact payload builder, and cross-page transfer helpers |
| [`native/`](native/README.md) | WeChat Mini-Program DevTools simulator adapter (`capture.mjs`, `measure.mjs`, `config.mjs`) |
| [`integrations/`](integrations/react.mjs) | Optional React JSX (`react.mjs`) and Vue SFC (`vue.mjs`) compile-time component identity probes |
| [`tools/`](tools/cloud-export.md) | Cloud export helpers and controlled raster acceptance (`raster-acceptance.mjs`) |
| [`skills/ui-parity/`](skills/ui-parity/SKILL.md) | Agent skill workflow for end-to-end capture, mirror, audit, and review |

## CLI reference

```sh
node cli.mjs capture <scenarios.json> <capture-dir> [--font-evidence] [--raster-profile <profile.json>]
node cli.mjs inspect <bundle.json>
node cli.mjs audit <bundle.json> <design-diff.json> <audit.json> [--geometry-tolerance 1]
node cli.mjs verify <capture-dir> <figma-png-dir> <report-dir> [--pixel-tolerance 16] [--max-diff-ratio 0.01]
node cli.mjs review <base.json> <current.json> <figma-snapshot.json> <out-dir> [--css theme.css] [--scenarios scenarios.json]
node cli.mjs review-styles <base.json> <current.json> <figma-snapshot.json> <out-dir> --css theme.css --mappings mappings.json
```

## Verified benchmark & boundaries

The table compares the **same 10 Figma PNGs** against two Chromium captures of the example on macOS (`--pixel-tolerance 16 --max-diff-ratio 0.01`; see [examples/inbox/raster-capture.md](examples/inbox/raster-capture.md)):

| Browser reference | Desktop · 1024 × 720 | Phone · 375 × 700 |
| --- | ---: | ---: |
| Original page with system Arial | 5 of 5 | 1 of 5 |
| Pinned Arimo with grayscale font smoothing | 5 of 5 | 5 of 5 |

Figma readback verified **66 editable text layers**, **36 component instances**, and **16/16 prototype click destinations**. Against the unmodified DOM, pixel snapping and single-line text box widening shifted some positions/widths by up to `4.97 px`.

**Known boundaries:**
- Arbitrary CSS (complex grids, pseudo-elements, fluid `clamp()`, custom shaders) does not losslessly convert 1:1 to Figma Auto Layout.
- The MCP path renders editable text, frames, solid paints, and inline SVGs; captured raster assets require the desktop plugin path.
- Solid paint token matching in the MCP renderer binds by color value—if two tokens share the exact same hex/RGBA value, their semantic distinction collapses.
- Cross-OS font metrics and subpixel antialiasing affect pixel-diff ratios unless controlled via `--font-evidence` and `--raster-profile`.
- `review` / `review-styles` emit reviewable patches for unambiguous CSS tokens and explicitly mapped `width`, `height`, `border-radius`, and `font-size` properties; structural component-tree edits still require human/agent review.

## Capture your own UI

Start from `examples/inbox/scenarios.json`. Point `states[].url` to a running app or local HTML file, provide a unique `ready` selector per state, and declare viewports and click `edges`:

```sh
node cli.mjs capture path/to/scenarios.json build/app --font-evidence
node cli.mjs inspect build/app/bundle.json
```

- **Component identity**: Annotate elements with `data-component` / `data-variant`, map by selector, or enable the [React](integrations/react.mjs) / [Vue](integrations/vue.mjs) compile-time plugins.
- **WeChat Mini-Programs**: See [native/README.md](native/README.md) for WeChat DevTools simulator capture and measurement.

## Review changes from Figma

Keep the imported `bundle.json` as `base.json`, re-capture current code to `current.json`, export the edited Figma revision as `design-diff.json`, and run:

```sh
node cli.mjs review base.json current.json build/figma/design-diff.json build/review \
  --scenarios examples/inbox/scenarios.json --css examples/inbox/theme.css
```

Inspect `build/review/review.json` for three-way conflicts and `tokens.patch` (or `styles.patch` via `review-styles`) for reviewable CSS updates.

## Development & Tests

```sh
npm test
npm run test:integrations
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, test expectations, and bug reporting, and [LICENSE](LICENSE) for the Apache-2.0 license.
