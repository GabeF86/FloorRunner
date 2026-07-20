// Physician Planner assembly math (2026-07-20). The ONE home for every
// computation the planner card/API needs that isn't already single-homed
// elsewhere. This module ASSEMBLES — it never re-implements:
//   - obligation arithmetic     → lib/fteTarget.ts (fteWeightedTarget,
//     roundedObligation, clampParToPoolFte, computeCallObligationCensus)
//   - working-days arithmetic   → rulesEngine/workDays.ts (isWorkingDay,
//     ptoWeekdaysCovered, requiredWorkDays, entitledOffDays,
//     creditsAsWorkedAvailability)
//   - template→slot semantics   → lib/templateSlots.ts (slateForDayType's
//     Friday partial-override union, templateSlotCount, derivedDayTypeFor —
//     extracted from the schedules POST route so estimates can't diverge
//     from real slot creation)
//   - date/bucket primitives    → rulesEngine/shared.ts (addDays,
//     dayTypeBucket, isDismissedAvailability)
//   - embed normalization       → lib/embed.ts (embedArray)
// Drift-proofing is by construction (imports) AND by test: plannerMath.test.ts
// cross-checks these assemblies against the engine helpers on identical inputs.
//
// Pure functions only — no I/O; the planner API route and the dashboard card
// both consume this module, so server-computed actuals and client-computed
// what-ifs share one set of rules.

import {
  addDays,
  dayTypeBucket,
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
  clampParToPoolFte,
  computeCallObligationCensus,
  fteWeightedTarget,
  roundedObligation,
  type CensusProfile,
} from './fteTarget';
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
  const dayTypeCounts = new Map<string, number>();
  const workingDaySet = new Set<string>();
  for (const d of dates) {
    const dt = derivedDayTypeFor(d, holidayByDate.get(d));
    dayTypeCounts.set(dt, (dayTypeCounts.get(dt) ?? 0) + 1);
    if (isWorkingDay(d, majorHolidayDates)) workingDaySet.add(d);
  }
  return { dates, dayTypeCounts, majorHolidayDates, workingDaySet, workingDays: workingDaySet.size };
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
// Buckets collapse via the engine's dayTypeBucket (holiday day types lump
// into 'holiday'; sat/sun separate). Estimates only — actual schedules may
// differ (e.g. later required_count edits).
export function estimateCallSlots(
  templateCounts: ReadonlyArray<TemplateSlotCountRow>,
  dayTypeCounts: ReadonlyMap<string, number>,
): CallSlotEstimate {
  let total = 0;
  const byBucket = new Map<string, number>();
  const byBucketCode = new Map<string, { bucket: string; code: string; count: number }>();
  for (const [dayType, nDays] of dayTypeCounts) {
    if (nDays <= 0) continue;
    for (const row of slateForDayType(templateCounts, dayType)) {
      if (row.category !== 'call') continue;
      const slots = row.count * nDays;
      if (slots <= 0) continue; // count-0 rows exist only to suppress (Friday contract)
      const bucket = dayTypeBucket(dayType);
      total += slots;
      byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + slots);
      const key = `${bucket}|${row.code}`;
      const cur = byBucketCode.get(key);
      if (cur) cur.count += slots;
      else byBucketCode.set(key, { bucket, code: row.code, count: slots });
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
    storedParLevel: 0, // irrelevant to poolFte; clamp not consumed here
    siteId,
    profiles: [...profiles],
    slots: [],
  }).poolFte;
}

export interface CallObligationEstimate {
  effectivePar: number;   // clampParToPoolFte(storedPar, poolFte)
  totalExpected: number;  // fractional FTE share of every call slot
  obligation: number;     // roundedObligation(totalExpected) — half-up
}

// One provider's call obligation for `totalCallSlots` given the stored par,
// the pool ΣFTE (default from rosterPoolFte; what-if may override either) and
// the provider FTE (what-if may override). Pure composition of the fteTarget
// helpers — identical by construction to the engine's obligation.ts math.
export function callObligationFor(
  totalCallSlots: number,
  storedPar: number,
  poolFte: number,
  fte: number,
): CallObligationEstimate {
  const effectivePar = clampParToPoolFte(storedPar, poolFte);
  const totalExpected = fteWeightedTarget(totalCallSlots, effectivePar, fte);
  return { effectivePar, totalExpected, obligation: roundedObligation(totalExpected) };
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
// (assignmentFills, dayTypeBucket, creditsAsWorkedAvailability, working-day
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
        const bucket = dayTypeBucket(dayType);
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
