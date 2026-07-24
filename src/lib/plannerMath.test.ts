// lib/plannerMath — planner assembly math. Two layers of drift-proofing:
// by construction (every rule is IMPORTED from its single home) and by test
// (the cross-check blocks below feed the SAME inputs to plannerMath and to
// the engine helpers/census and require identical outputs).
import { describe, it, expect } from 'vitest';
import {
  MAX_PLANNER_RANGE_DAYS,
  aggregateTemplateSlotCounts,
  assignmentFills,
  buildPlannerContext,
  callObligationFor,
  computeScheduleActuals,
  enumerateRange,
  estimateCallSlots,
  liveAvailabilityRows,
  plannerYearCounters,
  providerDayStats,
  providerPlannerNumbers,
  rangeComposition,
  rosterPoolFte,
  type PlannerAvailabilityRow,
  type PlannerPayload,
  type PlannerRosterEntry,
  type PlannerSlotRow,
  type PlannerTemplateRow,
} from './plannerMath';
import {
  computeCallObligationCensus,
  extraCalls,
  fteWeightedTarget,
  roundedObligation,
} from './fteTarget';
import { countDaysInYear, ptoCounterStats } from './dateRanges';
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

  it('hand-computed pin: 40 slots, par 10 → fte 0.8 expects 3.2, obligation 3', () => {
    const est = callObligationFor(40, 10, 0.8);
    expect(est.totalExpected).toBeCloseTo(3.2, 10);
    expect(est.obligation).toBe(3);
  });

  it('par-authoritative (2026-07-24, re-pinned): par 12 over pool ΣFTE 2.6 divides by 12, not 2.6', () => {
    // Was: clamped to 2.6 → 26/2.6 × 1 = 10. Now: 26/12 × 1 = 2.167 → 2 —
    // the uncovered remainder is the paid-pickup layer.
    const est = callObligationFor(26, 12, 1);
    expect(est.totalExpected).toBeCloseTo(26 / 12, 10);
    expect(est.obligation).toBe(2);
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
    // The census's obligation weight is POOL-scoped (poolFteFor: 0 for the
    // day doc 'c' — 2026-07-22). callObligationFor stays FTE-parametric by
    // design (the planner's what-if asks "at this FTE, what's the share"), so
    // the identity holds when fed the same weight the census uses.
    expect(census.effectivePar).toBe(12); // par-authoritative — pool 2.6 does not clamp
    for (const pid of ['a', 'b', 'c', 'e']) {
      const est = callObligationFor(census.totalCallSlots, 12, census.poolFteFor(pid));
      expect(est.totalExpected).toBe(census.totalExpectedFor(pid));
      expect(est.obligation).toBe(roundedObligation(census.totalExpectedFor(pid)));
    }
    expect(census.poolFteFor('c')).toBe(0); // day doc — owes no calls
    expect(census.fteFor('c')).toBe(1);     // real FTE intact for workday math
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
    const engineExpected = totalExpectedCalls(ctx); // 16 call slots at the stored par 12 (par-authoritative)
    const engineObligations = computeObligations(ctx);
    for (const [pid, expected] of engineExpected) {
      const fte = ctx.providers.find(p => p.id === pid)!.fte_value;
      const est = callObligationFor(16, 12, fte);
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

// ── Card-level assembly (payload → per-physician numbers) ────────────────────

const rosterEntry = (
  provider_id: string,
  fte_value: number | null,
  over: Partial<PlannerRosterEntry> = {},
): PlannerRosterEntry => ({
  provider_id,
  first_name: 'F',
  last_name: provider_id.toUpperCase(),
  short_display_name: null,
  initials: null,
  provider_type: 'physician',
  fte_value,
  home_site_id: 'site-1',
  call_taker: true,
  partial_call_taker: false,
  is_day_doc: false,
  is_icu_doc: false,
  ...over,
});

describe('buildPlannerContext + providerPlannerNumbers', () => {
  // C1 call every day type present in January (no holiday templates):
  // 15 weekday + 5 friday + 5 saturday + 4 sunday = 29 call slots.
  const TEMPLATES = aggregateTemplateSlotCounts([
    tmplRow('weekday', 'st-C1', 'C1', 'call', 1),
    tmplRow('friday', 'st-C1', 'C1', 'call', 1),
    tmplRow('saturday', 'st-C1', 'C1', 'call', 1),
    tmplRow('sunday', 'st-C1', 'C1', 'call', 1),
    tmplRow('weekday', 'st-D1', 'D1', 'regular', 3), // regular: never a call slot
  ]);

  const payload: PlannerPayload = {
    site: { id: 'site-1', name: 'Main', call_par_level: 12, call_par_level_stored: 12 },
    range: { date_start: JAN.start, date_end: JAN.end },
    holidays: JAN_HOLIDAYS,
    templates: TEMPLATES,
    roster: [
      rosterEntry('a', 1),
      rosterEntry('b', 0.6),
      rosterEntry('c', 1, { call_taker: false }), // day doc — outside the pool
      rosterEntry('e', null),                     // null fte → census coerces to 1
    ],
    availability: [
      avail({ provider_id: 'b', availability_type: 'pto', start_date: '2026-01-05', end_date: '2026-01-09' }), // 5 weekdays
    ],
    actuals: null,
  };
  const ctx = buildPlannerContext(payload);

  it('context singles-home the pool, composition and estimate (cross-checked)', () => {
    expect(ctx.census.poolFte).toBeCloseTo(2.6, 10); // a(1) + b(0.6) + e(null→1)
    expect(ctx.census.poolFte).toBe(rosterPoolFte(payload.roster, 'site-1'));
    expect(ctx.composition.workingDays).toBe(workingDaysInRange(ctx.composition.dates, ctx.composition.majorHolidayDates));
    expect(ctx.callEstimate.total).toBe(29);
    expect(ctx.availabilityByPid.get('b')).toHaveLength(1);
    expect(ctx.availabilityByPid.has('a')).toBe(false);
  });

  it('CROSS-CHECK: current numbers are exactly the engine-helper composition on identical inputs', () => {
    const n = providerPlannerNumbers(ctx, 'b');
    // Par-authoritative (2026-07-24, re-pinned): the denominator is the stored
    // par 12 verbatim — the pool ΣFTE (2.6) no longer clamps it.
    expect(n.fte).toBe(0.6);
    expect(n.parLevel).toBe(12);
    expect(n.totalExpected).toBe(fteWeightedTarget(29, 12, 0.6));
    expect(n.obligation).toBe(roundedObligation(n.totalExpected));
    // Per-bucket expected is the raw fteWeightedTarget of that bucket's slots…
    for (const b of n.buckets) {
      expect(b.expected).toBe(fteWeightedTarget(b.slots, 12, 0.6));
    }
    // …and sums back to the total by linearity.
    const summed = n.buckets.reduce((acc, b) => acc + b.expected, 0);
    expect(summed).toBeCloseTo(n.totalExpected, 10);
    // Days side routes through providerDayStats (itself engine-pinned above).
    const pto = ptoWeekdaysCovered(payload.availability, ctx.composition.workingDaySet).size;
    expect(n.days.ptoWeekdays).toBe(pto);
    expect(n.days.required).toBe(requiredWorkDays(0.6, ctx.composition.workingDays, pto));
    expect(n.days.entitledOff).toBe(entitledOffDays(0.6, ctx.composition.workingDays));
  });

  it('without actuals every assigned-side figure is null (estimate, not a fake zero)', () => {
    const n = providerPlannerNumbers(ctx, 'b');
    expect(n.hasActuals).toBe(false);
    expect(n.assignedCalls).toBeNull();
    expect(n.remainingCalls).toBeNull();
    expect(n.extra).toBeNull();
    expect(n.credited).toBeNull();
    expect(n.dayDelta).toBeNull();
    expect(n.buckets.every(b => b.assigned === null)).toBe(true);
  });

  it('what-if overrides replace exactly one input each, through the same formulas', () => {
    // (poolFte override removed 2026-07-24 — par-authoritative made it dead.)
    const wi = providerPlannerNumbers(ctx, 'b', {
      fte: 1, parLevel: 10, extraPtoWeekdays: 2,
    });
    expect(wi.parLevel).toBe(10); // the authoritative denominator
    expect(wi.totalExpected).toBe(fteWeightedTarget(29, 10, 1));
    expect(wi.obligation).toBe(roundedObligation(wi.totalExpected));
    expect(wi.days.ptoWeekdays).toBe(7); // 5 real + 2 hypothetical
    expect(wi.days.required).toBe(requiredWorkDays(1, ctx.composition.workingDays, 7));
    expect(wi.days.entitledOff).toBe(entitledOffDays(1, ctx.composition.workingDays));
    // Hypothetical sell-back removes netted days (floored at 0 upstream).
    const sold = providerPlannerNumbers(ctx, 'b', { sellbackWeekdays: 5 });
    expect(sold.days.ptoWeekdays).toBe(0);
  });

  it('census fte coercion applies (null fte → 1), matching the engine profile load', () => {
    const n = providerPlannerNumbers(ctx, 'e');
    expect(n.fte).toBe(1);
    expect(n.totalExpected).toBe(fteWeightedTarget(29, n.parLevel, 1));
  });

  it('wires actuals: assigned/remaining/extras + credited breakdown + day delta', () => {
    const withActuals: PlannerPayload = {
      ...payload,
      actuals: {
        schedule: { id: 's1', schedule_name: 'Jan', status: 'draft', date_start: JAN.start, date_end: JAN.end, version_number: 1 },
        byProvider: {
          b: {
            callCounts: [
              { bucket: 'weekday', code: 'C1', count: 2 },
              { bucket: 'saturday', code: 'C1', count: 1 },
              // A bucket the templates produce NO slots for must still render.
              { bucket: 'holiday', code: 'CH', count: 1 },
            ],
            assignedWorkdays: ['2026-01-12', '2026-01-13'],
            postCallRestWorkdays: ['2026-01-14'],
            icuWorkdays: ['2026-01-15'],
          },
        },
      },
    };
    const actx = buildPlannerContext(withActuals);
    const n = providerPlannerNumbers(actx, 'b');
    expect(n.hasActuals).toBe(true);
    expect(n.assignedCalls).toBe(4);
    expect(n.remainingCalls).toBe(Math.max(0, n.obligation - 4));
    expect(n.extra).toBe(extraCalls(4, n.totalExpected)); // last-N convention count
    expect(n.credited).toEqual({ assignments: 2, postCall: 1, icu: 1, total: 4 });
    expect(n.dayDelta).toBe(4 - n.days.required);
    const byBucket = new Map(n.buckets.map(b => [b.bucket, b]));
    expect(byBucket.get('weekday')?.assigned).toBe(2);
    expect(byBucket.get('friday')?.assigned).toBe(0);
    expect(byBucket.get('holiday')).toEqual({ bucket: 'holiday', slots: 0, expected: 0, assigned: 1 });

    // Under a live schedule, a provider with no assignments shows genuine
    // zeros — the schedule exists and they have nothing (≠ the null case).
    const na = providerPlannerNumbers(actx, 'a');
    expect(na.assignedCalls).toBe(0);
    expect(na.credited).toEqual({ assignments: 0, postCall: 0, icu: 0, total: 0 });
    expect(na.dayDelta).toBe(0 - na.days.required);
  });
});

// ── Year counters (provider-profile parity) ──────────────────────────────────

describe('plannerYearCounters', () => {
  // 2026-03-02 = Monday (Jan 1 2026 is a Thursday).
  const rows: PlannerAvailabilityRow[] = [
    avail({ availability_type: 'pto', start_date: '2026-03-02', end_date: '2026-03-08' }),          // Mon–Sun: 5 wkd, 7 cal
    avail({ availability_type: 'pto_sellback', start_date: '2026-03-06', end_date: '2026-03-07' }), // Fri+Sat sold back
    avail({ availability_type: 'unavailable', start_date: '2026-04-01', end_date: '2026-04-03' }),  // 3 days off
    avail({ availability_type: 'sick', start_date: '2026-05-04', end_date: '2026-05-05' }),         // other: 2
    avail({ availability_type: 'blocked', start_date: '2026-06-10', end_date: '2026-06-10' }),      // other: 1
    avail({ availability_type: 'blocked', reason_code: 'icu_week', start_date: '2026-06-01', end_date: '2026-06-07' }), // ICU: excluded
    avail({ availability_type: 'no_call_request', start_date: '2026-06-15', end_date: '2026-06-15' }),                  // never counted
    avail({ availability_type: 'call_request', start_date: '2026-06-16', end_date: '2026-06-16' }),                     // never counted (2026-07-22 mirror)
    avail({ availability_type: 'pto', start_date: '2026-07-01', end_date: '2026-07-02', approval_status: 'denied' }),   // dismissed
  ];
  const out = plannerYearCounters(rows, 2026);

  it('CROSS-CHECK: PTO counter is exactly ptoCounterStats on the live pto/sell-back rows', () => {
    expect(out.pto).toEqual(ptoCounterStats(
      [{ start_date: '2026-03-02', end_date: '2026-03-08' }],
      [{ start_date: '2026-03-06', end_date: '2026-03-07' }],
      2026,
    ));
    // Headline INCLUDES sold-back days (Gabriel's sell-back semantics).
    expect(out.pto.weekdaysBooked).toBe(5);
    expect(out.pto.weekdaysSold).toBe(1); // the Friday (Saturday isn't a weekday)
    expect(out.pto.calendarBooked).toBe(7);
  });

  it('category counters mirror the profile page split (ICU + both request types excluded, dismissed dropped)', () => {
    expect(out.sellbackDays).toBe(countDaysInYear([{ start_date: '2026-03-06', end_date: '2026-03-07' }], 2026));
    expect(out.sellbackDays).toBe(2);
    expect(out.daysOffDays).toBe(3);
    expect(out.otherDays).toBe(3); // sick 2 + generic blocked 1; ICU rotation + no-call + call requests never count
  });
});
