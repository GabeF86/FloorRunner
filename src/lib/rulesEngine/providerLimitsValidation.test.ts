// Provider-limits validation (2026-07-22, patch34) — SOFT flags only, never
// hard, never blocking: an assignment set exceeding a STATED cap (per-code
// call count, or working days over the stated/derived max) flags softly so
// manual-edit overruns stay visible. Caps govern auto-generation; manual
// edits legitimately bypass them — the flag is the visibility, not a block.
import { describe, it, expect } from 'vitest';
import { evaluators } from './evaluators';
import { loadProviderLimitsValidationCtx } from './loadContext';
import type { SiteValidationContext } from './loadContext';
import { batchValidateVersion } from './batchValidate';
import { makeFakeSupabase, type TableCfg } from './__fixtures__/fakeSupabase';
import type { EvaluationContext, ShiftTypeRow, SlotRow } from './types';

// ── fixture builders (mirrors evaluators.test.ts) ────────────────────────────
// Dates: 2026-01-05 Mon … 2026-01-09 Fri, 10 Sat, 11 Sun.

function st(code: string, category: ShiftTypeRow['category'] = 'call'): ShiftTypeRow {
  return {
    id: `st-${code}`, site_id: 's1', code, name: code, category,
    requires_credential: null, requires_specific_skills: [], generation_engine: null,
  };
}
const SHIFT_TYPES = [st('C1'), st('C2'), st('D1', 'regular')];

function slot(over: Partial<SlotRow> = {}): SlotRow {
  return {
    id: 'slot1', site_id: 's1', slot_date: '2026-01-07',
    shift_type_id: 'st-C1', provider_group: 'physician',
    derived_day_type: 'weekday', ...over,
  };
}

function neighbor(date: string, code: string) {
  const t = SHIFT_TYPES.find(s => s.code === code)!;
  return {
    assignment_id: `n-${date}-${code}`, slot_date: date, shift_type_code: code,
    shift_type_category: t.category, day_type: 'weekday' as const,
  };
}

const WEEK_WORKING_DAYS = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];

function ctx(over: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    slot: slot(), shiftType: SHIFT_TYPES[0], providerId: 'p1',
    providerGroup: 'physician', credentials: null, fte_value: 1, poolFlags: null,
    neighborAssignments: [], availability: [], sameDayAssignments: [],
    crossSiteAssignments: [], scheduleVersionId: 'v1', rules: [],
    shiftTypesByCode: new Map(SHIFT_TYPES.map(s => [s.code, s])),
    shiftTypesById: new Map(SHIFT_TYPES.map(s => [s.id, s])),
    ...over,
  };
}

function plcCtx(over: Partial<NonNullable<EvaluationContext['providerLimitsCtx']>> = {}) {
  return {
    limits: { p1: { calls: { C1: 1 } } },
    blockStart: '2026-01-05',
    blockEnd: '2026-01-11',
    workingDaySet: new Set(WEEK_WORKING_DAYS),
    workingDaysCapByProvider: new Map<string, number>(),
    ...over,
  };
}

const limitFlags = (c: EvaluationContext) =>
  evaluators.flatMap(e => e(c)).filter(v => /provider limit/i.test(v.rule_name));

describe('providerLimits evaluator — per-code call cap', () => {
  it('soft-flags every same-code call assignment once the block count exceeds the stated cap', () => {
    const c = ctx({
      providerLimitsCtx: plcCtx(),
      neighborAssignments: [neighbor('2026-01-05', 'C1')], // second C1 in block
    });
    const flags = limitFlags(c);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('soft');
    expect(flags[0].message).toMatch(/2 C1/);
    expect(flags[0].message).toMatch(/max 1/i);
  });

  it('AT the cap is clean', () => {
    const c = ctx({ providerLimitsCtx: plcCtx() }); // this slot is the only C1
    expect(limitFlags(c)).toHaveLength(0);
  });

  it('other codes and non-call slots never trip a C1 cap', () => {
    const asC2 = ctx({
      shiftType: SHIFT_TYPES[1], slot: slot({ shift_type_id: 'st-C2' }),
      providerLimitsCtx: plcCtx(),
      neighborAssignments: [neighbor('2026-01-05', 'C2'), neighbor('2026-01-06', 'C2')],
    });
    expect(limitFlags(asC2)).toHaveLength(0);
    const asD1 = ctx({
      shiftType: SHIFT_TYPES[2], slot: slot({ shift_type_id: 'st-D1' }),
      providerLimitsCtx: plcCtx(),
    });
    expect(limitFlags(asD1)).toHaveLength(0);
  });

  it('no limits context / no provider / no entry for this provider → clean', () => {
    expect(limitFlags(ctx())).toHaveLength(0);
    expect(limitFlags(ctx({ providerId: null, providerLimitsCtx: plcCtx() }))).toHaveLength(0);
    expect(limitFlags(ctx({
      providerLimitsCtx: plcCtx({ limits: { OTHER: { calls: { C1: 0 } } } }),
    }))).toHaveLength(0);
  });
});

describe('providerLimits evaluator — working-days cap', () => {
  it('soft-flags a working-day assignment when distinct assigned working days exceed the stated cap', () => {
    const c = ctx({
      providerLimitsCtx: plcCtx({
        limits: { p1: { workingDays: 1 } },
        workingDaysCapByProvider: new Map([['p1', 1]]),
      }),
      neighborAssignments: [neighbor('2026-01-05', 'C2')], // a second assigned working day
    });
    const flags = limitFlags(c);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('soft');
    expect(flags[0].message).toMatch(/2 working days?/i);
    expect(flags[0].message).toMatch(/max 1/i);
  });

  it('a weekend assignment consumes no working day and never flags', () => {
    const c = ctx({
      slot: slot({ slot_date: '2026-01-10', derived_day_type: 'saturday' }),
      providerLimitsCtx: plcCtx({
        limits: { p1: { workingDays: 0 } },
        workingDaysCapByProvider: new Map([['p1', 0]]),
      }),
    });
    expect(limitFlags(c)).toHaveLength(0);
  });

  it('AT the cap is clean (dedupe: two same-day assignments are one working day)', () => {
    const c = ctx({
      providerLimitsCtx: plcCtx({
        limits: { p1: { workingDays: 1 } },
        workingDaysCapByProvider: new Map([['p1', 1]]),
      }),
      neighborAssignments: [neighbor('2026-01-07', 'D1')], // same date as the slot
    });
    expect(limitFlags(c)).toHaveLength(0);
  });
});

// ── loadProviderLimitsValidationCtx — the shared loader (serial + batch) ─────
// version → schedule_id → schedules.provider_limits/date_start/date_end/org →
// major holidays → (daysOff providers only) block availability for netting.
// Degradation: missing column / no row / no limits / any load failure → null
// (feature off — a soft advisory quietly absent, never a crash or a partial
// cap set).

describe('loadProviderLimitsValidationCtx', () => {
  // May 2026 block (Fri 5/22 → Fri 5/29): 6 weekdays minus Memorial Day 5/25
  // = 5 working days. p1 PTO Tue 5/26 + Wed 5/27 nets 2.
  const loaderTables = (over: Record<string, TableCfg> = {}): Record<string, TableCfg> => ({
    schedule_versions: { data: { schedule_id: 'sched1' }, error: null },
    schedules: { data: {
      provider_limits: { p1: { daysOff: 1, calls: { C1: 2 } }, p2: { workingDays: 1 } },
      date_start: '2026-05-22', date_end: '2026-05-29', organization_id: 'org1',
    }, error: null },
    holiday_calendars: {
      data: [{ holiday_date: '2026-05-25', holiday_name: 'Memorial Day', is_major_holiday: true }],
      error: null,
    },
    provider_availability: { data: [
      { provider_id: 'p1', availability_type: 'pto', start_date: '2026-05-26', end_date: '2026-05-27', approval_status: 'approved' },
    ], error: null },
    ...over,
  });

  it('resolves limits, the block working-day set, and both cap entry modes', async () => {
    const { sb } = makeFakeSupabase({ tables: loaderTables() });
    const { ctx: plc } = await loadProviderLimitsValidationCtx(sb, 'v1');
    expect(plc).toBeTruthy();
    expect(plc!.limits.p1).toEqual({ daysOff: 1, calls: { C1: 2 } });
    expect(plc!.blockStart).toBe('2026-05-22');
    expect(plc!.blockEnd).toBe('2026-05-29');
    expect(plc!.workingDaySet.size).toBe(5);
    expect(plc!.workingDaySet.has('2026-05-25')).toBe(false); // major holiday
    // p1 daysOff 1 → 5 − 2 pto − 1 = 2; p2 workingDays 1 → 1 as entered.
    expect(plc!.workingDaysCapByProvider.get('p1')).toBe(2);
    expect(plc!.workingDaysCapByProvider.get('p2')).toBe(1);
  });

  it('missing provider_limits column (pre-patch34) → null, no throw', async () => {
    const { sb } = makeFakeSupabase({ tables: loaderTables({
      schedules: { data: null, error: { message: 'column schedules.provider_limits does not exist' } },
    }) });
    const { ctx: plc } = await loadProviderLimitsValidationCtx(sb, 'v1');
    expect(plc).toBeNull();
  });

  it('no stated limits → null (feature off)', async () => {
    const { sb } = makeFakeSupabase({ tables: loaderTables({
      schedules: { data: { provider_limits: null, date_start: '2026-05-22', date_end: '2026-05-29', organization_id: 'org1' }, error: null },
    }) });
    const { ctx: plc } = await loadProviderLimitsValidationCtx(sb, 'v1');
    expect(plc).toBeNull();
  });

  it('malformed limits → null (never a partial cap set)', async () => {
    const { sb } = makeFakeSupabase({ tables: loaderTables({
      schedules: { data: { provider_limits: { p1: { calls: { C1: -1 } } }, date_start: '2026-05-22', date_end: '2026-05-29', organization_id: 'org1' }, error: null },
    }) });
    const { ctx: plc } = await loadProviderLimitsValidationCtx(sb, 'v1');
    expect(plc).toBeNull();
  });
});

// ── batchValidate threads the limits context (parity home: same loader) ──────
describe('batchValidateVersion — provider limits soft flags', () => {
  const st_ = (code: string): ShiftTypeRow => ({
    id: `st-${code}`, site_id: 's1', code, name: code, category: 'call',
    requires_credential: null, requires_specific_skills: [], generation_engine: null,
  });
  const siteCtx: SiteValidationContext = {
    shiftTypesById: new Map([['st-C1', st_('C1')]]),
    shiftTypesByCode: new Map([['C1', st_('C1')]]),
    rules: [],
  };
  const batchSlot = (id: string, date: string, aid: string) => ({
    id, site_id: 's1', slot_date: date, shift_type_id: 'st-C1',
    provider_group: 'physician', derived_day_type: 'weekday',
    schedule_version_id: 'v1', required_count: 1,
    assignments: [{ id: aid, provider_id: 'p1', assignment_status: 'assigned' }],
  });
  const joinedRow = (aid: string, slotId: string, date: string) => ({
    id: aid, provider_id: 'p1', schedule_slot_id: slotId, assignment_status: 'assigned',
    schedule_slots: {
      id: slotId, slot_date: date, shift_type_id: 'st-C1',
      derived_day_type: 'weekday', site_id: 's1', schedule_version_id: 'v1',
      schedule_versions: { version_status: 'draft' },
    },
  });

  it('two C1 calls against a stated max of 1 soft-flag through the batch path', async () => {
    const { sb } = makeFakeSupabase({ tables: {
      schedule_slots: { data: [
        batchSlot('sA', '2026-01-05', 'a1'),
        batchSlot('sB', '2026-01-07', 'a2'),
      ], error: null },
      providers: { data: [{ id: 'p1', provider_type: 'physician', provider_employment_profiles: { fte_value: 1 } }], error: null },
      provider_availability: { data: [], error: null },
      provider_site_credentials: { data: [], error: null },
      assignments: { data: [joinedRow('a1', 'sA', '2026-01-05'), joinedRow('a2', 'sB', '2026-01-07')], error: null },
      schedule_versions: { data: { schedule_id: 'sched1' }, error: null },
      schedules: { data: {
        provider_limits: { p1: { calls: { C1: 1 } } },
        date_start: '2026-01-01', date_end: '2026-01-31', organization_id: 'org1',
      }, error: null },
      holiday_calendars: { data: [], error: null },
    } });
    const batch = await batchValidateVersion(sb, 'v1', siteCtx);
    expect(batch.results).toHaveLength(2);
    for (const r of batch.results) {
      expect(r.evaluated).toBe(true);
      expect(r.violations).toEqual(expect.arrayContaining([
        expect.objectContaining({ rule_name: 'Provider limit (calls)', severity: 'soft' }),
      ]));
    }
  });
});

// ── call splits (2026-07-22): WEIGHTED, PARENT-MAPPED call caps ─────────────
// A segment assignment counts against the PARENT code's stated cap at its
// fractional call_burden_weight (a C1N12 = 0.5 of C1). Whole calls keep
// weight 1 / their own code — pre-split behavior byte for byte.

describe('providerLimits evaluator — weighted parent-mapped segments', () => {
  const segSt = (code: string, weight: number, parent: string): ShiftTypeRow => ({
    ...st(code), call_burden_weight: weight, parent_call_code: parent,
  });
  const SEG_TYPES = [...SHIFT_TYPES, segSt('C1N12', 0.5, 'C1'), segSt('C1D12', 0.5, 'C1')];
  const segCtx = (over: Partial<EvaluationContext> = {}): EvaluationContext => ctx({
    shiftTypesByCode: new Map(SEG_TYPES.map(s => [s.code, s])),
    shiftTypesById: new Map(SEG_TYPES.map(s => [s.id, s])),
    ...over,
  });
  const segNeighbor = (date: string, code: string) => ({
    assignment_id: `n-${date}-${code}`, slot_date: date, shift_type_code: code,
    shift_type_category: 'call', day_type: 'weekday' as const,
  });

  it('a 0.5 segment on top of two whole C1s exceeds cap 2 (2.5 > 2) and the message shows the fractional count', () => {
    const c = segCtx({
      shiftType: SEG_TYPES.find(s => s.code === 'C1N12')!,
      slot: slot({ shift_type_id: 'st-C1N12' }),
      providerLimitsCtx: plcCtx({ limits: { p1: { calls: { C1: 2 } } } }),
      neighborAssignments: [segNeighbor('2026-01-05', 'C1'), segNeighbor('2026-01-06', 'C1')],
    });
    const flags = limitFlags(c);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('soft');
    expect(flags[0].message).toMatch(/2\.5 C1/);
  });

  it('a 0.5 segment plus one whole C1 stays within cap 2 (1.5) — clean', () => {
    const c = segCtx({
      shiftType: SEG_TYPES.find(s => s.code === 'C1N12')!,
      slot: slot({ shift_type_id: 'st-C1N12' }),
      providerLimitsCtx: plcCtx({ limits: { p1: { calls: { C1: 2 } } } }),
      neighborAssignments: [segNeighbor('2026-01-05', 'C1')],
    });
    expect(limitFlags(c)).toHaveLength(0);
  });

  it('segment NEIGHBORS fold under the parent cap too: whole C1 evaluated + three 0.5 segments = 2.5 > 2', () => {
    const c = segCtx({
      providerLimitsCtx: plcCtx({ limits: { p1: { calls: { C1: 2 } } } }),
      neighborAssignments: [
        segNeighbor('2026-01-05', 'C1N12'), segNeighbor('2026-01-06', 'C1D12'),
        segNeighbor('2026-01-08', 'C1N12'),
      ],
    });
    const flags = limitFlags(c);
    expect(flags).toHaveLength(1);
    expect(flags[0].message).toMatch(/2\.5 C1/);
  });

  it('two half segments exactly AT the cap with a whole call (2.0 vs cap 2) are clean', () => {
    const c = segCtx({
      providerLimitsCtx: plcCtx({ limits: { p1: { calls: { C1: 2 } } } }),
      neighborAssignments: [segNeighbor('2026-01-05', 'C1N12'), segNeighbor('2026-01-06', 'C1D12')],
    });
    expect(limitFlags(c)).toHaveLength(0);
  });
});

// Open-slot warnings are category-keyed, so an OPEN call SEGMENT gets the
// same soft open-call flag a whole call does (design: existing unfilled-call
// warnings apply to segments as-is).
describe('openSlot evaluator — call segments inherit the open-call warning', () => {
  it('an open C1N12 segment slot soft-flags exactly like an open C1', () => {
    const segShiftType: ShiftTypeRow = {
      ...st('C1N12'), call_burden_weight: 0.5, parent_call_code: 'C1',
    };
    const c = ctx({
      providerId: null,
      shiftType: segShiftType,
      slot: slot({ shift_type_id: 'st-C1N12' }),
    });
    const flags = evaluators.flatMap(e => e(c)).filter(v => v.rule_name === 'Open slot');
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('soft');
    expect(flags[0].message).toContain('C1N12');
  });
});
