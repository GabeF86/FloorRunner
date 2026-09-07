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
  type PlannerSlotRow,
  type ProviderActuals,
} from './plannerMath';
import {
  effectiveWorkDaysFte,
  entitledOffDays,
  ptoWeekdaysCovered,
  PTO_NETTING_TYPES,
} from './rulesEngine/workDays';
import { addDays, BLOCKING_AVAIL, isDismissedAvailability } from './rulesEngine/shared';
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
  /**
   * PUBLISHED slots at the site, any date — filtered to the year here.
   * MUST be drawn from the SAME published-version set as `coveredSpans`
   * below: if a slot's version isn't one of the versions `coveredSpans` was
   * built from (or vice versa), a provider's calls and their off-days-used
   * figure would be scoped to two different realities — e.g. a call counted
   * from a version whose block isn't in `coveredSpans` would inflate
   * `callTotal` without ever being eligible to explain an off day, or the
   * reverse, a `coveredSpans` block with no matching slots would charge every
   * working day in it as an off day for everyone.
   */
  slots: ReadonlyArray<PlannerSlotRow>;
  holidays: ReadonlyArray<PlannerHoliday>;
  shiftTypes: ReadonlyMap<string, TallyShiftType>;
  /**
   * Date ranges of the published blocks at the site that overlap the year.
   * MUST derive from the same published-version set as `slots` above — see
   * its doc comment.
   */
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
   * Off days consumed, counted ONLY across `coveredSpan`. Null in TWO cases,
   * and both must render as "nothing counted", never as a plausible-looking
   * 0 ("took no days off"):
   *   - no published block covers any of the year at all (`coveredSpan` is
   *     null) — an unbuilt month is not a month of days off; or
   *   - a published block exists but clips to ZERO working days in the year
   *     (`coveredSpan.workingDays === 0`, e.g. a block running
   *     2025-11-01..2026-01-01 clips for 2026 to a single date that is a
   *     major holiday) — nothing was examined, so nothing was counted; `0`
   *     here would read as "took no days off all year", which is false.
   */
  offDaysUsed: number | null;
  callCounts: CallCount[];
  callTotal: number;
}

/**
 * The published blocks' outer bounds for the year, plus the disjoint
 * ranges that make them up.
 */
export interface CoveredSpanInfo {
  /** Earliest clipped-to-year start across every segment. */
  start: string;
  /** Latest clipped-to-year end across every segment. */
  end: string;
  /** Working days inside the union of segments — what offDaysUsed counts
   *  against. Can be 0 (see ProviderAnnualFigures.offDaysUsed). */
  workingDays: number;
  /**
   * The published blocks' own clipped ranges, ascending, adjacent/overlapping
   * ones merged. `segments.length > 1` means the coverage has GAPS and the
   * bare start–end range OVERSTATES it — e.g. a Jan–Mar block and a
   * Sep–Dec block collapse to a bare "start: Jan, end: Dec" that reads as
   * near-total coverage when five months in between were never built.
   * Any label built from this MUST either walk `segments` or say "and gaps
   * in between" — never print `start`–`end` alone when `segments.length > 1`.
   */
  segments: Array<{ start: string; end: string }>;
}

export interface CoveredSpanResult {
  /** Null ONLY when nothing overlaps the year at all — never for a published
   *  block that clips to zero working days (see CoveredSpanInfo.workingDays). */
  span: CoveredSpanInfo | null;
  /** Working days in `workingDaySet` covered by `span`'s segments. Empty set
   *  when `span` is null. */
  coveredWorkingDays: Set<string>;
}

/**
 * Clips `coveredSpans` to the requested year, merges adjacent (touching, no
 * gap) or overlapping ranges into disjoint segments, and intersects the
 * result with `workingDaySet` (the year's full working-day set).
 *
 * A malformed span (`date_start > date_end`, before or after clipping) is
 * silently dropped — same posture as a span with no overlap in the year, and
 * consistent with the module's swallow-bad-input-rather-than-throw stance
 * elsewhere (offDayBudgetFor's unknown-FTE handling).
 *
 * `span` is null ONLY when nothing published overlaps the year at all. It is
 * deliberately NOT null when a published block clips to zero working days —
 * a block running 2025-11-01..2026-01-01 clips for 2026 to a single date
 * that is a major holiday, and that block is still genuinely published;
 * asserting `span: null` there would claim "nothing is published in 2026",
 * which is false. `span.workingDays === 0` is how that case is told apart
 * from "no schedule exists" — see ProviderAnnualFigures.offDaysUsed for how
 * callers must render the difference.
 */
export function coveredSpanFor(
  coveredSpans: ReadonlyArray<CoveredSpan>,
  workingDaySet: ReadonlySet<string>,
  year: number,
): CoveredSpanResult {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const clipped = coveredSpans
    .map(s => ({
      start: s.date_start < yearStart ? yearStart : s.date_start,
      end: s.date_end > yearEnd ? yearEnd : s.date_end,
    }))
    .filter(s => s.start <= s.end) // no overlap in the year, or malformed input
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));

  // Merge adjacent-or-overlapping ranges into disjoint segments. String
  // YYYY-MM-DD comparison sorts identically to calendar order, so this needs
  // no Date objects. `s.start <= addDays(last.end, 1)` catches BOTH cases in
  // one test: overlap (s.start <= last.end) and touching-with-no-gap
  // (s.start === last.end + 1 day).
  const segments: Array<{ start: string; end: string }> = [];
  for (const s of clipped) {
    const last = segments[segments.length - 1];
    if (last && s.start <= addDays(last.end, 1)) {
      if (s.end > last.end) last.end = s.end;
    } else {
      segments.push({ ...s });
    }
  }

  const coveredWorkingDays = new Set<string>();
  for (const d of workingDaySet) {
    if (segments.some(s => d >= s.start && d <= s.end)) coveredWorkingDays.add(d);
  }

  if (segments.length === 0) return { span: null, coveredWorkingDays };
  return {
    span: {
      start: segments[0].start,
      end: segments[segments.length - 1].end,
      workingDays: coveredWorkingDays.size,
      segments,
    },
    coveredWorkingDays,
  };
}

export interface AnnualTally {
  year: number;
  /** Weekdays in the year minus MAJOR holidays (workDays.ts contract). */
  workingDaysInYear: number;
  /** See CoveredSpanInfo. Null when nothing is published in the year. */
  coveredSpan: CoveredSpanInfo | null;
  providers: Map<string, ProviderAnnualFigures>;
  /**
   * Provider ids with published call assignments in the year that are NOT in
   * `profiles` (e.g. someone who went inactive mid-year, or a roster query
   * that missed them). Their calls are counted in NEITHER `providers` NOR
   * anywhere else — exposed here, sorted, so a caller can footnote them
   * rather than silently losing the count. Empty array, never undefined,
   * when there are none.
   */
  unrosteredProviderIds: ReadonlyArray<string>;
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

  const { span: coveredSpan, coveredWorkingDays } =
    coveredSpanFor(coveredSpans, comp.workingDaySet, year);

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
  // provider — feeds BOTH the off-days math below and ptoFiguresFor, which
  // would otherwise re-filter the whole roster's rows down to `pid` itself.
  const byProvider = availabilityByProvider(availability);

  const providers = new Map<string, ProviderAnnualFigures>();
  for (const profile of profiles) {
    const pid = profile.provider_id;
    const myCounts = counts.get(pid) ?? [];
    const rows = byProvider.get(pid) ?? [];

    // Null when no published block covers the year AT ALL, or when one does
    // but clips to zero working days in it (coveredSpan.workingDays === 0,
    // e.g. clipping to a single major holiday) — nothing was examined either
    // way, so nothing is counted. See ProviderAnnualFigures.offDaysUsed.
    let offDaysUsed: number | null = null;
    if (coveredSpan && coveredSpan.workingDays > 0) {
      // A working day is an OFF DAY only if nothing else explains it
      // (Gabriel 2026-09-06: "dont count sick days as off days").
      //
      // Built as a UNION of explained dates rather than a chain of
      // subtractions, because the sets overlap: an ICU `blocked` row is both
      // credited-as-worked AND a blocking absence, so subtracting counts would
      // charge it twice and under-report off days.
      const a = actuals[pid];
      const explained = new Set<string>();
      // 1. Credited as worked — assignment, post-call rest, ICU. Already
      //    clipped to the working-day set by computeScheduleActuals, and the
      //    three sets are disjoint by construction.
      for (const d of a?.assignedWorkdays ?? []) explained.add(d);
      for (const d of a?.postCallRestWorkdays ?? []) explained.add(d);
      // ICU-credited days are ALWAYS a subset of nonEntitlementAbsenceDates
      // below: creditsAsWorkedAvailability requires availability_type ===
      // 'blocked' (icuRotation's ICU_WEEK_REASON/ICU_POST_CALL_REASON rows),
      // and 'blocked' is itself in NON_ENTITLEMENT_ABSENCE_TYPES. This line
      // therefore changes nothing about `explained`'s SIZE — it is kept for
      // INTENT, so "ICU time is credited work" is stated explicitly here
      // rather than left to be inferred from two unrelated-looking sets
      // happening to overlap.
      for (const d of a?.icuWorkdays ?? []) explained.add(d);
      // 2. PTO-netting leave, sell-back aware.
      for (const d of ptoWeekdaysCovered(rows, coveredWorkingDays)) explained.add(d);
      // 3. Non-entitlement absences: sick, jury duty, plain blocked. NOT
      //    `unavailable` — workDays.ts states those rows ARE the off-day
      //    entitlement being consumed, so they must stay countable.
      for (const d of nonEntitlementAbsenceDates(rows, coveredWorkingDays)) explained.add(d);

      // No Math.max(0, ...) clamp: every contributor to `explained` above is
      // either filtered by `coveredWorkingDays` or intersected against it,
      // and coveredSpan.workingDays IS coveredWorkingDays.size (coveredSpanFor
      // constructs them together) — so explained.size <= coveredSpan.workingDays
      // holds by construction, always. A clamp here would silently turn a
      // future bug that leaks the wrong working-day set into one of these
      // contributors into a plausible-looking 0 ("took no days off") instead
      // of an obviously-wrong negative number — exactly the silent-clean
      // failure invariant 6 exists to prevent.
      offDaysUsed = coveredSpan.workingDays - explained.size;
    }

    providers.set(pid, {
      pto: ptoFiguresFor(profile, rows, year),
      offDayBudget: offDayBudgetFor(profile, comp.workingDays),
      offDaysUsed,
      callCounts: myCounts,
      callTotal: callTotal(myCounts),
    });
  }

  // Providers with counted calls but no roster profile — see
  // AnnualTally.unrosteredProviderIds. Cheap: `counts` and `profiles` are
  // both already in hand.
  const rosterIds = new Set(profiles.map(p => p.provider_id));
  const unrosteredProviderIds = [...counts.keys()].filter(pid => !rosterIds.has(pid)).sort();

  return {
    year,
    workingDaysInYear: comp.workingDays,
    coveredSpan,
    providers,
    unrosteredProviderIds,
  };
}
