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
//     a Monday holiday is a M-Th call), via plannerMath.computeScheduleActuals
//     — the bucket arrives pre-computed on its ProviderActuals output; this
//     module does not call dayTypeBucketOn itself
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
  computeScheduleActuals,
  plannerYearCounters,
  rangeComposition,
  type PlannerAvailabilityRow,
  type PlannerHoliday,
  type ProviderActuals,
} from './plannerMath';
import {
  effectiveWorkDaysFte,
  entitledOffDays,
  ptoWeekdaysCovered,
  PTO_NETTING_TYPES,
} from './rulesEngine/workDays';
import { BLOCKING_AVAIL, isDismissedAvailability } from './rulesEngine/shared';
import { PTO_WORK_DAYS_PER_WEEK } from './dateRanges';
import {
  callBurdenWeight,
  parentCallCodeOf,
  type BurdenWeighted,
  type ParentCoded,
} from './callBurden';

/** The employment-profile fields this module needs. */
export interface TallyProfile {
  provider_id: string;
  /** Call FTE. NULL means NOT STATED — offDayBudgetFor returns
   *  { kind: 'unknown' } rather than guessing; it is never treated as 0. */
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
 * The off-day BUDGET, as a discriminated union rather than a bare number
 * (Gabriel 2026-09-06). Four states that must never collapse into each other:
 *   - `days`           a real off-day entitlement.
 *   - `none`           owes every working day — a full-timer (or a >1 FTE
 *                       "odd partner working two jobs") has NO off days
 *                       because they owe everything.
 *   - `not-applicable` owes NO working days at all — a per diem's off-day
 *                       BUDGET concept doesn't apply. The opposite fact from
 *                       `none`: nothing to owe, not everything owed.
 *   - `unknown`         fte_value null, non-finite or negative — a data gap
 *                       worth fixing, not a correct answer.
 * `offDaysText` and every other consumer is forced by the compiler to handle
 * all four, so a per diem and a full-timer can never both render as "0".
 */
export type OffDayBudget =
  | { kind: 'days'; days: number }
  | { kind: 'none' }
  | { kind: 'not-applicable' }
  | { kind: 'unknown' };

/**
 * The off-day BUDGET: working days the provider is not obligated to work,
 * because their working-days FTE is below 1. Independent of PTO — a PTO day is
 * not an off day, it is a paid absence from an obligated day.
 *
 * Note this is NOT the same thing as `availability_type = 'unavailable'` rows,
 * which the provider profile labels "Days Off". Those are typed entries; this
 * is a contractual entitlement.
 *
 * BRANCHES ON THE COMPUTED DAYS, NOT ON FTE THRESHOLDS — except
 * `not-applicable`, which is about OWING NOTHING and so is the one state that
 * keys off the FTE itself. An earlier draft specified `days`/`none` by FTE
 * range ("0 < eff < 1" / "eff is 1") and that is wrong twice over: a call FTE
 * of 1.5 (legal — FTE_MAX is 2, for a partner working two jobs) matches no
 * band at all, and a work_days_fte of 0.999 rounds to a zero entitlement
 * while still matching "0 < eff < 1", rendering `{ kind: 'days', days: 0 }` —
 * "0 budgeted", the exact string this ruling exists to abolish. Branching on
 * `entitledOffDays`'s answer instead sends both of those to `none`.
 *
 * Returns `{ kind: 'unknown' }` when the FTE is unknown (null/undefined/
 * non-finite/negative) — an unknown FTE is BLANK, not a stated zero, and must
 * never render as "entitled to every working day off" (what `entitledOffDays`
 * would compute for fte=0, which is exactly what `not-applicable` replaces).
 * This deliberately does NOT follow the rest of the codebase's convention of
 * coercing a missing FTE with `|| 1` (fteTarget.ts:606's `prof.fte_value || 1`
 * engine-pool coercion; dayShiftAutoGen.ts:367's `Number(p.fte_value) || 1`
 * day-shift cap — both also swallow a stated 0 as a side effect). Those sites
 * need SOME number to keep a generation pipeline moving; this module is a
 * read-only view with no such obligation, so it refuses to guess instead.
 */
export function offDayBudgetFor(profile: TallyProfile, workingDaysInYear: number): OffDayBudget {
  if (profile.fte_value == null) return { kind: 'unknown' }; // unstated — cannot say, not a guessed 0
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
  if (!Number.isFinite(fte) || fte < 0) return { kind: 'unknown' }; // unparseable/negative
  // 'not-applicable' is about OWING NOTHING, so — and ONLY this branch — keys
  // off the FTE itself rather than the computed answer. Routed through
  // effectiveWorkDaysFte (never fte_value directly): Hussain is call FTE 0.70
  // with working-days FTE 1.00 and must NOT land here.
  if (effectiveWorkDaysFte(fte, profile.work_days_fte) === 0) return { kind: 'not-applicable' };
  // Everything else keys off the ANSWER, so a >1 FTE and a rounds-to-zero
  // budget both land in 'none' rather than rendering "0 budgeted".
  const days = entitledOffDays(fte, workingDaysInYear, profile.work_days_fte);
  return days === 0 ? { kind: 'none' } : { kind: 'days', days };
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
  /**
   * Weighted: a 12h segment is 0.5, a whole call is 1. Accumulated from
   * possibly-repeating fractional weights (three 8h thirds at 0.3333 each
   * sum to 0.9999, not 1) — this is a RAW FLOAT. Render it through
   * `callBurden.formatCallWeight`; never compare it to a whole number
   * directly.
   */
  count: number;
}

/**
 * Weighted per-provider call counts, folded ON TOP of
 * `plannerMath.computeScheduleActuals`'s raw per-code counts — this function
 * does not walk slot rows itself. `computeScheduleActuals` already owns the
 * fill predicate, the assignments-embed normalization and the date-aware
 * fairness bucketing (`dayTypeBucketOn`); re-implementing any of those here
 * would be a second copy free to drift from it (see the CROSS-LINK note at
 * plannerMath.ts:56-62 for a live example of exactly that kind of drift).
 *
 * The fold: each `callCounts` entry arrives keyed by the slot's OWN code at
 * count 1 per filled assignment; this re-keys it to the PARENT call code
 * (`callBurden.parentCallCodeOf`) and multiplies by the burden weight
 * (`callBurden.callBurdenWeight`), summing entries that land on the same
 * (bucket, parent code) pair. Same shape as `genContext.ts`'s
 * `addHistorical`, which applies this identical fold to historical rows.
 *
 * Year and site scoping are NOT this function's job — the caller filters the
 * slots handed to `computeScheduleActuals` first (Task 4: by year; the route:
 * by published version, clinical invariant 3). `actuals` is trusted as-is.
 *
 * A provider present in `actuals` with zero CALL assignments (e.g. day-shift
 * only) is omitted from the result entirely — never given an empty array.
 */
export function annualCallCounts(
  actuals: Record<string, ProviderActuals>,
  shiftTypes: ReadonlyMap<string, TallyShiftType>,
): Map<string, CallCount[]> {
  const out = new Map<string, CallCount[]>();

  for (const [pid, a] of Object.entries(actuals)) {
    const folded = new Map<string, CallCount>();
    for (const { bucket, code: rawCode, count: rawCount } of a.callCounts) {
      const meta = shiftTypes.get(rawCode);
      const code = parentCallCodeOf(rawCode, meta);
      const weight = callBurdenWeight(meta);
      const key = `${bucket}|${code}`;
      const cur = folded.get(key);
      if (cur) cur.count += rawCount * weight;
      else folded.set(key, { bucket, code, count: rawCount * weight });
    }
    if (folded.size === 0) continue; // no call assignments — omit, not []
    out.set(pid, [...folded.values()].sort(
      // Alphabetical (friday, saturday, sunday, weekday) — NOT display order
      // (M-Th, Fri, Sat, Sun). A caller that needs display order iterates
      // shared.FAIRNESS_BUCKETS itself and filters against this map.
      (x, y) => x.bucket.localeCompare(y.bucket) || x.code.localeCompare(y.code)));
  }
  return out;
}

/** Weighted total across every bucket — the roster's "Calls this year" cell.
 *  Raw float (see `CallCount.count`) — render through `formatCallWeight`. */
export function callTotal(counts: ReadonlyArray<CallCount>): number {
  return counts.reduce((n, c) => n + c.count, 0);
}

// ── Off days used, and the covered span (Task 4) ────────────────────────────

/**
 * One slot row as `plannerMath.computeScheduleActuals` expects it — derived
 * structurally from its own parameter type rather than importing
 * `PlannerSlotRow` by name. Task 3's refold moved all slot-walking (the fill
 * predicate, the assignments-embed normalization, the date-aware bucketing)
 * into `computeScheduleActuals` itself; this module calls that function but
 * has no reason to re-acquire its input type's name into its own import list.
 */
type TallySlotRow = Parameters<typeof computeScheduleActuals>[0][number];

// Absence types that EXPLAIN an unworked day without it being a day off
// (Gabriel 2026-09-06: "dont count sick days as off days").
//
// DERIVED from the engine's own sets, never hand-typed — a literal list would
// drift the first time an availability type is added. BLOCKING_AVAIL is
// {pto, sick, fmla, parental_leave, military_leave, jury_duty, unavailable,
// blocked}; removing the PTO-netting types (counted separately) and
// `unavailable` leaves {sick, jury_duty, blocked}.
//
// `unavailable` is deliberately KEPT OUT of this set: workDays.ts states that
// those rows ARE the partial's entitledOff being consumed, so they must remain
// countable as off days. Conference / CME / admin are not in BLOCKING_AVAIL at
// all — the provider was schedulable and simply wasn't scheduled — so those
// days stay off days too.
export const NON_ENTITLEMENT_ABSENCE_TYPES: ReadonlySet<string> = new Set(
  [...BLOCKING_AVAIL].filter(t => !PTO_NETTING_TYPES.has(t) && t !== 'unavailable'),
);

/**
 * Working dates in `workingDaySet` covered by a live non-entitlement absence.
 * Dismissed (denied/canceled) rows are ignored, matching every other consumer.
 */
export function nonEntitlementAbsenceDates(
  rows: ReadonlyArray<PlannerAvailabilityRow>,
  workingDaySet: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (isDismissedAvailability(row)) continue;
    if (!NON_ENTITLEMENT_ABSENCE_TYPES.has(row.availability_type)) continue;
    for (const d of workingDaySet) {
      if (row.start_date <= d && d <= row.end_date) out.add(d);
    }
  }
  return out;
}

export interface CoveredSpan {
  date_start: string;
  date_end: string;
}

export interface AnnualTallyInput {
  year: number;
  profiles: ReadonlyArray<TallyProfile>;
  /** Whole-roster availability rows; each MUST carry provider_id. */
  availability: ReadonlyArray<PlannerAvailabilityRow>;
  /** PUBLISHED slots at the site, any date — filtered to the year here. */
  slots: ReadonlyArray<TallySlotRow>;
  holidays: ReadonlyArray<PlannerHoliday>;
  shiftTypes: ReadonlyMap<string, TallyShiftType>;
  /** Date ranges of the published blocks at the site that overlap the year. */
  coveredSpans: ReadonlyArray<CoveredSpan>;
}

export interface ProviderAnnualFigures {
  pto: PtoFigures;
  /**
   * Contractual off-day entitlement for the whole year — a tagged union, not a
   * number, so a per diem ('not-applicable') and a full-timer ('none') can
   * never render as the same "0". See offDayBudgetFor.
   */
  offDayBudget: OffDayBudget;
  /**
   * Off days consumed, counted ONLY across `coveredSpan`. Null when no
   * published block covers any of the year — an unbuilt month is not a month
   * of days off, and must never be rendered as one.
   */
  offDaysUsed: number | null;
  callCounts: CallCount[];
  callTotal: number;
}

export interface AnnualTally {
  year: number;
  /** Weekdays in the year minus MAJOR holidays (workDays.ts contract). */
  workingDaysInYear: number;
  /**
   * The union of published block ranges, clipped to the year, expressed as its
   * outer bounds plus the working-day count actually used for offDaysUsed.
   * Null when nothing is published in the year.
   */
  coveredSpan: { start: string; end: string; workingDays: number } | null;
  providers: Map<string, ProviderAnnualFigures>;
}

/**
 * The board's whole annual picture in one pass.
 *
 * `slots` must already be published-only and site-scoped; see annualCallCounts.
 */
export function computeAnnualTally(input: AnnualTallyInput): AnnualTally {
  const { year, profiles, availability, slots, holidays, shiftTypes, coveredSpans } = input;

  // The year's working-day set. rangeComposition caps at MAX_PLANNER_RANGE_DAYS
  // (400), comfortably above a 366-day year.
  const comp = rangeComposition(`${year}-01-01`, `${year}-12-31`, holidays);

  // The published blocks' CALENDAR bounds, clipped to the year — NOT derived
  // from which of their dates happen to be working days. A block that runs
  // Mon..Sun must report its Sunday as the span's end; deriving start/end
  // from the working-day set would silently truncate it to the preceding
  // Friday, misrepresenting the block boundary the honesty caveat names.
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const clippedSpans = coveredSpans
    .map(s => ({
      start: s.date_start < yearStart ? yearStart : s.date_start,
      end: s.date_end > yearEnd ? yearEnd : s.date_end,
    }))
    .filter(s => s.start <= s.end); // drop spans with no overlap in the year

  // Working days inside a published block, clipped to the year — this set (not
  // the span's calendar bounds above) is what offDaysUsed below counts against.
  const coveredWorkingDays = new Set<string>();
  for (const d of comp.workingDaySet) {
    if (clippedSpans.some(s => d >= s.start && d <= s.end)) coveredWorkingDays.add(d);
  }
  const coveredSpan = clippedSpans.length === 0 ? null : {
    start: clippedSpans.reduce((min, s) => (s.start < min ? s.start : min), clippedSpans[0].start),
    end: clippedSpans.reduce((max, s) => (s.end > max ? s.end : max), clippedSpans[0].end),
    workingDays: coveredWorkingDays.size,
  };

  // ONE walk over the slots, feeding both halves of the tally.
  // computeScheduleActuals owns the fill predicate, the embed normalization and
  // the date-aware bucketing; annualCallCounts folds split segments over its raw
  // per-code counts, and the off-days math below reads its three DISJOINT
  // worked-day sets (assigned / post-call rest / ICU), so their sizes simply add.
  //
  // The year filter lives HERE, not inside annualCallCounts — this is the line
  // that makes a block straddling New Year split between two calendar years.
  //
  // Called UNCONDITIONALLY, even when nothing is published: its callCounts
  // accumulation never consults the working-day set (plannerMath.ts:400-410), so
  // an empty coveredWorkingDays still yields correct call counts. Gating it on
  // coveredSpan would zero out every call in a year with no published block.
  const yearSlots = slots.filter(s => s.slot_date.startsWith(`${year}-`));
  const actuals = computeScheduleActuals(yearSlots, availability, coveredWorkingDays, holidays);
  const counts = annualCallCounts(actuals, shiftTypes);

  // Group availability once rather than rescanning the whole roster's rows per
  // provider (annualTally.availabilityByProvider).
  const byProvider = availabilityByProvider(availability);

  const providers = new Map<string, ProviderAnnualFigures>();
  for (const profile of profiles) {
    const pid = profile.provider_id;
    const myCounts = counts.get(pid) ?? [];

    let offDaysUsed: number | null = null;
    if (coveredSpan) {
      // A working day is an OFF DAY only if nothing else explains it
      // (Gabriel 2026-09-06: "dont count sick days as off days").
      //
      // Built as a UNION of explained dates rather than a chain of
      // subtractions, because the sets overlap: an ICU `blocked` row is both
      // credited-as-worked AND a blocking absence, so subtracting counts would
      // charge it twice and under-report off days.
      const rows = byProvider.get(pid) ?? [];
      const a = actuals[pid];
      const explained = new Set<string>();
      // 1. Credited as worked — assignment, post-call rest, ICU. Already
      //    clipped to the working-day set by computeScheduleActuals, and the
      //    three sets are disjoint by construction.
      for (const d of a?.assignedWorkdays ?? []) explained.add(d);
      for (const d of a?.postCallRestWorkdays ?? []) explained.add(d);
      for (const d of a?.icuWorkdays ?? []) explained.add(d);
      // 2. PTO-netting leave, sell-back aware.
      for (const d of ptoWeekdaysCovered(rows, coveredWorkingDays)) explained.add(d);
      // 3. Non-entitlement absences: sick, jury duty, plain blocked. NOT
      //    `unavailable` — workDays.ts states those rows ARE the off-day
      //    entitlement being consumed, so they must stay countable.
      for (const d of nonEntitlementAbsenceDates(rows, coveredWorkingDays)) explained.add(d);

      offDaysUsed = Math.max(0, coveredSpan.workingDays - explained.size);
    }

    providers.set(pid, {
      pto: ptoFiguresFor(profile, availability, year),
      offDayBudget: offDayBudgetFor(profile, comp.workingDays),
      offDaysUsed,
      callCounts: myCounts,
      callTotal: callTotal(myCounts),
    });
  }

  return { year, workingDaysInYear: comp.workingDays, coveredSpan, providers };
}
