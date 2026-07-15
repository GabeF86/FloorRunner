# Schedule Grid Density — Design

**Date:** 2026-07-14 · **Status:** approved ("go" after numbers presented) · **Scope:** schedule detail page (`src/app/(scheduling)/schedules/[id]/page.tsx`) + minimal AppShell/PageHeader support. Styling only — zero data/engine/behavior changes.

Gabriel's ask: shorten grid cell heights; widen the schedule screen so more is visible at once; compress and lift everything above the grid box.

## Changes (numbers approved)

### 1. Width — un-box the schedule detail page
- AppShell (`src/components/AppShell.tsx:224-227`) boxes non-fullBleed content to `maxWidth:1280` + `--space-6` padding. Make the schedule detail route full-bleed: AppShell is a client component — derive `fullBleed` from `usePathname()` matching `/schedules/<id>` (in the `(scheduling)` layout or inside AppShell, implementer picks the cleaner seam; existing explicit `fullBleed` prop consumers must be unaffected).
- Page outer padding (`page.tsx:895`) `'24px 32px'` → `'10px 16px'`.
- Only the schedule detail page widens; dashboard/settings/etc. stay boxed at 1280.
- Bonus: full-bleed restores a clean `height:100%` chain to the grid's `flex:1` scroll box (the boxed wrapper has no height).

### 2. Cell heights (fonts unchanged everywhere)
- Data cells (`page.tsx:1353-1354`): `minHeight:32` → `24`, padding `'3px 4px'` → `'1px 4px'`.
- Shift-label cells (`:1290-1291`): `minHeight:32` → `24`, padding `'8px 10px'` → `'4px 10px'`.
- Virtual rows (`renderVirtualRows` `:1738-1739`, `:1763-1764`): label `minHeight:28`→`22`, padding `'6px 10px'`→`'3px 10px'`; data `minHeight:28`→`22`, padding `'2px 4px'`→`'1px 4px'`.
- Header rows: day-of-week corner/labels (`:1198`, `:1221`) `minHeight:35`→`26`, label padding `'6px 8px'`→`'3px 8px'`; date header (`:1234`, `:1256`) padding `'6px 12px'`/`'6px 8px'`→`'3px 12px'`/`'3px 8px'`.
- Calendar view (`:2618`): `gridAutoRows: minmax(140px,1fr)` → `minmax(112px,1fr)`; leave its inner sizing alone.
- INVARIANT: month name-fit fix (commit 9670f6d) untouched — column floors 82/74px and name fonts 11/13 stay exactly as-is.

### 3. Above-the-grid chrome
- Breadcrumb (`:904-909`): `marginBottom:12` → `6`.
- PageHeader: add an opt-in `compact` prop to `src/components/ui/PageHeader.tsx` (h1 `--fs-xl`→17, `marginBottom var(--space-5)`→8) — default rendering byte-identical for all other pages; schedules/[id] passes `compact`.
- Toolbar row (`:1024`): `marginBottom:20`→`8`, `paddingTop:14`→`6`.
- Generation banner `marginBottom:12`→`8`.

## Non-goals
- No font-size changes inside grid cells. No column-width changes. No behavior/data changes. No other pages widened. No sizing-token extraction (would be nice; not this pass — the values are one page's inline literals).

## Testing / verification
- No style tests exist (verified) — gates are tsc + full suite + build, then a manual look on production. gridTheme.test.ts (colors) must stay green.
- Verify other AppShell pages still boxed (spot-check dashboard HTML) and explicit fullBleed consumers unaffected.
