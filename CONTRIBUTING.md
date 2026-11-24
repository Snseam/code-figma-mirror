# Contributing

Use Node.js 22 or later. Run these commands from the repository root:

```sh
npm ci
npx playwright install chromium
npm ci --prefix integrations
npm test
npm run test:integrations
```

The root suite exercises real Chromium capture, the desktop plugin in a simulated Figma host, the WeChat adapter contract, MCP rendering and transfer, image comparison, and reverse patch generation. The integration suite exercises React and Vue component identity. To run the optional pinned-font test, follow the [Arimo setup](examples/inbox/raster-capture.md).

For a parity bug, include a minimal public fixture, the viewport, the declared UI state and the smallest interaction that reproduces it. For text or color differences, include the actual font, comparison threshold and affected layer or token when available. Capture and export to `build/`. Share screenshots of synthetic data only. Keep personal Figma identifiers, plugin IDs, MCP session details and export receipts local.

In a pull request, describe the behavior change and which commands you ran. If a change affects a renderer, identify the target host and record whether you checked a real Figma export. A simulated-host test and a pixel comparison answer different questions. Web interface changes follow the project's [Modern Web Guidance](AGENTS.md).

The project uses [Apache-2.0](LICENSE). The vendored GoogleChrome Modern Web Guidance skill retains its [upstream license](.agents/skills/GoogleChrome-modern-web-guidance.LICENSE) and [source revision](skills-lock.json).
