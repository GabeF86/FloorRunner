# Schedule Builder — Premium Visual Redesign (Design Spec)

- **Date:** 2026-06-15
- **Branch:** `feature/floor-runner-ui-redesign`
- **Target file:** `src/app/(scheduling)/schedules/[id]/page.tsx` (single file, ~2,626 lines)
- **Status:** Design approved in brainstorming (visual directions locked via the visual companion). Ready for implementation planning.
- **Mockups (reference, gitignored):** `.superpowers/brainstorm/8413-1781552938/content/` → `grid-direction-v4.html`, `header.html` (option A), `picker.html`, `virtual-rows.html`.

---

## 1. Goal

Bring the schedule builder grid to the same premium, legible standard already applied to the Floor Runner board (`f1675fb`) and the staffing calculator (`8694a4f`). Today the grid uses 8–13px fonts, 8px-dot validation markers, and a dense inline-styled layout that is hard to read. This redesign raises the type scale, cleans up the visual hierarchy, and refines every cell state — **without changing any behavior**.

## 2. Scope & guardrails

This is a **presentational-only** change, following the exact pattern of the staffing-calculator redesign (`8694a4f`: "All interactive logic … unchanged — presentational only. Screenshot-verified.").

**In scope (visual only):**
- Typography scale, color, spacing, borders, radii, shadows.
- Header layout reorganization (no control added or removed).
- Cell-state styling for every existing signal.
- Popover, virtual-row, modal, and calendar-view styling.
- Accessibility carry-through: `aria-label`s on icon/badge-only elements, sufficient contrast, `:focus-visible` rings on interactive elements.

**Out of scope (do NOT touch):**
- Data fetching, hooks, derived-data `useMemo`s, and all handlers (`assignProvider`, `removeAssignment`, `toggleLock`, `autoGenerateSchedule`, `publishSchedule`, pool/counts modals' logic).
- View-mode behavior (week / month / calendar switching, week offset, calendar month offset).
- Validation rules, the rules-summary aggregation, over-par / extra-call / post-call derivation.
- The picker's filtering/assignment logic and the "already assigned on this date" disabling.
- File structure: **no component extraction.** Restyle in place. (Extraction was explicitly deferred at the "Depth" decision.)
- API routes, the `schedule-assignments` upsert change, and the unique-constraints migration (separate, pre-existing working-tree threads).

**Verification:** screenshots of every state listed in §9 before claiming done. No logic regressions.

## 3. Design tokens

The surrounding app shell is dark (`var(--text)` light on dark `var(--bg-*)`); the grid **data area is white**. The redesign keeps that dark-chrome / light-body split ("Refined Slate").

**Color**
| Token | Value | Use |
|---|---|---|
| chrome-bg | `#1e293b` | header rows, shift-label column, virtual-row labels |
| chrome-bg-weekend | `#172230` | weekend day/date header cells |
| accent | `#38bdf8` / `#0ea5e9` | single uniform accent: shift-label left stripe, today marker, focus rings |
| body-cell | `#ffffff` | assignment cells |
| body-weekend | `#edf1f6` | weekend column wash (replaces old indigo tint) |
| body-holiday | `rgba(251,191,36,0.22)` | holiday column wash (amber — **kept distinct from weekend gray**) |
| name | `#0f172a` | assigned provider names (bold black, no pill) |
| open | `#dc2626` | "OPEN" text (plain, no pill) |
| unassigned | `#cbd5e1` | em-dash |
| grid-line | `#e8edf3` | cell borders |
| status-row name | `#64748b` | virtual-row names (muted, uniform) |
| hard | `#ef4444` · soft | `#f59e0b` | validation badges & dots |
| over-par | `rgba(239,68,68,0.15)` cell bg + `#b91c1c` "OVER" tag | over-par assignment |
| extra-call | `rgba(14,165,233,0.18)` cell bg + "EXTRA" tag | extra-call assignment |

**Category colors (virtual-row label borders only):** Available `#10b981`, Post-Call `#8b5cf6`, Off `#94a3b8`, PTO `#f59e0b`.

**Type scale (replaces the 8–13px sprawl)**
- Provider name (assigned): 13px / 800.
- Shift code: 13px / 800 white; shift sub-name: 9.5px / `#94a3b8`.
- Date header: 12.5px / 700; day-of-week: 10px / 700 uppercase; MD·CRNA count: 8.5px mono.
- Virtual-row name: 11.5px / 500 muted; virtual label: 11.5px / 700.
- "OPEN": 11px / 800; validation badge glyph: 9px / 900.

**Geometry**
- Columns: shift-label `84px` + date columns `minmax(74px, 1fr)` (was `160px` + `minmax(100px,1fr)`) → tighter, "balanced" density (~10–14 days visible).
- Row min-height: assignment `32px` (was 44), virtual `28px`.
- Radii: 8px buttons/inputs, 10–12px containers. Soft shadows on elevated surfaces (header card, popover, modals).

## 4. Header — two-tier (option A)

Replace the single wrapping top bar with a two-tier header card on the dark shell:

- **Identity row:** breadcrumb (`Schedules / <name>`), then `<h1>` title (21px/800), status pill (existing `STATUS_COLORS`), version chip (`v2 · active`), date range (muted). The **rules-health pill** is pushed to the far right of this row — same data (`rulesSummary`), same dropdown, restyled: rounded, dot + `142 checked · 3H · 5S`, green when clean.
- **Divider** (1px), then **toolbar row:** left = view segmented control (Week / Month / Calendar) + week-nav arrows (when week mode); right = action buttons.
- **Button hierarchy:** ghost (Call Counts, Select Pool), emerald **Auto-Generate**, gradient **Publish** as the single primary. Draft-only buttons keep their existing conditional render.

All buttons keep their exact `onClick`s and conditional visibility.

## 5. Grid — headers & shift-label column

- **Day-of-week + date headers:** sticky, `chrome-bg`; weekend cells use `chrome-bg-weekend`; **today** = `accent` date text + 3px inset bottom rule; holiday keeps amber tint + holiday name; MD·CRNA count line preserved (mono).
- **Shift-label column:** sticky left, `chrome-bg`, **white** code + 9.5px muted sub-name, **uniform** `accent` 4px left stripe for every shift type (no per-shift colors). `st.color_hex` is **no longer used** for the label — note this is an intentional drop of per-shift color (carried only as the uniform accent).

## 6. Grid — assignment cells & all states

Cells become clean text-in-cell (no pills). Every existing signal is preserved:

| State | Today | Redesign |
|---|---|---|
| Assigned | colored chip (shift color bg+text) | **plain bold-black name**, centered |
| Open call | red "OPEN" pill | plain red "OPEN" text |
| Unassigned | (was "OPEN" 11px) | em-dash `—`, `aria-label="Unassigned"` |
| Weekend | indigo 6% wash | **gray wash** `#edf1f6` |
| Holiday | amber 22% wash | unchanged (amber, distinct from weekend) |
| Today | blue left border | accent inset left border (kept) |
| Saturday divider | 2px border | kept (subtle) |
| Extra-call | blue cell bg + "EXTRA" | kept; "EXTRA" tag restyled |
| Over-par | red cell bg (tooltip only) | red cell bg **+ small "OVER" corner tag** (new, clearer; presentational) |
| Locked | 🔒 top-right | kept |
| Validation hard/soft | 8px dot | **~12px `!`/`?` badge box** (9px glyph) top-left, `aria-label` (already started in working tree) |

Hover affordance and the existing click-to-open-popover behavior are unchanged.

## 7. Virtual rows (Available / Post-Call / Off / PTO)

- Category color moves to the **label left border** (green / violet / slate / amber); label text white.
- Provider names render as **muted gray plain text** (`#64748b`, 11.5px/500), **uniform across all four categories** (PTO is *not* emphasized — explicit decision).
- A **2px rule** separates the assignment zone from the status zone; status cells sit on a faintly off-white bg so the zone reads as secondary.
- Multi-row expansion (`Available 1`, `Available 2`, …) and `alwaysRender` for PTO are preserved unchanged.
- `renderVirtualRows` keeps its signature and call sites; only its inline styles change. (The `color`/`bg` chip args are repurposed: `color` → label-border; the chip `bg` tint is dropped.)

## 8. Modals & calendar view (same language, not separately mocked)

Apply the same tokens — readable type scale, rounded elevated surfaces, soft shadows, accent + ghost button hierarchy — to:
- **`CallCountsModal`** and **`PoolSelectorModal`** (restyle shells, headers, rows, inputs, footer buttons).
- **`CalendarView`** month grid (date cells, MD/CRNA counts, over-par/holiday/today treatment consistent with the main grid's gray-weekend / amber-holiday / accent-today scheme).

No behavioral change to any of the three.

## 9. Accessibility

- `aria-label` on every icon/badge-only element (validation badge, lock, em-dash, OVER/EXTRA tags).
- `:focus-visible` ring (accent) on cells (already clickable), buttons, the search input, and provider rows.
- Verify text contrast ≥ 4.5:1 (muted virtual-row gray on white, date header text on chrome) and ≥ 3:1 for the accent stripe / large text.
- Preserve existing `title` tooltips (they add detail; not a replacement for labels).

## 10. Verification plan (screenshot every state)

1. Week view, draft status, with assignments — hierarchy of bold-black vs muted.
2. A cell each: OPEN, unassigned em-dash, hard-flag badge, soft-flag badge, over-par (OVER), extra-call (EXTRA), locked.
3. A weekend pair + a holiday column + the today column together.
4. Header in draft (all buttons) and published (Auto-Generate/Pool/Publish hidden) states.
5. Rules-health pill: clean and violations states + open dropdown.
6. Popover: empty-cell picker (with a disabled "assigned" row) and filled-cell action menu (with violations).
7. Virtual rows including a multi-row Available and the always-render empty PTO.
8. Month view and Calendar view.
9. Re-run the existing build/typecheck; confirm no logic touched (diff is styles + JSX wrappers only).

## 11. Risks & notes

- **Density vs. legibility:** 74px columns + 13px names is the "balanced" target; if real names overflow, allow ellipsis (names already `whiteSpace: nowrap`). Confirm with real roster data during verification.
- **Dropped per-shift color:** intentional. If row identity feels weak in practice, a future option is a thin shift-colored cell left-edge — not in this pass.
- **Working-tree overlap:** the already-started a11y tweaks in this file (Fragment key, em-dash, `!`/`?` badge) are **absorbed** by this design — they are the redesign's starting point, not a separate change.
- **File size:** the file stays large (no extraction). Edits will be many small inline-style changes; care needed to avoid touching logic lines.

## 12. Out of scope / future

Component extraction of the 2,626-line monolith, any interaction/UX change (picker flow, validation surfacing, view modes), wall-display density mode, and the concurrency/migration thread.
