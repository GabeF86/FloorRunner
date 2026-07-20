// Pure date-range helpers for the availability UI (2026-07-20).
//
// - collapseDatesToRanges: turns a calendar multi-select (arbitrary set of
//   ISO dates) into the MINIMAL set of {start,end} rows to store: contiguous
//   runs collapse into one range, isolated days become single-day ranges.
// - countDaysInYear: DISTINCT calendar-day count of range coverage clipped to
//   one calendar year. Used by the availability-tab category counters, which
//   deliberately count calendar days (weekends and weekdays alike) — the
//   engine's Mon–Fri PTO-netting math lives in workDays.ts and is a different
//   number on purpose.
//
// Kept UI-agnostic and DB-free so it can be vitest-covered directly.

import { addDays } from './rulesEngine/shared';

export interface DateRange {
  start: string; // ISO YYYY-MM-DD, inclusive
  end: string;   // ISO YYYY-MM-DD, inclusive
}

/**
 * Collapse a set of ISO dates into minimal inclusive ranges.
 * Input may be unsorted and contain duplicates; output ranges are sorted
 * ascending and non-overlapping.
 */
export function collapseDatesToRanges(dates: readonly string[]): DateRange[] {
  const sorted = [...new Set(dates)].sort();
  const out: DateRange[] = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last && addDays(last.end, 1) === d) {
      last.end = d;
    } else {
      out.push({ start: d, end: d });
    }
  }
  return out;
}

/**
 * Number of DISTINCT calendar days covered by `ranges` that fall inside
 * calendar year `year`. Overlapping ranges never double-count. Ranges are
 * clipped to [year-01-01, year-12-31]; ranges entirely outside contribute 0.
 */
export function countDaysInYear(
  ranges: ReadonlyArray<{ start_date: string; end_date: string }>,
  year: number,
): number {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const covered = new Set<string>();
  for (const r of ranges) {
    if (r.end_date < r.start_date) continue; // malformed row — count nothing
    const start = r.start_date < yearStart ? yearStart : r.start_date;
    const end = r.end_date > yearEnd ? yearEnd : r.end_date;
    for (let d = start; d <= end; d = addDays(d, 1)) covered.add(d);
  }
  return covered.size;
}
