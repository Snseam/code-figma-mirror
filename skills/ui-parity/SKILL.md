---
name: ui-parity
description: Capture an existing frontend at declared viewport sizes, generate editable Figma boards with components and prototype links, compare actual Figma exports against the source, and review design-token changes.
---

# Capture and check an existing UI

Run commands from the directory containing `cli.mjs`. Locate the application's real entry point and record the source revision, runtime, data fixtures and viewport sizes. For native WeChat input, use `native/README.md` to select the DevTools adapter. Record whether the reference comes from a browser, a simulator or a physical device.

When designing or modifying web UI in this project, follow the project-root `AGENTS.md` and the installed `modern-web-guidance` skill. During replication, measure the existing interface as delivered. Keep any captures with a substituted font or rendering setting in a separately labeled comparison.

1. Model each business state in a scenario file following `examples/inbox/scenarios.json`. Use a distinguishing ready selector for a dialog or a state sharing a URL. Scope the fixture to the task and map existing reusable components using `figmaKey`, selectors or source component markers.
2. Run `node cli.mjs capture scenarios.json build/capture`. Read all capture warnings and inspect the expected transitions with `node cli.mjs inspect build/capture/bundle.json`. Retain this bundle as the base for a future three-way review.
3. In the intended Figma Design file, import the bundle with the development plugin in `plugin/manifest.json`, or use the Figma MCP workflow in `mcp/README.md`. For MCP, send the generated `mcp/transfer.mjs` batches to a dedicated staging page, record its receipt, and render into a separate output page. Use the desktop plugin for raster assets or existing library mappings. Record the destination page and review font substitutions, component matches and prototype starting points.
4. Open the prototype and exercise the most important business flow. With the desktop plugin, download the ZIP into `build/export` and extract it. With MCP, use `tools/cloud-export.md` to read back the output section and bind an actual 1× Figma PNG to each board.
5. Run `node cli.mjs audit build/capture/bundle.json build/export/design-diff.json build/audit.json` and `node cli.mjs verify build/capture build/export build/visual`. Inspect actual source, Figma and difference images in the HTML. Record thresholds, failed cases, missing screens, and any untested interaction.
6. For reverse changes, provide the original bundle, a fresh capture and the exported `design-diff.json` to `node cli.mjs review`. Inspect `review.json` and the CSS patch. Keep separate evidence for visual similarity, component identity and prototype actions.
