// Physician Planner assembly math (2026-07-20). The ONE home for every
// computation the planner card/API needs that isn't already single-homed
// elsewhere. This module ASSEMBLES — it never re-implements:
//   - obligation arithmetic     → lib/fteTarget.ts (fteWeightedTarget,
//     roundedObligation, computeCallObligationCensus; par-authoritative
//     2026-07-24 — the stored par is the denominator, never pool-clamped)
//   - working-days arithmetic   → rulesEngine/workDays.ts (isWorkingDay,
//     ptoWeekdaysCovered, requiredWorkDays, entitledOffDays,
//     creditsAsWorkedAvailability)
//   - template→slot semantics   → lib/templateSlots.ts (slateForDayType's
//     Friday partial-override union, templateSlotCount, derivedDayTypeFor —
//     extracted from the schedules POST route so estimates can't diverge
//     from real slot creation)
//   - date/bucket primitives    → rulesEngine/shared.ts (addDays,
//     dayTypeBucketOn, isDismissedAvailability)
//   - embed normalization       → lib/embed.ts (embedArray)
// Drift-proofing is by construction (imports) AND by test: plannerMath.test.ts
// cross-checks these assemblies against the engine helpers on identical inputs.
//
// Pure functions only — no I/O; the planner API route and the dashboard card
// both consume this module, so server-computed actuals and client-computed
// what-ifs share one set of rules.

import {
  addDays,
  dayTypeBucketOn,
  isDismissedAvailability,
} from './rulesEngine/shared';
import {
  creditsAsWorkedAvailability,
  entitledOffDays,
  isWorkingDay,
  ptoWeekdaysCovered,
  requiredWorkDays,
} from './rulesEngine/workDays';
import {
  computeCallObligationCensus,
  extraCalls,
  fteWeightedTarget,
  roundedObligation,
  type CallObligationCensus,
  type CensusProfile,
} from './fteTarget';
import { countDaysInYear, ptoCounterStats, type PtoCounterStats } from './dateRanges';
import { ICU_POST_CALL_REASON, ICU_WEEK_REASON } from './icuRotation';
import { derivedDayTypeFor, slateForDayType, templateSlotCount } from './templateSlots';
import { embedArray } from './embed';

// ── Filled-assignment predicate (single home) ────────────────────────────────
// An assignment "fills" its slot only when it carries a provider and hasn't
// been canceled/declined (mirrors the grid's OPEN-cell rendering). Moved here
// from the dashboard's queries.ts (which now imports it) so the planner's
// actuals and the dashboard rollup share one predicate.
//
// CROSS-LINK: the assistant's read tools use `provider_id && status ===
// 'assigned'` as their filled-predicate (loadVersionSlotRows / get_grid in
// src/lib/scheduleAssistant/tools.ts). The two agree on all data the app
// writes today — assignment rows only ever carry 'assigned' or 'open' — but
// they diverge on hypothetical statuses (e.g. pending, external_fill would be
// "filled" here and "open" there). If any new status is ever written, revisit
// BOTH predicates together.
export function assignmentFills(a: { provider_id: string | null; assignment_status: string }): boolean {
  return !!a.provider_id && a.assignment_status !== 'canceled' && a.assignment_status !== 'declined';
}

// ── Template aggregation (API payload shape) ─────────────────────────────────

// Raw shift_templates row + shift_types embed as the planner route selects it.
export interface PlannerTemplateRow {
  day_type: string;
  shift_type_id: string;
  required_count?: number | null;
  shift_types: { code: string; category: string } | null;
}

// One aggregate row per (day_type, shift_type): how many slots one day of
// that day_type materializes for that shift type. count 0 rows are KEPT —
// a friday row with required_count 0 must stay visible to slateForDayType so
// it suppresses the weekday slate for its shift type (route parity).
// Aggregation is keyed by shift_type_id (the union's key in the route);
// code/category ride along for display + call filtering.
export interface TemplateSlotCountRow {
  day_type: string;
  shift_type_id: string;
  code: string;
  category: string;
  count: number;
}

export function aggregateTemplateSlotCounts(rows: PlannerTemplateRow[]): TemplateSlotCountRow[] {
  const byKey = new Map<string, TemplateSlotCountRow>();
  for (const r of rows) {
    const code = r.shift_types?.code;
    const category = r.shift_types?.category;
    if (!code || !category) continue; // orphan template row — no shift type join
    const key = `${r.day_type}|${r.shift_type_id}`;
    const count = templateSlotCount(r);
    const cur = byKey.get(key);
    if (cur) cur.count += count; // duplicate rows sum, exactly as the route materializes both
    else byKey.set(key, { day_type: r.day_type, shift_type_id: r.shift_type_id, code, category, count });
  }
  return [...byKey.values()].sort((a, b) =>
    a.day_type.localeCompare(b.day_type) || a.code.localeCompare(b.code));
}

// ── Range composition (dates → day types → working days) ─────────────────────

// Hard bound on planner ranges — keeps date enumeration trivially cheap and
// the API's row counts bounded. The route 400s beyond it; the lib throws so
// misuse is loud, never silent truncation.
export const MAX_PLANNER_RANGE_DAYS = 400;

export interface PlannerHoliday {
  holiday_date: string;
  is_major_holiday: boolean;
}

export interface RangeComposition {
  dates: string[];                       // every calendar date in [start, end]
  /** derived day_type -> the dates in range carrying it, ascending. Carried
   * alongside the counts because a day type is NOT enough to bucket a slot:
   * a holiday day type is charged to the fairness bucket of the day of the
   * week it falls on, which only the date knows (estimateCallSlots). */
  dayTypeDates: Map<string, string[]>;
  dayTypeCounts: Map<string, number>;    // derived day_type -> #dates in range
  majorHolidayDates: Set<string>;        // majors in range (workingDays input)
  workingDaySet: Set<string>;            // weekdays minus major holidays
  workingDays: number;                   // |workingDaySet|
}

export function enumerateRange(dateStart: string, dateEnd: string): string[] {
  const dates: string[] = [];
  if (dateEnd < dateStart) return dates;
  for (let d = dateStart; d <= dateEnd; d = addDays(d, 1)) {
    dates.push(d);
    if (dates.length > MAX_PLANNER_RANGE_DAYS) {
      throw new Error(`planner range exceeds ${MAX_PLANNER_RANGE_DAYS} days`);
    }
  }
  return dates;
}

// Day-type composition + working-day set for a range. Day typing is the
// route's derivedDayTypeFor (major/federal/DOW precedence); the working-day
// predicate is the engine's isWorkingDay (weekday minus MAJOR holidays —
// federal holidays are worked, workDays.ts contract).
export function rangeComposition(
  dateStart: string,
  dateEnd: string,
  holidays: ReadonlyArray<PlannerHoliday>,
): RangeComposition {
  const holidayByDate = new Map(holidays.map(h => [h.holiday_date, h]));
  const majorHolidayDates = new Set(
    holidays.filter(h => h.is_major_holiday).map(h => h.holiday_date));
  const dates = enumerateRange(dateStart, dateEnd);
  const dayTypeDates = new Map<string, string[]>();
  const workingDaySet = new Set<string>();
  for (const d of dates) {
    const dt = derivedDayTypeFor(d, holidayByDate.get(d));
    const list = dayTypeDates.get(dt);
    if (list) list.push(d);
    else dayTypeDates.set(dt, [d]);
    if (isWorkingDay(d, majorHolidayDates)) workingDaySet.add(d);
  }
  // Derived, never counted twice — the two views cannot disagree.
  const dayTypeCounts = new Map<string, number>(
    [...dayTypeDates].map(([dt, ds]) => [dt, ds.length]));
  return {
    dates, dayTypeDates, dayTypeCounts, majorHolidayDates,
    workingDaySet, workingDays: workingDaySet.size,
  };
}

// ── Future-block call-slot estimate (templates × day-type composition) ───────

export interface CallSlotEstimate {
  total: number;                                   // call slots in the range
  byBucket: Map<string, number>;                   // fairness bucket -> slots
  byBucketCode: Map<string, { bucket: string; code: string; count: number }>; // `${bucket}|${code}`
}

// Call slots a range WOULD materialize from the active templates: for each
// day type present in the range, the slate is slateForDayType (Friday
// partial-override union included) and each row contributes count × #days.
//
// The SLATE is chosen by day type (template rows are stored per day type —
// a 'major_holiday' row is a real, separately-editable row), but the fairness
// BUCKET is chosen by dayTypeBucketOn, per DATE: a Monday holiday's call slots
// land in the weekday bucket (Gabriel 2026-07-27). That is why this takes the
// range's day-type DATES rather than a bare count — one day type can span
// several buckets once holidays are folded in. The planner card's buckets must
// agree with the engine's or the dashboard contradicts the schedule.
//
// Estimates only — actual schedules may differ (e.g. later required_count edits).
export function estimateCallSlots(
  templateCounts: ReadonlyArray<TemplateSlotCountRow>,
  dayTypeDates: ReadonlyMap<string, readonly string[]>,
): CallSlotEstimate {
  let total = 0;
  const byBucket = new Map<string, number>();
  const byBucketCode = new Map<string, { bucket: string; code: string; count: number }>();
  for (const [dayType, dates] of dayTypeDates) {
    if (dates.length === 0) continue;
    const slate = slateForDayType(templateCounts, dayType).filter(r => r.category === 'call');
    if (slate.length === 0) continue;
    // Days of this day type, grouped by the bucket their DATE puts them in.
    const daysByBucket = new Map<string, number>();
    for (const d of dates) {
      const b = dayTypeBucketOn(dayType, d);
      daysByBucket.set(b, (daysByBucket.get(b) ?? 0) + 1);
    }
    for (const row of slate) {
      for (const [bucket, nDays] of daysByBucket) {
        const slots = row.count * nDays;
        if (slots <= 0) continue; // count-0 rows exist only to suppress (Friday contract)
        total += slots;
        byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + slots);
        const key = `${bucket}|${row.code}`;
        const cur = byBucketCode.get(key);
        if (cur) cur.count += slots;
        else byBucketCode.set(key, { bucket, code: row.code, count: slots });
      }
    }
  }
  return { total, byBucket, byBucketCode };
}

// ── Call obligation assembly (current + what-if) ─────────────────────────────

// Default generation-pool ΣFTE from the roster — via computeCallObligationCensus
// with an empty slot list, so the pool rule (home-site call/partial-call
// takers; fte || 1 coercion) has exactly one home. Roster rows are structurally
// CensusProfile.
export function rosterPoolFte(profiles: ReadonlyArray<CensusProfile>, siteId: string): number {
  return computeCallObligationCensus({
    storedParLevel: 0, // irrelevant — poolFte never depends on the par
    siteId,
    profiles: [...profiles],
    slots: [],
  }).poolFte;
}

export interface CallObligationEstimate {
  totalExpected: number;  // fractional FTE share of every call slot
  obligation: number;     // roundedObligation(totalExpected) — half-up
}

// One provider's call obligation for `totalCallSlots` at the stored par (the
// what-if may override par or FTE). Par-authoritative (Gabriel 2026-07-24):
// the denominator is the par verbatim — the pool's ΣFTE no longer clamps it,
// so when the pool is smaller than the par the obligations under-cover the
// range and the remainder is the paid-pickup layer. Pure composition of the
// fteTarget helpers — identical by construction to the engine's obligation.ts.
export function callObligationFor(
  totalCallSlots: number,
  parLevel: number,
  fte: number,
): CallObligationEstimate {
  const totalExpected = fteWeightedTarget(totalCallSlots, parLevel, fte);
  return { totalExpected, obligation: roundedObligation(totalExpected) };
}

// ── Working-days assembly (current + what-if) ────────────────────────────────

export interface PlannerAvailabilityRow {
  provider_id?: string;
  availability_type: string;
  start_date: string;
  end_date: string;
  approval_status: string;
  reason_code?: string | null;
}

export interface ProviderDayStats {
  fte: number;
  workingDays: number;   // |workingDaySet| for the range
  ptoWeekdays: number;   // netting-leave weekdays (sell-back restores removed) ± what-if
  required: number;      // requiredWorkDays(fte, WD, ptoWeekdays)
  entitledOff: number;   // entitledOffDays(fte, WD)
}

// What-if variables (panel C). Hypothetical only — callers must render them
// as such; nothing here writes anything.
//   extraPtoWeekdays:  additional hypothetical PTO weekdays (nets 1:1).
//   sellbackWeekdays:  hypothetical sell-back days — sold-back days are OWED
//                      AGAIN, so they come OUT of the netted total (mirrors
//                      ptoWeekdaysCovered's live-sellback subtraction).
export interface DayStatsWhatIf {
  extraPtoWeekdays?: number;
  sellbackWeekdays?: number;
}

// Per-provider days numbers for a range: real netting from availability rows
// via the engine's ptoWeekdaysCovered (pending included, denied/canceled
// ignored, live sell-back restores removed), then the requiredWorkDays /
// entitledOffDays arithmetic — all imported, none re-implemented.
export function providerDayStats(
  fte: number,
  workingDaySet: ReadonlySet<string>,
  availability: ReadonlyArray<PlannerAvailabilityRow>,
  whatIf?: DayStatsWhatIf,
): ProviderDayStats {
  const workingDays = workingDaySet.size;
  const realPto = ptoWeekdaysCovered(availability, workingDaySet).size;
  const ptoWeekdays = Math.max(
    0, realPto + (whatIf?.extraPtoWeekdays ?? 0) - (whatIf?.sellbackWeekdays ?? 0));
  return {
    fte,
    workingDays,
    ptoWeekdays,
    required: requiredWorkDays(fte, workingDays, ptoWeekdays),
    entitledOff: entitledOffDays(fte, workingDays),
  };
}

// ── Draft-schedule actuals (server-computed; workDayReport analogue) ─────────

// Slot row as the planner route selects it (assignments embed normalized via
// embedArray — single object on UNIQUE-constraint DBs, array elsewhere).
export interface PlannerSlotRow {
  slot_date: string;
  derived_day_type?: string | null;
  shift_types: {
    code: string;
    category: string;
    requires_post_call_rule?: boolean | null;
  } | null;
  assignments?: { provider_id: string | null; assignment_status: string }
    | Array<{ provider_id: string | null; assignment_status: string }>
    | null;
}

export interface ProviderActuals {
  /** Filled call assignments by (fairness bucket, code), sorted bucket→code. */
  callCounts: Array<{ bucket: string; code: string; count: number }>;
  /** Distinct working days with any filled assignment (any category). */
  assignedWorkdays: string[];
  /** Post-call rest working days: the day AFTER each requires_post_call_rule
   *  assignment (clinical invariant 1), minus days already assigned. Rest
   *  days falling outside the range's working-day set are not counted —
   *  same range-clipping the engine's workDayReport applies. */
  postCallRestWorkdays: string[];
  /** ICU-credited working days (blocked rows with ICU reason codes), minus
   *  days already counted above — the three sets stay disjoint exactly like
   *  workDayReport's credited breakdown. */
  icuWorkdays: string[];
}

// Reconstructs per-provider actuals from a draft schedule's slot rows +
// availability, using the SAME classifiers the engine's report uses
// (assignmentFills, dayTypeBucketOn, creditsAsWorkedAvailability, working-day
// membership). Differences from workDayReport, both deliberate: post-call
// rest is derived from requires_post_call_rule (+1 day — the invariant's
// definition) rather than a CallPatternDoc's block offsets (no engine/pattern
// invocation here), and inputs are DB rows rather than a GenerationContext.
export function computeScheduleActuals(
  slots: ReadonlyArray<PlannerSlotRow>,
  availability: ReadonlyArray<PlannerAvailabilityRow>,
  workingDaySet: ReadonlySet<string>,
  holidays: ReadonlyArray<PlannerHoliday>,
): Record<string, ProviderActuals> {
  const holidayByDate = new Map(holidays.map(h => [h.holiday_date, h]));

  interface Acc {
    callCounts: Map<string, { bucket: string; code: string; count: number }>;
    assigned: Set<string>;
    postCall: Set<string>;
    icu: Set<string>;
    postCallSources: string[]; // dates of requires_post_call_rule assignments
  }
  const byPid = new Map<string, Acc>();
  const acc = (pid: string): Acc => {
    let a = byPid.get(pid);
    if (!a) {
      a = { callCounts: new Map(), assigned: new Set(), postCall: new Set(), icu: new Set(), postCallSources: [] };
      byPid.set(pid, a);
    }
    return a;
  };

  // 1. Filled assignments → call counts + assigned working days + post-call sources.
  for (const slot of slots) {
    const st = slot.shift_types;
    if (!st) continue;
    // Stored derived_day_type wins; absent (legacy rows) falls back to the
    // single-homed date→day-type derivation with the range's holiday rows.
    const dayType = slot.derived_day_type || derivedDayTypeFor(slot.slot_date, holidayByDate.get(slot.slot_date));
    for (const a of embedArray(slot.assignments)) {
      if (!assignmentFills(a)) continue;
      const pid = a.provider_id as string;
      const p = acc(pid);
      if (st.category === 'call') {
        // Date-aware: a holiday-dated call counts in its day-of-week bucket
        // (the engine's rule — Gabriel 2026-07-27), so the card's per-bucket
        // actuals line up with the quota the engine enforced.
        const bucket = dayTypeBucketOn(dayType, slot.slot_date);
        const key = `${bucket}|${st.code}`;
        const cur = p.callCounts.get(key);
        if (cur) cur.count += 1;
        else p.callCounts.set(key, { bucket, code: st.code, count: 1 });
      }
      if (workingDaySet.has(slot.slot_date)) p.assigned.add(slot.slot_date);
      if (st.requires_post_call_rule) p.postCallSources.push(slot.slot_date);
    }
  }

  // 2. Post-call rest days (disjoint from assigned).
  for (const p of byPid.values()) {
    for (const src of p.postCallSources) {
      const rest = addDays(src, 1);
      if (workingDaySet.has(rest) && !p.assigned.has(rest)) p.postCall.add(rest);
    }
  }

  // 3. ICU-credited working days (disjoint from both) — includes providers
  // with ICU rows but no assignments in the range.
  for (const row of availability) {
    if (!row.provider_id || !creditsAsWorkedAvailability(row)) continue;
    const p = acc(row.provider_id);
    for (const d of workingDaySet) {
      if (row.start_date <= d && d <= row.end_date && !p.assigned.has(d) && !p.postCall.has(d)) {
        p.icu.add(d);
      }
    }
  }

  const out: Record<string, ProviderActuals> = {};
  for (const [pid, p] of byPid) {
    out[pid] = {
      callCounts: [...p.callCounts.values()].sort((a, b) =>
        a.bucket.localeCompare(b.bucket) || a.code.localeCompare(b.code)),
      assignedWorkdays: [...p.assigned].sort(),
      postCallRestWorkdays: [...p.postCall].sort(),
      icuWorkdays: [...p.icu].sort(),
    };
  }
  return out;
}

// ── Non-dismissed availability filter (payload hygiene) ──────────────────────
// The planner payload carries only rows the engines would honor — the same
// isDismissedAvailability status semantics every engine routes through.
export function liveAvailabilityRows<T extends { approval_status: string }>(rows: ReadonlyArray<T>): T[] {
  return rows.filter(r => !isDismissedAvailability(r));
}

// ═══ Card-level assembly (payload → per-physician numbers) ═══════════════════
// Everything below turns ONE planner API payload into the numbers the
// Physician Planner card renders. The card itself does no arithmetic — every
// displayed figure comes out of these functions (grep-provable: the TSX has
// no `Math.`, no `toFixed`, no numeric operators on domain values).

// The planner route's payload, typed once here so the route (producer) and
// the card (consumer) share the shape.
export interface PlannerPayloadSite {
  id: string;
  name: string;
  /** Resolved through the engine's DEFAULT_PAR_LEVEL rule by the route. */
  call_par_level: number;
  call_par_level_stored: number | null;
}

// Roster rows are structurally CensusProfile (fteTarget.ts) — the pool rule
// and the `fte_value || 1` coercion apply to them without adaptation.
export interface PlannerRosterEntry extends CensusProfile {
  first_name: string | null;
  last_name: string | null;
  short_display_name: string | null;
  initials: string | null;
  provider_type: string | null;
  is_day_doc: boolean;
  is_icu_doc: boolean;
}

export interface PlannerActualsPayload {
  schedule: {
    id: string;
    schedule_name: string;
    status: string;
    date_start: string;
    date_end: string;
    version_number: number;
  };
  byProvider: Record<string, ProviderActuals>;
}

export interface PlannerPayload {
  site: PlannerPayloadSite;
  range: { date_start: string; date_end: string };
  holidays: PlannerHoliday[];
  templates: TemplateSlotCountRow[];
  roster: PlannerRosterEntry[];
  availability: PlannerAvailabilityRow[];
  actuals: PlannerActualsPayload | null;
}

// Precomputed per-payload context: the range composition, the template call
// estimate, the roster census (ONE home for the pool ΣFTE and the fte
// coercion — computeCallObligationCensus with an empty slot list), and the
// availability rows grouped per provider.
export interface PlannerContext {
  payload: PlannerPayload;
  composition: RangeComposition;
  callEstimate: CallSlotEstimate;
  census: CallObligationCensus;
  availabilityByPid: Map<string, PlannerAvailabilityRow[]>;
}

export function buildPlannerContext(payload: PlannerPayload): PlannerContext {
  const composition = rangeComposition(
    payload.range.date_start, payload.range.date_end, payload.holidays);
  const callEstimate = estimateCallSlots(payload.templates, composition.dayTypeDates);
  const census = computeCallObligationCensus({
    storedParLevel: payload.site.call_par_level,
    siteId: payload.site.id,
    profiles: payload.roster,
    slots: [],
  });
  const availabilityByPid = new Map<string, PlannerAvailabilityRow[]>();
  for (const row of payload.availability) {
    if (!row.provider_id) continue;
    const list = availabilityByPid.get(row.provider_id);
    if (list) list.push(row);
    else availabilityByPid.set(row.provider_id, [row]);
  }
  return { payload, composition, callEstimate, census, availabilityByPid };
}

// What-if variables (panel C). Hypothetical only — nothing here writes
// anything; the card labels the output as such. Each override replaces one
// input of the SAME formulas the current numbers use:
//   fte       → replaces the profile's coerced FTE (obligation AND days math)
//   parLevel  → replaces sites.call_par_level (authoritative denominator)
//   extraPtoWeekdays / sellbackWeekdays → DayStatsWhatIf (providerDayStats)
// (The old poolFte override is GONE — par-authoritative 2026-07-24 made the
// pool ΣFTE irrelevant to obligation math, so the lever was dead.)
export interface PlannerWhatIf extends DayStatsWhatIf {
  fte?: number;
  parLevel?: number;
}

export interface PlannerBucketRow {
  bucket: string;          // fairness bucket (dayTypeBucketOn)
  slots: number;           // call slots the range materializes in this bucket
  expected: number;        // fteWeightedTarget(slots, parLevel, fte) — fractional
  assigned: number | null; // filled call assignments (null without actuals)
}

export interface ProviderPlannerNumbers {
  providerId: string;
  fte: number;             // what-if override or the census-coerced profile FTE
  poolFte: number;         // roster pool ΣFTE — display/coverage context only
  parLevel: number;        // THE obligation denominator (stored or what-if) — par-authoritative
  totalCallSlots: number;
  totalExpected: number;   // fractional
  obligation: number;      // roundedObligation(totalExpected)
  buckets: PlannerBucketRow[];
  /** True when the payload found an overlapping draft/published schedule. */
  hasActuals: boolean;
  assignedCalls: number | null;
  remainingCalls: number | null; // obligation − assigned, floored at 0
  /** extraCalls(assigned, totalExpected) — the last-N OVER convention. */
  extra: number | null;
  days: ProviderDayStats;
  credited: { assignments: number; postCall: number; icu: number; total: number } | null;
  /** credited.total − days.required: + over, − under. */
  dayDelta: number | null;
}

const EMPTY_ACTUALS: ProviderActuals = {
  callCounts: [], assignedWorkdays: [], postCallRestWorkdays: [], icuWorkdays: [],
};

// One provider's full planner numbers — current stats when whatIf is omitted,
// hypothetical when overrides are present. Pure composition of the shared
// helpers via callObligationFor/providerDayStats; a provider absent from
// actuals.byProvider under a live schedule legitimately shows zeros (the
// schedule exists and they have nothing), while actuals: null renders the
// assigned-side numbers as null (pre-generation estimate, not a zero).
export function providerPlannerNumbers(
  ctx: PlannerContext,
  providerId: string,
  whatIf?: PlannerWhatIf,
): ProviderPlannerNumbers {
  const fte = whatIf?.fte ?? ctx.census.fteFor(providerId);
  // Call-obligation weight is POOL-scoped for current stats (a day doc owes
  // zero calls — census.poolFteFor, 2026-07-22); an explicit what-if FTE
  // overrides it (the card's question is "at this FTE, taking call, what
  // would they owe"). Workday stats below stay on real FTE — the working-days
  // contract applies to everyone.
  const callFte = whatIf?.fte ?? ctx.census.poolFteFor(providerId);
  const poolFte = ctx.census.poolFte; // context/coverage display only — never a denominator
  const parLevel = whatIf?.parLevel ?? ctx.payload.site.call_par_level;
  const { totalExpected, obligation } =
    callObligationFor(ctx.callEstimate.total, parLevel, callFte);

  const hasActuals = ctx.payload.actuals != null;
  const actuals = ctx.payload.actuals?.byProvider[providerId] ?? (hasActuals ? EMPTY_ACTUALS : null);

  let assignedCalls = 0;
  const assignedByBucket = new Map<string, number>();
  for (const c of actuals?.callCounts ?? []) {
    assignedCalls += c.count;
    assignedByBucket.set(c.bucket, (assignedByBucket.get(c.bucket) ?? 0) + c.count);
  }

  // Bucket rows: union of estimate buckets and (rare) assigned-only buckets —
  // an assignment in a bucket the templates no longer produce must stay
  // visible, never silently dropped.
  const bucketKeys = new Set([...ctx.callEstimate.byBucket.keys(), ...assignedByBucket.keys()]);
  const buckets: PlannerBucketRow[] = [...bucketKeys].sort().map(bucket => {
    const slots = ctx.callEstimate.byBucket.get(bucket) ?? 0;
    return {
      bucket,
      slots,
      expected: fteWeightedTarget(slots, parLevel, callFte),
      assigned: actuals ? (assignedByBucket.get(bucket) ?? 0) : null,
    };
  });

  const days = providerDayStats(
    fte, ctx.composition.workingDaySet, ctx.availabilityByPid.get(providerId) ?? [], whatIf);

  const credited = actuals
    ? {
        assignments: actuals.assignedWorkdays.length,
        postCall: actuals.postCallRestWorkdays.length,
        icu: actuals.icuWorkdays.length,
        total: actuals.assignedWorkdays.length
          + actuals.postCallRestWorkdays.length
          + actuals.icuWorkdays.length,
      }
    : null;

  return {
    providerId,
    fte,
    poolFte,
    parLevel,
    totalCallSlots: ctx.callEstimate.total,
    totalExpected,
    obligation,
    buckets,
    hasActuals,
    assignedCalls: actuals ? assignedCalls : null,
    remainingCalls: actuals ? Math.max(0, obligation - assignedCalls) : null,
    extra: actuals ? extraCalls(assignedCalls, totalExpected) : null,
    days,
    credited,
    dayDelta: credited ? credited.total - days.required : null,
  };
}

// ── Year counters (provider-profile parity) ──────────────────────────────────
// The planner's year counters MUST read exactly like the provider profile
// page's category counters (src/app/(scheduling)/providers/[id]/page.tsx):
// same helpers, same live-row filter, same category split —
//   PTO       → ptoCounterStats (weekday headline INCLUDING sold-back days;
//               the sold count rides along — Gabriel's sell-back semantics)
//   Sell-back → calendar days (countDaysInYear)
//   Days off  → 'unavailable' rows, calendar days
//   Other     → everything else EXCEPT no-call/call requests and ICU rotation
//               rows ('blocked' with an icu_* reason — those live in the
//               profile's ICU section, and their weekdays credit as WORKED,
//               not leave).
export interface PlannerYearCounters {
  year: number;
  pto: PtoCounterStats;
  sellbackDays: number;
  daysOffDays: number;
  otherDays: number;
}

// The profile page's non-counter categories, plus its ICU-owned row test.
// call_request (2026-07-22) mirrors no_call_request: it has its own profile
// section (Call Requests) and is a soft request, never counted leave.
const NON_OTHER_TYPES = new Set(['pto', 'pto_sellback', 'unavailable', 'no_call_request', 'call_request']);
function isIcuRotationRow(r: PlannerAvailabilityRow): boolean {
  return r.availability_type === 'blocked'
    && (r.reason_code === ICU_WEEK_REASON || r.reason_code === ICU_POST_CALL_REASON);
}

export function plannerYearCounters(
  rows: ReadonlyArray<PlannerAvailabilityRow>,
  year: number,
): PlannerYearCounters {
  const live = liveAvailabilityRows(rows);
  const pto = live.filter(r => r.availability_type === 'pto');
  const sell = live.filter(r => r.availability_type === 'pto_sellback');
  const daysOff = live.filter(r => r.availability_type === 'unavailable');
  const other = live.filter(r => !NON_OTHER_TYPES.has(r.availability_type) && !isIcuRotationRow(r));
  return {
    year,
    pto: ptoCounterStats(pto, sell, year),
    sellbackDays: countDaysInYear(sell, year),
    daysOffDays: countDaysInYear(daysOff, year),
    otherDays: countDaysInYear(other, year),
  };
}
