# Public UI parity cases

Three public frontends were tested on November 24, 2026, with the mirror engine at `fd9d1bb`, Playwright 1.61.1 and Chromium on macOS. Seven boards came from live pages and two from frozen component previews. The desktop plugin imported each capture into a separate test design. All nine boards had the expected dimensions. All four declared click edges replayed in Chromium and pointed to the expected board in Figma. **Zero of nine boards passed the visual gate.**

Each evidence image contains three full-resolution panels in order from left to right: the Chromium reference, the corresponding isolated Figma board render, and the pixel difference. Pink marks pixels whose difference exceeds the per-channel tolerance of 16. A board passes when at most 1% of its pixels exceed that tolerance. The comparison includes the entire viewport, including blank space. The desktop browser and Figma PNGs use one pixel per CSS pixel. Results are available as [machine-readable JSON](results.json).

| Frontend and source | Viewport | Board | Pixels over tolerance | Evidence |
| --- | --- | --- | ---: | --- |
| shadcn/ui · live docs | 1280 × 900 | Dialog closed | 4.6618% | [Compare](evidence/shadcn-live-closed.png) |
| shadcn/ui · live docs | 1280 × 900 | Dialog open | 11.9448% | [Compare](evidence/shadcn-live-open.png) |
| Plane · live | 390 × 844 | Sign-in, empty email | 4.5725% | [Compare](evidence/plane-welcome.png) |
| Plane · live | 390 × 844 | Email entered | 4.8609% | [Compare](evidence/plane-email-entered.png) |
| Cal.com · live | 1280 × 900 | Calendar | 1.4042% | [Compare](evidence/cal-calendar.png) |
| Cal.com · live | 1280 × 900 | Day and available times | 2.4059% | [Compare](evidence/cal-times.png) |
| Cal.com · live | 1280 × 900 | Attendee details | 1.5444% | [Compare](evidence/cal-details.png) |
| shadcn/ui · frozen excerpt | 1024 × 720 | Button sizes | 1.0076% | [Compare](evidence/shadcn-buttons.png) |
| shadcn/ui · frozen excerpt | 1024 × 720 | Edit profile | 3.4421% | [Compare](evidence/shadcn-dialog.png) |

### What the rendered boards show

- **shadcn/ui** — The live preview opens and closes from its trigger. The open Figma board loses the background blur and renders underlying content through the dialog. Several labels wrap mid-word. In the frozen Button example, the browser and Figma both report Geist Regular at 24 px and a 72.875 px text box, yet the title wraps in the Figma render. The frozen previews use an extracted layout with a custom wrapper and the original font stylesheet. Their percentages apply to that layout. [Button source](https://ui.shadcn.com/docs/components/base/button) · [Dialog source](https://ui.shadcn.com/docs/components/base/dialog)
- **Plane** — Entering a synthetic email changes the Continue button from disabled to enabled. Its label wraps across two lines in both Figma renders. The captured CSS requests `Inter Variable`, Chromium font evidence identifies Inter, and Figma reports Inter Medium for this label. The input itself is a raster layer. The scenario ends before submission. [Plane sign-in](https://app.plane.so)
- **Cal.com** — Choosing a day and a slot opens the attendee form. The first capture saw an input while its parent was still at zero opacity. The published run waits for the panel animation to finish. Figma readback confirmed both click destinations. Two-digit dates wrap onto separate lines and the selected-day fills differ. The run ends at the unsubmitted form. [Booking page](https://cal.com/rick/get-rick-rolled)

| Component check | DOM occurrences explicitly marked by the scenarios | Native `INSTANCE` nodes counted inside the Figma boards |
| --- | ---: | ---: |
| shadcn/ui · live | 3 | 2 |
| Plane | 2 | 1 |
| Cal.com | 82 | 43 |
| shadcn/ui · frozen | 22 | 1 |

The readback traversed the board descendants and excluded the masters shelf. These counts measure instance retention for the selectors used in these cases. Text layers, component masters and flattened frames have different Figma types. The prototype check covered the stored click actions and destinations. Interactive playback inside Figma Present and a per-layer geometry audit remain unverified for this batch.

### Reproduce the published pixel comparison

From the repository root, install the locked dependencies and replay the saved panels:

```sh
npm ci
node examples/public-ui/verify-evidence.mjs build/public-ui-replay
```

The replay checks each panel's RGBA SHA-256, runs the repository's `verify` comparator, checks the exact differing pixel counts, and writes a standalone HTML report per case. Exit `2` reproduces the recorded visual failures. It works offline after dependency installation.

### Capture a fresh run

```sh
npx playwright install chromium
node cli.mjs capture examples/public-ui/shadcn.json build/public-shadcn --font-evidence
node cli.mjs capture examples/public-ui/plane.json build/public-plane --font-evidence
TZ=Asia/Shanghai node examples/public-ui/cal-booking.mjs build/public-cal-config
TZ=Asia/Shanghai node cli.mjs capture build/public-cal-config/scenarios.json build/public-cal --font-evidence
```

The Cal.com generator selects an available day and slot and records their selectors. Run capture promptly in the same timezone. Availability and upstream DOM can change between visits. The live shadcn/ui scenario waits for client hydration before clicking. A fresh capture produces new references. Import its `bundle.json` using the [desktop plugin](../../plugin/README.md) and compare the exported boards to its own `source/` images.
