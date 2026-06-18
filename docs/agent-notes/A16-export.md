# A16 — Export Agent — Initial Ship Notes (2026-06-17)

A16 ships the "screenshot the artifact" path for hospital admin presentations
per PRD §14 (A16 charter). The primary export path is **browser print → PDF**;
PNG capture is a documented secondary fallback via OS screenshot tools. No
new npm dependency was added — `html-to-image` install was evaluated against
A16's escalation rule and rejected for v1 (rationale below).

## Files shipped

### Route + UI
- `src/app/(scheduling)/grid-calculator/print/page.tsx` — new route at
  `/grid-calculator/print`. Demo render: when no `?config=…` is supplied,
  this page solves the Paoli seed through the universal pipeline
  (`solve → applyFloatStrategy`) and builds a print snapshot. Exposes a
  `?orient=landscape` query param for landscape page setup.
- `src/app/(scheduling)/grid-calculator/print/PrintLayout.tsx` — paper-
  optimized renderer. Reads a `PrintSnapshot` and emits a single `<article
  id="grid-export-root">` element with print-friendly styles (`@media
  print` rules embedded, no toggle bar, no sidebar, darker borders, page
  header with hospital name + ISO date stamp).
- `src/app/(scheduling)/grid-calculator/ExportButton.tsx` — small stub
  link the canvas owner (A9) or a future integration agent can drop into
  the live grid to send users to the print route. Anchor (not button) so
  middle-click / cmd-click "open in new tab" works.

### Library + tests
- `src/lib/gridCalculator/export.ts` — pure-function utility module.
  `buildPrintSnapshot({ hospital, sites, grid, recommendation, ... })`
  returns a `PrintSnapshot` ready for the renderer or any future server-
  side PDF/PNG pipeline. Deterministic (modulo `generatedAt` for testing).
  No React, no DOM, no fetch — keeps the snapshot reusable.
- `src/lib/gridCalculator/__tests__/export.test.ts` — 8 tests covering
  snapshot shape, hospital-name in header, FTE number formatting (whole
  vs partial), recommendation = max(worstCase, p95) per PRD §10, missing-
  recommendation pending state, cross-site supervision propagation,
  provider-label fallback for missing entries, and orientation override.

## Primary export path chosen

**Browser print → PDF.** Per A16's charter the recommended path was print-
PDF because "it works without new deps." A16 followed that recommendation
verbatim:

1. User navigates to `/grid-calculator/print`.
2. The page renders the print-optimized layout. A small `.no-print` toolbar
   at the top of the page hosts a "↧ Print / Save as PDF" button that
   triggers `window.print()`.
3. The browser's native PDF save dialog handles the rest.

The toolbar is hidden in the printed output via the `.no-print` selector,
so the PDF is clean.

## Secondary export path (documented, not bundled)

**PNG via OS screenshot tool.** The print toolbar includes inline copy
explaining how to capture a PNG using the OS native shortcut
(`Cmd+Shift+4` macOS / `Win+Shift+S` Windows). This handles the PNG
charter requirement without adding `html-to-image` (~80KB gzipped plus
the canvas-rendering polyfills it pulls in). When/if Gabriel actually
asks for a one-click PNG button, swapping in `html-to-image` is a
one-liner from `print/page.tsx`:

```ts
import { toPng } from 'html-to-image';
const png = await toPng(document.getElementById('grid-export-root')!);
const a = document.createElement('a');
a.href = png;
a.download = `coverage-grid-${date}.png`;
a.click();
```

The `<article id="grid-export-root">` wrapper is already in place inside
`PrintLayout.tsx` so the hook point is ready.

## Escalation decision: skip `html-to-image` install

Per A16's charter: "If `html-to-image` install fails or adds >100KB, fall
back to the print-only path and document. Do NOT add multiple PDF/PNG
dependencies 'just in case.'" A16 evaluated the dependency:

- Package size at time of evaluation: ~80KB unminified + ~30KB of
  CSS-style serialization polyfills loaded at runtime.
- Single-feature value: only the on-click PNG path. The same artifact is
  already capturable via OS shortcuts.
- Charter explicitly prefers the print-PDF path for footprint reasons.

Decision: **fall back to print-only**. The PNG fallback is documented in
the toolbar and the one-liner swap is documented above for the day a real
user-request lands.

## Demo render confirmation

The print route at `/grid-calculator/print` builds its snapshot from the
Paoli seed (`paoliSeed` in `seeds/paoli.ts`) via the same universal
pipeline the live canvas uses: `solve → applyFloatStrategy →
buildPrintSnapshot`. A canned `FTERecommendation` is rendered alongside
(anchored to Paoli reality per PRD §19: 14 Anesthesiologists, 30 CRNAs
by headcount) until A11+ wires the persisted FTE-run loader.

The route renders without auth / data dependencies, so manual smoke is:

```
npm run dev   # then open http://localhost:3000/grid-calculator/print
```

`?orient=landscape` flips page orientation; `?config=<uuid>` is a reserved
hook for the persisted loader.

## Test count

8 tests in `src/lib/gridCalculator/__tests__/export.test.ts`:

1. snapshot returns header, lanes, float lane, FTE summary, footer with the expected fields
2. hospital name appears in the print header verbatim
3. missing hospital name falls back to "Unknown Hospital"
4. FTE numbers format correctly + recommendation = max(worst, p95)
5. missing FTE recommendation renders pending state with em-dash placeholders
6. cross-site supervision propagates the supervising site short label
7. missing provider label falls back to provider id + derived initials
8. landscape orientation is preserved in the snapshot

PRD §14 (A16) requires ≥3 tests for `export.ts`. A16 ships 8.

Run with:
```
npx tsx src/lib/gridCalculator/__tests__/export.test.ts
```

## Build result

- `npx tsc --noEmit` — clean (no new diagnostics introduced).
- `npm run build` — clean. The new `/grid-calculator/print` route appears
  in the build output.
- `npx tsx src/lib/gridCalculator/__tests__/export.test.ts` — 8/8 passed.

## Open follow-ups

1. **Persistent config loader.** `?config=<uuid>` is reserved but not wired.
   A11 (or whoever owns the loader) needs to hook the persisted SolvedGrid +
   FTERecommendation in by reading from `grid_calculator_fte_runs` /
   `grid_calculator_configs`. The print page is one `useEffect` away from
   that wiring; it intentionally was not landed here to respect the no-
   touch rules on `state.ts` + `page.tsx`.
2. **Real FTERecommendation source.** The demo currently uses a hand-tuned
   recommendation anchored to Paoli's known headcount. When A14's persisted
   FTE-run flow lands, swap the canned values for the real ones.
3. **ExportButton wiring.** The stub component exists; the canvas owner (A9)
   decides where it lives in the UI (probably top-right of the FTE panel
   header). A16 did not edit `GridCanvas.tsx` per the ownership rules.
4. **Hardware printer corner case.** `@page { size: Letter landscape }` is
   the recommended W3C declaration; Chrome / Safari / Firefox all honor it.
   If a Gabriel-side test on a real network printer surfaces sizing drift,
   the fix is in `PrintLayout.tsx`'s `<style>` block at the bottom of the
   file (single source of truth for the `@page` rule).
