// lib/plannerMath — planner assembly math. Two layers of drift-proofing:
// by construction (every rule is IMPORTED from its single home) and by test
// (the cross-check blocks below feed the SAME inputs to plannerMath and to
// the engine helpers/census and require identical outputs).
import { describe, it, expect } from 'vitest';
import {
  MAX_PLANNER_RANGE_DAYS,
  aggregateTemplateSlotCounts,
  assignmentFills,
  callObligationFor,
  computeScheduleActuals,
  enumerateRange,
  estimateCallSlots,
  liveAvailabilityRows,
  providerDayStats,
  rangeComposition,
  rosterPoolFte,
  type PlannerAvailabilityRow,
  type PlannerSlotRow,
  type PlannerTemplateRow,
} from './plannerMath';
import {
  computeCallObligationCensus,
  fteWeightedTarget,
  roundedObligation,
  clampParToPoolFte,
} from './fteTarget';
import {
  entitledOffDays,
  ptoWeekdaysCovered,
  requiredWorkDays,
  workingDaysInRange,
} from './rulesEngine/workDays';
import { totalExpectedCalls, computeObligations } from './rulesEngine/obligation';
import type { GenerationContext } from './rulesEngine/genTypes';
import { derivedDayTypeFor, slateForDayType, templateSlotCount } from './templateSlots';
import { addDays } from './rulesEngine/shared';

// ── Fixtures ─────────────────────────────────────────────────────────────────

// January 2026: Jan 1 = Thursday (major holiday), Jan 19 = Monday (federal,
// minor — MLK). 22 weekdays, of which 21 are working days (majors excluded,
// federal minors worked). Day-type composition: 15 weekday, 5 friday,
// 5 saturday, 4 sunday, 1 major_holiday, 1 federal_holiday.
const JAN = { start: '2026-01-01', end: '2026-01-31' };
const JAN_HOLIDAYS = [
  { holiday_date: '2026-01-01', is_major_holiday: true },
  { holiday_date: '2026-01-19', is_major_holiday: false },
];

const tmplRow = (
  day_type: string,
  shift_type_id: string,
  code: string,
  category: string,
  required_count: number | null = 1,
): PlannerTemplateRow =>
  ({ day_type, shift_type_id, required_count, shift_types: { code, category } });

const avail = (over: Partial<PlannerAvailabilityRow> & Pick<PlannerAvailabilityRow, 'availability_type' | 'start_date' | 'end_date'>): PlannerAvailabilityRow =>
  ({ approval_status: 'approved', ...over });

// ── enumerateRange / rangeComposition ────────────────────────────────────────

describe('enumerateRange', () => {
  it('enumerates inclusive ranges; inverted ranges are empty', () => {
    expect(enumerateRange('2026-01-30', '2026-02-02')).toEqual([
      '2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02',
    ]);
    expect(enumerateRange('2026-02-02', '2026-01-30')).toEqual([]);
  });

  it(`throws past ${MAX_PLANNER_RANGE_DAYS} days — misuse is loud, never truncated`, () => {
    expect(() => enumerateRange('2026-01-01', addDays('2026-01-01', MAX_PLANNER_RANGE_DAYS)))
      .toThrow(/exceeds/);
    // Exactly at the cap is fine.
    expect(enumerateRange('2026-01-01', addDays('2026-01-01', MAX_PLANNER_RANGE_DAYS - 1)))
      .toHaveLength(MAX_PLANNER_RANGE_DAYS);
  });
});

describe('rangeComposition', () => {
  const comp = rangeComposition(JAN.start, JAN.end, JAN_HOLIDAYS);

  it('derives the day-type composition with holiday precedence', () => {
    expect(Object.fromEntries(comp.dayTypeCounts)).toEqual({
      major_holiday: 1, federal_holiday: 1, weekday: 15, friday: 5, saturday: 5, sunday: 4,
    });
  });

  it('working days = weekdays minus MAJOR holidays only (federal minors are worked)', () => {
    expect(comp.workingDays).toBe(21);
    expect(comp.workingDaySet.has('2026-01-01')).toBe(false); // major, Thursday
    expect(comp.workingDaySet.has('2026-01-19')).toBe(true);  // federal minor, Monday
    expect(comp.workingDaySet.has('2026-01-10')).toBe(false); // Saturday
  });

  it('CROSS-CHECK: workingDays equals the engine workingDaysInRange on identical inputs', () => {
    expect(comp.workingDays).toBe(workingDaysInRange(comp.dates, comp.majorHolidayDates));
  });
});

// ── Template aggregation + call-slot estimates ───────────────────────────────

describe('aggregateTemplateSlotCounts', () => {
  it('aggregates per (day_type, shift_type), keeping count-0 rows for Friday suppression', () => {
    const rows = [
      tmplRow('weekday', 'st-C1', 'C1', 'call', 1),
      tmplRow('weekday', 'st-C1', 'C1', 'call', 2),      // duplicate rows sum
      tmplRow('friday', 'st-C1', 'C1', 'call', 0),        // kept at 0
      tmplRow('weekday', 'st-D1', 'D1', 'regular', null), // null → 1
      { day_type: 'weekday', shift_type_id: 'st-X', required_count: 1, shift_types: null }, // orphan dropped
    ];
    expect(aggregateTemplateSlotCounts(rows)).toEqual([
      { day_type: 'friday', shift_type_id: 'st-C1', code: 'C1', category: 'call', count: 0 },
      { day_type: 'weekday', shift_type_id: 'st-C1', code: 'C1', category: 'call', count: 3 },
      { day_type: 'weekday', shift_type_id: 'st-D1', code: 'D1', category: 'regular', count: 1 },
    ]);
  });
});

describe('estimateCallSlots', () => {
  const RAW = [
    tmplRow('weekday', 'st-C1', 'C1', 'call', 1),
    tmplRow('weekday', 'st-C2', 'C2', 'call', 1),
    tmplRow('weekday', 'st-C3', 'C3', 'call', 0),   // suppressed on weekdays
    tmplRow('friday', 'st-C3', 'C3', 'call', 1),    // friday-specific C3
    tmplRow('friday', 'st-C1', 'C1', 'call', 0),    // friday row SUPPRESSES C1 on Fridays
    tmplRow('saturday', 'st-CS', 'C1', 'call', 1),
    tmplRow('sunday', 'st-CS', 'C1', 'call', 1),
    tmplRow('major_holiday', 'st-CH', 'C1', 'call', 2),
    tmplRow('weekday', 'st-D1', 'D1', 'regular', 3), // regular slots never count
  ];
  const agg = aggregateTemplateSlotCounts(RAW);
  const comp = rangeComposition(JAN.start, JAN.end, JAN_HOLIDAYS);
  const est = estimateCallSlots(agg, comp.dayTypeCounts);

  it('applies the Friday union, count-0 suppression and holiday day types per bucket', () => {
    expect(Object.fromEntries(est.byBucket)).toEqual({
      // weekday: 15 days × (C1 + C2) = 30
      weekday: 30,
      // friday: 5 days × (C3 friday + C2 weekday fill; C1 suppressed by count-0 friday row) = 10
      friday: 10,
      saturday: 5,
      sunday: 4,
      // major holiday Jan 1: 2 slots; federal Jan 19 has NO federal_holiday
      // template row → contributes nothing (both would lump into 'holiday').
      holiday: 2,
    });
    expect(est.total).toBe(51);
    expect(est.byBucketCode.get('friday|C2')).toEqual({ bucket: 'friday', code: 'C2', count: 5 });
    expect(est.byBucketCode.get('friday|C1')).toBeUndefined();
  });

  it('CROSS-CHECK: equals a per-date route-style materialization (slateForDayType + templateSlotCount over every date)', () => {
    // Simulate exactly what the schedules POST does with the RAW rows, date
    // by date, counting call-category slots — the aggregate-level estimate
    // must match the row-level materialization.
    const holidayMap = new Map(JAN_HOLIDAYS.map(h => [h.holiday_date, h]));
    let simulatedTotal = 0;
    const simulatedByBucketCode = new Map<string, number>();
    for (const date of comp.dates) {
      const dayType = derivedDayTypeFor(date, holidayMap.get(date));
      for (const tmpl of slateForDayType(RAW, dayType)) {
        if (tmpl.shift_types?.category !== 'call') continue;
        const count = templateSlotCount(tmpl);
        simulatedTotal += count;
        if (count > 0) {
          const bucket = dayType === 'major_holiday' || dayType === 'federal_holiday' ? 'holiday' : dayType;
          const key = `${bucket}|${tmpl.shift_types.code}`;
          simulatedByBucketCode.set(key, (simulatedByBucketCode.get(key) ?? 0) + count);
        }
      }
    }
    expect(est.total).toBe(simulatedTotal);
    expect(new Map([...est.byBucketCode].map(([k, v]) => [k, v.count]))).toEqual(simulatedByBucketCode);
  });
});

// ── Call obligation assembly ─────────────────────────────────────────────────

describe('callObligationFor + rosterPoolFte', () => {
  const profiles = [
    { provider_id: 'a', home_site_id: 'site-1', call_taker: true, partial_call_taker: false, fte_value: 1 },
    { provider_id: 'b', home_site_id: 'site-1', call_taker: false, partial_call_taker: true, fte_value: 0.6 },
    { provider_id: 'c', home_site_id: 'site-1', call_taker: false, partial_call_taker: false, fte_value: 1 },   // day doc — not pool
    { provider_id: 'd', home_site_id: 'site-2', call_taker: true, partial_call_taker: false, fte_value: 1 },    // other site
    { provider_id: 'e', home_site_id: 'site-1', call_taker: true, partial_call_taker: false, fte_value: null }, // null fte → 1
  ];

  it('rosterPoolFte mirrors the census default pool (home-site call/partial takers, fte||1)', () => {
    expect(rosterPoolFte(profiles, 'site-1')).toBeCloseTo(2.6, 10); // a(1) + b(0.6) + e(1)
  });

  it('hand-computed pin: 40 slots, par 10, pool 12 → fte 0.8 expects 3.2, obligation 3', () => {
    const est = callObligationFor(40, 10, 12, 0.8);
    expect(est.effectivePar).toBe(10);           // pool above par: no clamp
    expect(est.totalExpected).toBeCloseTo(3.2, 10);
    expect(est.obligation).toBe(3);
  });

  it('par clamps DOWN to pool ΣFTE, never up (live-data shape: par 12, pool 2.6)', () => {
    const est = callObligationFor(26, 12, 2.6, 1);
    expect(est.effectivePar).toBeCloseTo(2.6, 10);
    expect(est.totalExpected).toBeCloseTo(10, 10);
    expect(est.effectivePar).toBe(clampParToPoolFte(12, 2.6));
  });

  it('CROSS-CHECK: identical to computeCallObligationCensus on the same slot census', () => {
    const slots = Array.from({ length: 17 }, (_, i) => ({
      slot_date: addDays('2026-01-01', i),
      shift_types: { category: 'call', code: 'C1' },
      assignments: [],
    }));
    const census = computeCallObligationCensus({
      storedParLevel: 12, siteId: 'site-1', profiles, slots,
    });
    for (const pid of ['a', 'b', 'c', 'e']) {
      const est = callObligationFor(census.totalCallSlots, 12, census.poolFte, census.fteFor(pid));
      expect(est.effectivePar).toBe(census.effectivePar);
      expect(est.totalExpected).toBe(census.totalExpectedFor(pid));
      expect(est.obligation).toBe(roundedObligation(census.totalExpectedFor(pid)));
    }
  });

  it('CROSS-CHECK: identical to the ENGINE obligation math (rulesEngine/obligation.ts) on the same context', () => {
    // Minimal GenerationContext slice — totalExpectedCalls touches only
    // parLevel/providers/slotsToFill/seedAssignments.
    const ctx = {
      parLevel: 12,
      providers: [
        { id: 'a', fte_value: 1 },
        { id: 'b', fte_value: 0.6 },
        { id: 'e', fte_value: 1 },
      ],
      slotsToFill: Array.from({ length: 15 }, () => ({ required_count: 1 })),
      seedAssignments: [
        { shift_type_category: 'call' },
        { shift_type_category: 'regular' }, // never a call slot
      ],
    } as unknown as GenerationContext;
    const engineExpected = totalExpectedCalls(ctx); // 16 call slots, effectivePar = min(12, 2.6)
    const engineObligations = computeObligations(ctx);
    const poolFte = 1 + 0.6 + 1;
    for (const [pid, expected] of engineExpected) {
      const fte = ctx.providers.find(p => p.id === pid)!.fte_value;
      const est = callObligationFor(16, 12, poolFte, fte);
      expect(est.totalExpected).toBe(expected);
      expect(est.obligation).toBe(engineObligations.get(pid));
    }
  });

  it('per-bucket expected stays the raw fteWeightedTarget (no rounding at bucket level)', () => {
    // The card's per-bucket mini-table is fractional by contract; pin that the
    // assembly path for a bucket is exactly fteWeightedTarget.
    expect(fteWeightedTarget(5, 2.6, 0.6)).toBeCloseTo((5 / 2.6) * 0.6, 12);
  });
});

// ── Working-days assembly ────────────────────────────────────────────────────

describe('providerDayStats', () => {
  const comp = rangeComposition(JAN.start, JAN.end, JAN_HOLIDAYS);
  const rows: PlannerAvailabilityRow[] = [
    avail({ availability_type: 'pto', start_date: '2026-01-05', end_date: '2026-01-09' }),      // Mon–Fri: 5 weekdays
    avail({ availability_type: 'pto', start_date: '2026-01-13', end_date: '2026-01-13', approval_status: 'pending' }), // pending NETS
    avail({ availability_type: 'pto', start_date: '2026-01-14', end_date: '2026-01-14', approval_status: 'denied' }),  // ignored
    avail({ availability_type: 'sick', start_date: '2026-01-12', end_date: '2026-01-12' }),     // sick never nets
    avail({ availability_type: 'pto_sellback', start_date: '2026-01-08', end_date: '2026-01-09' }), // restores 2
  ];

  it('nets PTO through the engine ptoWeekdaysCovered (sell-back restores, pending counts)', () => {
    const stats = providerDayStats(0.8, comp.workingDaySet, rows);
    expect(stats.ptoWeekdays).toBe(4); // 5 + 1 pending − 2 sold back
    expect(stats.workingDays).toBe(21);
    expect(stats.required).toBe(13);   // round(0.8×21)=17 − 4
    expect(stats.entitledOff).toBe(4); // 21 − 17
  });

  it('CROSS-CHECK: identical to the engine helpers on the same inputs', () => {
    const stats = providerDayStats(0.8, comp.workingDaySet, rows);
    const pto = ptoWeekdaysCovered(rows, comp.workingDaySet).size;
    expect(stats.ptoWeekdays).toBe(pto);
    expect(stats.required).toBe(requiredWorkDays(0.8, comp.workingDays, pto));
    expect(stats.entitledOff).toBe(entitledOffDays(0.8, comp.workingDays));
  });

  it('what-if extra PTO and hypothetical sell-back adjust the netted count (floored at 0)', () => {
    const base = providerDayStats(0.8, comp.workingDaySet, rows);
    const extra = providerDayStats(0.8, comp.workingDaySet, rows, { extraPtoWeekdays: 2 });
    expect(extra.ptoWeekdays).toBe(base.ptoWeekdays + 2);
    expect(extra.required).toBe(requiredWorkDays(0.8, 21, base.ptoWeekdays + 2));
    const sold = providerDayStats(0.8, comp.workingDaySet, rows, { sellbackWeekdays: 10 });
    expect(sold.ptoWeekdays).toBe(0); // floored
    expect(sold.required).toBe(requiredWorkDays(0.8, 21, 0));
    // entitledOff is PTO-independent by contract.
    expect(sold.entitledOff).toBe(base.entitledOff);
  });
});

// ── Draft-schedule actuals ───────────────────────────────────────────────────

describe('computeScheduleActuals', () => {
  const comp = rangeComposition(JAN.start, JAN.end, JAN_HOLIDAYS);

  const slot = (
    slot_date: string,
    code: string,
    category: string,
    provider_id: string | null,
    over: Partial<PlannerSlotRow> & { assignment_status?: string; requires_post_call_rule?: boolean } = {},
  ): PlannerSlotRow => ({
    slot_date,
    derived_day_type: over.derived_day_type,
    shift_types: { code, category, requires_post_call_rule: over.requires_post_call_rule ?? false },
    assignments: provider_id === null ? [] : [{
      provider_id, assignment_status: over.assignment_status ?? 'assigned',
    }],
  });

  it('counts filled call assignments by (bucket|code); open/canceled/declined never count', () => {
    const slots = [
      slot('2026-01-05', 'C1', 'call', 'a', { derived_day_type: 'weekday' }),
      slot('2026-01-09', 'C2', 'call', 'a', { derived_day_type: 'friday' }),
      slot('2026-01-10', 'C1', 'call', 'a', { derived_day_type: 'saturday' }),
      slot('2026-01-06', 'C1', 'call', null),                                     // open
      slot('2026-01-07', 'C1', 'call', 'a', { assignment_status: 'canceled' }),
      slot('2026-01-08', 'C1', 'call', 'a', { assignment_status: 'declined' }),
    ];
    const out = computeScheduleActuals(slots, [], comp.workingDaySet, JAN_HOLIDAYS);
    expect(out.a.callCounts).toEqual([
      { bucket: 'friday', code: 'C2', count: 1 },
      { bucket: 'saturday', code: 'C1', count: 1 },
      { bucket: 'weekday', code: 'C1', count: 1 },
    ]);
    // assignmentFills is the same predicate the dashboard rollup uses.
    expect(assignmentFills({ provider_id: 'a', assignment_status: 'canceled' })).toBe(false);
    expect(assignmentFills({ provider_id: null, assignment_status: 'assigned' })).toBe(false);
  });

  it('missing derived_day_type falls back to the single-homed holiday-aware derivation', () => {
    const slots = [slot('2026-01-01', 'C1', 'call', 'a')]; // Jan 1 = major holiday, no stored day type
    const out = computeScheduleActuals(slots, [], comp.workingDaySet, JAN_HOLIDAYS);
    expect(out.a.callCounts).toEqual([{ bucket: 'holiday', code: 'C1', count: 1 }]);
    expect(out.a.assignedWorkdays).toEqual([]); // major holiday is not a working day
  });

  it('accepts the one-to-one assignments embed shape (single object, not array)', () => {
    const single: PlannerSlotRow = {
      slot_date: '2026-01-05',
      derived_day_type: 'weekday',
      shift_types: { code: 'D1', category: 'regular' },
      assignments: { provider_id: 'a', assignment_status: 'assigned' },
    };
    const out = computeScheduleActuals([single], [], comp.workingDaySet, JAN_HOLIDAYS);
    expect(out.a.assignedWorkdays).toEqual(['2026-01-05']);
    expect(out.a.callCounts).toEqual([]); // regular shift never a call count
  });

  it('post-call rest = next working day after requires_post_call_rule calls, disjoint from assigned days', () => {
    const slots = [
      // Mon Jan 5 C2 → Tue Jan 6 rest.
      slot('2026-01-05', 'C2', 'call', 'a', { derived_day_type: 'weekday', requires_post_call_rule: true }),
      // Wed Jan 7 C2, but provider ALSO works Thu Jan 8 → rest not counted (assigned wins).
      slot('2026-01-07', 'C2', 'call', 'a', { derived_day_type: 'weekday', requires_post_call_rule: true }),
      slot('2026-01-08', 'D1', 'regular', 'a', { derived_day_type: 'weekday' }),
      // Fri Jan 9 C2 → Saturday: not a working day, no rest credit.
      slot('2026-01-09', 'C2', 'call', 'a', { derived_day_type: 'friday', requires_post_call_rule: true }),
      // Sat Jan 31 C2 → Feb 1 is outside the range's working-day set: clipped.
      slot('2026-01-30', 'C2', 'call', 'a', { derived_day_type: 'friday', requires_post_call_rule: true }),
      // Non-post-call call (beeper-style) earns no rest.
      slot('2026-01-12', 'CB', 'call', 'a', { derived_day_type: 'weekday', requires_post_call_rule: false }),
    ];
    const out = computeScheduleActuals(slots, [], comp.workingDaySet, JAN_HOLIDAYS);
    expect(out.a.postCallRestWorkdays).toEqual(['2026-01-06']);
    expect(out.a.assignedWorkdays).toEqual([
      '2026-01-05', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-12', '2026-01-30',
    ]);
  });

  it('ICU-credited working days come from the engine classifier and stay disjoint from assigned/post-call', () => {
    const slots = [
      slot('2026-01-05', 'C2', 'call', 'a', { derived_day_type: 'weekday', requires_post_call_rule: true }),
      slot('2026-01-07', 'D1', 'regular', 'a', { derived_day_type: 'weekday' }),
    ];
    const availability: PlannerAvailabilityRow[] = [
      // ICU week Mon Jan 5 – Sun Jan 11 for provider a: working days 5,6,7,8,9
      // minus assigned (5,7) minus post-call rest (6) → credits 8,9.
      avail({ provider_id: 'a', availability_type: 'blocked', reason_code: 'icu_week', start_date: '2026-01-05', end_date: '2026-01-11' }),
      // ICU post-call Monday for provider b (no assignments at all).
      avail({ provider_id: 'b', availability_type: 'blocked', reason_code: 'icu_post_call', start_date: '2026-01-12', end_date: '2026-01-12' }),
      // Plain blocked (no ICU reason) and denied ICU rows credit nothing.
      avail({ provider_id: 'b', availability_type: 'blocked', start_date: '2026-01-13', end_date: '2026-01-13' }),
      avail({ provider_id: 'b', availability_type: 'blocked', reason_code: 'icu_week', start_date: '2026-01-14', end_date: '2026-01-14', approval_status: 'denied' }),
    ];
    const out = computeScheduleActuals(slots, availability, comp.workingDaySet, JAN_HOLIDAYS);
    expect(out.a.postCallRestWorkdays).toEqual(['2026-01-06']);
    expect(out.a.icuWorkdays).toEqual(['2026-01-08', '2026-01-09']);
    expect(out.b.icuWorkdays).toEqual(['2026-01-12']);
    expect(out.b.assignedWorkdays).toEqual([]);
  });
});

// ── Availability payload hygiene ─────────────────────────────────────────────

describe('liveAvailabilityRows', () => {
  it('drops denied/canceled, keeps pending/approved/waitlisted (engine status semantics)', () => {
    const rows = ['approved', 'pending', 'waitlisted', 'denied', 'canceled'].map(s =>
      avail({ availability_type: 'pto', start_date: '2026-01-05', end_date: '2026-01-05', approval_status: s }));
    expect(liveAvailabilityRows(rows).map(r => r.approval_status)).toEqual([
      'approved', 'pending', 'waitlisted',
    ]);
  });
});
