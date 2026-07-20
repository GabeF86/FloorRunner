// Pure date-range helpers for the availability UI (2026-07-20).
//
// - collapseDatesToRanges: turns a calendar multi-select (arbitrary set of
//   ISO dates) into the MINIMAL set of {start,end} rows to store: contiguous
//   runs collapse into one range, isolated days become single-day ranges.
// - countDaysInYear: DISTINCT calendar-day count of range coverage clipped to
//   one calendar year. Used by the Sell-Back / Days Off / Other Leave category
//   counters, which deliberately count calendar days (weekends and weekdays
//   alike).
// - ptoCounterStats: the PTO counter's numbers — WEEKDAYS (Mon–Fri).
//   Physician PTO banks are debited in working days, so the headline number a
//   chief compares to the annual entitlement is weekdaysBooked. SELL-BACK
//   SEMANTICS (Gabriel 2026-07-20): a sold-back day is STILL DEDUCTED from
//   the PTO pool — the provider burns the PTO day AND works it at premium.
//   So the headline INCLUDES sold-back days; weekdaysSold is reported
//   alongside as information. (The engine's ptoWeekdaysCovered netting in
//   workDays.ts is a DIFFERENT question — whether the day excuses the
//   work-days requirement — and correctly excludes sold-back days there:
//   they are worked, so still owed.)
//   Deliberately simpler than the engine in two stated ways: no major-holiday
//   exclusion (needs a DB read; the scheduler's working-days budget is the
//   finer number), and PTO rows count on their RAW entered dates (no weekend
//   bookend — the bookend blocks scheduling, it doesn't debit the bank).
//
// Kept UI-agnostic and DB-free so it can be vitest-covered directly.

import { addDays, dayOfWeekUTC } from './rulesEngine/shared';

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
 * The DISTINCT calendar days covered by `ranges` that fall inside calendar
 * year `year`. Overlapping ranges never double-count. Ranges are clipped to
 * [year-01-01, year-12-31]; ranges entirely outside contribute nothing.
 */
export function coveredDaysInYear(
  ranges: ReadonlyArray<{ start_date: string; end_date: string }>,
  year: number,
): Set<string> {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const covered = new Set<string>();
  for (const r of ranges) {
    if (r.end_date < r.start_date) continue; // malformed row — count nothing
    const start = r.start_date < yearStart ? yearStart : r.start_date;
    const end = r.end_date > yearEnd ? yearEnd : r.end_date;
    for (let d = start; d <= end; d = addDays(d, 1)) covered.add(d);
  }
  return covered;
}

/** Count of DISTINCT calendar days covered inside `year` (see coveredDaysInYear). */
export function countDaysInYear(
  ranges: ReadonlyArray<{ start_date: string; end_date: string }>,
  year: number,
): number {
  return coveredDaysInYear(ranges, year).size;
}

/** Count of weekdays (Mon–Fri) among `dates` (ISO YYYY-MM-DD). */
export function countWeekdays(dates: Iterable<string>): number {
  let n = 0;
  for (const d of dates) {
    const dow = dayOfWeekUTC(d);
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

/** The PTO category counter's numbers for one calendar year. */
export interface PtoCounterStats {
  /** Weekdays covered by PTO rows in the year — THE headline: PTO consumed
   *  from the pool, INCLUDING sold-back days (sell-back never refunds PTO). */
  weekdaysBooked: number;
  /** PTO-covered weekdays also covered by a sell-back row (worked at premium,
   *  still deducted from the pool). Informational, shown alongside. */
  weekdaysSold: number;
  /** weekdaysBooked − weekdaysSold: days actually spent OFF. Not the pool
   *  debit — kept for display of "days off vs sold" breakdowns. */
  weekdaysNet: number;
  /** Calendar days covered by PTO rows (weekends incl.), full coverage. */
  calendarBooked: number;
  /** Calendar days covered by PTO minus sell-back-overridden dates. */
  calendarNet: number;
}

/**
 * PTO counter math, net of sell-back: a date covered by BOTH a PTO row and a
 * sell-back row is a working date (the chief bought it back) and must not be
 * charged as PTO taken. Standalone sell-back coverage (no PTO underneath) is
 * inherently ignored here — subtraction only ever removes PTO-covered dates.
 * Callers pass LIVE (non-dismissed) rows only.
 */
export function ptoCounterStats(
  ptoRanges: ReadonlyArray<{ start_date: string; end_date: string }>,
  sellbackRanges: ReadonlyArray<{ start_date: string; end_date: string }>,
  year: number,
): PtoCounterStats {
  const pto = coveredDaysInYear(ptoRanges, year);
  const sell = coveredDaysInYear(sellbackRanges, year);
  const sold = [...pto].filter(d => sell.has(d));
  const net = [...pto].filter(d => !sell.has(d));
  const weekdaysBooked = countWeekdays(pto);
  const weekdaysSold = countWeekdays(sold);
  return {
    weekdaysBooked,
    weekdaysSold,
    weekdaysNet: weekdaysBooked - weekdaysSold,
    calendarBooked: pto.size,
    calendarNet: net.length,
  };
}
