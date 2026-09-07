// Annual tally — the calendar-year figures behind the Block Prep board's
// roster columns and the AnnualTallyCard mounted on it and on /dashboard.
//
// THIS MODULE ASSEMBLES; IT DOES NOT DERIVE. Every rule routes to the helper
// that already owns it:
//   - PTO used / sold-back      → plannerMath.plannerYearCounters, which is
//     itself dateRanges.ptoCounterStats over liveAvailabilityRows
//   - off-day BUDGET            → rulesEngine/workDays.entitledOffDays
//   - PTO netting inside a span → rulesEngine/workDays.ptoWeekdaysCovered
//   - worked-day credit         → plannerMath.computeScheduleActuals
//   - fairness bucket           → rulesEngine/shared.dayTypeBucketOn (DATE-aware:
//     a Monday holiday is a M-Th call)
//   - call split weighting      → callBurden.callBurdenWeight / parentCallCodeOf
//
// THE TALLY IS A VIEW, NEVER AN INPUT (Gabriel 2026-09-06, verbatim: "I want
// each call block to be its own calculation... it wont matter what happened the
// previous block, the number of calls given out will depend on the FTE status").
// Nothing here is read by the engine. There is deliberately NO annual call
// obligation: obligations are per-block, from the stated FTE bands, and an
// annual over/under figure would be a second obligation model running beside
// them. Call counts here are COUNTS. Only PTO and off days, which have real
// annual denominators, carry a "remaining".
//
// BLANK IS NOT ZERO. A null pto_weeks means nobody has stated the allotment and
// yields a null remaining — never 0, never negative. A stated 0 is a real zero
// (Gabriel: "0 is a real number for some of them").

import {
  plannerYearCounters,
  type PlannerAvailabilityRow,
} from './plannerMath';
import { entitledOffDays } from './rulesEngine/workDays';
import { PTO_WORK_DAYS_PER_WEEK } from './dateRanges';

/** The employment-profile fields this module needs. */
export interface TallyProfile {
  provider_id: string;
  /** Call FTE. Null on a legacy profile — treated as 0. */
  fte_value: number | null;
  /** Working-days FTE (patch43). Null means "same as fte_value". */
  work_days_fte: number | null;
  /** Annual PTO allotment in weeks. NULL means NOT STATED; 0 is a real zero. */
  pto_weeks: number | null;
}

/**
 * INVARIANT: `allotmentDays` and `remainingDays` are null exactly together —
 * both null when the allotment is unstated, both non-null when it's stated
 * (including a stated 0). Never one without the other.
 */
export interface PtoFigures {
  /** Weekdays consumed from the pool this year, sold-back days INCLUDED. */
  usedWeekdays: number;
  /** Of those, how many were also sold back (worked at premium). Informational. */
  soldWeekdays: number;
  /** pto_weeks x 5, or null when the allotment is unstated. */
  allotmentDays: number | null;
  /** allotmentDays - usedWeekdays, or null when the allotment is unstated. */
  remainingDays: number | null;
}

/**
 * One provider's annual PTO figures. `rows` may be the whole roster's
 * availability; only this provider's rows are used, and dismissed
 * (denied/canceled) rows are ignored by plannerYearCounters.
 */
export function ptoFiguresFor(
  profile: TallyProfile,
  rows: ReadonlyArray<PlannerAvailabilityRow>,
  year: number,
): PtoFigures {
  const mine = rows.filter(r => r.provider_id === profile.provider_id);
  const counters = plannerYearCounters(mine, year);
  const allotmentDays = profile.pto_weeks == null
    ? null
    : profile.pto_weeks * PTO_WORK_DAYS_PER_WEEK;
  return {
    usedWeekdays: counters.pto.weekdaysBooked,
    soldWeekdays: counters.pto.weekdaysSold,
    allotmentDays,
    remainingDays: allotmentDays == null ? null : allotmentDays - counters.pto.weekdaysBooked,
  };
}

/**
 * The off-day BUDGET: working days the provider is not obligated to work,
 * because their working-days FTE is below 1. Independent of PTO — a PTO day is
 * not an off day, it is a paid absence from an obligated day.
 *
 * Note this is NOT the same thing as `availability_type = 'unavailable'` rows,
 * which the provider profile labels "Days Off". Those are typed entries; this
 * is a contractual entitlement.
 *
 * Returns null when the FTE is unknown (null/undefined/non-finite) — an
 * unknown FTE is BLANK, not a stated zero, and must never render as "entitled
 * to every working day off" (what `entitledOffDays` would compute for fte=0).
 * This deliberately does NOT follow the rest of the codebase's convention of
 * coercing a missing FTE with `|| 1` (fteTarget.ts:606's `prof.fte_value || 1`
 * engine-pool coercion; dayShiftAutoGen.ts:367's `Number(p.fte_value) || 1`
 * day-shift cap — both also swallow a stated 0 as a side effect). Those sites
 * need SOME number to keep a generation pipeline moving; this module is a
 * read-only view with no such obligation, so it refuses to guess instead.
 */
export function offDayBudgetFor(profile: TallyProfile, workingDaysInYear: number): number | null {
  if (profile.fte_value == null) return null; // unstated — cannot say, not a guessed 0
  // fte_value is a Postgres `numeric` column and can arrive over the wire as a
  // string (e.g. "0.75"); that is why it alone is coerced here.
  // work_days_fte's string coercion happens later, inside entitledOffDays'
  // effectiveWorkDaysFte, and pto_weeks needs none (it's int4).
  const fte = Number(profile.fte_value);
  if (!Number.isFinite(fte)) return null; // unparseable — unknown, never a guessed 0
  // TODO(gabriel): a stated 0.00-FTE per diem falls through to here and gets
  // the FULL working-day count as their off-day budget (entitledOffDays(0, WD)
  // = WD). Is that the number the board should show for a per diem, or should
  // it read "n/a" instead? Open product question — ask before shipping this
  // to a per-diem-heavy site.
  return entitledOffDays(fte, workingDaysInYear, profile.work_days_fte);
}

/**
 * Groups availability rows by provider_id — splits a whole-roster payload's
 * rows into per-provider slices for callers that iterate a roster (Task 4).
 * Deliberately does NOT filter by approval_status: that predicate belongs to
 * the helpers that already own it (isDismissedAvailability, reached via
 * ptoWeekdaysCovered and plannerYearCounters/liveAvailabilityRows) — filtering
 * here too would be a second, independently-maintained copy of that status
 * rule sitting in front of them, free to drift out of sync.
 */
export function availabilityByProvider(
  rows: ReadonlyArray<PlannerAvailabilityRow>,
): Map<string, PlannerAvailabilityRow[]> {
  const out = new Map<string, PlannerAvailabilityRow[]>();
  for (const row of rows) {
    if (!row.provider_id) continue;
    const list = out.get(row.provider_id);
    if (list) list.push(row);
    else out.set(row.provider_id, [row]);
  }
  return out;
}
