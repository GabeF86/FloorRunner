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
  liveAvailabilityRows,
  plannerYearCounters,
  type PlannerAvailabilityRow,
} from './plannerMath';
import { entitledOffDays } from './rulesEngine/workDays';

// Working days consumed per week of PTO. Deliberately a local constant rather
// than an import from gridCalculator/providerProfile.ts, which holds its own
// copy for its simulator: CLAUDE.md keeps gridCalculator a sibling engine that
// does not share code with the scheduling path, and one definitional integer is
// a smaller cost than crossing that boundary.
export const PTO_WORK_DAYS_PER_WEEK = 5;

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
 */
export function offDayBudgetFor(profile: TallyProfile, workingDaysInYear: number): number {
  return entitledOffDays(
    Number(profile.fte_value ?? 0), workingDaysInYear, profile.work_days_fte);
}

/** Live (non-dismissed) rows for one provider — shared by the callers below. */
export function liveRowsFor(
  providerId: string, rows: ReadonlyArray<PlannerAvailabilityRow>,
): PlannerAvailabilityRow[] {
  return liveAvailabilityRows(rows.filter(r => r.provider_id === providerId));
}
