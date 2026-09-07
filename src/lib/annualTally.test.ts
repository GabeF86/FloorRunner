// Annual tally math. Fixtures mirror the live Paoli roster shape: a 1.0 FTE
// with a stated allotment, a partial-call doc whose WORKING-days FTE is 1.00
// (Hussain), and a call taker with no allotment stated at all.
import { describe, it, expect } from 'vitest';
import {
  ptoFiguresFor, offDayBudgetFor, availabilityByProvider, annualCallCounts, callTotal,
  computeAnnualTally, coveredSpanFor, NON_ENTITLEMENT_ABSENCE_TYPES,
  type TallyProfile, type TallyShiftType,
} from './annualTally';
import { computeScheduleActuals, rangeComposition } from './plannerMath';
import { formatCallWeight } from './callBurden';
import { ICU_WEEK_REASON } from './icuRotation';
import type { PlannerAvailabilityRow, PlannerHoliday, PlannerSlotRow } from './plannerMath';

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
  // offDayBudgetFor returns a discriminated union (Gabriel 2026-09-06), not a
  // bare number/null — 'none' and 'not-applicable' are OPPOSITE facts (owes
  // everything vs. owes nothing) and must never collapse into the same "0".

  it('gives a full-timer "none" — they owe every working day, so there are no off days', () => {
    expect(offDayBudgetFor(profile({ fte_value: 1 }), 250)).toEqual({ kind: 'none' });
  });

  it('gives a 0.75 FTE a real days figure — a quarter of the working days', () => {
    // 250 - round(187.5) = 250 - 188 = 62. entitledOffDays rounds half UP, and
    // that rounding is the engine's — match it, never "fix" it here.
    expect(offDayBudgetFor(profile({ fte_value: 0.75 }), 250)).toEqual({ kind: 'days', days: 62 });
  });

  it('keys off WORKING-days FTE, not call FTE (the Hussain case)', () => {
    // Call FTE 0.70 but work_days_fte 1.00 — he works full days, so "none".
    expect(offDayBudgetFor(profile({ fte_value: 0.7, work_days_fte: 1 }), 250)).toEqual({ kind: 'none' });
  });

  it('returns "unknown" for a null FTE — never a guessed maximal budget', () => {
    expect(offDayBudgetFor(profile({ fte_value: null }), 250)).toEqual({ kind: 'unknown' });
  });

  it('returns "unknown" for a non-numeric FTE rather than rendering NaN', () => {
    const bad = profile({ fte_value: 'abc' as unknown as number });
    expect(offDayBudgetFor(bad, 250)).toEqual({ kind: 'unknown' });
  });

  it('returns "unknown" for a negative FTE rather than inverting the subtraction', () => {
    // Mirrors effectiveWorkDaysFte's own `< 0` guard (workDays.ts:193). Not
    // reachable through the app (range-checked at the write gates) — this
    // pins the defence-in-depth, not a live path. Without the guard,
    // entitledOffDays(-1, 250) = 250 - round(-250) = 500: twice the year.
    expect(offDayBudgetFor(profile({ fte_value: -1 }), 250)).toEqual({ kind: 'unknown' });
  });

  it('treats a stated zero FTE as "not-applicable" — a per diem owes NO working days at all', () => {
    // A stated 0 is not blank, but it is also not a number to show: a per
    // diem's effective working-days FTE is 0, so the off-day BUDGET concept
    // doesn't apply (Gabriel 2026-09-06, "n/a for gorelick"). This replaces
    // the earlier TODO, which had this falling through to the FULL working-
    // day count — literally correct but useless on screen.
    expect(offDayBudgetFor(profile({ fte_value: 0 }), 250)).toEqual({ kind: 'not-applicable' });
  });

  it('treats a call FTE of 1.5 as "none" — a >1 FTE must not go unmatched', () => {
    // FTE_MAX is 2 (the "odd partner working two jobs" case). Branching on
    // FTE THRESHOLDS ("eff is 1" / "0 < eff < 1") instead of the computed
    // answer leaves 1.5 matching no state at all — this is the case that
    // proved that draft wrong.
    expect(offDayBudgetFor(profile({ fte_value: 1.5 }), 250)).toEqual({ kind: 'none' });
  });

  it('treats a work_days_fte of 0.999 as "none", never as "0 budgeted"', () => {
    // entitledOffDays rounds 0.999 x 250 = 249.75 UP to 250, so the computed
    // entitlement is exactly 0. Branching on the FTE ("0 < eff < 1") would
    // land this in 'days' with days: 0, rendering "0 budgeted" — the exact
    // string this ruling exists to abolish. Branching on the ANSWER (0) sends
    // it to 'none' instead.
    expect(offDayBudgetFor(profile({ fte_value: 1, work_days_fte: 0.999 }), 250)).toEqual({ kind: 'none' });
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
  // Parent code is NOT a prefix of the segment code — folding this one
  // reorders the keys, unlike every C1N12/C1D8-style fixture above.
  ['Z9', { call_burden_weight: 0.5, parent_call_code: 'C1' }],
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

  it("carries computeScheduleActuals' bucket/code ordering through the fold", () => {
    // NOTE: none of these codes get parent-folded (C1/C2 have no
    // parent_call_code), so this only checks that the fold's own sort call
    // does not scramble what computeScheduleActuals already handed it
    // sorted — see the dedicated re-sort test below for the case where
    // folding itself must change the order.
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

  it('re-sorts after parent folding reorders the keys', () => {
    const actuals = actualsFor([
      slot('2026-09-08', 'C2', 'p1', 'weekday'),
      slot('2026-09-09', 'Z9', 'p1', 'weekday'),
    ]);
    // computeScheduleActuals hands these over sorted by OWN code: C2, Z9.
    expect(actuals.p1.callCounts.map(c => c.code)).toEqual(['C2', 'Z9']);
    // After folding Z9 -> C1, C1 must come FIRST.
    expect(annualCallCounts(actuals, SHIFT_TYPES).get('p1')).toEqual([
      { bucket: 'weekday', code: 'C1', count: 0.5 },
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

describe('NON_ENTITLEMENT_ABSENCE_TYPES', () => {
  it('derives to exactly {sick, jury_duty, blocked} — pinned so a change to ' +
     "BLOCKING_AVAIL or PTO_NETTING_TYPES can't silently drift this set", () => {
    expect([...NON_ENTITLEMENT_ABSENCE_TYPES].sort()).toEqual(['blocked', 'jury_duty', 'sick']);
  });
});

const HOLIDAYS_2026: PlannerHoliday[] = [
  { holiday_date: '2026-01-01', is_major_holiday: true },
  { holiday_date: '2026-05-25', is_major_holiday: true },
  { holiday_date: '2026-07-04', is_major_holiday: true },
  { holiday_date: '2026-09-07', is_major_holiday: true },
  { holiday_date: '2026-11-26', is_major_holiday: true },
  { holiday_date: '2026-12-25', is_major_holiday: true },
];

describe('coveredSpanFor', () => {
  const workingDaySet = rangeComposition('2026-01-01', '2026-12-31', HOLIDAYS_2026).workingDaySet;

  it('gives one segment for a single block', () => {
    const { span } = coveredSpanFor(
      [{ date_start: '2026-06-08', date_end: '2026-06-14' }], workingDaySet, 2026);
    expect(span).toEqual({
      start: '2026-06-08', end: '2026-06-14', workingDays: 5,
      segments: [{ start: '2026-06-08', end: '2026-06-14' }],
    });
  });

  it('keeps two disjoint blocks as TWO segments — the bare start/end range must not overstate coverage', () => {
    // Jan-Mar and Sep-Dec, a five-month gap. The bare start/end alone would
    // read as "Jan-Dec covered", which is false — Task 5's label must walk
    // `segments` (or say "and gaps in between") whenever segments.length > 1.
    const { span } = coveredSpanFor(
      [
        { date_start: '2026-01-05', date_end: '2026-03-22' },
        { date_start: '2026-09-07', date_end: '2026-12-20' },
      ],
      workingDaySet, 2026,
    );
    expect(span!.segments).toEqual([
      { start: '2026-01-05', end: '2026-03-22' },
      { start: '2026-09-07', end: '2026-12-20' },
    ]);
    expect(span!.start).toBe('2026-01-05');
    expect(span!.end).toBe('2026-12-20');
  });

  it('merges two ADJACENT blocks (no gap between them) into one segment', () => {
    const { span } = coveredSpanFor(
      [
        { date_start: '2026-01-05', date_end: '2026-03-22' },
        { date_start: '2026-03-23', date_end: '2026-06-07' }, // starts the day after
      ],
      workingDaySet, 2026,
    );
    expect(span!.segments).toEqual([{ start: '2026-01-05', end: '2026-06-07' }]);
  });

  it('merges two OVERLAPPING blocks into one segment', () => {
    const { span } = coveredSpanFor(
      [
        { date_start: '2026-01-05', date_end: '2026-03-22' },
        { date_start: '2026-03-01', date_end: '2026-06-07' }, // overlaps the first
      ],
      workingDaySet, 2026,
    );
    expect(span!.segments).toEqual([{ start: '2026-01-05', end: '2026-06-07' }]);
  });

  it('does not let a WHOLLY-CONTAINED span shrink the merged segment', () => {
    // Without the `s.end > last.end` containment guard, merging the shorter
    // contained span second would overwrite last.end DOWN to 2026-06-01,
    // silently discarding 2026-06-02..2026-09-30 from coverage and
    // under-reporting both workingDays and offDaysUsed. Reachable when a
    // short special-purpose schedule is published inside a long block, or a
    // corrected block is republished overlapping an older one.
    const { span } = coveredSpanFor(
      [
        { date_start: '2026-03-01', date_end: '2026-09-30' },
        { date_start: '2026-05-01', date_end: '2026-06-01' }, // wholly inside the first
      ],
      workingDaySet, 2026,
    );
    expect(span!.segments).toEqual([{ start: '2026-03-01', end: '2026-09-30' }]);
  });

  it('merges the same way regardless of input order', () => {
    const outOfOrder = coveredSpanFor(
      [
        { date_start: '2026-09-07', date_end: '2026-12-20' },
        { date_start: '2026-01-05', date_end: '2026-03-22' },
      ],
      workingDaySet, 2026,
    );
    expect(outOfOrder.span!.segments).toEqual([
      { start: '2026-01-05', end: '2026-03-22' },
      { start: '2026-09-07', end: '2026-12-20' },
    ]);
  });

  it('drops a span with no overlap in the requested year', () => {
    const { span } = coveredSpanFor(
      [{ date_start: '2025-01-01', date_end: '2025-06-01' }], workingDaySet, 2026);
    expect(span).toBeNull();
  });

  it('drops a malformed span (start after end) rather than producing a negative range', () => {
    const { span } = coveredSpanFor(
      [{ date_start: '2026-06-10', date_end: '2026-06-01' }], workingDaySet, 2026);
    expect(span).toBeNull();
  });

  it('returns null (not a zero-day span) when given no spans at all', () => {
    expect(coveredSpanFor([], workingDaySet, 2026).span).toBeNull();
  });

  it('keeps a genuinely published block that clips to ZERO working days — NEVER null', () => {
    // Runs into 2026 for exactly one date (2026-01-01), which is a major
    // holiday. A block IS published; asserting `span: null` here would claim
    // "nothing published in 2026", which is false. `workingDays: 0` is how
    // this is told apart from "no schedule exists" (see
    // ProviderAnnualFigures.offDaysUsed for how callers must render it).
    const { span, coveredWorkingDays } = coveredSpanFor(
      [{ date_start: '2025-11-01', date_end: '2026-01-01' }], workingDaySet, 2026);
    expect(span).not.toBeNull();
    expect(span).toEqual({
      start: '2026-01-01', end: '2026-01-01', workingDays: 0,
      segments: [{ start: '2026-01-01', end: '2026-01-01' }],
    });
    expect(coveredWorkingDays.size).toBe(0);
  });
});

describe('computeAnnualTally', () => {
  const base = {
    year: 2026,
    profiles: [profile({ provider_id: 'p1', fte_value: 1, pto_weeks: 4 })],
    availability: [] as PlannerAvailabilityRow[],
    slots: [] as PlannerSlotRow[],
    holidays: HOLIDAYS_2026,
    shiftTypes: SHIFT_TYPES,
    coveredSpans: [] as Array<{ date_start: string; date_end: string }>,
  };

  it('reports a null offDaysUsed when no published block covers the year', () => {
    const t = computeAnnualTally(base);
    expect(t.coveredSpan).toBeNull();
    expect(t.providers.get('p1')!.offDaysUsed).toBeNull();
  });

  it('counts working days in the year excluding major holidays only', () => {
    // 2026-07-04 is a Saturday, so it removes no working day; the other five
    // majors are weekdays. 2026 has 261 weekdays.
    const t = computeAnnualTally(base);
    expect(t.workingDaysInYear).toBe(261 - 5);
  });

  it('counts off days only through the blocks that exist', () => {
    // One published week, Mon 2026-06-08 .. Sun 2026-06-14: 5 working days.
    // The provider is assigned on 2 of them and has no PTO, so 3 are off days.
    const t = computeAnnualTally({
      ...base,
      coveredSpans: [{ date_start: '2026-06-08', date_end: '2026-06-14' }],
      slots: [
        slot('2026-06-08', 'C1', 'p1', 'weekday'),
        slot('2026-06-10', 'C1', 'p1', 'weekday'),
      ],
    });
    expect(t.coveredSpan).toEqual({
      start: '2026-06-08', end: '2026-06-14', workingDays: 5,
      segments: [{ start: '2026-06-08', end: '2026-06-14' }],
    });
    // 2026-06-08 is a call with requires_post_call_rule unset in the fixture,
    // so only the two assigned days are credited.
    expect(t.providers.get('p1')!.offDaysUsed).toBe(3);
  });

  it('does not charge PTO weekdays as off days', () => {
    const t = computeAnnualTally({
      ...base,
      coveredSpans: [{ date_start: '2026-06-08', date_end: '2026-06-14' }],
      slots: [slot('2026-06-08', 'C1', 'p1', 'weekday')],
      availability: [pto('2026-06-09', '2026-06-10')],
    });
    // 5 working days - 1 assigned - 2 PTO = 2 off days.
    expect(t.providers.get('p1')!.offDaysUsed).toBe(2);
  });

  it('splits a block that straddles New Year by slot_date', () => {
    // This coverage lives HERE, not in annualCallCounts — the year filter is
    // computeAnnualTally's. Gabriel 2026-09-06: "a call on 1/5 counts toward
    // 2027." The same two slots must land in different years.
    const slots = [
      slot('2026-12-28', 'C1', 'p1', 'weekday'),
      slot('2027-01-05', 'C1', 'p1', 'weekday'),
    ];
    expect(computeAnnualTally({ ...base, year: 2026, slots }).providers.get('p1')!.callTotal).toBe(1);
    expect(computeAnnualTally({
      ...base, year: 2027, slots, holidays: [{ holiday_date: '2027-01-01', is_major_holiday: true }],
    }).providers.get('p1')!.callTotal).toBe(1);
  });

  it('counts calls even when no block is published that year', () => {
    // computeScheduleActuals must be called unconditionally: gating it on
    // coveredSpan would zero every call in a year with nothing published.
    const t = computeAnnualTally({
      ...base,
      coveredSpans: [],
      slots: [slot('2026-06-08', 'C1', 'p1', 'weekday')],
    });
    expect(t.coveredSpan).toBeNull();
    expect(t.providers.get('p1')!.callTotal).toBe(1);
    expect(t.providers.get('p1')!.offDaysUsed).toBeNull();
  });

  it('clips the covered span to the requested year', () => {
    const t = computeAnnualTally({
      ...base,
      coveredSpans: [{ date_start: '2026-12-28', date_end: '2027-01-10' }],
    });
    expect(t.coveredSpan!.start).toBe('2026-12-28');
    expect(t.coveredSpan!.end).toBe('2026-12-31');
  });

  it('carries PTO, budget and call figures onto every profile row', () => {
    const t = computeAnnualTally({
      ...base,
      profiles: [
        profile({ provider_id: 'p1', fte_value: 1, pto_weeks: 4 }),
        profile({ provider_id: 'p2', fte_value: 0.5, pto_weeks: null }),
      ],
      slots: [slot('2026-06-08', 'C1', 'p1', 'weekday')],
    });
    const p1 = t.providers.get('p1')!;
    expect(p1.pto.allotmentDays).toBe(20);
    expect(p1.offDayBudget).toEqual({ kind: 'none' });
    expect(p1.callTotal).toBe(1);
    const p2 = t.providers.get('p2')!;
    expect(p2.pto.remainingDays).toBeNull();
    expect(p2.offDayBudget).toEqual({ kind: 'days', days: 128 });
    expect(p2.callTotal).toBe(0);
    expect(p2.callCounts).toEqual([]);
  });

  // ── The two product rulings (Gabriel 2026-09-06) ──────────────────────────
  // These pin the "sick days don't count as off days" ruling and its mirror
  // ("unavailable" DOES count) — the plan's own test list predates the
  // ruling, so this coverage is not in the plan text above.

  it('does NOT count a sick day inside the covered span as an off day', () => {
    const t = computeAnnualTally({
      ...base,
      coveredSpans: [{ date_start: '2026-06-08', date_end: '2026-06-14' }],
      availability: [{
        provider_id: 'p1', availability_type: 'sick',
        start_date: '2026-06-09', end_date: '2026-06-09', approval_status: 'approved',
      }],
    });
    // 5 working days, 1 explained by sickness -> 4 off days, not 5. Sick
    // days do not count as off days (Gabriel: "dont count sick days").
    expect(t.providers.get('p1')!.offDaysUsed).toBe(4);
  });

  it('DOES count an "unavailable" day inside the covered span as an off day — the opposite of sick', () => {
    const t = computeAnnualTally({
      ...base,
      coveredSpans: [{ date_start: '2026-06-08', date_end: '2026-06-14' }],
      availability: [{
        provider_id: 'p1', availability_type: 'unavailable',
        start_date: '2026-06-09', end_date: '2026-06-09', approval_status: 'approved',
      }],
    });
    // workDays.ts: an 'unavailable' row IS the off-day entitlement being
    // consumed, so — unlike sick — it stays countable. Still 5, not 4. If
    // sick and unavailable were ever treated the same, this test and the one
    // above could not both pass.
    expect(t.providers.get('p1')!.offDaysUsed).toBe(5);
  });

  it('does NOT count a jury-duty day as an off day', () => {
    const t = computeAnnualTally({
      ...base,
      coveredSpans: [{ date_start: '2026-06-08', date_end: '2026-06-14' }],
      availability: [{
        provider_id: 'p1', availability_type: 'jury_duty',
        start_date: '2026-06-09', end_date: '2026-06-09', approval_status: 'approved',
      }],
    });
    expect(t.providers.get('p1')!.offDaysUsed).toBe(4);
  });

  it('counts an ICU blocked row ONCE — a union of explained dates, not a subtraction chain', () => {
    // An icu_week 'blocked' row is BOTH credited as worked
    // (computeScheduleActuals' icuWorkdays) AND a non-entitlement blocking
    // absence (nonEntitlementAbsenceDates — 'blocked' is in the derived set).
    // A subtraction-chain implementation
    // (workingDays - assigned - postCall - icu - pto - nonEntitlement) would
    // subtract this ONE date twice: 5 - 1(icu) - 1(nonEntitlement) = 3. The
    // union of explained dates counts it once: 5 - 1 = 4. This test would
    // FAIL under the subtraction-chain form (it would compute 3, not 4),
    // which is what makes it discriminate.
    const t = computeAnnualTally({
      ...base,
      coveredSpans: [{ date_start: '2026-06-08', date_end: '2026-06-14' }],
      availability: [{
        provider_id: 'p1', availability_type: 'blocked', reason_code: ICU_WEEK_REASON,
        start_date: '2026-06-09', end_date: '2026-06-09', approval_status: 'approved',
      }],
    });
    expect(t.providers.get('p1')!.offDaysUsed).toBe(4);
  });

  it('scopes non-entitlement absences to EACH PROVIDER, never the whole roster', () => {
    // If `rows` inside the off-days loop ever degenerated to the whole-roster
    // `availability` array instead of that provider's own rows, BOTH
    // providers would be charged for BOTH sick days. This is the off-days
    // analogue of the provider-filter regression ptoFiguresFor's tests above
    // already guard (a mutation there proved all tests stayed green without
    // that filter) — this path never had that coverage.
    const t = computeAnnualTally({
      ...base,
      profiles: [
        profile({ provider_id: 'p1', fte_value: 1, pto_weeks: 4 }),
        profile({ provider_id: 'p2', fte_value: 1, pto_weeks: 4 }),
      ],
      coveredSpans: [{ date_start: '2026-06-08', date_end: '2026-06-14' }],
      availability: [
        {
          provider_id: 'p1', availability_type: 'sick',
          start_date: '2026-06-09', end_date: '2026-06-09', approval_status: 'approved',
        },
        {
          provider_id: 'p2', availability_type: 'sick',
          start_date: '2026-06-11', end_date: '2026-06-11', approval_status: 'approved',
        },
      ],
    });
    // Each provider's OWN sick day explains 1 of their 5 working days -> 4
    // off days each. Neither is charged for the OTHER's sick day too (which
    // would produce 3 for both under the regression).
    expect(t.providers.get('p1')!.offDaysUsed).toBe(4);
    expect(t.providers.get('p2')!.offDaysUsed).toBe(4);
  });

  it('yields a null offDaysUsed when the covered span clips to ZERO working days — even though a block IS published', () => {
    // The block runs into 2026 for exactly one date, 2026-01-01, a major
    // holiday. A block IS genuinely published for the year (coveredSpan is
    // non-null, per coveredSpanFor's contract), but nothing was examined, so
    // offDaysUsed must read as "nothing counted" (null), never as a
    // plausible-looking 0 — Task 5 would otherwise render "0 of 62 used",
    // which claims a full year of perfect attendance that was never checked.
    const t = computeAnnualTally({
      ...base,
      coveredSpans: [{ date_start: '2025-11-01', date_end: '2026-01-01' }],
    });
    expect(t.coveredSpan).toEqual({
      start: '2026-01-01', end: '2026-01-01', workingDays: 0,
      segments: [{ start: '2026-01-01', end: '2026-01-01' }],
    });
    expect(t.providers.get('p1')!.offDaysUsed).toBeNull();
  });

  it('does not let an assignment OUTSIDE the covered span inflate offDaysUsed, though it still counts toward callTotal', () => {
    // Covered span is one full working week (Mon-Fri, 5 working days); the
    // assignment below falls in a different month entirely, outside it.
    const t = computeAnnualTally({
      ...base,
      coveredSpans: [{ date_start: '2026-06-08', date_end: '2026-06-12' }],
      slots: [slot('2026-07-01', 'C1', 'p1', 'weekday')],
    });
    expect(t.coveredSpan!.workingDays).toBe(5);
    // No assignment falls INSIDE the span, so all 5 days are off days — the
    // out-of-span call must not explain any of them.
    expect(t.providers.get('p1')!.offDaysUsed).toBe(5);
    // The call itself is still counted: callTotal is not scoped to the span
    // (computeScheduleActuals is called unconditionally over the whole year).
    expect(t.providers.get('p1')!.callTotal).toBe(1);
  });

  it('does not let a sell-back cancel an UNRELATED sick-day explanation on the same date', () => {
    // The PTO is sold back (removed from PTO-netting — the day is owed
    // again), but the provider was ALSO sick that day. nonEntitlementAbsenceDates
    // explains the date independently of ptoWeekdaysCovered's sell-back
    // override — they are separate contributors to the union, not a pipeline
    // where selling back a day cancels an unrelated sickness explanation too.
    const t = computeAnnualTally({
      ...base,
      coveredSpans: [{ date_start: '2026-06-08', date_end: '2026-06-12' }],
      availability: [
        pto('2026-06-09', '2026-06-09'),
        { ...pto('2026-06-09', '2026-06-09'), availability_type: 'pto_sellback' },
        {
          provider_id: 'p1', availability_type: 'sick',
          start_date: '2026-06-09', end_date: '2026-06-09', approval_status: 'approved',
        },
      ],
    });
    // 5 working days, 06-09 explained via sick (not via the sold-back PTO) ->
    // 4 off days, not 5.
    expect(t.providers.get('p1')!.offDaysUsed).toBe(4);
  });

  it('lists provider ids with published calls but no roster profile, without losing the count anywhere else', () => {
    const t = computeAnnualTally({
      ...base,
      profiles: [profile({ provider_id: 'p1' })], // p9 is NOT in the roster
      slots: [slot('2026-06-08', 'C1', 'p9', 'weekday')],
    });
    expect(t.unrosteredProviderIds).toEqual(['p9']);
    expect(t.providers.has('p9')).toBe(false);
  });
});
