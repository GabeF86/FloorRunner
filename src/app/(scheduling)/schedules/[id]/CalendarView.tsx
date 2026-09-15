'use client';

/* ── Calendar (month grid) view ──────────────────────────────────────────────
 * DYNAMICALLY IMPORTED (next/dynamic, ssr: false) by the schedule grid page.
 * It renders only when the user switches to `view === 'calendar'`; the default
 * view is the month grid, so for most visits this is a whole second renderer
 * that never runs. `ssr: false` is correct: it is toggled client-side and the
 * page owns the data it displays.
 *
 * `CalendarWorker` and `useMemoMonths` come with it rather than going into
 * ./gridShared — nothing else uses either. The page builds `workingByDate`
 * from an inline object literal that matches CalendarWorker structurally, so
 * it needs no import of the type.
 *
 * Moved verbatim out of page.tsx — same props, same logic, same rendering.
 * ───────────────────────────────────────────────────────────────────────── */

import { useMemo } from 'react';
import { gridTokens, manualHighlightTitle } from './gridTheme';
import type { HighlightColor } from '@/lib/highlightColor';
import {
  DAYS_SHORT, parseDate, getDayOfWeek, colorWithAlpha, type Holiday,
} from './gridShared';

/* ── Grid ink (theme-invariant) ──────────────────────────────────────────────
 * The calendar draws on the SAME two surfaces the month grid does, and neither
 * follows the app theme: gridTokens.chrome is #1e293b and gridTokens.bodyCell
 * is #ffffff in BOTH light and dark (gridTheme.ts owns that decision). So ink
 * drawn here cannot come from --warn / --blue / --danger: those flip with the
 * theme and would land deep-amber-on-near-black one way, or pale-amber-on-white
 * the other. The values below are the ones gridTheme does not already name,
 * stated once rather than inline, and chosen to clear AA on the surface each
 * one actually sits on. Mirrors the identical block in page.tsx — the two grids
 * share a vocabulary but not a module (gridTheme.ts is frozen). */
const GRID_INK = {
  /** Weekend day-of-week label on chrome — deliberately a step brighter than
   *  gridTokens.chromeMuted so Sat/Sun read first in the header. */
  weekendChrome: '#cbd5e1',
  /** Holiday ink on the pale holiday wash (gridTokens.bodyHoliday, amber at
   *  0.22 over white). The amber itself is ~1.6:1 there and unreadable; this
   *  deep amber is ~6:1. Same value as the light-theme --warn, fixed here
   *  because the cell under it never goes dark. */
  holiday: '#b45309',
  /** Over-obligation name on the over-par wash — the deeper red the month
   *  grid's OVER tag uses, rather than the wash's own #ef4444 (~3.3:1 at this
   *  text size). */
  over: '#b91c1c',
  /** The grid's sky accent, in the deep form a white body cell needs.
   *  gridTokens.accentStrong is ~2.9:1 on gridTokens.bodyCell, which is fine
   *  for a 2px outline and not fine for 9–12px text; this is ~6.4:1 and is the
   *  same deep blue the month grid's EXTRA tag uses. Carries the today marker
   *  and the head-count chip. */
  accentOnBody: '#0369a1',
} as const;

/* ── Calendar (month grid) View ──────────────────────────────────────────── */

interface CalendarWorker {
  assignmentId: string;
  providerId: string;
  last_name: string;
  initials: string;
  shortName: string;
  shiftCode: string;
  color: string;
  providerType: string;
  countsTowardCount: boolean;
  // Hand-set billing mark (patch42) carried through so the calendar lens shows
  // the same marks the month/week grid does. A mark that vanished when the
  // user switched view mode would read as data loss.
  highlight: HighlightColor | null;
}

export function CalendarView({
  allDates,
  monthOffset,
  onPrevMonth,
  onNextMonth,
  mdCountByDate,
  crnaCountByDate,
  workingByDate,
  overParAssignmentIds,
  holidayMap,
  todayStr,
}: {
  allDates: string[];
  monthOffset: number;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  mdCountByDate: Record<string, number>;
  crnaCountByDate: Record<string, number>;
  workingByDate: Record<string, CalendarWorker[]>;
  overParAssignmentIds: Set<string>;
  holidayMap: Record<string, Holiday>;
  todayStr: string;
}) {
  // overParAssignmentIds is consumed in the working-list rendering below.
  // Build the list of (year, month) pairs the schedule touches so prev/next
  // never strays outside the block. Hooks must run unconditionally — guard
  // with early-return AFTER all hook calls.
  const monthsTouched = useMemoMonths(allDates);

  if (allDates.length === 0 || monthsTouched.length === 0) {
    return <div style={{ padding: 40, color: 'var(--text-muted)' }}>No dates in this schedule.</div>;
  }

  const idx = Math.max(0, Math.min(monthOffset, monthsTouched.length - 1));
  const { year, month } = monthsTouched[idx];
  const hasPrev = idx > 0;
  const hasNext = idx < monthsTouched.length - 1;

  const inScheduleSet = new Set(allDates);

  // First Sunday on or before the 1st of the month → start of grid.
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const firstDow = firstOfMonth.getUTCDay();
  const gridStart = new Date(firstOfMonth);
  gridStart.setUTCDate(firstOfMonth.getUTCDate() - firstDow);

  // 6 rows × 7 cols = 42 cells, enough for any month layout.
  const cells: Array<{ dateStr: string; inMonth: boolean; inSchedule: boolean }> = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setUTCDate(gridStart.getUTCDate() + i);
    const ds = d.toISOString().slice(0, 10);
    cells.push({
      dateStr: ds,
      inMonth: d.getUTCMonth() === month && d.getUTCFullYear() === year,
      inSchedule: inScheduleSet.has(ds),
    });
  }
  // Trim trailing all-out-of-month row if unused for a tighter layout.
  const lastRowUsed = cells.slice(35, 42).some(c => c.inMonth);
  const visibleCells = lastRowUsed ? cells : cells.slice(0, 35);

  const monthName = firstOfMonth.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });

  return (
    <div style={{
      flex: 1, overflow: 'auto', borderRadius: 8,
      border: '1px solid var(--border)',
      background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column',
    }}>
      {/* Month nav bar. Grid CHROME, not a themed surface — it sits directly on
          top of the weekday header below, which is gridTokens.chrome, and the
          two used to be a shade apart for no reason. Everything in it therefore
          takes chrome tokens: the text used to be var(--text-muted), which is
          #475569 in the light theme and effectively invisible on this bar. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px', borderBottom: '1px solid ' + gridTokens.chromeBorder,
        background: gridTokens.chrome, color: gridTokens.chromeText,
      }}>
        <MonthNavButton onClick={onPrevMonth} enabled={hasPrev} label="Previous month" glyph={'←'} />
        <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: '0.02em' }}>
          {monthName} {year}
        </div>
        <MonthNavButton onClick={onNextMonth} enabled={hasNext} label="Next month" glyph={'→'} />
      </div>

      {/* Weekday header */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
        background: gridTokens.chrome, borderBottom: '1px solid ' + gridTokens.chromeBorder,
      }}>
        {DAYS_SHORT.map((d, i) => {
          const isWeekend = i === 0 || i === 6;
          return (
            <div key={d} style={{
              padding: '8px 4px', textAlign: 'center', fontSize: 11, fontWeight: 700,
              color: isWeekend ? GRID_INK.weekendChrome : gridTokens.chromeMuted,
              textTransform: 'uppercase', letterSpacing: '0.05em',
              borderRight: i < 6 ? '1px solid ' + gridTokens.chromeBorder : 'none',
            }}>
              {d}
            </div>
          );
        })}
      </div>

      {/* Month grid */}
      <div style={{
        flex: 1, display: 'grid',
        gridTemplateColumns: 'repeat(7, 1fr)',
        gridAutoRows: 'minmax(112px, 1fr)',
      }}>
        {visibleCells.map((cell) => {
          const date = cell.dateStr;
          const dow = getDayOfWeek(date);
          const isWeekend = dow === 0 || dow === 6;
          const holiday = holidayMap[date];
          const isToday = date === todayStr;
          const workers = cell.inSchedule ? (workingByDate[date] || []) : [];
          const mdCount = cell.inSchedule ? (mdCountByDate[date] ?? 0) : 0;
          const crnaCount = cell.inSchedule ? (crnaCountByDate[date] ?? 0) : 0;
          const dayNum = parseDate(date).getDate();

          const cellBg = !cell.inMonth
            ? 'rgba(15,23,42,0.4)'
            : holiday
              ? gridTokens.bodyHoliday
              : isWeekend
                ? gridTokens.bodyWeekend
                : gridTokens.bodyCell;

          return (
            <div key={date} style={{
              padding: 6,
              // gridTokens.line — the month grid's own hairline. var(--border)
              // is #1e3a5f in the dark theme, which drew a navy lattice across
              // cells that are white whatever the theme is.
              borderRight: '1px solid ' + gridTokens.line,
              borderBottom: '1px solid ' + gridTokens.line,
              background: cellBg,
              opacity: !cell.inMonth ? 0.4 : !cell.inSchedule ? 0.55 : 1,
              display: 'flex', flexDirection: 'column', gap: 4,
              overflow: 'hidden',
              outline: isToday ? ('2px solid ' + gridTokens.accentStrong) : 'none',
              outlineOffset: -2,
            }}>
              {/* Day number + holiday tag + counts */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 4 }}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{
                    fontSize: 12.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                    // gridTokens.name, not var(--text): the cell under it is
                    // gridTokens.bodyCell (#ffffff) in both themes, so the
                    // dark-theme --text (#e2e8f0) would be white-on-white.
                    color: isToday ? GRID_INK.accentOnBody : holiday ? GRID_INK.holiday : gridTokens.name,
                  }}>
                    {dayNum}
                  </span>
                  {holiday && (
                    <span style={{
                      fontSize: 9, color: GRID_INK.holiday, fontWeight: 600,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      maxWidth: 120,
                    }} title={holiday.holiday_name}>
                      {holiday.holiday_name}
                    </span>
                  )}
                </div>
                {cell.inSchedule && (mdCount > 0 || crnaCount > 0) && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
                    <span title="MDs working (weekday C1 excluded)" style={{
                      fontSize: 10, fontWeight: 800,
                      color: GRID_INK.accentOnBody,
                      background: colorWithAlpha(GRID_INK.accentOnBody, 0.1),
                      padding: '1px 6px', borderRadius: 999,
                      fontFamily: 'var(--font-mono), ui-monospace, monospace',
                      fontVariantNumeric: 'tabular-nums',
                    }}>
                      {mdCount} MD
                    </span>
                    {crnaCount > 0 && (
                      <span title="CRNAs working" style={{
                        fontSize: 9, fontWeight: 700,
                        // statusName, not chromeMuted: this sits on a white
                        // body cell, where #94a3b8 is ~2.5:1.
                        color: gridTokens.statusName,
                        fontFamily: 'var(--font-mono), ui-monospace, monospace',
                        fontVariantNumeric: 'tabular-nums',
                      }}>
                        {crnaCount} CRNA
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Working list — last name preferred, fallback to initials,
                  then short_display_name if both blank. */}
              {workers.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1, overflow: 'hidden' }}>
                  {workers.map((w, wi) => {
                    const display = (w.last_name && w.last_name.trim())
                      || (w.initials && w.initials.trim())
                      || w.shortName;
                    const isOverPar = overParAssignmentIds.has(w.assignmentId);
                    // Manual mark out-ranks the over-par wash here for the same
                    // reason it does in the grid: over-par is computed, this is
                    // hand-set. The chip keeps the inset ring so the two reds
                    // stay tellable apart at a glance.
                    const marked = w.highlight;
                    return (
                      <div
                        key={wi}
                        title={
                          (marked ? manualHighlightTitle(marked) + ' ' : '') +
                          (isOverPar ? 'Past rounded call obligation — one of their extra calls. ' : '') +
                          `${w.shortName} · ${w.shiftCode}`
                        }
                        style={{
                          display: 'flex', alignItems: 'center', gap: 4,
                          fontSize: 10, lineHeight: 1.25,
                          // gridTokens.name, not var(--text) — see the day
                          // number above: these cells are white in both themes.
                          color: gridTokens.name,
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          background: marked
                            ? gridTokens.manualHighlight[marked]
                            : isOverPar ? gridTokens.overPar : 'transparent',
                          boxShadow: marked ? gridTokens.manualHighlightOutline : undefined,
                          borderRadius: 3,
                          padding: (marked || isOverPar) ? '0 2px' : 0,
                        }}
                      >
                        <span style={{
                          flexShrink: 0, fontSize: 8, fontWeight: 700,
                          padding: '1px 4px', borderRadius: 3,
                          background: colorWithAlpha(w.color, 0.18),
                          color: w.color,
                          letterSpacing: '0.02em',
                          fontFamily: 'var(--font-mono), ui-monospace, monospace',
                        }}>
                          {w.shiftCode}
                        </span>
                        <span style={{
                          fontWeight: w.providerType === 'physician' ? 600 : 500,
                          overflow: 'hidden', textOverflow: 'ellipsis',
                          color: isOverPar ? GRID_INK.over : gridTokens.name,
                        }}>
                          {display}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* Month prev/next. Its own component because the affordance is three states —
 * rest, hover, press — and a bare <button> with an inline `background` cannot
 * express any of them from CSS: an inline background outranks a class :hover,
 * so a .fr-btn rule here would be dead on arrival. Hover and press are
 * therefore applied inline too, which is the one arrangement that works.
 * The keyboard ring is NOT handled here — this renders inside the page's
 * .schedule-builder-page scope, which already carries a :focus-visible rule. */
function MonthNavButton({
  onClick, enabled, label, glyph,
}: { onClick: () => void; enabled: boolean; label: string; glyph: string }) {
  const rest = 'transparent';
  const hover = 'rgba(255,255,255,0.08)';   // chrome is dark in both themes
  const press = 'rgba(255,255,255,0.14)';
  return (
    <button
      onClick={onClick}
      disabled={!enabled}
      aria-label={label}
      title={enabled ? label : 'No further months in this schedule'}
      style={{
        width: 30, height: 30, borderRadius: 'var(--radius-sm)',
        border: '1px solid ' + gridTokens.chromeBorder,
        background: rest, color: gridTokens.chromeText,
        opacity: enabled ? 1 : 0.35,
        cursor: enabled ? 'pointer' : 'not-allowed',
        fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background var(--dur-fast) var(--ease-out),'
          + ' transform var(--dur-instant) var(--ease-out)',
      }}
      onMouseEnter={e => { if (enabled) e.currentTarget.style.background = hover; }}
      onMouseLeave={e => {
        e.currentTarget.style.background = rest;
        e.currentTarget.style.transform = 'none';
      }}
      onMouseDown={e => { if (enabled) { e.currentTarget.style.background = press; e.currentTarget.style.transform = 'translateY(1px)'; } }}
      onMouseUp={e => { if (enabled) { e.currentTarget.style.background = hover; e.currentTarget.style.transform = 'none'; } }}
    >
      {glyph}
    </button>
  );
}

// Walks the schedule date list and returns one entry per (year, month) the
// schedule touches. Order = chronological. Drives the calendar's prev/next
// nav so navigation never strays outside the block.
function useMemoMonths(allDates: string[]): Array<{ year: number; month: number }> {
  return useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ year: number; month: number }> = [];
    for (const d of allDates) {
      const dt = parseDate(d);
      const key = `${dt.getFullYear()}-${dt.getMonth()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ year: dt.getFullYear(), month: dt.getMonth() });
    }
    return out;
  }, [allDates]);
}
