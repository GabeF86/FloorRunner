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
