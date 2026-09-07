// Annual tally math. Fixtures mirror the live Paoli roster shape: a 1.0 FTE
// with a stated allotment, a partial-call doc whose WORKING-days FTE is 1.00
// (Hussain), and a call taker with no allotment stated at all.
import { describe, it, expect } from 'vitest';
import {
  ptoFiguresFor, offDayBudgetFor, availabilityByProvider, annualCallCounts, callTotal,
  type TallyProfile, type TallyShiftType,
} from './annualTally';
import { computeScheduleActuals } from './plannerMath';
import { formatCallWeight } from './callBurden';
import type { PlannerAvailabilityRow, PlannerSlotRow } from './plannerMath';

const profile = (over: Partial<TallyProfile> = {}): TallyProfile => ({
  provider_id: 'p1',
  fte_value: 1,
  work_days_fte: null,
  pto_weeks: 4,
  ...over,
});

const pto = (start: string, end: string, over: Partial<PlannerAvailabilityRow> = {}): PlannerAvailabilityRow => ({
  provider_id: 'p1',
  availability_type: 'pto',
  start_date: start,
  end_date: end,
  approval_status: 'approved',
  ...over,
});

describe('ptoFiguresFor', () => {
  it('counts weekdays used and subtracts them from the allotment', () => {
    // Mon 2026-06-08 .. Fri 2026-06-12 = 5 weekdays.
    const f = ptoFiguresFor(profile({ pto_weeks: 4 }), [pto('2026-06-08', '2026-06-12')], 2026);
    expect(f.usedWeekdays).toBe(5);
    expect(f.allotmentDays).toBe(20);
    expect(f.remainingDays).toBe(15);
  });

  it('counts sold-back days as USED — selling back never refunds the pool', () => {
    const rows = [
      pto('2026-06-08', '2026-06-12'),
      { ...pto('2026-06-08', '2026-06-09'), availability_type: 'pto_sellback' },
    ];
    const f = ptoFiguresFor(profile({ pto_weeks: 4 }), rows, 2026);
    expect(f.usedWeekdays).toBe(5);
    expect(f.soldWeekdays).toBe(2);
    expect(f.remainingDays).toBe(15);
  });

  it('reports NO remaining figure when the allotment is unstated', () => {
    const f = ptoFiguresFor(profile({ pto_weeks: null }), [pto('2026-06-08', '2026-06-12')], 2026);
    expect(f.usedWeekdays).toBe(5);
    expect(f.allotmentDays).toBeNull();
    expect(f.remainingDays).toBeNull();
  });

  it('treats a stated zero as a real zero, not as unstated', () => {
    const f = ptoFiguresFor(profile({ pto_weeks: 0 }), [], 2026);
    expect(f.allotmentDays).toBe(0);
    expect(f.remainingDays).toBe(0);
  });

  it('ignores denied and canceled rows', () => {
    const rows = [pto('2026-06-08', '2026-06-12', { approval_status: 'denied' })];
    expect(ptoFiguresFor(profile(), rows, 2026).usedWeekdays).toBe(0);
  });

  it('counts only the requested year for a range that straddles New Year', () => {
    // 2026-12-30..2027-01-02: 2026 weekdays are Wed 30 + Thu 31 = 2.
    const f = ptoFiguresFor(profile(), [pto('2026-12-30', '2027-01-02')], 2026);
    expect(f.usedWeekdays).toBe(2);
  });

  // The provider_id filter is load-bearing: Task 4 calls this in a loop over
  // every profile, passing the WHOLE roster's rows each time. If the filter
  // ever degenerated to "use all rows", every provider would be charged the
  // entire site's PTO — these two tests exist to catch exactly that.
  it("ignores another provider's rows entirely", () => {
    const rows = [
      pto('2026-06-08', '2026-06-12'), // p1 — 5 weekdays
      { ...pto('2026-06-15', '2026-06-19'), provider_id: 'p2' }, // p2 — must not leak into p1's count
    ];
    const f = ptoFiguresFor(profile(), rows, 2026);
    expect(f.usedWeekdays).toBe(5);
  });

  it('pins current behaviour for a row with no provider_id at all: it counts toward nobody', () => {
    // provider_id is optional on PlannerAvailabilityRow (plannerMath.ts:267).
    // The filter is `r.provider_id === profile.provider_id`, so a row missing
    // the field entirely (undefined) never matches any real provider id and
    // is silently excluded — a malformed row must never get attributed to
    // whichever profile happens to be passed in.
    const rows = [{ ...pto('2026-06-08', '2026-06-12'), provider_id: undefined }];
    const f = ptoFiguresFor(profile(), rows, 2026);
    expect(f.usedWeekdays).toBe(0);
  });
});

describe('offDayBudgetFor', () => {
  it('gives a full-timer zero off days', () => {
    expect(offDayBudgetFor(profile({ fte_value: 1 }), 250)).toBe(0);
  });

  it('gives a 0.75 FTE a quarter of the working days', () => {
    // 250 - round(187.5) = 250 - 188 = 62. entitledOffDays rounds half UP, and
    // that rounding is the engine's — match it, never "fix" it here.
    expect(offDayBudgetFor(profile({ fte_value: 0.75 }), 250)).toBe(62);
  });

  it('keys off WORKING-days FTE, not call FTE (the Hussain case)', () => {
    // Call FTE 0.70 but work_days_fte 1.00 — he works full days, so zero off days.
    expect(offDayBudgetFor(profile({ fte_value: 0.7, work_days_fte: 1 }), 250)).toBe(0);
  });

  it('returns null for an unknown FTE — never a guessed maximal budget', () => {
    expect(offDayBudgetFor(profile({ fte_value: null }), 250)).toBeNull();
  });

  it('returns null for a non-numeric FTE rather than rendering NaN', () => {
    const bad = profile({ fte_value: 'abc' as unknown as number });
    expect(offDayBudgetFor(bad, 250)).toBeNull();
  });

  it('returns null for a negative FTE rather than inverting the subtraction', () => {
    // Mirrors effectiveWorkDaysFte's own `< 0` guard (workDays.ts:193). Not
    // reachable through the app (range-checked at the write gates) — this
    // pins the defence-in-depth, not a live path. Without the guard,
    // entitledOffDays(-1, 250) = 250 - round(-250) = 500: twice the year.
    expect(offDayBudgetFor(profile({ fte_value: -1 }), 250)).toBeNull();
  });

  it('treats a stated zero FTE as a real answer, not as unknown', () => {
    // A stated 0 is not blank — it delegates to entitledOffDays like any
    // other finite FTE (see the TODO in annualTally.ts on whether the FULL
    // working-day result this produces is the right board figure).
    expect(offDayBudgetFor(profile({ fte_value: 0 }), 250)).toBe(250);
  });
});

describe('availabilityByProvider', () => {
  it('groups rows by provider_id', () => {
    const rows = [
      pto('2026-06-08', '2026-06-12'),
      { ...pto('2026-07-01', '2026-07-02'), provider_id: 'p2' },
      { ...pto('2026-08-01', '2026-08-02'), provider_id: 'p2' },
    ];
    const grouped = availabilityByProvider(rows);
    expect(grouped.get('p1')?.length).toBe(1);
    expect(grouped.get('p2')?.length).toBe(2);
  });

  it('has no entry at all for a provider with no rows — not an empty array', () => {
    const grouped = availabilityByProvider([pto('2026-06-08', '2026-06-12')]);
    expect(grouped.has('p3')).toBe(false);
  });

  it('drops a row with no provider_id rather than grouping it under "undefined"', () => {
    const rows = [{ ...pto('2026-06-08', '2026-06-12'), provider_id: undefined }];
    const grouped = availabilityByProvider(rows);
    expect(grouped.size).toBe(0);
  });
});

const SHIFT_TYPES = new Map<string, TallyShiftType>([
  ['C1', { call_burden_weight: 1, parent_call_code: null }],
  ['C2', { call_burden_weight: 1, parent_call_code: null }],
  // A 12-hour split segment: half a call, folded under its parent C1.
  ['C1N12', { call_burden_weight: 0.5, parent_call_code: 'C1' }],
  // Live 8-hour thirds (patch35): C1D8/C1E8/C1N8, each 0.3333 of a C1.
  ['C1D8', { call_burden_weight: 0.3333, parent_call_code: 'C1' }],
  ['C1E8', { call_burden_weight: 0.3333, parent_call_code: 'C1' }],
  ['C1N8', { call_burden_weight: 0.3333, parent_call_code: 'C1' }],
]);

const slot = (
  date: string, code: string, providerId: string | null,
  dayType: string, status = 'assigned',
): PlannerSlotRow => ({
  slot_date: date,
  derived_day_type: dayType,
  shift_types: { code, category: 'call' },
  assignments: providerId ? [{ provider_id: providerId, assignment_status: status }] : [],
});

// annualCallCounts is now a pure FOLD over computeScheduleActuals's raw
// per-code counts (Change A) — it never walks slot rows itself. Every test
// below builds actuals through the real helper, exactly as Task 4 will, so a
// fixture never claims a bucketing/fill-predicate behaviour that
// computeScheduleActuals doesn't actually produce. Empty availability/
// workingDaySet/holidays are equivalent to what annualCallCounts's own
// (now-removed) day-type fallback used to compute: computeScheduleActuals's
// callCounts accumulation never consults workingDaySet, and a stored
// derived_day_type still wins over the DOW fallback with no holidays passed.
const actualsFor = (slots: PlannerSlotRow[]) =>
  computeScheduleActuals(slots, [], new Set<string>(), []);

describe('annualCallCounts', () => {
  it('folds a split segment under its parent at half weight', () => {
    // 2026-09-12 is a Saturday.
    const out = annualCallCounts(
      actualsFor([slot('2026-09-12', 'C1N12', 'p1', 'saturday')]), SHIFT_TYPES);
    expect(out.get('p1')).toEqual([{ bucket: 'saturday', code: 'C1', count: 0.5 }]);
  });

  it('sums two 12h segments into one whole Saturday C1', () => {
    const out = annualCallCounts(actualsFor([
      slot('2026-09-12', 'C1N12', 'p1', 'saturday'),
      slot('2026-09-19', 'C1N12', 'p1', 'saturday'),
    ]), SHIFT_TYPES);
    expect(out.get('p1')).toEqual([{ bucket: 'saturday', code: 'C1', count: 1 }]);
  });

  it('sums three live 0.3333 eighths (C1D8/C1E8/C1N8) to ~1, collapsing through formatCallWeight', () => {
    // Live data: three 8h segments of the same parent (C1) on the same day.
    // 0.3333 x 3 = 0.9999 — NOT exactly 1, and NOT mere float noise: 0.3333
    // is a deliberately truncated decimal for 1/3, so the shortfall is a real
    // 1e-4, not a ~1e-16 rounding artifact. `toBeCloseTo(x, 6)` would demand
    // a difference under 5e-7 and can never pass here — precision 3 (< 5e-4)
    // is the tolerance that actually matches this data; this pins the
    // raw-float contract on CallCount.count/callTotal rather than a
    // `toEqual(1)` that would be lucky to pass and unpin the moment the
    // weights changed.
    const out = annualCallCounts(actualsFor([
      slot('2026-09-08', 'C1D8', 'p1', 'weekday'),
      slot('2026-09-08', 'C1E8', 'p1', 'weekday'),
      slot('2026-09-08', 'C1N8', 'p1', 'weekday'),
    ]), SHIFT_TYPES);
    const counts = out.get('p1')!;
    expect(counts).toHaveLength(1);
    expect(counts[0].bucket).toBe('weekday');
    expect(counts[0].code).toBe('C1');
    expect(callTotal(counts)).toBeCloseTo(1, 3);
    expect(formatCallWeight(callTotal(counts))).toBe('1');
  });

  it('buckets a Monday holiday as a M-Th call, not a holiday', () => {
    // Labor Day 2026-09-07 is a Monday; its stored day type is the holiday one.
    const out = annualCallCounts(
      actualsFor([slot('2026-09-07', 'C1', 'p1', 'holiday')]), SHIFT_TYPES);
    expect(out.get('p1')).toEqual([{ bucket: 'weekday', code: 'C1', count: 1 }]);
  });

  it('ignores unfilled slots and canceled assignments', () => {
    const out = annualCallCounts(actualsFor([
      slot('2026-09-08', 'C1', null, 'weekday'),
      slot('2026-09-09', 'C1', 'p1', 'weekday', 'canceled'),
    ]), SHIFT_TYPES);
    expect(out.size).toBe(0);
  });

  it('ignores non-call slots — and omits a day-shift-only provider rather than giving them []', () => {
    const daySlot: PlannerSlotRow = {
      slot_date: '2026-09-08',
      derived_day_type: 'weekday',
      shift_types: { code: 'D1', category: 'day' },
      assignments: [{ provider_id: 'p1', assignment_status: 'assigned' }],
    };
    // computeScheduleActuals DOES create a 'p1' entry here (any filled
    // assignment counts for assignedWorkdays), with an empty callCounts
    // array. annualCallCounts must fold that down to "no entry at all".
    const actuals = actualsFor([daySlot]);
    expect(Object.keys(actuals)).toContain('p1');
    expect(actuals.p1.callCounts).toEqual([]);
    expect(annualCallCounts(actuals, SHIFT_TYPES).size).toBe(0);
  });

  it('sorts counts by bucket then code', () => {
    const out = annualCallCounts(actualsFor([
      slot('2026-09-13', 'C2', 'p1', 'sunday'),
      slot('2026-09-08', 'C2', 'p1', 'weekday'),
      slot('2026-09-08', 'C1', 'p1', 'weekday'),
    ]), SHIFT_TYPES);
    expect(out.get('p1')).toEqual([
      { bucket: 'sunday', code: 'C2', count: 1 },
      { bucket: 'weekday', code: 'C1', count: 1 },
      { bucket: 'weekday', code: 'C2', count: 1 },
    ]);
  });

  it('end-to-end: a null derived_day_type on a Saturday still buckets as saturday', () => {
    // 2026-09-26 is a Saturday (independently verified, not reused from the
    // fixtures above). This now pins computeScheduleActuals' own DOW fallback
    // (templateSlots.derivedDayTypeFor), not annualCallCounts's — a legacy row
    // with no derived_day_type must NOT default to 'weekday' anywhere in the
    // pipeline, or this Saturday call would land in the M-Th bucket.
    const row: PlannerSlotRow = {
      slot_date: '2026-09-26',
      derived_day_type: null,
      shift_types: { code: 'C1', category: 'call' },
      assignments: [{ provider_id: 'p1', assignment_status: 'assigned' }],
    };
    const out = annualCallCounts(actualsFor([row]), SHIFT_TYPES);
    expect(out.get('p1')).toEqual([{ bucket: 'saturday', code: 'C1', count: 1 }]);
  });

  it('end-to-end: an assignments embed returned as a single object is still counted', () => {
    // PostgREST collapses the slot->assignments embed to an object when the
    // UNIQUE constraint is present (embed.ts). This now pins
    // computeScheduleActuals' own embedArray normalization, not
    // annualCallCounts's — PlannerSlotRow's type permits this shape and the
    // fold must still see the assignment that produced.
    const row: PlannerSlotRow = {
      slot_date: '2026-09-08',
      derived_day_type: 'weekday',
      shift_types: { code: 'C1', category: 'call' },
      assignments: { provider_id: 'p1', assignment_status: 'assigned' },
    };
    const out = annualCallCounts(actualsFor([row]), SHIFT_TYPES);
    expect(out.get('p1')).toEqual([{ bucket: 'weekday', code: 'C1', count: 1 }]);
  });

  it('falls back to weight 1 / own code when the shift type is absent from the map', () => {
    // callBurden.ts: callBurdenWeight(undefined) === 1 and
    // parentCallCodeOf(code, undefined) === code — the documented pre-patch35
    // / unknown-code default. 'C9' is deliberately absent from SHIFT_TYPES.
    // This IS still annualCallCounts's own logic — the fold is what looks the
    // code up in shiftTypes, not computeScheduleActuals.
    const out = annualCallCounts(
      actualsFor([slot('2026-09-08', 'C9', 'p1', 'weekday')]), SHIFT_TYPES);
    expect(out.get('p1')).toEqual([{ bucket: 'weekday', code: 'C9', count: 1 }]);
  });
});
