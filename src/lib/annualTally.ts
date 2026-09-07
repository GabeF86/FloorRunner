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
  assignmentFills,
  type PlannerAvailabilityRow,
  type PlannerSlotRow,
} from './plannerMath';
import { entitledOffDays } from './rulesEngine/workDays';
import { PTO_WORK_DAYS_PER_WEEK } from './dateRanges';
import { dayTypeBucketOn } from './rulesEngine/shared';
import {
  callBurdenWeight,
  parentCallCodeOf,
  type BurdenWeighted,
  type ParentCoded,
} from './callBurden';
import { embedArray } from './embed';
import { derivedDayTypeFor } from './templateSlots';

/** The employment-profile fields this module needs. */
export interface TallyProfile {
  provider_id: string;
  /** Call FTE. NULL means NOT STATED — offDayBudgetFor returns null rather
   *  than guessing; it is never treated as 0. */
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
  // Mirrors effectiveWorkDaysFte's guard (workDays.ts:193) so the two never
  // diverge on what counts as garbage: non-finite OR negative. Not reachable
  // through the app today (validateAndSplitPatch range-checks fte_value, plus
  // a DB CHECK) — defence-in-depth, not a live bug. Without the `< 0` half, a
  // negative FTE would flow into entitledOffDays and invert its subtraction
  // (fte=-1, WD=250 → 250 - round(-250) = 500 — twice the working year).
  if (!Number.isFinite(fte) || fte < 0) return null; // unparseable/negative — unknown, never a guessed 0
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

/** The shift-type columns the weighting needs, keyed by code. */
export type TallyShiftType = BurdenWeighted & ParentCoded;

export interface CallCount {
  /** Fairness bucket: weekday | friday | saturday | sunday. */
  bucket: string;
  /** PARENT call code — a split segment counts under the call it is part of. */
  code: string;
  /** Weighted: a 12h segment is 0.5, a whole call is 1. */
  count: number;
}

/**
 * Weighted per-provider call counts for one calendar year, keyed by provider id.
 *
 * `slots` MUST already be scoped to published versions at the site of interest
 * — this function does not know about version status and will happily count a
 * draft. The route is responsible for that (clinical invariant 3).
 *
 * Attribution is by `slot_date`, so a block straddling New Year splits between
 * the two years (Gabriel 2026-09-06: "a call on 1/5 counts toward 2027").
 */
export function annualCallCounts(
  slots: ReadonlyArray<PlannerSlotRow>,
  shiftTypes: ReadonlyMap<string, TallyShiftType>,
  year: number,
): Map<string, CallCount[]> {
  const prefix = `${year}-`;
  const byProvider = new Map<string, Map<string, CallCount>>();

  for (const slot of slots) {
    const st = slot.shift_types;
    if (!st || st.category !== 'call') continue;
    if (!slot.slot_date.startsWith(prefix)) continue;

    const meta = shiftTypes.get(st.code);
    // Stored derived_day_type wins; a legacy row without one falls back to the
    // single-homed date->day-type derivation, NOT to a hardcoded 'weekday'.
    // dayTypeBucket only consults the date for HOLIDAY types (shared.ts:415),
    // so a wrong day type wins outright — a hardcoded 'weekday' would charge a
    // Saturday call to the M-Th bucket. Holidays need not be threaded here:
    // dayTypeBucketOn already re-buckets a holiday to its day of the week, so
    // the DOW derivation lands on the same answer.
    const dayType = slot.derived_day_type || derivedDayTypeFor(slot.slot_date, undefined);
    const bucket = dayTypeBucketOn(dayType, slot.slot_date);
    const code = parentCallCodeOf(st.code, meta);
    const weight = callBurdenWeight(meta);

    // embedArray is the single home for the slot->assignments embed shape
    // (see src/lib/embed.ts — PostgREST returns an object or an array
    // depending on the UNIQUE constraint). Never re-inline that normalization.
    for (const a of embedArray(slot.assignments)) {
      if (!assignmentFills(a)) continue;
      const pid = a.provider_id as string;
      let counts = byProvider.get(pid);
      if (!counts) { counts = new Map(); byProvider.set(pid, counts); }
      const key = `${bucket}|${code}`;
      const cur = counts.get(key);
      if (cur) cur.count += weight;
      else counts.set(key, { bucket, code, count: weight });
    }
  }

  const out = new Map<string, CallCount[]>();
  for (const [pid, counts] of byProvider) {
    out.set(pid, [...counts.values()].sort(
      (a, b) => a.bucket.localeCompare(b.bucket) || a.code.localeCompare(b.code)));
  }
  return out;
}

/** Weighted total across every bucket — the roster's "Calls this year" cell. */
export function callTotal(counts: ReadonlyArray<CallCount>): number {
  return counts.reduce((n, c) => n + c.count, 0);
}
