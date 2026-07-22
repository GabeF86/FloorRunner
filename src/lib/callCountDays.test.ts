// Call Counts modal day-math (2026-07-22): bucket day counts, Days Off,
// Working Days credit. The helpers ASSEMBLE the single-homed contracts
// (rulesEngine/workDays.ts arithmetic, plannerMath's computeScheduleActuals /
// rangeComposition) — these tests pin both the worked numbers AND the
// agreement with those contracts on identical inputs.
import { describe, it, expect } from 'vitest';
import { requiredWorkDays } from './rulesEngine/workDays';
import { ICU_WEEK_REASON } from './icuRotation';
import { rangeComposition, type PlannerSlotRow } from './plannerMath';
import { bucketDayCounts, daysOffFor, creditedWorkingDayTotals } from './callCountDays';

// 2026-03-02 = Monday … 2026-03-08 = Sunday (a clean holiday-free week).
const WEEK = rangeComposition('2026-03-02', '2026-03-08', []);

const slot = (slot_date: string, derived_day_type: string): { slot_date: string; derived_day_type: string } =>
  ({ slot_date, derived_day_type });

const assigned = (provider_id: string, assignment_status = 'assigned') => ({ provider_id, assignment_status });

const callSlot = (slot_date: string, derived_day_type: string, pid: string): PlannerSlotRow => ({
  slot_date,
  derived_day_type,
  shift_types: { code: 'C2', category: 'call', requires_post_call_rule: true },
  assignments: [assigned(pid)],
});

const daySlot = (slot_date: string, derived_day_type: string, pid: string): PlannerSlotRow => ({
  slot_date,
  derived_day_type,
  shift_types: { code: '7-3', category: 'day', requires_post_call_rule: false },
  assignments: [assigned(pid)],
});

/* ── bucketDayCounts ─────────────────────────────────────────────────────── */

describe('bucketDayCounts', () => {
  it('counts DISTINCT slot dates per stored day type — multiple slots on one date count once', () => {
    expect(bucketDayCounts([
      slot('2026-03-02', 'weekday'),
      slot('2026-03-02', 'weekday'), // second slot, same date
      slot('2026-03-03', 'weekday'),
      slot('2026-03-06', 'friday'),
      slot('2026-03-07', 'saturday'),
      slot('2026-03-08', 'sunday'),
    ])).toEqual({ weekday: 2, friday: 1, saturday: 1, sunday: 1 });
  });

  it('a Monday major holiday is NOT a weekday — holiday day types get no bucket count (mirrors the modal columns)', () => {
    // 2026-05-25 = Memorial Day, a Monday: stored derived_day_type is
    // 'major_holiday', so it must not inflate M–Th. Non-major federal
    // holidays ('federal_holiday') carry no bucket column either.
    expect(bucketDayCounts([
      slot('2026-05-25', 'major_holiday'),
      slot('2026-06-19', 'federal_holiday'),
      slot('2026-03-02', 'weekday'),
    ])).toEqual({ weekday: 1, friday: 0, saturday: 0, sunday: 0 });
  });

  it('empty slot list → all-zero counts', () => {
    expect(bucketDayCounts([])).toEqual({ weekday: 0, friday: 0, saturday: 0, sunday: 0 });
  });
});

/* ── daysOffFor ──────────────────────────────────────────────────────────── */

describe('daysOffFor', () => {
  it('worked example: 54 WD, 18 PTO weekdays, 0.5 FTE → required 9, days off 27', () => {
    // Pin the single-homed contract input first, then the derived column.
    expect(requiredWorkDays(0.5, 54, 18)).toBe(9); // round(0.5×54) − 18
    expect(daysOffFor(0.5, 54, 18)).toBe(27);      // 54 − 18 − 9
  });

  it('agrees with the workDays contract (WD − pto − requiredWorkDays) on a spread of inputs', () => {
    const cases: Array<[number, number, number]> = [
      [1, 54, 0], [0.8, 43, 5], [0.6, 54, 2], [0.5, 20, 0], [0.9, 61, 10], [0.75, 54, 18],
    ];
    for (const [fte, wd, pto] of cases) {
      expect(daysOffFor(fte, wd, pto)).toBe(Math.max(0, wd - pto - requiredWorkDays(fte, wd, pto)));
    }
  });

  it('full-FTE providers compute to 0, with and without PTO (modal renders —)', () => {
    expect(daysOffFor(1, 54, 0)).toBe(0);
    expect(daysOffFor(1, 54, 5)).toBe(0);
  });

  it('PTO beyond the FTE requirement: required floors at 0, days off never negative', () => {
    // 0.2 × 20 WD → required 4; 6 PTO weekdays floors required to 0.
    expect(daysOffFor(0.2, 20, 6)).toBe(14); // 20 − 6 − 0
    // Pathological: PTO exceeding the block itself still never goes negative.
    expect(daysOffFor(0.2, 5, 6)).toBe(0);
  });
});

/* ── creditedWorkingDayTotals ────────────────────────────────────────────── */

describe('creditedWorkingDayTotals', () => {
  it('credits the assignment weekday AND the post-call rest day (invariant-1 rest credits as worked)', () => {
    const totals = creditedWorkingDayTotals(
      [callSlot('2026-03-03', 'weekday', 'p1')], // Tue C2
      [], WEEK.workingDaySet, []);
    expect(totals.p1).toBe(2); // Tue worked + Wed rest credited
  });

  it('a rest day that is itself assigned counts once (disjoint credit sets)', () => {
    const totals = creditedWorkingDayTotals([
      callSlot('2026-03-03', 'weekday', 'p1'),   // Tue C2 → Wed rest
      daySlot('2026-03-04', 'weekday', 'p1'),    // Wed also assigned
    ], [], WEEK.workingDaySet, []);
    expect(totals.p1).toBe(2); // Tue + Wed, never double-counted
  });

  it('weekend calls credit nothing — Saturday call, Sunday rest are both outside the working-day set', () => {
    const totals = creditedWorkingDayTotals(
      [callSlot('2026-03-07', 'saturday', 'p1')],
      [], WEEK.workingDaySet, []);
    expect(totals.p1 ?? 0).toBe(0);
  });

  it('ICU week weekdays credit as worked', () => {
    const totals = creditedWorkingDayTotals([], [{
      provider_id: 'p2', availability_type: 'blocked', reason_code: ICU_WEEK_REASON,
      start_date: '2026-03-02', end_date: '2026-03-08', approval_status: 'approved',
    }], WEEK.workingDaySet, []);
    expect(totals.p2).toBe(5); // Mon–Fri; Sat/Sun of the ICU week are not working days
  });

  it('a major-holiday Monday assignment consumes no credit (not a working day)', () => {
    const holidays = [{ holiday_date: '2026-05-25', is_major_holiday: true }];
    const comp = rangeComposition('2026-05-25', '2026-05-29', holidays);
    const totals = creditedWorkingDayTotals(
      [daySlot('2026-05-25', 'major_holiday', 'p1')],
      [], comp.workingDaySet, holidays);
    expect(totals.p1 ?? 0).toBe(0);
  });

  it('canceled assignments credit nothing (assignmentFills predicate)', () => {
    const totals = creditedWorkingDayTotals([{
      ...daySlot('2026-03-03', 'weekday', 'p1'),
      assignments: [assigned('p1', 'canceled')],
    }], [], WEEK.workingDaySet, []);
    expect(totals.p1 ?? 0).toBe(0);
  });
});
