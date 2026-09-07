// Block Prep board VIEW logic — the decisions the board makes that could be
// wrong, kept next to a test. The page component is markup over these.
// (vitest runs environment:'node' with no jsdom, so a component is not
// unit-testable; same split blockTargetsPanel.ts established.)
//
// The rules that matter here:
//
// 1. BLANK IS NOT ZERO, IN BOTH DIRECTIONS. A null PTO allotment renders an
//    em-dash and a "not stated" caption; a typed 0 renders "0". Parsing goes
//    the same way: blank -> null, "0" -> 0. Collapsing either into the other
//    is the bug this board exists to stop.
//
// 2. NEVER SHOW A NUMBER THAT WASN'T COUNTED. Off days used is null when no
//    published block covers the year, and the label says so rather than
//    printing a 0 that reads as "took no days off".
//
// 3. AN OVERDRAWN BALANCE IS SHOWN, NOT CLAMPED. Someone 5 days past their
//    allotment reads "5 over", because that is a thing a chief needs to see.

// CoveredSpanInfo is annualTally's exported span shape { start, end,
// workingDays, segments }. Imported, never restated — `segments` carries the
// individual published blocks so a gapped range can never render as
// continuous coverage.
import type {
  CallCount, CoveredSpanInfo, OffDayBudget, PtoFigures,
} from './annualTally';

export interface RosterRow {
  provider_id: string;
  display_name: string;
  last_name: string;
  fte_value: number | null;
  work_days_fte: number | null;
  pto_weeks: number | null;
  call_taker: boolean;
  partial_call_taker: boolean;
  pto: PtoFigures;
  /** Tagged union — 'none' (a full-timer owes every working day) and
   *  'not-applicable' (a per diem owes none) are different facts and render
   *  differently. Never guessed from a missing FTE. */
  offDayBudget: OffDayBudget;
  offDaysUsed: number | null;
  callCounts: CallCount[];
  callTotal: number;
}

/** FTE descending, then last name. A null FTE sorts last, not first. */
export function sortRosterRows(rows: ReadonlyArray<RosterRow>): RosterRow[] {
  return [...rows].sort((a, b) => {
    const fa = a.fte_value ?? -1;
    const fb = b.fte_value ?? -1;
    if (fa !== fb) return fb - fa;
    return a.last_name.localeCompare(b.last_name);
  });
}

/** The allotment cell. Em-dash for unstated; "0" for a real zero. */
export function allotmentText(ptoWeeks: number | null): string {
  return ptoWeeks == null ? '—' : String(ptoWeeks);
}

/** The PTO cell caption. */
export function remainingText(pto: PtoFigures): string {
  const sold = pto.soldWeekdays > 0 ? ` (incl. ${pto.soldWeekdays} sold back)` : '';
  // allotmentDays and remainingDays are null together or not at all — the
  // invariant PtoFigures documents. No `?? 0` fallback here: a fallback could
  // only fire if that invariant were broken, and it would silently print
  // "0 left" instead of failing loudly.
  if (pto.allotmentDays == null || pto.remainingDays == null) {
    return `${pto.usedWeekdays} used${sold} · allotment not stated`;
  }
  const rem = pto.remainingDays;
  const tail = rem < 0 ? `${Math.abs(rem)} over` : `${rem} left`;
  return `${pto.usedWeekdays} of ${pto.allotmentDays} used${sold} · ${tail}`;
}

/**
 * The off-days cell. Four states, and the two that both mean "zero days" are
 * deliberately different strings: a 1.0 FTE has NO off days because they owe
 * every working day; a per diem has none because they owe nothing at all, so
 * the concept doesn't apply (Gabriel 2026-09-06: "n/a for gorelick").
 *
 * `used === 0` is a GENUINE counted zero here, not "nothing was counted" —
 * annualTally.computeAnnualTally returns `offDaysUsed: null` (never 0) when
 * no published block covers the year or a covered block clips to zero
 * working days, so by the time a literal `0` reaches this function it means
 * a real span was examined and the provider took none of their budgeted off
 * days across it. "0 of N used" is therefore the correct, honest string —
 * pinned by a test, not left to drift into a "not counted" reading.
 */
export function offDaysText(budget: OffDayBudget, used: number | null): string {
  switch (budget.kind) {
    case 'unknown':        return 'FTE not stated';
    case 'not-applicable': return 'n/a';
    case 'none':           return 'none';
    case 'days':
      return used == null ? `${budget.days} budgeted` : `${used} of ${budget.days} used`;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
}

/**
 * The honesty caveat under the off-days column. Off days can only be counted
 * where a schedule exists; this names the span so nobody reads the figure as a
 * full-year number.
 *
 * THE GAP CASE IS THE WHOLE POINT. When the year's published blocks are
 * disjoint — a draft block sitting between two published ones is enough — the
 * start–end range OVERSTATES coverage badly: two blocks at either end of the
 * year read as "Jan 5 – Dec 20" while covering half the working days. So the
 * label must say how many blocks it counted whenever there is more than one
 * segment, and never present a gapped range as a continuous one.
 */
export function coveredSpanLabel(span: CoveredSpanInfo | null): string {
  if (!span) {
    return 'No published blocks this year — off days show the budget only, with nothing counted against it.';
  }
  // A published block that contains no working days (e.g. one clipped to a
  // single major holiday) is NOT the same as nothing being published, and must
  // not read as "0 days off taken".
  if (span.workingDays === 0) {
    return 'The published block covers no working days this year — nothing has been counted against the off-day budget.';
  }
  const start = shortDate(span.start).replace(/, \d{4}$/, '');
  const range = `${start} – ${shortDate(span.end)}`;
  if (span.segments.length > 1) {
    return `Off days counted across ${span.segments.length} published blocks only, with gaps between them: `
      + `${range} (${span.workingDays} working days counted).`;
  }
  return `Off days counted across published blocks only: ${range} (${span.workingDays} working days).`;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Parse an FTE cell. `max` is 2 for call FTE (FTE_MAX — the odd partner working
 * two jobs) and 1 for working-days FTE (nobody owes more days than the block
 * has). `allowBlank` is true only for working-days FTE, where blank means
 * "same as call FTE".
 */
export function parseFteInput(
  raw: string, opts: { allowBlank: boolean; max: number },
): ParseResult<number | null> {
  const s = raw.trim();
  if (s === '') {
    return opts.allowBlank
      ? { ok: true, value: null }
      : { ok: false, error: 'FTE is required' };
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'Must be a non-negative number' };
  if (n > opts.max) return { ok: false, error: `Must be ${opts.max} or less` };
  return { ok: true, value: n };
}

/** Parse the PTO allotment cell. Blank -> null (not stated); "0" -> 0 (real). */
export function parseAllotmentInput(raw: string): ParseResult<number | null> {
  const s = raw.trim();
  if (s === '') return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return { ok: false, error: 'Must be a whole number of weeks' };
  return { ok: true, value: n };
}
