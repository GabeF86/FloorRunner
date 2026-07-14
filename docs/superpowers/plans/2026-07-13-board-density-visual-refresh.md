# Board Density & Visual Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Ship the nine visual-session decisions from `docs/superpowers/specs/2026-07-13-board-density-visual-refresh-design.md`: compact cards, solid compressed headers, dark palette, sidebar rail, slim top bar, Rows view with column flow, wall mode, drag polish, 4px system.

**Architecture:** One new theme module (`boardTheme.ts`) is the single source of dimensional/palette truth; components consume it. `PersonChip` extracts from SiteCard for reuse by the new `RowsView`. The wall page is a thin chrome-less wrapper over RowsView. Site colors change via a recorded, reversible data update at the verification gate — no schema work.

**Tech Stack:** Next.js 14, React inline styles + the repo's CSS vars, localStorage persistence patterns already in BoardClient.

**Standing constraints:** branch `board-visual`, never push mid-plan; commit trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; no component test harness — gates are `npx tsc --noEmit`, `npm test` (675 baseline + 10 documented gridCalculator file errors), `npx next build`, plus the structured manual pass at Task 9; the board realtime channel-topic pattern (unique topic per mount) must not regress if touched.

**Fact sheet (verified 2026-07-13):** room card today: `minWidth 152 / minHeight 132`, header `padding 7px 10px 6px`, room-name `12.5px mono`, chips `11.5px`, grid `gap 10, padding 12px 14px` (SiteCard.tsx:86,166,177). Site header: `padding 10px 16px`, name `15px` colored, translucent gradient (SiteCard.tsx:74-76). Sidebar: width state `sidebarWidth` default 290, localStorage `sidebarWidth`, resize handle at BoardClient:344; panes split by `mdPct`/`srnaSurgeonPct`. View state: `viewMode: 'grid' | 'network'` (BoardClient:60), switched by `PillToggleV1` (:490, def :748). StatsBar: standalone box above the board (StatsBar.tsx:15-80) with StatPill + supervision Banner. `PersonChip` is a private component at SiteCard.tsx:225. Live site colors: Main OR `#0ea5e9`, Endoscopy `#10b981`, Neuro `#a78bfa`, EP Lab `#f59e0b`, OB `#f472b6`, Float `#10b981`.

---

### Task 1: `boardTheme.ts` + PersonChip extraction

**Files:**
- Create: `src/app/board/boardTheme.ts`
- Create: `src/app/board/PersonChip.tsx` (moved from SiteCard.tsx:225 — verbatim, then themed in Task 3)
- Modify: `src/app/board/SiteCard.tsx` (delete private PersonChip, import)

- [x] **Step 1.1:** Create the theme module:

```ts
// boardTheme.ts — single source of truth for the board's compact-mode scale
// and dark site palette (spec 2026-07-13). All values sit on a 4px grid.
// Components import from here; no dimensional literals in components.
export const BT = {
  // room cards (compact — spec §1, mockup option B)
  room: { minWidth: 112, minHeight: 88, radius: 8, headerPad: '4px 8px', bodyPad: 4, gap: 2 },
  roomsArea: { gap: 8, pad: '8px 12px' },
  // site header (solid bar — spec §3)
  siteHeader: { pad: '4px 12px', nameSize: 13, countSize: 10, radius: 10 },
  // type scale: exactly two content sizes + the header (spec §7)
  font: { roomName: 11, chip: 10 },
  chip: { radius: 4, pad: '2px 6px', minHeight: 20 },
  // drag feedback (spec §8) — hover-over only, reduced-motion aware
  drag: { transition: 'transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease', hoverScale: 'scale(1.01)' },
  rows: { rowMinHeight: 26, rowPad: '3px 8px', colPad: '0 8px', divider: '1px solid var(--border-muted)' },
  railWidth: 44,
} as const;

// Dark site palette (spec §4). Keyed by site NAME for the one-off data update
// + AddSiteModal choices; at runtime components always read site.color from
// the DB row — this map is not a runtime lookup table.
export const DARK_SITE_PALETTE: Record<string, string> = {
  'Main OR': '#1e3a8a', 'Endoscopy': '#065f46', 'OB': '#5b21b6',
  'Neuro': '#0e7490', 'EP Lab': '#92400e', 'Float / Breaks': '#334155',
};
// AddSiteModal swatches (order = suggestion order for new sites)
export const SITE_COLOR_CHOICES = ['#1e3a8a', '#065f46', '#5b21b6', '#0e7490', '#92400e', '#9d174d', '#3f6212', '#334155'];
```

- [x] **Step 1.2:** Extract `PersonChip` verbatim (props `{assignment, person, alertLevels, dailyShifts, onRemove}` and its helpers if private to it) from SiteCard.tsx:225 into `src/app/board/PersonChip.tsx` with `export default`. SiteCard imports it. NO styling changes in this task (Task 3 does that) — `git diff` on the chip body must show a pure move.
- [x] **Step 1.3:** Gates: `npx tsc --noEmit`, `npm test` (675 + 10 documented), `npx next build`. **Commit** `refactor: boardTheme constants + PersonChip extraction (pure move)`.

---

### Task 2: solid compact site headers + compact room cards

**Files:** Modify `src/app/board/SiteCard.tsx`, `src/app/board/FloatBar.tsx`, `src/app/board/PersonChip.tsx`.

- [x] **Step 2.1 (SiteCard header, lines ~74-81):** replace the translucent-gradient header with the solid bar: `background: site.color`, `padding: BT.siteHeader.pad`, name `color:#fff, fontSize: BT.siteHeader.nameSize, fontWeight 750`, count `rgba(255,255,255,.65), fontSize: BT.siteHeader.countSize`, `borderBottom: none`, top radii from `BT.siteHeader.radius`. `+ Room` / `Delete Site` buttons restyle to sit on the solid bar: `background: rgba(255,255,255,.14), border: 1px solid rgba(255,255,255,.3), color: #fff` (danger button keeps red tint but on-white treatment: `background: rgba(255,255,255,.12), color: #fecaca, border-color: rgba(254,202,202,.4)`).
- [x] **Step 2.2 (RoomCell, lines ~160-222):** apply `BT.room.*` — minWidth 152→`BT.room.minWidth`, minHeight 132→`BT.room.minHeight`, radius 12→`BT.room.radius`, header padding→`BT.room.headerPad`, room-name fontSize 12.5→`BT.font.roomName`, surgeon suffix 11→9.5 and LAST-NAME-ONLY when the room is at min width (render `person.name.split(' ').pop()`, title attr = full name), chips container gap 3→`BT.room.gap`, padding→`BT.room.bodyPad`. Rooms area (line 86): gap 10→`BT.roomsArea.gap`, padding→`BT.roomsArea.pad`, `minHeight 110→72`.
- [x] **Step 2.3 (PersonChip):** chip font 11.5→`BT.font.chip`, radius→`BT.chip.radius`, padding→`BT.chip.pad`, **minHeight `BT.chip.minHeight` (20px) and the chip row keeps a ≥32px pointer target via padding-box on the drag handle** (spec risk #1 — measure the rendered hit area, state it in the report). FloatBar chips get the same scale.
- [x] **Step 2.4:** Gates + visual smoke via dev server screenshot description. **Commit** `feat: solid compact site headers + compact room cards (boardTheme scale)`.

---

### Task 3: sidebar collapse → icon rail with live counts

**Files:** Modify `src/app/board/Sidebar.tsx`, `src/app/board/BoardClient.tsx`.

- [x] **Step 3.1 (BoardClient):** add `const [sidebarCollapsed, setSidebarCollapsed] = useState(false)` hydrated from localStorage `sidebarCollapsed` (same try/catch pattern as `sidebarWidth`, BoardClient:66); persist on change. Keyboard: `useEffect` keydown listener for `(e.metaKey || e.ctrlKey) && e.key === 'b'` → toggle (guard: not when target is an input/textarea). Pass `collapsed`/`onToggleCollapse` to Sidebar; when collapsed the sidebar container width is `BT.railWidth` and the resize handle hides.
- [x] **Step 3.2 (Sidebar):** when `collapsed`, render the rail INSTEAD of panes:

```tsx
// Rail: ≡ expand button + one icon per role group with a live working-today
// count badge. Counts reuse the exact sidebar data (staff = activeStaff
// upstream; activeStaffIds = daily_active).
const groups: Array<{ icon: string; label: string; roles: Role[] }> = [
  { icon: '🩺', label: 'Physicians', roles: ['physician'] },
  { icon: '💉', label: 'CRNAs / SRNAs / Residents / Fellows', roles: ['crna', 'srna', 'resident', 'fellow'] },
  { icon: '🔪', label: 'Surgeons', roles: ['surgeon'] },
];
return (
  <div style={{ width: BT.railWidth, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '10px 0', borderRight: '1px solid var(--border)', background: 'var(--bg-surface)' }}>
    <button onClick={onToggleCollapse} title="Expand sidebar (⌘B)" style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--bg-deep)', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>≡</button>
    {groups.map((g) => {
      const working = staff.filter((p) => g.roles.includes(p.role) && activeStaffIds.has(p.id)).length;
      return (
        <button key={g.label} onClick={onToggleCollapse} title={`${g.label}: ${working} working today — click to expand`} style={{ position: 'relative', width: 28, height: 28, borderRadius: 7, background: 'var(--bg-deep)', border: '1px solid var(--border)', cursor: 'pointer', fontSize: 12 }}>
          {g.icon}
          {working > 0 && <span style={{ position: 'absolute', top: -5, right: -5, background: '#1e3a8a', color: '#fff', fontSize: 8, fontWeight: 800, borderRadius: 6, padding: '0 3px', minWidth: 12 }}>{working}</span>}
        </button>
      );
    })}
  </div>
);
```

Expanded state gains a matching collapse button (≡ or ⟨) in the sidebar's search row. Drag-out from the rail is out of scope (spec §5).
- [x] **Step 3.3:** Gates. **Commit** `feat: collapsible sidebar — 44px icon rail with live working counts (⌘B)`.

---

### Task 4: slim stats top bar

**Files:** Modify `src/app/board/BoardClient.tsx` (header row ~480-535), `src/app/board/StatsBar.tsx`.

- [x] **Step 4.1:** Convert StatsBar to a slim inline variant: export `StatsInline` rendering ONLY the StatPills + room count in one `~30px` row (reuse StatPill verbatim; drop the outer box/margins), and keep the supervision `Banner` as a separate export rendered full-width UNDER the header ONLY when `mdsOverLimit > 0 || mdsAtLimit > 0` (unchanged thresholds, SUPERVISION_LIMITS import). Delete the old block layout.
- [x] **Step 4.2:** In BoardClient's header row, mount `<StatsInline …/>` between the hospital selector and the view toggle; remove the old `<StatsBar/>` mount below the header. Net vertical space reclaimed ≈ 40px (report the measured before/after from the DOM).
- [x] **Step 4.3:** Gates. **Commit** `feat: stats fold into slim header line (banner only when supervision at/over limit)`.

---

### Task 5: Rows view with column flow

**Files:** Create `src/app/board/RowsView.tsx`; modify `src/app/board/BoardClient.tsx` (viewMode type + switch), `src/app/board/SiteCard.tsx` (export shared helpers if needed).

- [x] **Step 5.1 (BoardClient):** `viewMode: 'grid' | 'rows' | 'network'` (localStorage-persisted as today); `PillToggleV1` options become `[{v:'grid',label:'Cards'},{v:'rows',label:'Rows'},{v:'network',label:'Network'}]`; render branch for `'rows'`.
- [x] **Step 5.2 (RowsView):** per site: solid header (same treatment as Task 2), body = **CSS multi-column** column flow with dividers:

```tsx
// Column flow: CSS columns give height-driven fill with automatic balance.
// column-rule renders the divider (spec: rooms flow down, spill right).
<div style={{ padding: '6px 8px', columnWidth: 260, columnGap: 16, columnRule: BT.rows.divider, maxHeight: roomsHeight ?? undefined, overflowY: 'auto' }}>
  {site.rooms.map((room) => (
    <div key={room.id} style={{ breakInside: 'avoid', marginBottom: 3 }}>
      <RoomRow room={room} … />
    </div>
  ))}
</div>
```

`RoomRow`: one flex row `minHeight: BT.rows.rowMinHeight, pad BT.rows.rowPad` — mono room name (min-width 44, `BT.font.roomName`), then MD chips, CRNA chips, surgeon name last (`9.5px` amber); chips `flexWrap: 'wrap'` so extra staff wrap to a second line (spec risk #3 — never hide a person); No-MD warning as the row's border color (`rgba(245,158,11,.4)`) + compact `⚠ MD` badge. Row is a full drop target with the same `handleDrop(room.id)` semantics and drag-over glow as RoomCell; chips use the shared `PersonChip` (compact) with remove-on-click.
- [x] **Step 5.3:** Float zone + relieved box + out-list remain as-is in rows mode (only site cards change shape). Verify drag: sidebar→row, row→row, row→relieved.
- [x] **Step 5.4:** Gates. **Commit** `feat: Rows view — one line per room, height-driven column flow with dividers`.

---

### Task 6: wall display mode

**Files:** Create `src/app/board/wall/page.tsx`; small export adjustments in BoardClient/RowsView as needed.

- [x] **Step 6.1:** Route `/board/wall` (server component mirroring `board/page.tsx`'s data fetch for TODAY only) rendering a client `WallClient`: full-screen dark layout, slim top line (hospital name from localStorage-equivalent — accept `?hospital=` query param default all, document it), a live clock (30s tick), then read-only RowsView (no drag handlers — pass a `readOnly` prop that RowsView uses to skip drop wiring and remove buttons), realtime subscription reusing the SAME unique-channel-topic pattern as BoardClient (cite BoardClient's channel effect; simplest: extract that effect's table-refetch wiring into a small hook `useBoardRealtime(today, setters)` in `src/app/board/useBoardRealtime.ts` and use it in BOTH BoardClient and WallClient — pure move for BoardClient, zero behavior change).
- [x] **Step 6.2:** No sidebar, no assistant button, no modals; `<meta name="robots" content="noindex">`-equivalent not needed (internal). Gates + manual check in a second window. **Commit** `feat: wall display mode — chrome-less full-screen Rows view with live updates`.

---

### Task 7: drag feedback + 4px sweep

**Files:** Modify `src/app/board/SiteCard.tsx`, `RowsView.tsx`, `FloatBar.tsx`, `RelievedBox.tsx`, `OutListPanel.tsx`, `Sidebar.tsx`.

- [x] **Step 7.1:** Drop-target hover: replace the existing `transition: 'all 0.14s'` with `BT.drag.transition` and add `transform: isOver ? BT.drag.hoverScale : 'none'`; glow stays color-keyed to `site.color`. Wrap in reduced-motion: add a module-level `<style>` block (pattern: ChatDrawer's `chat-mic-pulse`) defining `.board-drop-target { transition: … }` + `@media (prefers-reduced-motion: reduce) { .board-drop-target { transition: none; transform: none !important; } }`, applied via className; inline transform only when motion allowed is acceptable alternative — implementer picks ONE approach and applies it consistently across all drop targets (room cells, rows, float, relieved, sidebar).
- [x] **Step 7.2:** 4px sweep: audit the six files for paddings/gaps/font-sizes off the 4px grid or off the two-size type scale (`BT.font`) in compact areas; fix stragglers; radii to 10/8/4 (site/room/chip). Report every value changed as a from→to list (this is a visual-QA aid for Task 9).
- [x] **Step 7.3:** Gates. **Commit** `feat: 120ms drop-target feedback (reduced-motion aware) + 4px spacing/type sweep`.

---

### Task 8: AddSiteModal palette + site-color data update file

**Files:** Modify `src/app/board/Modals.tsx` (AddSiteModal swatches → `SITE_COLOR_CHOICES`); create `scripts/updateSiteColorsDark.sql` (plain SQL, recorded rollback).

- [x] **Step 8.1:** Swap AddSiteModal's color options to `SITE_COLOR_CHOICES` from boardTheme.
- [x] **Step 8.2:** Write the data update with the OLD values recorded for one-line rollback:

```sql
-- scripts/updateSiteColorsDark.sql — spec §4 palette (DATA-ONLY, reversible).
-- OLD values (rollback reference): Main OR #0ea5e9, Endoscopy #10b981,
-- Neuro #a78bfa, EP Lab #f59e0b, OB #f472b6, Float / Breaks #10b981.
UPDATE public.sites SET color = '#1e3a8a' WHERE name = 'Main OR'   AND hospital = 'Paoli Hospital';
UPDATE public.sites SET color = '#065f46' WHERE name = 'Endoscopy' AND hospital = 'Paoli Hospital';
UPDATE public.sites SET color = '#5b21b6' WHERE name = 'OB'        AND hospital = 'Paoli Hospital';
UPDATE public.sites SET color = '#0e7490' WHERE name = 'Neuro'     AND hospital = 'Paoli Hospital';
UPDATE public.sites SET color = '#92400e' WHERE name = 'EP Lab'    AND hospital = 'Paoli Hospital';
UPDATE public.sites SET color = '#334155' WHERE is_float;
-- Verify: SELECT name, color FROM public.sites ORDER BY position;
```

**Do NOT apply** — Task 9 applies it at the visual gate so Gabriel sees the palette land live. Gates + **Commit** `feat: dark site palette in AddSiteModal + recorded color data update (not applied)`.

---

### Task 9: gates, color apply, manual visual pass (USER), merge

- [x] **Step 9.1:** Full gates: tsc, `npm test` (675 + 10 documented — this plan adds no tests unless a task introduced logic worth pinning), `npx next build`.
- [x] **Step 9.2:** Apply `scripts/updateSiteColorsDark.sql` via the Management API (ref `qhwdbtixhzdsgwwtcfrm` verified) — realtime repaints Gabriel's open board instantly.
- [x] **Step 9.3: Manual visual pass WITH Gabriel** on localhost: Cards view density (compare sites-visible before/after), header contrast, rail collapse/expand + ⌘B + count badges, slim top bar, Rows view column flow + drag in rows, wall page in a second window receiving a live assistant/drag change, drag feedback feel, reduced-motion honored (macOS setting). Fix-forward findings.
- [x] **Step 9.4:** Plan close-out note; merge `board-visual` → main (--no-ff), push (deploys), verify prod /board + /board/wall; memory update (board visual system: boardTheme is the source of truth; palette is DB data; wall mode exists).

---

## Self-review notes

- Spec coverage: §1→T2, §2→T5, §3→T2, §4→T8+9.2, §5→T3, §6→T4, §7→T7 (+T1 constants), §8→T7, §9→T6. Risks: drag-target size→T2.3, dark tints→T2/T7 reports, row overflow→T5.2 wrap.
- Known adaptation points (deliberate): PersonChip's exact private helpers (T1.2 reads first); StatsBar's Banner import path; RowsView column strategy allows CSS-columns or flex-columns if `breakInside` misbehaves — implementer documents the choice; wall page hospital source (`?hospital=` param) documented in T6.
- Type consistency: `BT` and `DARK_SITE_PALETTE`/`SITE_COLOR_CHOICES` names used identically across T1-T8; `readOnly` prop on RowsView introduced in T6 and only consumed there.

---

## Close-out (2026-07-14)

Merged `board-visual` → main (`cb7dc86`, --no-ff, 13 commits) and deployed. All tasks
implemented with per-task spec + quality review loops; final whole-branch review: READY
TO MERGE, no Critical/Important findings. Gates at merge: tsc clean, 675 vitest passing
(+ the 10 documented gridCalculator file errors), `next build` clean.

Deviations/extensions from the plan as written:
- T4: StatsInline placed at the Live/Planning ↔ facility-pills seam (plan's literal
  "between hospital selector and view toggle" wasn't adjacent in the real header);
  BODY height calc replaced with `flex:1/minHeight:0` because SupervisionBanner is a
  variable-height sibling. "~33px reclaimed" is arithmetic, not DOM-measured.
- T5: room drag-reorder and the resize handle are Cards-only by design (multicol
  column-major flow makes drag order ambiguous); heights set in Cards are honored.
- T7 fellow audit fixed two pre-existing bugs (fellows missing relief-countdown in
  alertLevels; fellows sorted above MDs in PrintView) and led to `computeAlertLevels`
  being extracted to boardLogic.ts, shared by BoardClient + WallClient.
- T8: AddSiteModal had no preset swatches to "swap" — an 8-swatch SITE_COLOR_CHOICES
  row was added above the kept native color input (StepSites ColorPicker precedent).
- 9.2 extension (Gabriel, 2026-07-14): dark palette applied to ALL hospitals (Bryn Mawr
  + unassigned-hospital sites), same site type → same color; script updated with
  rollback values. Live DB verified: all 13 sites on the dark palette.
- 9.3: Gabriel approved after the colors landed live ("go ahead merge"); detailed
  per-item checklist walkthrough was offered but not itemized back — fix-forward
  remains open for anything he spots in production.

Known deferrals / follow-ups:
- Wall bundle pulls the interactive board via `hexToRgb`/`AddSiteTile` imports from
  BoardClient (~172 kB First Load) — relocate `hexToRgb` to a leaf util if it matters.
- Spec §7 says chip radius 5, plan/implementation use 4 (plan followed; spec wording).
- Cards-view inter-card `gap: 14` in BoardClient vs Rows' 12 — match if desired.
- EP Lab (#92400e) and Endoscopy (#065f46) header-text contrast vs white are below
  4.5:1 (documented interim in SiteCard.tsx; "do not add per-color conditionals").
