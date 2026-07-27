// Call Counts modal day-math (2026-07-22): bucket day counts, Days Off,
// Working Days credit. The helpers ASSEMBLE the single-homed contracts
// (rulesEngine/workDays.ts arithmetic, plannerMath's computeScheduleActuals /
// rangeComposition) — these tests pin both the worked numbers AND the
// agreement with those contracts on identical inputs.
import { describe, it, expect } from 'vitest';
import { requiredWorkDays } from './rulesEngine/workDays';
import { ICU_WEEK_REASON } from './icuRotation';
import { rangeComposition, type PlannerSlotRow } from './plannerMath';
import {
  bucketDayCounts, daysOffFor, creditedWorkingDayTotals,
  weekendUnitTotal, weekendsWorkedTotals, requiredWeekendsFor,
} from './callCountDays';

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

/* ── Obligatory weekends ─────────────────────────────────────────────────── */

// 2026-08-14/15/16 = Fri/Sat/Sun; 2026-08-21/22/23 = the next weekend.
const wkCall = (slot_date: string, weight?: number) => ({
  slot_date,
  shift_types: { category: 'call', call_burden_weight: weight ?? null },
});
// A full Paoli-shaped weekend day: C1 + C2 + C3 standing on one date.
const threeTiers = (slot_date: string) => [wkCall(slot_date), wkCall(slot_date), wkCall(slot_date)];
const PAOLI_WEEKEND = [
  ...threeTiers('2026-08-14'), ...threeTiers('2026-08-15'), ...threeTiers('2026-08-16'),
];

describe('weekendUnitTotal', () => {
  it('one three-tier weekend = 3 units — the weekend\'s WIDEST day, not its 9 call days', () => {
    expect(weekendUnitTotal(PAOLI_WEEKEND)).toBe(3);
  });

  it('units add up across weekends (11 weekends × 3 tiers = 33, Gabriel\'s block)', () => {
    // The 11 Fridays of the 8/10–10/25 block — one per weekend, three tiers each.
    const fridays = [
      '2026-08-14', '2026-08-21', '2026-08-28', '2026-09-04', '2026-09-11', '2026-09-18',
      '2026-09-25', '2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23',
    ];
    expect(weekendUnitTotal(fridays.flatMap(threeTiers))).toBe(33);
  });

  it('a split call does not inflate its day (0.5 + 0.5 = one tier)', () => {
    expect(weekendUnitTotal([
      ...threeTiers('2026-08-14'),
      wkCall('2026-08-15', 0.5), wkCall('2026-08-15', 0.5), wkCall('2026-08-15'), wkCall('2026-08-15'),
      ...threeTiers('2026-08-16'),
    ])).toBe(3);
  });

  it('Mon–Thu call slots and weekend NON-call slots contribute nothing', () => {
    expect(weekendUnitTotal([
      wkCall('2026-08-12'), // Wednesday call
      { slot_date: '2026-08-15', shift_types: { category: 'day', call_burden_weight: null } },
    ])).toBe(0);
  });

  it('a weekend covered by a lone Saturday call is one unit', () => {
    expect(weekendUnitTotal([wkCall('2026-08-15')])).toBe(1);
  });
});

describe('weekendsWorkedTotals', () => {
  it('a Fri + Sat + Sun chain is ONE weekend, not three', () => {
    const totals = weekendsWorkedTotals([
      { provider_id: 'p1', slot_date: '2026-08-14' },
      { provider_id: 'p1', slot_date: '2026-08-15' },
      { provider_id: 'p1', slot_date: '2026-08-16' },
    ]);
    expect(totals.p1).toBe(1);
  });

  it('separate weekends each count', () => {
    const totals = weekendsWorkedTotals([
      { provider_id: 'p1', slot_date: '2026-08-16' }, // Sun of weekend 1
      { provider_id: 'p1', slot_date: '2026-08-21' }, // Fri of weekend 2
      { provider_id: 'p2', slot_date: '2026-08-22' },
    ]);
    expect(totals.p1).toBe(2);
    expect(totals.p2).toBe(1);
  });

  // Gabriel 2026-07-27, verbatim: "A 0.5 weekend would be a 12 hour shift on
  // a sunday or saturday" — the live C1D12 / C1N12 halves.
  it('a lone 12h Sunday segment is HALF a weekend', () => {
    const totals = weekendsWorkedTotals([
      { provider_id: 'p1', slot_date: '2026-08-16', weight: 0.5 },
    ]);
    expect(totals.p1).toBe(0.5);
  });

  it('a 12h Saturday plus a 12h Sunday adds back up to one weekend', () => {
    const totals = weekendsWorkedTotals([
      { provider_id: 'p1', slot_date: '2026-08-15', weight: 0.5 },
      { provider_id: 'p1', slot_date: '2026-08-16', weight: 0.5 },
    ]);
    expect(totals.p1).toBe(1);
  });

  it('half weekends add across weekends (two 12h Sundays = 1.0)', () => {
    const totals = weekendsWorkedTotals([
      { provider_id: 'p1', slot_date: '2026-08-16', weight: 0.5 },
      { provider_id: 'p1', slot_date: '2026-08-23', weight: 0.5 },
    ]);
    expect(totals.p1).toBe(1);
  });

  it('three 8h thirds credit a whole weekend, not 0.9999 (WEIGHT_EPSILON)', () => {
    const totals = weekendsWorkedTotals([
      { provider_id: 'p1', slot_date: '2026-08-16', weight: 0.3333 },
      { provider_id: 'p1', slot_date: '2026-08-16', weight: 0.3333 },
      { provider_id: 'p1', slot_date: '2026-08-16', weight: 0.3333 },
    ]);
    expect(totals.p1).toBe(1);
  });

  it('weekday calls never count as a weekend', () => {
    const totals = weekendsWorkedTotals([{ provider_id: 'p1', slot_date: '2026-08-12' }]);
    expect(totals.p1 ?? 0).toBe(0);
  });
});

describe('requiredWeekendsFor', () => {
  // Gabriel 2026-07-27: an 11-week block at par 11 owes a 1.0 FTE 3 weekends;
  // a 0.5 FTE owes 1.5 — "I dont want to round up for a 0.5 FTE ... they
  // should be assigned a 12 hr Sunday Shift to count for the 0.5".
  const UNITS = 33; // 11 weekends × 3 tiers
  it('an 11-week block at par 11 owes a 1.0 FTE three weekends', () => {
    expect(requiredWeekendsFor(UNITS, 11, 1)).toBe(3);
  });

  it('a 0.5 FTE owes 1.5 weekends — never rounded up to 2', () => {
    expect(requiredWeekendsFor(UNITS, 11, 0.5)).toBe(1.5);
  });

  it('a 0.75 FTE owes 2.5 (2.25 → nearest half, ties up)', () => {
    expect(requiredWeekendsFor(UNITS, 11, 0.75)).toBe(2.5);
  });

  it('resolves to half-weekend granularity — the 12h weekend shift', () => {
    expect(requiredWeekendsFor(UNITS, 11, 0.6)).toBe(2);    // 1.8 → 2
    expect(requiredWeekendsFor(UNITS, 11, 0.4)).toBe(1);    // 1.2 → 1
    expect(requiredWeekendsFor(UNITS, 11, 0.3)).toBe(1);    // 0.9 → 1
    expect(requiredWeekendsFor(UNITS, 11, 0.2)).toBe(0.5);  // 0.6 → 0.5
  });

  it('a provider outside the call pool (weight 0) owes none', () => {
    expect(requiredWeekendsFor(UNITS, 11, 0)).toBe(0);
  });

  it('a missing/zero par owes none rather than dividing by zero', () => {
    expect(requiredWeekendsFor(UNITS, 0, 1)).toBe(0);
  });
});
