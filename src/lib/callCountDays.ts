// Call Counts modal day-math (2026-07-22) — the pure helpers behind the
// modal's bucket day counts and its Days Off / Working Days columns. This
// module ASSEMBLES the single-homed contracts, it never re-implements them:
//   - required-days arithmetic → rulesEngine/workDays.ts (requiredWorkDays —
//     THE round(FTE × WD) − PTO contract the engine cap and planner card use)
//   - working-day credit       → plannerMath.computeScheduleActuals (the
//     generation banner's workDayReport analogue: weekday assignments +
//     post-call rest days credited as worked + ICU weeks, disjoint sets)
// The modal (CallCountsModal in schedules/[id]/page.tsx) only aggregates and
// renders; every domain rule routes through here → the shared helpers.

import { requiredWorkDays } from './rulesEngine/workDays';
import { WEIGHT_EPSILON, callBurdenWeight } from './callBurden';
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

/* ── Obligatory weekends (Gabriel 2026-07-27) ────────────────────────────── */

// A WEEKEND is the Fri/Sat/Sun group (weekendGroup.ts — the same definition
// his no-call rule uses), and a weekend UNIT is one provider covering one
// weekend. How many units a weekend consumes = its WIDEST single day: the
// largest call weight standing on any ONE of its three dates. Max, not sum,
// is what makes the weekend one duty instead of three: the tier rotation
// inside a weekend (Fri C1 → Sat C2 → Sun C3) is one person's weekend.
//
// Paoli: Saturday and Sunday carry 3 call tiers (C1 + C2 + C3), but FRIDAY
// carries only 2 as of 2026-07-27 — Friday neuro lost its slot and the Friday
// C2 doc cross-covers it. The weekend is still 3 units, and the MAX is exactly
// why: since the measure is the widest single date and never the sum, Friday's
// tier count does not enter the answer at all unless Friday were the widest
// day. So 3 units per weekend → an 11-week block is 33 units, and at par 11 a
// 1.0 FTE owes 3 weekends (his stated number, pinned in the tests). Derived
// from the SLOTS, so a weekend with reduced coverage owes proportionally less
// and no structure is hardcoded.
//
// Split calls (patch35) count their burden weight, so a 0.5 + 0.5 Saturday
// C1 is one tier, not two.
export function weekendUnitTotal(
  slots: ReadonlyArray<{
    slot_date: string;
    shift_types: { category: string; call_burden_weight?: number | null } | null;
  }>,
): number {
  const byWeekend = new Map<string, Map<string, number>>();
  for (const s of slots) {
    if (s.shift_types?.category !== 'call') continue;
    const key = weekendGroupKey(s.slot_date);
    if (!key) continue;
    let days = byWeekend.get(key);
    if (!days) { days = new Map<string, number>(); byWeekend.set(key, days); }
    days.set(s.slot_date, (days.get(s.slot_date) || 0) + callBurdenWeight(s.shift_types));
  }
  let total = 0;
  for (const days of byWeekend.values()) total += Math.max(...days.values());
  return total;
}

// Weekends WORKED per provider — FRACTIONAL (Gabriel 2026-07-27: "A 0.5
// weekend would be a 12 hour shift on a sunday or saturday"). Credit for one
// weekend = the provider's total call BURDEN WEIGHT that weekend, capped at
// one weekend: a whole 24h weekend call or a full Fri/Sat/Sun chain is 1.0,
// a single 12h split segment (the live C1D12 / C1N12 Sunday halves, weight
// 0.5) is 0.5, and a 12h Saturday plus a 12h Sunday adds back up to a whole
// weekend. The cap is what keeps the weekend the unit — holding all three
// tiers of one weekend is still ONE weekend, never three.
//
// WEIGHT_EPSILON absorbs stored-fraction noise, so three 8h thirds (3 ×
// 0.3333) credit a full weekend rather than 0.9999. Weekday calls are
// ignored; providers with no weekend call are simply absent (callers render
// 0/—).
export function weekendsWorkedTotals(
  callRecords: ReadonlyArray<{ provider_id: string; slot_date: string; weight?: number | null }>,
): Record<string, number> {
  const byPid = new Map<string, Map<string, number>>();
  for (const rec of callRecords) {
    const key = weekendGroupKey(rec.slot_date);
    if (!key) continue;
    let weekends = byPid.get(rec.provider_id);
    if (!weekends) { weekends = new Map<string, number>(); byPid.set(rec.provider_id, weekends); }
    weekends.set(key, (weekends.get(key) || 0) + callBurdenWeight({ call_burden_weight: rec.weight }));
  }
  const out: Record<string, number> = {};
  for (const [pid, weekends] of byPid) {
    let total = 0;
    for (const held of weekends.values()) total += held >= 1 - WEIGHT_EPSILON ? 1 : held;
    out[pid] = total;
  }
  return out;
}

// Weekends OWED: the par-authoritative obligation the call columns use
// (fteTarget.ts) applied to weekend units — weekend units ÷ par × FTE — but
// resolved to the nearest HALF weekend instead of a whole one (Gabriel
// 2026-07-27). Half is the finest weekend duty that actually exists: a 12h
// Saturday or Sunday shift. So an 11-week block at par 11 (33 units) owes a
// 1.0 FTE 3 weekends, a 0.75 FTE 2.5, and a 0.5 FTE 1.5 — the 0.5 taken as
// one 12h weekend shift, never rounded away to a whole weekend.
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
  return Math.round(raw * 2) / 2; // nearest half weekend, ties up
}
