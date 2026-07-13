# Board Density & Visual Refresh — Design

**Date:** 2026-07-13 · **Status:** approved via visual-companion session (mockups in `.superpowers/brainstorm/69419-1783983593/`, gitignored) · **Scope:** `/board` UI only — no schema changes, one data update (site colors)

Goal: see much more of the hospital at once, and make the board look like a marketable product. All choices below were picked by Gabriel from rendered mockups.

## Decisions (from the visual session)

1. **Compact room cards** (mockup option B): ~35% smaller — room card `minWidth 152→112`, `minHeight 132→~88` (with the header/chip scale-down below), room-name font 12.5→11, chip font 11.5→10, chip paddings tightened, room grid gap 10→6, rooms-area padding 12/14→8/10. Surgeon name in the room header truncates (`— Smith`, no first initial when tight).
2. **Row mode as a third view** (mockup density-v2, option A): each room renders as one horizontal row (mono room name, then person chips left-to-right, surgeon last); rows flow top-to-bottom into **columns with `1px` divider lines**, auto-flowing by available box height (CSS multi-column or column-flexbox — implementation may choose, but column fill must adapt to site-box height/resize). View switch becomes a three-way segmented control: **Cards / Rows / Network** (persisted in localStorage like the current grid/network toggle).
3. **Solid site headers, compressed** (colors mockup option A): header bar padding `10px 16px → 5px 12px` (~42px → ~28px), solid `site.color` background, **white** site name (`fontSize 15→13`), room-count in `rgba(255,255,255,.65)`, `+ Room`/`Delete` buttons restyled white-on-translucent to sit on the solid bar.
4. **Darker site palette** (data change to `public.sites.color`): Main OR `#1e3a8a` (navy), Endoscopy `#065f46` (dark emerald), OB `#5b21b6` (deep purple — takes purple from Neuro per Gabriel), Neuro `#0e7490` (dark cyan), EP Lab `#92400e` (dark amber), Float/Breaks `#334155` (slate). `AddSiteModal`'s color choices switch to this dark palette so new sites match. Tinted usages of `site.color` elsewhere (drop-glow, borders, + Room button) keep working — verify contrast at the darker values.
5. **Collapsible sidebar → icon rail**: a collapse control shrinks the sidebar to a **44px rail** showing role icons (🩺 MD / 💉 CRNA-SRNA-resident / 🔪 surgeon) each with a live **count badge of who's working today**; click any icon or the ≡ button (or **⌘B**) to expand back to the previous width. Collapsed state + width both persist in localStorage. Drag-out from the rail is NOT required (expand to drag).
6. **Slim stats top bar**: fold `StatsBar` into one ~30px line inside the board header row: hospital name, `MD n/m` + `CRNA n/m` staffed-vs-total chips (same numbers as today's StatsBar), room count, supervision warning banner only when at/over limit, and the Cards/Rows/Network switch. Frees ~40px of vertical space.
7. **Strict spacing/type system**: all board paddings/gaps on a 4px grid; exactly two font sizes in compact mode (11 mono for room names / 10 sans for chips, plus the 13px header); radii standardized (site 10, room 8, chip 5). Sweep SiteCard/FloatBar/OutListPanel/RelievedBox for stragglers.
8. **Premium drag feedback**: valid drop targets get a 120ms scale (1.01) + colored glow on hover-over ONLY (no idle animation); wrapped in `prefers-reduced-motion` (pattern from the mic pulse). Existing `transition: all 0.14s` sites consolidated to the same timing.
9. **Wall display mode**: `/board/wall` (or `?wall=1` — implementer's choice, document it) renders Rows view full-screen: no sidebar/rail, no composer chrome, no edit affordances, slim top bar with hospital + clock, realtime-driven (already live), auto-reconnect. Meant for a hallway/lounge TV and demos.

**Skipped by choice:** calmer alert styling (relief-countdown chip treatment stays as-is).

## Non-goals

- No behavior changes to drag-drop semantics, supervision math, out-order, assistant, or realtime (beyond the wall page consuming them).
- No schema changes; the only data change is the six `sites.color` values (via a small data patch or the sites API — NOT a schema migration).
- NetworkView keeps its current look (it inherits the new site colors automatically).
- No light-theme work; the board stays dark.

## Structure

- `src/app/board/boardTheme.ts` (new): the compact-mode scale — spacing, radii, font sizes, palette constants, drag-feedback timing — one source of truth the components import (mirrors `gridTheme.ts` on the scheduling side).
- `RowsView.tsx` (new): the row-mode renderer (reuses PersonChip in a horizontal layout; same drop semantics per room row).
- `WallPage`: thin route wrapping RowsView with fullscreen chrome.
- `Sidebar.tsx`: gains collapsed-rail rendering + the expand/collapse control; `BoardClient` owns the persisted state (`sidebarCollapsed`).
- `SiteCard.tsx`/`FloatBar.tsx`: compact dimensions from `boardTheme`; solid header treatment.
- `StatsBar.tsx`: folds into the header line (component slimmed, not deleted).
- Site colors: one-off data update + `AddSiteModal` palette swap.

## Testing / verification

- `boardTheme.ts` constants unit-tested only where logic exists (e.g., palette map completeness vs known sites: trivial — may skip tests for pure constants).
- No component test harness exists: verification is tsc + build + a structured manual pass (every view × drag flows × collapse/expand × wall page on a second window) + before/after screenshots for the visual diff.
- Realtime/assistant regression check: one assistant command visible live in Cards, Rows, and Wall.

## Risks

- **Drag targets shrink** — compact cards must keep ≥ 32px person-chip hit areas; if drag feels fiddly in practice, bump chip height not card size.
- **Darker site colors reduce tint visibility** where `site.color` feeds translucent backgrounds (drop-glow, float zone) — each usage checked during implementation; fallback is a fixed-lightness accent derived from the hue.
- **Row mode with many staff per room** (physician stacking) can overflow a row — rows wrap chips to a second line rather than truncating people (never hide a human on a staffing board).
