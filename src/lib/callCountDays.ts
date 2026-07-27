// Call Counts modal day-math (2026-07-22) — the pure helpers behind the
// modal's bucket day counts and its Days Off / Working Days columns. This
// module ASSEMBLES the single-homed contracts, it never re-implements them:
//   - required-days arithmetic → rulesEngine/workDays.ts (requiredWorkDays —
//     THE round(FTE × WD) − PTO contract the engine cap and planner card use)
//   - working-day credit       → plannerMath.computeScheduleActuals (the
//     generation banner's workDayReport analogue: weekday assignments +
//     post-call rest days credited as worked + ICU weeks, disjoint sets)
//   - neuro weekend credit     → rulesEngine/neuroWeekend.ts
//     (creditedUnitsByProvider — pair 1.0 / single day 0.5, the SAME function
//     the solver's gates and the generation banner use)
// The modal (CallCountsModal in schedules/[id]/page.tsx) only aggregates and
// renders; every domain rule routes through here → the shared helpers.

import { requiredWorkDays } from './rulesEngine/workDays';
import {
  creditedUnitsByProvider,
  type NeuroPlacement,
  type NeuroWeekendConfig,
} from './rulesEngine/neuroWeekend';
import { WEIGHT_EPSILON, callBurdenWeight, parentCallCodeOf } from './callBurden';
import { fteWeightedTarget } from './fteTarget';
import { weekendGroupKey } from './weekendGroup';
import {
  computeScheduleActuals,
  type PlannerAvailabilityRow,
  type PlannerHoliday,
  type PlannerSlotRow,
} from './plannerMath';

/* ── Bucket day counts ───────────────────────────────────────────────────── */

// The modal's four bucket columns, keyed by STORED derived_day_type — the
// same exact-match keys the bucket aggregation uses. Holiday day types
// ('major_holiday' / 'federal_holiday') have no bucket column, so they get no
// day count either: a Monday major holiday never inflates M–Th. The stored
// day type already encodes the holiday calendar, so no re-derivation here.
export const BUCKET_DAY_TYPES = ['weekday', 'friday', 'saturday', 'sunday'] as const;
export type BucketDayType = (typeof BUCKET_DAY_TYPES)[number];

// Distinct slot dates per bucket day type from the schedule's slots — "how
// many M–Th / Fri / Sat / Sun days are in this block". Distinct by date so
// multi-slot days (C1+C2+C3 on one date) count once.
export function bucketDayCounts(
  slots: ReadonlyArray<{ slot_date: string; derived_day_type: string }>,
): Record<BucketDayType, number> {
  const seen = new Map<BucketDayType, Set<string>>(BUCKET_DAY_TYPES.map(t => [t, new Set<string>()]));
  for (const s of slots) {
    seen.get(s.derived_day_type as BucketDayType)?.add(s.slot_date);
  }
  const out = {} as Record<BucketDayType, number>;
  for (const t of BUCKET_DAY_TYPES) out[t] = seen.get(t)!.size;
  return out;
}

/* ── Days Off ────────────────────────────────────────────────────────────── */

// Entitled weekday days off for the block from the FTE fraction:
//   daysOff = workingDays − ptoWeekdays − required
// where required = requiredWorkDays(fte, workingDays, ptoWeekdays) — the
// single-homed round(FTE × WD) − PTO contract (workDays.ts), floored at 0
// there. While required is positive the identity collapses to the familiar
// entitledOff = WD − round(FTE × WD); once PTO exceeds the FTE requirement
// the floor kicks in and the remainder is WD − PTO. Outer floor guards the
// pathological PTO-exceeds-block case. Full-FTE providers compute to 0.
//
// `ptoWeekdays` is INTENTIONALLY caller-supplied: the modal passes its
// already-computed PTO Days tally so the two columns can never disagree on
// what counted as a PTO weekday.
export function daysOffFor(fte: number, workingDays: number, ptoWeekdays: number): number {
  const required = requiredWorkDays(fte, workingDays, ptoWeekdays);
  return Math.max(0, workingDays - ptoWeekdays - required);
}

/* ── Working Days credit ─────────────────────────────────────────────────── */

// Per-provider credited working-day totals for a draft — the thin grid-shaped
// adapter over plannerMath.computeScheduleActuals (grid slot rows are
// structurally PlannerSlotRow once the grid selects requires_post_call_rule).
// Total = distinct working days with any filled assignment + post-call rest
// working days (invariant 1's earned rest credits as worked) + ICU rotation
// working days — three disjoint sets, identical semantics to the generation
// banner's workDayReport credited.total. Providers with no credits are simply
// absent (callers render 0/—).
export function creditedWorkingDayTotals(
  slots: ReadonlyArray<PlannerSlotRow>,
  availability: ReadonlyArray<PlannerAvailabilityRow>,
  workingDaySet: ReadonlySet<string>,
  holidays: ReadonlyArray<PlannerHoliday>,
): Record<string, number> {
  const actuals = computeScheduleActuals(slots, availability, workingDaySet, holidays);
  const out: Record<string, number> = {};
  for (const [pid, a] of Object.entries(actuals)) {
    out[pid] = a.assignedWorkdays.length + a.postCallRestWorkdays.length + a.icuWorkdays.length;
  }
  return out;
}

/* ── Obligatory weekends (Gabriel 2026-07-27, REVISED same day) ──────────── */

// A weekend DUTY is one of exactly two kinds, and the two are counted
// DIFFERENTLY. Gabriel's model, verbatim: "In an 11 week block with 11 par
// call takers, there should be 4 Weekday C1 and 4 C2's, 1 Friday C1, Saturday
// C1 and Sunday C1. So 3 weekend obligations. For 0.75 FTE the obligation is 2
// weekends ... Always imagine there are 11 call takers and use that to
// calculate the obligatory numbers" — plus "Every call taker should be given a
// neuro weekend call, except for horan it should only be one weekend day."
//
//   • PRIMARY-CALL duty — counted PER WEEKEND DAY. The primary call code is
//     the one with shift_types.call_rank 0 (first call); NEVER a code-name
//     literal. An 11-week block stands 11 Friday C1 + 11 Saturday C1 + 11
//     Sunday C1 = 33 such slots, so at par 11 a 1.0 FTE owes 3 — his "3
//     weekend obligations". The weekend C2s/C3s are NOT separately owed: they
//     ride along on the block chain (the Saturday C2 doc also holds Friday C2
//     and Sunday C1, and it is the Sunday C1 that is their duty).
//   • NEURO duty — counted PER WEEKEND PAIR. A Sat+Sun neuro pair is 1.0, a
//     lone neuro weekend day is 0.5 (Horan, 0.5 FTE, takes exactly one day).
//     11 pairs in the block = 11 units, so 1 per 1.0 FTE at par 11.
//
// Per weekend that is 3 primary days + 1 neuro pair = 4 units, and a weekend
// genuinely needs 4 docs — which is what makes the two sides of the column
// reconcile. THAT was the bug this replaces: the old denominator counted the
// weekend's widest DAY (3 tiers → 33 units) while the numerator credited every
// distinct doc who touched a weekend (~3.3 per weekend on live data), so every
// provider rendered red. 33 + 11 = 44 at par 11 → 4 per 1.0 FTE.
//
// The neuro half of the arithmetic is NOT re-implemented here — it is
// rulesEngine/neuroWeekend.ts's `creditedUnitsByProvider` (pair 1.0 / single
// day 0.5), the same function the solver's gates and the generation banner
// use, so placement and reporting cannot drift on what a neuro weekend is
// worth. The import direction (lib/ → lib/rulesEngine/) is the one this file
// already uses for rulesEngine/workDays.
//
// The neuro CODE comes from the site's active CallPatternDoc
// (`neuroWeekend.code`) — a site that states none simply has no neuro term
// and its column falls back to primary-call weekend days alone.
//
// Split calls (patch35) count their burden weight, so a Sunday C1 served as
// C1D12 + C1N12 is one primary day, not two, and a lone 12h half is 0.5.

const PRIMARY_CALL_RANK = 0;

export interface WeekendDutyShiftType {
  category: string;
  code: string;
  // patch18. Absent/null on a segment row falls back to the PARENT code's rank
  // (patch35 copies call_rank onto segments, so this is belt-and-braces).
  call_rank?: number | null;
  call_burden_weight?: number | null;
  parent_call_code?: string | null;
}

export interface WeekendDutySlot {
  slot_date: string;
  shift_types: WeekendDutyShiftType | null;
  assignments?: ReadonlyArray<{ provider_id?: string | null }> | null;
}

// creditedUnitsByProvider is a BATCH function keyed by provider; the block
// total is the same per-weekend pair arithmetic with the whole block standing
// in for one "provider". This key can never collide with a provider UUID.
const BLOCK_KEY = ' block';

const neuroConfigFor = (code: string): NeuroWeekendConfig =>
  // requirementBands is irrelevant here — this module only ever calls the
  // CREDIT half of neuroWeekend.ts. The owed half is the engine's FTE-band
  // question ("did this doc get their neuro weekend?"); the column's question
  // is the par-weighted one below.
  ({ code, requirementBands: [] });

// Resolve a call code's rank, falling back through parent_call_code so a
// segment row that never got a rank still classifies with its parent.
function callRankResolver(slots: ReadonlyArray<WeekendDutySlot>) {
  const rankByCode = new Map<string, number>();
  for (const s of slots) {
    const st = s.shift_types;
    if (!st || typeof st.call_rank !== 'number') continue;
    if (!rankByCode.has(st.code)) rankByCode.set(st.code, st.call_rank);
  }
  return (st: WeekendDutyShiftType): number | null => {
    if (typeof st.call_rank === 'number') return st.call_rank;
    const r = rankByCode.get(parentCallCodeOf(st.code, st));
    return typeof r === 'number' ? r : null;
  };
}

// One classification pass shared by the block total and the per-provider
// tally, so numerator and denominator can never disagree about which slots
// are duties. The two terms are DISJOINT by construction: a neuro-code slot
// is never also counted as primary, even at a site whose neuro code is its
// first-call code.
function classifyWeekendDuties(
  slots: ReadonlyArray<WeekendDutySlot>,
  neuroCode: string | undefined,
  onPrimary: (slot: WeekendDutySlot, weight: number) => void,
  onNeuro: (slot: WeekendDutySlot, parentCode: string) => void,
): void {
  const rankOf = callRankResolver(slots);
  for (const s of slots) {
    const st = s.shift_types;
    if (st?.category !== 'call') continue;
    if (!weekendGroupKey(s.slot_date)) continue;   // Mon–Thu call is not a weekend duty
    const parent = parentCallCodeOf(st.code, st);
    if (neuroCode && parent === neuroCode) onNeuro(s, parent);
    else if (rankOf(st) === PRIMARY_CALL_RANK) onPrimary(s, callBurdenWeight(st));
  }
}

/** The block's total weekend duty units — the column's DENOMINATOR input.
 * Weighted primary-call weekend slots (counted per day) + neuro weekend units
 * (counted per pair, via neuroWeekend.ts). Derived entirely from the slots, so
 * a block with reduced weekend coverage owes proportionally less and no
 * structure is hardcoded. `neuroCode` absent → the neuro term is absent. */
export function weekendObligationUnits(
  slots: ReadonlyArray<WeekendDutySlot>,
  neuroCode?: string,
): number {
  let primary = 0;
  const neuroPlacements: NeuroPlacement[] = [];
  classifyWeekendDuties(
    slots, neuroCode,
    (_s, weight) => { primary += weight; },
    (s, code) => { neuroPlacements.push({ provider_id: BLOCK_KEY, slot_date: s.slot_date, code }); },
  );
  const neuro = neuroCode
    ? creditedUnitsByProvider(neuroPlacements, neuroConfigFor(neuroCode)).get(BLOCK_KEY) || 0
    : 0;
  return primary + neuro;
}

/** Weekend duties HELD per provider — the column's ACTUAL. Same two terms,
 * same classification, added together:
 *   primary-call weekend days held (weighted — a 12h Sunday C1 half is 0.5)
 *   + neuro units held (a Sat+Sun pair 1.0, a lone neuro day 0.5).
 * Horan's stated block — one Saturday C1, one 12h Sunday C1, one single neuro
 * weekend day — is 1 + 0.5 + 0.5 = 2.0, landing her exactly on her 2.
 *
 * Assignment rows count exactly as the shared obligation census counts them
 * (fteTarget.computeCallObligationCensus): any row carrying a provider_id, no
 * status filter, so the weekend column and the call columns always see the
 * same set. Providers with no weekend duty are simply absent (callers render
 * 0/—). */
export function weekendDutiesByProvider(
  slots: ReadonlyArray<WeekendDutySlot>,
  neuroCode?: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  const neuroPlacements: NeuroPlacement[] = [];
  classifyWeekendDuties(
    slots, neuroCode,
    (s, weight) => {
      for (const a of s.assignments || []) {
        if (a.provider_id) out[a.provider_id] = (out[a.provider_id] || 0) + weight;
      }
    },
    (s, code) => {
      for (const a of s.assignments || []) {
        if (a.provider_id) neuroPlacements.push({ provider_id: a.provider_id, slot_date: s.slot_date, code });
      }
    },
  );
  if (neuroCode) {
    for (const [pid, units] of creditedUnitsByProvider(neuroPlacements, neuroConfigFor(neuroCode))) {
      out[pid] = (out[pid] || 0) + units;
    }
  }
  return out;
}

// Weekend duties OWED: the par-authoritative obligation the call columns use
// (fteTarget.ts) applied to weekend duty units — units ÷ par × FTE — resolved
// DOWN to the nearest half (Gabriel 2026-07-27, SUPERSEDING the nearest-half
// decision he made earlier the same day; his per-doc numbers require it —
// 0.75 × 3 must land on 2, not 2.5). Half is the finest weekend duty that
// actually exists: a 12h Saturday/Sunday shift, or a single neuro day.
//
// Paoli, 11-week block, par 11: (33 primary + 11 neuro) ÷ 11 = 4 per 1.0 FTE →
// 1.0 owes 4, 0.75 owes 3, 0.5 owes 2. His preview, exactly.
//
// WEIGHT_EPSILON is the same stored-fraction slack used everywhere else here:
// a raw value a hair under a half-step (3 × 0.3333 arithmetic) must land ON
// the step rather than being floored a whole half below it.
//
// `fte` is the CALL-POOL weight (census.poolFteFor): a provider outside the
// call pool owes none. Par-authoritative means a pool below the par
// under-covers the weekends by design; the excess weekends providers do work
// are the paid-pickup layer, same as the extra calls.
export function requiredWeekendsFor(
  weekendUnits: number,
  parLevel: number,
  fte: number,
): number {
  const raw = fteWeightedTarget(weekendUnits, parLevel, fte);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor((raw + WEIGHT_EPSILON) * 2) / 2; // DOWN to the nearest half
}
