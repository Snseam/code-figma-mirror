# Code Figma Mirror

Code Figma Mirror builds an editable Figma mirror of running frontend code, checks visual and interaction parity, and helps teams sync design edits back through reviewable CSS patches. You specify a viewport, a UI state and the interaction that reaches it. The browser supplies the measurements and reference screenshot. Figma supplies the component instances, prototype links and exported image that you can check against the original.

## Try the example

From a clone of this repository, with Node.js 22 or later:

```sh
npm ci
npx playwright install chromium
npm run demo
node cli.mjs inspect build/inbox/bundle.json
```

The **Field notes** example captures an open list, a closed list and three detail views on a phone and a desktop. The bundle contains 10 boards, 36 component occurrences, 16 replayed transitions and six color tokens. The ten browser PNGs are in `build/inbox/source/`. The example runs locally with fixture data. [Scenario file](examples/inbox/scenarios.json)

1. **Build the mirror.** In Figma Desktop, create a development plugin to obtain your own plugin ID. Copy `plugin/manifest.json`, `plugin/code.js` and `plugin/ui.html` to a local plugin folder, replace the placeholder ID in that manifest, then import it from **Plugins → Development**. Run the plugin in a Design file and import `build/inbox/bundle.json`. To drive a Figma MCP connection instead, use the transfer and render commands with your staging and output page IDs. [Desktop plugin](plugin/README.md) · [MCP renderer](mcp/README.md)
2. **Try the interaction.** Open the phone flow, select the closed list, open a detail and return. Select a card in the editor and inspect its main component. The scenario defines which states and interactions the mirror covers.
3. **Check what Figma actually rendered.** Download the plugin's export ZIP and extract it into `build/figma/` so that `design-diff.json` sits next to the board PNGs. For MCP runs, collect the node readbacks and 1× PNGs from the same section. [Cloud export](tools/cloud-export.md)

```sh
node cli.mjs audit build/inbox/bundle.json build/figma/design-diff.json build/audit.json
node cli.mjs verify build/inbox build/figma build/visual
```

`audit` checks measured geometry, editable text, component references and click destinations. Its default geometry tolerance is one logical pixel. `verify` defaults to exact pixel equality and writes `build/visual/report.html` with source, export and heatmap for each board. Both return exit code `2` when they find differences.

## What the example verifies

The table compares the **same ten Figma PNGs** with two Chromium captures of the English example on macOS. A pixel counts as different if any channel differs by more than 16 out of 255. Each board passes if at most 1% of its pixels differ. Reproduce that threshold with `--pixel-tolerance 16 --max-diff-ratio 0.01`. [Controlled capture recipe](examples/inbox/raster-capture.md)

| Browser reference | Desktop · 1024 × 720 | Phone · 375 × 700 |
| --- | ---: | ---: |
| Original page with system Arial | 5 of 5 | 1 of 5 |
| Pinned Arimo with grayscale font smoothing | 5 of 5 | 5 of 5 |

The Figma readback contained 66 editable text layers and 36 instances. All 16 prototype clicks reached their expected destinations in the tested flow. The rendered geometry matched the renderer's layout plan. Against the original DOM, pixel snapping and widening single-line text boxes changed some positions and widths by up to 4.97 px. The original mobile captures remain the reference for judging the unmodified app.

## Capture your own UI

Start with the example scenario. Set `states[].url` to a running page or a local HTML file, give each state a distinctive `ready` selector, and declare its viewports and click edges. Use `steps` to reach a state and `routes` for repeatable responses. Each state and edge replay gets an isolated browser context. Only transitions that reach the target state enter the bundle.

```sh
node cli.mjs capture path/to/scenarios.json build/app --font-evidence
node cli.mjs inspect build/app/bundle.json
```

- **Component identity.** Mark known hosts with `data-component` and `data-variant`, map them by selector, or use the optional [React JSX](integrations/react.mjs) and [Vue SFC](integrations/vue.mjs) compile-time integrations. The desktop plugin can resolve an explicitly mapped component in the current file or a published library.
- **Fonts and colors.** `--font-evidence` records the fonts Chromium used for each text host, including PostScript names and glyph counts. Compare them with the renderer's font substitution warnings. For color bindings, use distinct token values when possible. The MCP renderer matches solid paints by color value, so two names sharing the same value lose their semantic distinction. The capture format stores 8-bit colors.
- **Rendering coverage.** The MCP path supports editable text, frames, solid paints and inline SVG. The desktop plugin also supports captured raster assets. Geometry describes the captured viewport. Reflow at other widths, host controls, complex CSS and font rendering across operating systems need separate checks.
- **WeChat Mini Programs.** The [native adapter](native/README.md) measures explicitly selected WXML elements, replays taps and captures PNGs through the WeChat DevTools simulator. Its tests distinguish SDK contract fixtures from simulator output. Physical-device screenshots require a separate workflow.

## Review changes from Figma

Keep the exact imported `bundle.json` as `base.json`. After a code change, capture the same scenarios to `current.json`. Export the edited Figma revision to obtain `design-diff.json`. Comparing all three detects when both code and design have changed the same property.

```sh
node cli.mjs review base.json current.json build/figma/design-diff.json build/review \
  --scenarios examples/inbox/scenarios.json --css examples/inbox/theme.css
```

Inspect `review.json` for conflicts and `tokens.patch` for proposed edits to unambiguous CSS color declarations. For explicitly mapped `width`, `height`, `border-radius` and `font-size` declarations, use `review-styles` with `--css` and `--mappings` to produce `styles.patch`. Apply accepted patches through your normal code review and recapture the affected states. Component tree edits, arbitrary CSS and application logic still need human interpretation. [Style mapping examples](tests/style-review.test.mjs)

For an agent-driven run, use the [UI parity skill](skills/ui-parity/SKILL.md). The [contributor guide](CONTRIBUTING.md) covers setup, tests and reporting parity failures. The project uses the [Apache License 2.0](LICENSE).
