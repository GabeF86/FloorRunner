# Schedule Builder Premium Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the schedule builder grid (`src/app/(scheduling)/schedules/[id]/page.tsx`) to the premium "Refined Slate" design — readable type scale, bold-black names, gray weekend wash, two-tier header, restyled popover and status rows — with zero behavior change.

**Architecture:** Presentational-only. Introduce one colocated theme module (`gridTheme.ts`) holding design tokens plus the single piece of genuinely testable presentational logic (the cell-background precedence resolver). Every other task applies those tokens in place to existing JSX, surface by surface, committing after each. No component extraction; no logic, data, handler, or view-mode changes.

**Tech Stack:** Next.js 14 (app router, `'use client'`), React 18, inline styles, Vitest (`npm test`), ESLint (`npm run lint`), `tsc` typecheck.

**Spec:** `docs/superpowers/specs/2026-06-15-schedule-builder-redesign-design.md`
**Mockups (gitignored, visual reference):** `.superpowers/brainstorm/8413-1781552938/content/` → `grid-direction-v4.html`, `header.html` (A), `picker.html`, `virtual-rows.html`.

---

## Conventions (read once, used by every task)

**Target file** for all UI tasks: `src/app/(scheduling)/schedules/[id]/page.tsx`. Locate edit sites by the stable `/* ── … ── */` comment anchors named in each task (line numbers drift as you edit).

**This is a presentational redesign.** Classic red/green TDD applies only to Task 1 (the pure helper). For every JSX task the gate is the **Standard Visual Check**:

1. **Typecheck:** `npx tsc --noEmit` → no errors.
2. **Lint:** `npm run lint` → no new errors/warnings vs baseline.
3. **Render + screenshot:** `npm run dev`, open `http://localhost:3000/schedules/<draftScheduleId>` (in the app, go to **Schedules** → open any **Draft** schedule; copy its URL id). Screenshot the states the task names.
4. **Logic-untouched guard:** `git diff` the file and confirm changes are **only** `style={…}` objects, `className`/`aria-*` attributes, and JSX element wrapping. **No** edits to `useState/useEffect/useMemo/useCallback`, their dependency arrays, handler bodies (`assignProvider`, `removeAssignment`, `toggleLock`, `autoGenerateSchedule`, `publishSchedule`), `fetch` calls, derived-data math, or conditional-render guards.

**Commit** after each task (the branch is already `feature/floor-runner-ui-redesign`).

---

## Task 1: Theme tokens + cell-background resolver (TDD)

**Files:**
- Create: `src/app/(scheduling)/schedules/[id]/gridTheme.ts`
- Create (test): `src/app/(scheduling)/schedules/[id]/gridTheme.test.ts`

This module is the only logic-bearing piece. `cellBackground` must reproduce the **exact current precedence** (over-par › extra-call › holiday › weekend › base) so the restyle can't silently reorder state priority — only the color values change.

- [ ] **Step 1: Write the failing test**

```ts
// gridTheme.test.ts
import { describe, it, expect } from 'vitest';
import { gridTokens, cellBackground } from './gridTheme';

describe('cellBackground precedence', () => {
  const base = { isOverPar: false, isExtraCall: false, isHoliday: false, isWeekend: false };

  it('plain weekday cell is white', () => {
    expect(cellBackground(base)).toBe(gridTokens.bodyCell);
  });
  it('weekend uses the gray wash', () => {
    expect(cellBackground({ ...base, isWeekend: true })).toBe(gridTokens.bodyWeekend);
  });
  it('holiday beats weekend', () => {
    expect(cellBackground({ ...base, isWeekend: true, isHoliday: true })).toBe(gridTokens.bodyHoliday);
  });
  it('extra-call beats holiday/weekend', () => {
    expect(cellBackground({ ...base, isWeekend: true, isHoliday: true, isExtraCall: true })).toBe(gridTokens.extraCall);
  });
  it('over-par beats everything', () => {
    expect(cellBackground({ isOverPar: true, isExtraCall: true, isHoliday: true, isWeekend: true })).toBe(gridTokens.overPar);
  });
  it('hover returns the hover variant for each precedence level', () => {
    expect(cellBackground(base, true)).toBe(gridTokens.bodyCellHover);
    expect(cellBackground({ ...base, isWeekend: true }, true)).toBe(gridTokens.bodyWeekendHover);
    expect(cellBackground({ ...base, isHoliday: true }, true)).toBe(gridTokens.bodyHolidayHover);
    expect(cellBackground({ ...base, isExtraCall: true }, true)).toBe(gridTokens.extraCallHover);
    expect(cellBackground({ ...base, isOverPar: true }, true)).toBe(gridTokens.overParHover);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/app/\(scheduling\)/schedules/\[id\]/gridTheme.test.ts`
Expected: FAIL — `Cannot find module './gridTheme'`.

- [ ] **Step 3: Implement the module**

```ts
// gridTheme.ts — presentational tokens + cell-background resolver for the schedule grid.
export const gridTokens = {
  // chrome (dark)
  chrome: '#1e293b',
  chromeWeekend: '#172230',
  chromeBorder: '#1e3a5f',
  chromeText: '#f1f5f9',
  chromeMuted: '#94a3b8',
  // accent (single, uniform)
  accent: '#38bdf8',
  accentStrong: '#0ea5e9',
  // body backgrounds
  bodyCell: '#ffffff',
  bodyCellHover: 'rgba(14,165,233,0.06)',
  bodyWeekend: '#edf1f6',
  bodyWeekendHover: '#e2e8f0',
  bodyHoliday: 'rgba(251,191,36,0.22)',
  bodyHolidayHover: 'rgba(251,191,36,0.32)',
  extraCall: 'rgba(14,165,233,0.18)',
  extraCallHover: 'rgba(14,165,233,0.28)',
  overPar: 'rgba(239,68,68,0.15)',
  overParHover: 'rgba(239,68,68,0.28)',
  // text / marks
  name: '#0f172a',
  open: '#dc2626',
  unassigned: '#cbd5e1',
  statusName: '#64748b',
  line: '#e8edf3',
  hard: '#ef4444',
  soft: '#f59e0b',
  // virtual-row category accents (label border only)
  category: { Available: '#10b981', 'Post-Call': '#8b5cf6', Off: '#94a3b8', PTO: '#f59e0b' } as Record<string, string>,
} as const;

export interface CellStateFlags {
  isOverPar: boolean;
  isExtraCall: boolean;
  isHoliday: boolean;
  isWeekend: boolean;
}

/** Resolve a data-cell background. Precedence (highest first):
 *  over-par › extra-call › holiday › weekend › base. Matches the pre-redesign
 *  inline logic exactly; only the color values are new. */
export function cellBackground(s: CellStateFlags, hover = false): string {
  if (s.isOverPar) return hover ? gridTokens.overParHover : gridTokens.overPar;
  if (s.isExtraCall) return hover ? gridTokens.extraCallHover : gridTokens.extraCall;
  if (s.isHoliday) return hover ? gridTokens.bodyHolidayHover : gridTokens.bodyHoliday;
  if (s.isWeekend) return hover ? gridTokens.bodyWeekendHover : gridTokens.bodyWeekend;
  return hover ? gridTokens.bodyCellHover : gridTokens.bodyCell;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run src/app/\(scheduling\)/schedules/\[id\]/gridTheme.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(scheduling)/schedules/[id]/gridTheme.ts" "src/app/(scheduling)/schedules/[id]/gridTheme.test.ts"
git commit -m "Add schedule grid theme tokens + tested cell-background resolver"
```

---

## Task 2: Two-tier header

**Files:** Modify `page.tsx` — anchors `{/* Breadcrumb */}`, `{/* Top Bar */}` (current ~822–1062).

Goal: split the single wrapping top bar into an **identity row** (breadcrumb, title, status pill, version, date range, rules-health pill pushed right) + a 1px divider + a **toolbar row** (view segmented + week arrows left; ghost Call Counts / Select Pool, emerald Auto-Generate, gradient Publish right). Keep every button's existing `onClick` and conditional render exactly.

- [ ] **Step 1: Import tokens** at top of file (with the other imports):

```ts
import { gridTokens, cellBackground } from './gridTheme';
```

- [ ] **Step 2: Wrap the existing top-bar children into two rows.** Keep all existing button JSX (the `View toggle`, `Week navigation`, `Call Counts button`, `Pool selector`, `Auto-Generate`, `Publish` blocks) verbatim — only move them between the two row containers and update each button's `style` to the shared button styles below. Replace the outer `{/* Top Bar */}` container so its structure is:

```tsx
{/* Top Bar — identity row */}
<div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
  <h1 style={{ fontSize: 21, fontWeight: 800, color: 'var(--text)', margin: 0, letterSpacing: '-0.01em' }}>{schedule.schedule_name}</h1>
  {/* status pill — keep existing <span> but use: */}
  {/* style: fontSize:10.5, fontWeight:800, textTransform:'uppercase', letterSpacing:'0.05em', padding:'3px 9px', borderRadius:999, color:sc.color, background:sc.bg */}
  {/* version chip — keep, fontSize:11, color:'var(--text-dim)' */}
  {/* date range — keep, fontSize:12.5, color:'var(--text-muted)' */}
  <div style={{ flex: 1 }} />
  {/* rules-health pill button (the existing setShowRulesSummary button + dropdown) moves here, restyled per Step 3 */}
</div>

{/* Top Bar — toolbar row */}
<div style={{
  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
  marginBottom: 20, paddingTop: 14, borderTop: '1px solid var(--border)',
}}>
  {/* View toggle (existing) */}
  {/* Week navigation (existing, week mode only) */}
  <div style={{ flex: 1 }} />
  {/* Call Counts (existing) — buttonGhost */}
  {/* Select Pool (existing, draft only) — buttonIndigo */}
  {/* Auto-Generate (existing, draft only) — buttonGen */}
  {/* Publish (existing, draft only) — buttonPrimary */}
</div>
```

- [ ] **Step 3: Apply the shared button/segment styles.** Update each existing control's inline `style` to these exact objects (logic/labels unchanged):

```ts
// segmented view toggle container
{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }
// each seg button (active = viewMode === m)
{ padding: '6px 14px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
  background: active ? 'rgba(56,189,248,0.18)' : 'transparent',
  color: active ? '#7dd3fc' : 'var(--text-muted)' }
// week-nav arrow buttons
{ width: 30, height: 30, borderRadius: 8, border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }
// buttonGhost  (Call Counts)
{ padding: '7px 15px', fontSize: 12.5, fontWeight: 700, borderRadius: 8, cursor: 'pointer',
  background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' }
// buttonIndigo (Select Pool — when a custom pool is set keep the existing sky-tint variant logic)
{ padding: '7px 15px', fontSize: 12.5, fontWeight: 700, borderRadius: 8, cursor: 'pointer',
  background: 'rgba(99,102,241,0.14)', border: '1px solid rgba(99,102,241,0.35)', color: '#a5b4fc' }
// buttonGen (Auto-Generate; keep existing disabled styling when generating)
{ padding: '7px 16px', fontSize: 12.5, fontWeight: 700, borderRadius: 8, cursor: 'pointer',
  background: 'rgba(16,185,129,0.16)', border: '1px solid rgba(16,185,129,0.4)', color: '#34d399' }
// buttonPrimary (Publish)
{ padding: '7px 16px', fontSize: 12.5, fontWeight: 700, border: 'none', borderRadius: 8, cursor: 'pointer',
  background: 'linear-gradient(135deg,#0ea5e9,#6366f1)', color: '#fff', boxShadow: '0 4px 14px rgba(56,130,246,0.35)' }
// rules-health pill button (replace the existing inline style; keep the conditional color logic by hardCount/softCount)
{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 11px', borderRadius: 999, cursor: 'pointer',
  fontSize: 11.5, fontFamily: 'var(--font-mono), ui-monospace, monospace',
  /* keep existing conditional background/color/border by hardCount/softCount */ }
```

- [ ] **Step 4: Standard Visual Check.** Screenshot: (a) draft schedule header (all buttons present), (b) a published schedule (Auto-Generate/Pool/Publish hidden), (c) rules-health pill in clean and violation states + its dropdown open. Confirm the diff touched only styles/JSX wrapping (no `onClick`/conditionals changed).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(scheduling)/schedules/[id]/page.tsx"
git commit -m "Redesign schedule header: two-tier identity + toolbar rows"
```

---

## Task 3: Grid headers (day-of-week + date rows)

**Files:** Modify `page.tsx` — anchors `{/* ── Row 0: Day-of-week header ── */}` and `{/* ── Row 1: Date header ── */}` (current ~1108–1193).

- [ ] **Step 1: Restyle the corner + day-of-week cells.** Replace the per-cell `style` values: background `gridTokens.chrome`; weekend background `gridTokens.chromeWeekend`; text `gridTokens.chromeMuted` (weekend `#cbd5e1`); keep holiday amber (`#3a3010` bg, `#fbbf24` text); `fontSize: 10`, `fontWeight: 700`, uppercase, `letterSpacing: '0.05em'`. Keep `isToday`/`isSatBorder` left borders but set the today color to `gridTokens.accent`.

- [ ] **Step 2: Restyle the date row.** Date cells: background `gridTokens.chrome` / weekend `gridTokens.chromeWeekend` / holiday amber (unchanged); `fontSize: 12.5`, `fontWeight: 700`, text `gridTokens.chromeText`; **today** = color `gridTokens.accent` + `boxShadow: 'inset 0 -3px 0 ' + gridTokens.accentStrong`. Keep the holiday-name sub-line and the `mdCount/crnaCount` mono sub-line (just confirm sizes 9px/8.5px). The "Shifts" corner label: `fontSize: 11`, `color: gridTokens.chromeMuted`.

- [ ] **Step 3: Update the grid template** at the `{/* Grid Container */}` inner `<div style={{ display:'grid', … }}>`: change `gridTemplateColumns` to `` `84px repeat(${colCount}, minmax(74px, 1fr))` `` and `minWidth` to `` colCount > 7 ? `${84 + colCount * 74}px` : undefined ``.

- [ ] **Step 4: Standard Visual Check.** Screenshot a span containing a weekday, the today column, a weekend pair, and a holiday column together — confirm gray weekend vs amber holiday vs accent today are all distinguishable.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(scheduling)/schedules/[id]/page.tsx"
git commit -m "Redesign grid headers: readable type, gray weekend, accent today, tighter columns"
```

---

## Task 4: Shift-label column

**Files:** Modify `page.tsx` — anchor `{/* Shift label cell */}` inside the `shiftTypes.map` (current ~1199–1211).

- [ ] **Step 1: Restyle the label cell.** Background `gridTokens.chrome`; **uniform** left accent `borderLeft: '4px solid ' + gridTokens.accent` (remove the `st.color_hex` usage here); code line `fontSize: 13, fontWeight: 800, color: '#ffffff'`; sub-name line `fontSize: 9.5, color: gridTokens.chromeMuted`. Keep `minHeight` but set to `32`.

- [ ] **Step 2: Standard Visual Check.** Screenshot the label column with ≥4 shift types — codes are white, every left stripe is the same sky accent.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(scheduling)/schedules/[id]/page.tsx"
git commit -m "Redesign shift-label column: white codes, uniform accent stripe"
```

---

## Task 5: Assignment cells + all states

**Files:** Modify `page.tsx` — anchor `{/* Assignment cells */}` through the cell return (current ~1213–1359).

- [ ] **Step 1: Replace the inline background math with the helper.** Delete the local `baseCellBg`/`extraBg`/`overParBg`/`cellBg` consts and the inline hover expressions; compute via the resolver (data flags are already in scope — do **not** change how `isOverPar/isExtraCall/isHoliday/isWeekend` are derived):

```ts
const flagsForBg = { isOverPar, isExtraCall, isHoliday, isWeekend };
// container style: background: cellBackground(flagsForBg)
// onMouseEnter: e.currentTarget.style.background = cellBackground(flagsForBg, true)
// onMouseLeave: e.currentTarget.style.background = cellBackground(flagsForBg)
```

- [ ] **Step 2: Cell container style.** `borderBottom`/`borderRight`: `'1px solid ' + gridTokens.line`; today left border `'2px solid ' + gridTokens.accentStrong`; `padding: '3px 4px'`, `minHeight: 32`, keep `display/align/justify/center`, `cursor`, `position:'relative'`, `transition:'background 0.1s'`. Keep the `onClick` (`setActiveCell`) and `title` exactly.

- [ ] **Step 3: Restyle the three content states.**

```tsx
// assigned → plain bold black name (no pill)
<span style={{ fontSize: 13, fontWeight: 800, color: gridTokens.name, whiteSpace: 'nowrap' }}>
  {provider!.short_display_name}
</span>
// open call → plain red text
<span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.03em', color: gridTokens.open }}>OPEN</span>
// unassigned → em-dash (already present)
<span style={{ fontSize: 13, color: gridTokens.unassigned }} aria-label="Unassigned">&mdash;</span>
```

- [ ] **Step 4: Restyle the markers.**

```tsx
// validation badge (keep the hardFlag/softFlag/title/aria-label logic)
style={{ position:'absolute', top:2, left:2, minWidth:12, height:12, padding:'0 1px', borderRadius:4,
  display:'flex', alignItems:'center', justifyContent:'center', fontSize:9, fontWeight:900, lineHeight:1, color:'#fff',
  background: hardFlag ? gridTokens.hard : gridTokens.soft,
  boxShadow: hardFlag ? '0 0 4px rgba(239,68,68,0.6)' : '0 0 4px rgba(245,158,11,0.55)' }}
// over-par tag (NEW small marker; render only when isOverPar)
<span aria-label="Over par for this shift" style={{ position:'absolute', bottom:1, right:3, fontSize:7.5,
  fontWeight:800, letterSpacing:'0.03em', color:'#b91c1c', pointerEvents:'none' }}>OVER</span>
// extra-call tag (existing EXTRA) — restyle to match: fontSize:8, fontWeight:800, color:'#0369a1'
// lock icon (existing) — keep
```

- [ ] **Step 5: Standard Visual Check.** Screenshot cells covering each state: assigned (bold black), OPEN, em-dash, hard `!`, soft `?`, over-par (red + OVER), extra-call (blue + EXTRA), locked, on weekday + weekend. Verify hover still re-tints and the popover still opens on click.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(scheduling)/schedules/[id]/page.tsx"
git commit -m "Redesign assignment cells: plain bold names, plain OPEN, OVER tag, refined markers"
```

---

## Task 6: Virtual rows (Available / Post-Call / Off / PTO)

**Files:** Modify `page.tsx` — the four `renderVirtualRows({...})` call sites (~1363–1415) and the `renderVirtualRows` function (~1625–1697).

- [ ] **Step 1: Keep the call sites' data args; the `color` arg now means the label-border accent.** Leave each call's `label`, `count`, `dataByDate`, `visibleDates`, `todayStr`, `holidayMap`, `getDayOfWeek`, and PTO's `alwaysRender` unchanged. You may drop the now-unused `bg` arg from the calls and the function signature (or leave it; it will no longer be read).

- [ ] **Step 2: Restyle the label cell** inside `renderVirtualRows`: background `gridTokens.chrome`; `borderLeft: '4px solid ' + color`; label text `fontSize: 11.5, fontWeight: 700, color: '#e2e8f0'` (keep the `${idx+1}` multi-row suffix logic); `minHeight: 28`.

- [ ] **Step 3: Restyle the virtual data cells:** background via the resolver with assignment flags off — `cellBackground({ isOverPar:false, isExtraCall:false, isHoliday, isWeekend })`; borders `'1px solid ' + gridTokens.line`; today left border `'2px solid ' + gridTokens.accentStrong`; `minHeight: 28`, `padding: '2px 4px'`. The provider name becomes **muted plain text** (no chip): `fontSize: 11.5, fontWeight: 500, color: gridTokens.statusName, whiteSpace: 'nowrap'`. Uniform across all four categories (no PTO emphasis).

- [ ] **Step 4: Add the zone separator.** On the **first** virtual row's label and cells (the Available row, `idx===0` of the first call), add a stronger top border to mark the assignment→status boundary: label `borderTop: '2px solid #33455f'`, cells `borderTop: '2px solid #cbd5e1'`. (Simplest: pass an optional `zoneTop?: boolean` to `renderVirtualRows`, true only on the Available call, applied when `idx===0`.)

- [ ] **Step 5: Standard Visual Check.** Screenshot the status zone with a multi-row Available, Post-Call, Off, and the always-render (possibly empty) PTO row, directly under a real assignment row — confirm bold-black vs muted hierarchy and the 2px separator.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(scheduling)/schedules/[id]/page.tsx"
git commit -m "Redesign virtual rows: category-bordered labels, muted uniform names, zone separator"
```

---

## Task 7: Click-to-assign popover

**Files:** Modify `page.tsx` — anchor `{/* ── Provider Picker / Action Popover ── */}` (current ~1435–1593).

- [ ] **Step 1: Restyle the popover shell.** Keep the `position:'fixed'`, computed `left`/`top`, `width:268`, `zIndex`, `ref`. Update: `background:'var(--bg-surface)'`, `border:'1px solid var(--border)'`, `borderRadius:12`, `boxShadow:'0 16px 40px rgba(0,0,0,0.5)'`, `overflow:'hidden'`.

- [ ] **Step 2: Add the slot-context header** (label only — read from data already in scope; no logic change). At the top of both branches, render:

```tsx
<div style={{ padding:'9px 13px', background:'var(--bg-deep)', borderBottom:'1px solid var(--border)',
  fontSize:10.5, fontWeight:700, letterSpacing:'0.04em', textTransform:'uppercase', color:'var(--text-dim)',
  display:'flex', alignItems:'center', gap:7 }}>
  <span style={{ width:9, height:9, borderRadius:3, background: gridTokens.accent }} />
  {activeShiftType?.code} · {activeShiftType?.name} — {activeCellDateLabel}
</div>
```
If `activeShiftType`/`activeCellDateLabel` are not already derived, compute them **read-only** from the existing `activeSlot`/`activeCell` + `shiftTypes` (a `find` + the existing date formatter). Do not alter `setActiveCell` or any handler.

- [ ] **Step 3: Restyle the action menu** (assigned branch): name `fontSize:16, fontWeight:800, color:'#f8fafc'`; type line `fontSize:10, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'var(--text-dim)'`. Violations box: `border:'1px solid rgba(239,68,68,0.28)', background:'rgba(239,68,68,0.06)', borderRadius:9`; per-row severity dot uses `gridTokens.hard`/`gridTokens.soft`, rule name `fontSize:12, fontWeight:700`, message `fontSize:11, color:'var(--text-muted)'`. Buttons: Remove = `{ padding:'9px 12px', fontSize:12.5, fontWeight:700, borderRadius:8, textAlign:'left', border:'1px solid rgba(239,68,68,0.35)', background:'rgba(239,68,68,0.10)', color:'#f87171' }`; Lock = same shape with `border:'1px solid var(--border)', background:'transparent', color:'var(--text-muted)'`. Keep both `onClick`s.

- [ ] **Step 4: Restyle the provider picker** (unassigned branch): search wrapper input → `{ padding:'8px 11px', fontSize:12.5, borderRadius:8, border:'1px solid var(--border)', background:'var(--bg-deep)', color:'var(--text)' }` (keep `ref`, `value`, `onChange`). Each provider row: `{ display:'flex', alignItems:'center', gap:10, padding:'8px', borderRadius:8 }`, hover `rgba(56,189,248,0.10)`, disabled `opacity:0.4` (keep the `alreadyAssigned` guard + `onClick`). Avatar: `{ width:28, height:28, borderRadius:'50%', fontSize:10.5, fontWeight:800, background:'rgba(56,189,248,0.16)', color:'#7dd3fc' }`; name `fontSize:13, fontWeight:700`; type chip `{ fontSize:9, fontWeight:800, padding:'2px 6px', borderRadius:4, background:'rgba(100,116,139,0.22)', color:'var(--text-dim)' }`.

- [ ] **Step 5: Standard Visual Check.** Screenshot both: empty-cell picker (with a disabled "assigned" row) and filled-cell action menu (with ≥1 violation). Click a provider to confirm assignment still works; click Remove/Lock to confirm those still work.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(scheduling)/schedules/[id]/page.tsx"
git commit -m "Redesign assign popover: slot-context header, avatar picker rows, refined action menu"
```

---

## Task 8: Modals + calendar view (match the language)

**Files:** Modify `page.tsx` — `PoolSelectorModal` (anchor `function PoolSelectorModal`, ~1708), `CallCountsModal` (anchor `function CallCountsModal`, ~2023), `CalendarView` (anchor `function CalendarView`, ~2349).

No behavior change to any of the three — restyle only. Apply this token mapping to each component's existing styled elements:

- [ ] **Step 1: PoolSelectorModal.** Overlay → keep. Panel: `borderRadius:12, border:'1px solid var(--border)', boxShadow:'0 24px 60px rgba(0,0,0,0.5)'`. Title `fontSize:16, fontWeight:800`. Close button → `buttonGhost` shape (Task 2). Search/filter inputs → the Task 7 Step 4 input style. List rows → `padding:'8px', borderRadius:8`, hover `rgba(56,189,248,0.10)`. Footer Save → `buttonPrimary`; Cancel → `buttonGhost`. Bump any 9–11px body text to ≥12px. Keep all `onClick`/`onChange`/selection state.

- [ ] **Step 2: CallCountsModal.** Same panel/title/close treatment. Table/grid text → ≥12px, header cells `color:'var(--text-muted)', fontWeight:700`; numeric cells mono. Keep the data computation untouched.

- [ ] **Step 3: CalendarView.** Month nav arrows → the Task 2 week-nav arrow style; month label `fontSize:16, fontWeight:800`. Day cells: background via the same scheme — weekday white, weekend `gridTokens.bodyWeekend`, holiday `gridTokens.bodyHoliday`, today accent border (`'2px solid ' + gridTokens.accentStrong`); date number `fontSize:12.5, fontWeight:700`; keep the `mdCount/crnaCount` and over-par (`gridTokens.overPar`) treatments, just using the tokens.

- [ ] **Step 4: Standard Visual Check.** Open each: Pool Selector, Call Counts, and switch to Calendar view. Screenshot all three. Confirm save/select/close and month navigation still work; diff guard.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(scheduling)/schedules/[id]/page.tsx"
git commit -m "Restyle pool/counts modals + calendar view to match grid design language"
```

---

## Task 9: Accessibility + focus-visible sweep

**Files:** Modify `page.tsx` (all surfaces).

- [ ] **Step 1: Labels.** Confirm `aria-label` on every icon/badge-only element: validation badge (done in Task 5), `OVER`/`EXTRA` tags, lock icon (`aria-label="Locked slot"`), em-dash (done). Add where missing.

- [ ] **Step 2: Focus-visible.** Add a visible focus ring to interactive elements that lack one — assignment cells (they're clickable `div`s: add `tabIndex={0}` only if not already focusable **and** keep behavior; if adding keyboard activation is out of scope, instead ensure the buttons/inputs/provider rows show `:focus-visible`). For buttons/inputs/provider rows add `onFocus`/`onBlur` outline or a shared `outline: '2px solid ' + gridTokens.accent` on `:focus-visible` via a style tag. Keep it presentational; do **not** add new key handlers that change behavior.

- [ ] **Step 3: Contrast spot-check.** Verify muted status-row text (`gridTokens.statusName` on white) and header text meet ≥4.5:1; if `statusName` is borderline, darken to `#475569`. Adjust token if needed (re-run Task 1 test — values changed, not logic, so it still passes).

- [ ] **Step 4: Standard Visual Check.** Tab through header buttons, a cell, the popover; screenshot focus rings.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(scheduling)/schedules/[id]/page.tsx" "src/app/(scheduling)/schedules/[id]/gridTheme.ts"
git commit -m "Schedule builder a11y: aria-labels on marks, focus-visible rings, contrast"
```

---

## Task 10: Full verification

- [ ] **Step 1: Typecheck + lint + tests.**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: typecheck clean, lint clean, all vitest suites pass (including `gridTheme.test.ts`).

- [ ] **Step 2: Production build.**

Run: `npm run build`
Expected: build succeeds (Next.js compiles the route with no type errors).

- [ ] **Step 3: Full screenshot checklist** (spec §10) against a running `npm run dev`, on a real Draft schedule with assignments:
  1. Week view with assignments — bold-black vs muted hierarchy.
  2. Each cell state: OPEN, em-dash, hard `!`, soft `?`, OVER, EXTRA, locked.
  3. Weekend pair + holiday column + today column together.
  4. Header draft (all buttons) vs published (hidden buttons).
  5. Rules-health pill clean + violations + dropdown.
  6. Popover: empty-cell picker (disabled "assigned" row) + filled-cell action menu (violations).
  7. Virtual rows: multi-row Available + empty PTO.
  8. Month view + Calendar view.

- [ ] **Step 4: Final logic-untouched audit.** `git diff main...HEAD -- "src/app/(scheduling)/schedules/[id]/page.tsx"` — skim that no handler/hook/derivation/fetch line changed; the diff is styles, tokens, JSX wrapping, and aria attributes only.

- [ ] **Step 5: Done.** No extra commit needed (Task 9 was the last code change). Report screenshots to the user for sign-off.

---

## Self-review notes

- **Spec coverage:** §3 tokens → Task 1; §4 header → Task 2; §5 headers/labels → Tasks 3–4; §6 cell states (incl. OVER tag, weekend gray, holiday amber, today, badges) → Task 5; §7 virtual rows → Task 6; popover (§ picker) → Task 7; §8 modals + calendar → Task 8; §9 a11y → Task 9; §10 verification → Task 10. All sections mapped.
- **Type consistency:** `gridTokens` / `cellBackground(CellStateFlags, hover?)` are defined in Task 1 and used with the same names/signature in Tasks 2,5,6,8.
- **Presentational guard** is stated in Conventions and repeated as the per-task Step gate, since tasks may be executed out of order by separate subagents.
