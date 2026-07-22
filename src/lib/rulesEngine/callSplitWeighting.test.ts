// Call splits (2026-07-22): WEIGHTED engine seed counting + manual_only
// exclusion. Segments (patch35 shift types: parent_call_code + fractional
// call_burden_weight, manual_only true) are NEVER placed by the engine, but
// seeded/manual segment assignments must be SEEN correctly: they count toward
// buckets/fairness/obligations/provider-caps under the PARENT code at their
// weight, and the overnight segment's post-call rest binds in solve state.
// Every path defaults to weight 1 / parent = own code, so unsplit schedules
// are byte-identical (the fillAllPlan golden + parity pins are the guard).
import { describe, it, expect } from 'vitest';
import { solve, seedSolveState } from './solve';
import { totalExpectedCalls, computeObligations } from './obligation';
import { tallyCallsByPidCode, planWithinCallCaps, buildCallCaps } from './providerCaps';
import { loadGenerationContext } from './genContext';
import { CLASSIC_PATTERN } from './callPattern';
import { WEEKEND_V2_PATTERN } from './patterns/weekendV2';
import { makeFakeSupabase, type TableCfg } from './__fixtures__/fakeSupabase';
import { buildCtx, prov, callSlot, shiftInfo } from './__fixtures__/buildContext';
import type { GenerationContext, SeedAssignment, ShiftTypeInfo } from './genTypes';

// ── shared segment shift-type fixtures ──────────────────────────────────────

const segTypes = (): Map<string, ShiftTypeInfo> => new Map([
  ['C1', shiftInfo('C1', { category: 'call', call_rank: 0, generation_engine: 'call', requires_post_call_rule: true })],
  ['C2', shiftInfo('C2', { category: 'call', call_rank: 1, generation_engine: 'call' })],
  ['C1D12', shiftInfo('C1D12', { category: 'call', call_rank: 0, generation_engine: 'call', manual_only: true, call_burden_weight: 0.5, parent_call_code: 'C1' })],
  ['C1N12', shiftInfo('C1N12', { category: 'call', call_rank: 0, generation_engine: 'call', manual_only: true, call_burden_weight: 0.5, parent_call_code: 'C1', requires_post_call_rule: true })],
  ['C2D12', shiftInfo('C2D12', { category: 'call', call_rank: 1, generation_engine: 'call', manual_only: true, call_burden_weight: 0.5, parent_call_code: 'C2' })],
  ['C2N12', shiftInfo('C2N12', { category: 'call', call_rank: 1, generation_engine: 'call', manual_only: true, call_burden_weight: 0.5, parent_call_code: 'C2' })],
  ['C1N8', shiftInfo('C1N8', { category: 'call', call_rank: 0, generation_engine: 'call', manual_only: true, call_burden_weight: 0.3333, parent_call_code: 'C1', requires_post_call_rule: true })],
]);

const seed = (pid: string, date: string, code: string, dt = 'weekday', over: Partial<SeedAssignment> = {}): SeedAssignment => ({
  slot_date: date, provider_id: pid, shift_type_code: code,
  shift_type_category: 'call', derived_day_type: dt, ...over,
});

// ── seedSolveState — parent-coded, weighted seed counting ───────────────────

describe('seedSolveState — segment seeds count under the PARENT code at their weight', () => {
  it('a C1N12 seed adds 0.5 to the C1 bucket (never a C1N12 bucket) and a call date', () => {
    const ctx = buildCtx([], [prov('p1')], {
      shiftTypes: segTypes(),
      seedAssignments: [seed('p1', '2026-01-10', 'C1N12', 'saturday')],
    });
    const state = seedSolveState(ctx, CLASSIC_PATTERN);
    expect(state.bucketAssigned.get('p1|saturday|C1')).toBe(0.5);
    expect([...state.bucketAssigned.keys()].some(k => k.includes('C1N12'))).toBe(false);
    expect(state.callDatesByProvider.get('p1')).toEqual(['2026-01-10']);
  });

  it('two half-seeds (day + night, different providers) each count 0.5 under C1', () => {
    const ctx = buildCtx([], [prov('p1'), prov('p2')], {
      shiftTypes: segTypes(),
      seedAssignments: [
        seed('p1', '2026-01-07', 'C1D12'),
        seed('p2', '2026-01-07', 'C1N12'),
      ],
    });
    const state = seedSolveState(ctx, CLASSIC_PATTERN);
    expect(state.bucketAssigned.get('p1|weekday|C1')).toBe(0.5);
    expect(state.bucketAssigned.get('p2|weekday|C1')).toBe(0.5);
  });

  it('whole-call seeds keep counting exactly 1 (unsplit pin)', () => {
    const ctx = buildCtx([], [prov('p1')], {
      shiftTypes: segTypes(),
      seedAssignments: [seed('p1', '2026-01-07', 'C1')],
    });
    const state = seedSolveState(ctx, CLASSIC_PATTERN);
    expect(state.bucketAssigned.get('p1|weekday|C1')).toBe(1);
  });
});

describe('seedSolveState — post-call rest goes to the OVERNIGHT segment holder only', () => {
  it('a seeded C1 OVERNIGHT segment (requires_post_call_rule, no chain data of its own) rides the PARENT C1 +1 block', () => {
    const ctx = buildCtx([], [prov('p1')], {
      shiftTypes: segTypes(),
      seedAssignments: [seed('p1', '2026-01-07', 'C1N12')], // Wed night
    });
    const state = seedSolveState(ctx, CLASSIC_PATTERN); // C1 weekday blocks +1
    expect(state.assignedOnDate.get('2026-01-08')?.has('p1')).toBe(true);
    expect(state.blockedOnDate.get('2026-01-08')?.has('p1')).toBe(true);
  });

  it('a seeded C1 DAY segment (requires_post_call_rule false) blocks nothing', () => {
    const ctx = buildCtx([], [prov('p1')], {
      shiftTypes: segTypes(),
      seedAssignments: [seed('p1', '2026-01-07', 'C1D12')],
    });
    const state = seedSolveState(ctx, CLASSIC_PATTERN);
    expect(state.assignedOnDate.get('2026-01-08')?.has('p1')).toBeFalsy();
    expect(state.blockedOnDate.get('2026-01-08')?.has('p1')).toBeFalsy();
  });

  it('a seeded C2 OVERNIGHT segment whose code HAS dayChain data (patch35 +1 D1) mirrors C2 — no block', () => {
    // The patch35 doc gives C2N12 its own +1 D1 chain; like a seeded C2, the
    // next day is D1 duty (a fill link), never a hard block.
    const doc = {
      ...WEEKEND_V2_PATTERN,
      dayChains: [
        ...WEEKEND_V2_PATTERN.dayChains,
        { trigger: 'C2N12', dayTypes: ['weekday', 'friday', 'federal_holiday', 'major_holiday'] as Array<'weekday' | 'friday' | 'federal_holiday' | 'major_holiday'>, links: [{ offset: 1, code: 'D1' }] },
      ],
    };
    const ctx = buildCtx([], [prov('p1')], {
      shiftTypes: segTypes(),
      seedAssignments: [seed('p1', '2026-01-07', 'C2N12')],
    });
    const state = seedSolveState(ctx, doc);
    expect(state.blockedOnDate.get('2026-01-08')?.has('p1')).toBeFalsy();
  });
});

// ── obligation census — weighted ────────────────────────────────────────────

describe('totalExpectedCalls / computeObligations — weighted call census', () => {
  it('open manual-only segment slots (ctx.manualCallSlots) and segment seeds count at weight', () => {
    // 2 whole open C1 + one open 0.5 segment + one seeded 0.5 segment = 3.0
    // weighted call slots. Pool p1+p2 (2.0 FTE), par 2 → expected 1.5 each.
    const s1 = callSlot('s1', '2026-01-05', 'C1');
    const s2 = callSlot('s2', '2026-01-06', 'C1');
    const seg = callSlot('seg-open', '2026-01-07', 'C1D12');
    const ctx = buildCtx([s1, s2], [prov('p1'), prov('p2')], {
      parLevel: 2,
      shiftTypes: segTypes(),
      manualCallSlots: [seg],
      seedAssignments: [seed('p1', '2026-01-07', 'C1N12')],
    });
    const expected = totalExpectedCalls(ctx);
    expect(expected.get('p1')).toBeCloseTo(1.5, 9);
    expect(computeObligations(ctx).get('p1')).toBe(2); // round-half-up
  });

  it('all-weights-1 inputs are unchanged (unsplit pin)', () => {
    const ctx = buildCtx([callSlot('s1', '2026-01-05', 'C1')], [prov('p1')], {
      parLevel: 1,
      seedAssignments: [seed('p1', '2026-01-06', 'C1')],
    });
    expect(totalExpectedCalls(ctx).get('p1')).toBeCloseTo(2, 9);
  });
});

// ── provider caps — parent mapping + fractional room ────────────────────────

describe('provider-limit call caps — segment seeds consume the PARENT cap at weight', () => {
  const capCtx = (seeds: SeedAssignment[], openSlots = 1): GenerationContext => {
    const slots = [];
    for (let i = 0; i < openSlots; i++) {
      slots.push(callSlot(`c1-${i}`, `2026-01-${String(12 + i).padStart(2, '0')}`, 'C1'));
    }
    return buildCtx(slots, [prov('p1')], {
      shiftTypes: segTypes(),
      seedAssignments: seeds,
      providerLimits: { p1: { calls: { C1: 2 } } },
    });
  };

  it('cap C1=2 with two 0.5 segment seeds (1.0 consumed) still admits a whole C1', () => {
    const plan = solve(capCtx([
      seed('p1', '2026-01-05', 'C1D12'),
      seed('p1', '2026-01-06', 'C1N12'),
    ]));
    expect(plan.assignments.filter(a => a.shift_type_code === 'C1')).toHaveLength(1);
    expect(plan.unfilled).toHaveLength(0);
  });

  it('cap C1=2 with 1.5 consumed refuses the whole C1 (1.5 + 1 > 2) — slot stays open provider-cap', () => {
    const plan = solve(capCtx([
      seed('p1', '2026-01-05', 'C1D12'),
      seed('p1', '2026-01-06', 'C1N12'),
      seed('p1', '2026-01-08', 'C1N8'), // 0.3333 → 1.3333… still fits; add a 0.5 twice instead
      seed('p1', '2026-01-09', 'C1D12'),
    ]));
    // consumed = 0.5+0.5+0.3333+0.5 = 1.8333 → room 0.1667 < 1 → refuse
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unfilled).toHaveLength(1);
    expect(plan.unfilled[0].reason).toBe('provider-cap');
  });

  it('tallyCallsByPidCode maps segment seeds to the parent code at weight when given shiftTypes', () => {
    const tally = tallyCallsByPidCode([], [
      seed('p1', '2026-01-05', 'C1D12'),
      seed('p1', '2026-01-06', 'C1N12'),
      seed('p1', '2026-01-07', 'C1'),
    ], segTypes());
    expect(tally.get('p1|C1')).toBeCloseTo(2, 9);
    expect([...tally.keys()].some(k => k.includes('C1D12'))).toBe(false);
  });

  it('planWithinCallCaps respects weighted seeds (2.0 consumed is within cap 2; 2.5 is not)', () => {
    const caps = buildCallCaps({ p1: { calls: { C1: 2 } } })!;
    const within = planWithinCallCaps(caps, { assignments: [] }, [
      seed('p1', '2026-01-05', 'C1D12'), seed('p1', '2026-01-06', 'C1N12'),
      seed('p1', '2026-01-07', 'C1'),
    ], segTypes());
    expect(within).toBe(true);
    const over = planWithinCallCaps(caps, { assignments: [] }, [
      seed('p1', '2026-01-05', 'C1D12'), seed('p1', '2026-01-06', 'C1N12'),
      seed('p1', '2026-01-07', 'C1'), seed('p1', '2026-01-08', 'C2D12'),
      seed('p1', '2026-01-09', 'C1N12'),
    ], segTypes());
    expect(over).toBe(false); // C1 weight = 2.5 > 2 (the C2 segment is not a C1)
  });
});

// ── obligatory fill mode — fractional cap room ──────────────────────────────

describe('obligatory mode — segment seeds consume the rounded obligation at weight', () => {
  it('a 0.5 segment seed leaves no room for a whole call under obligation 1', () => {
    // par 2, pool 2×1.0 FTE, weighted slots = 2 whole + 0.5 seed = 2.5 →
    // expected 1.25 each → obligation 1 each. p1 already carries 0.5 → a whole
    // call would total 1.5 > 1 → p1 refused; p2 takes one (and is post-call
    // blocked for the adjacent day); the other stays open 'obligation-cap'.
    // Seed sits at 01-09 so no hard gate (post-call/same-date) masks the cap.
    const ctx = buildCtx(
      [callSlot('a', '2026-01-05', 'C1'), callSlot('b', '2026-01-06', 'C1')],
      [prov('p1'), prov('p2')],
      {
        parLevel: 2,
        shiftTypes: segTypes(),
        seedAssignments: [seed('p1', '2026-01-09', 'C1N12')],
      },
    );
    const plan = solve(ctx, { fillMode: 'obligatory' });
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].provider_id).toBe('p2');
    expect(plan.unfilled).toHaveLength(1);
    expect(plan.unfilled[0].reason).toBe('obligation-cap');
  });
});

// ── genContext — manual_only exclusion + weighted totals ────────────────────

const SITE = 'site1';
const SEG_SHIFT_TYPES = [
  { code: 'C1', category: 'call', call_rank: 0, relief_rank: null, is_overlay: false, generation_engine: 'call', requires_post_call_rule: true, call_coverage_type: null, manual_only: false, call_burden_weight: 1, parent_call_code: null },
  { code: 'C1D12', category: 'call', call_rank: 0, relief_rank: null, is_overlay: false, generation_engine: 'call', requires_post_call_rule: false, call_coverage_type: null, manual_only: true, call_burden_weight: 0.5, parent_call_code: 'C1' },
  { code: 'C1N12', category: 'call', call_rank: 0, relief_rank: null, is_overlay: false, generation_engine: 'call', requires_post_call_rule: true, call_coverage_type: null, manual_only: true, call_burden_weight: 0.5, parent_call_code: 'C1' },
];

function segRawSlot(o: {
  id: string; date: string; code: string;
  assignments?: Array<{ id: string; provider_id: string | null }>;
}) {
  return {
    id: o.id, slot_date: o.date, shift_type_id: `st-${o.code}`,
    provider_group: 'physician', required_count: 1, locked: false,
    derived_day_type: 'weekday', site_id: SITE,
    shift_types: { code: o.code, category: 'call' },
    assignments: o.assignments ?? [],
  };
}

function segTables(over: Record<string, TableCfg> = {}): Record<string, TableCfg> {
  return {
    schedule_slots: { data: [
      segRawSlot({ id: 'w1', date: '2026-01-07', code: 'C1' }),
      segRawSlot({ id: 'g1', date: '2026-01-08', code: 'C1D12' }),
      segRawSlot({ id: 'g2', date: '2026-01-08', code: 'C1N12', assignments: [{ id: 'a-g2', provider_id: 'p1' }] }),
    ], error: null },
    schedule_versions: { data: { schedule_id: 'sched1' }, error: null },
    sites: { data: { call_par_level: 1 }, error: null },
    shift_types: { data: SEG_SHIFT_TYPES, error: null },
    call_patterns: { data: null, error: null },
    provider_employment_profiles: { data: [
      { provider_id: 'p1', fte_value: 1.0, home_site_id: SITE, call_taker: true, partial_call_taker: false, available_weekdays: null },
    ], error: null },
    providers: { data: [{ id: 'p1', provider_type: 'physician', short_display_name: 'DOCA', status: 'active' }], error: null },
    provider_site_credentials: { data: [], error: null },
    provider_availability: { data: [], error: null },
    assignments: { data: [], error: null },
    schedules: { data: { provider_limits: null }, error: null },
    holiday_calendars: { data: [], error: null },
    ...over,
  };
}

describe('loadGenerationContext — manual_only call slots are NEVER in slotsToFill (the engine never places segments)', () => {
  it('excludes open manual-only segment slots from slotsToFill, records them on ctx.manualCallSlots, keeps them in slotIndex', async () => {
    const { sb } = makeFakeSupabase({ tables: segTables() });
    const res = await loadGenerationContext(sb, 'ver1');
    expect(res.ctx).toBeTruthy();
    const ctx = res.ctx!;
    expect(ctx.slotsToFill.map(s => s.slot_id)).toEqual(['w1']);
    expect((ctx.manualCallSlots ?? []).map(s => s.slot_id)).toEqual(['g1']);
    // Still indexed (chain lookups etc.) — just never main-loop inventory.
    expect(ctx.slotIndex.get('2026-01-08')?.get('C1D12')?.slot_id).toBe('g1');
  });

  it('bucketTotals fold segments under the PARENT code at weight (open 0.5 + assigned 0.5 + whole 1 = 2 under weekday|C1)', async () => {
    const { sb } = makeFakeSupabase({ tables: segTables() });
    const res = await loadGenerationContext(sb, 'ver1');
    const totals = res.ctx!.bucketTotals;
    expect(totals.get('weekday|C1')).toBeCloseTo(2, 9);
    expect([...totals.keys()].some(k => k.includes('C1D12') || k.includes('C1N12'))).toBe(false);
  });

  it('segment seeds land in seedAssignments (the solve side counts them under the parent)', async () => {
    const { sb } = makeFakeSupabase({ tables: segTables() });
    const res = await loadGenerationContext(sb, 'ver1');
    const segSeed = res.ctx!.seedAssignments.find(s => s.shift_type_code === 'C1N12');
    expect(segSeed).toBeTruthy();
    expect(segSeed!.provider_id).toBe('p1');
  });

  it('historical RPC rows for segment codes fold under the parent at weight (2 × C1N12 = 1.0 of C1)', async () => {
    const { sb } = makeFakeSupabase({
      tables: segTables(),
      rpc: { historical_call_counts: { data: [
        { provider_id: 'p1', bucket: 'weekday', code: 'C1N12', n: 2 },
        { provider_id: 'p1', bucket: 'weekday', code: 'C1', n: 3 },
      ], error: null } },
    });
    const res = await loadGenerationContext(sb, 'ver1');
    expect(res.ctx!.historicalAssignedByPid.get('p1')?.get('weekday|C1')).toBeCloseTo(4, 9);
    expect(res.ctx!.historicalTotalByBucket.get('weekday|C1')).toBeCloseTo(4, 9);
  });

  it('pre-patch35 (missing weight columns) degrades to the patch18 select — engine columns intact, weights default 1', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: segTables({
      shift_types: (filters) => {
        const sel = (filters.find(f => f.method === 'select')?.args[0] as string) ?? '';
        if (sel.includes('call_burden_weight')) {
          return { data: null, error: { message: 'column shift_types.call_burden_weight does not exist', code: '42703' } };
        }
        return { data: SEG_SHIFT_TYPES.map(({ code, category, call_rank, relief_rank, is_overlay, generation_engine, requires_post_call_rule, call_coverage_type, manual_only }) =>
          ({ code, category, call_rank, relief_rank, is_overlay, generation_engine, requires_post_call_rule, call_coverage_type, manual_only })), error: null };
      },
    }) });
    const res = await loadGenerationContext(sb, 'ver1');
    // shiftTypes present (patch18 columns loaded), weights default to 1.
    expect(res.ctx!.shiftTypes?.get('C1')?.call_rank).toBe(0);
    expect(res.ctx!.shiftTypes?.get('C1D12')?.call_burden_weight).toBe(1);
    // Silent degradation — an absent column can hold no segments.
    expect((res.ctx!.warnings ?? []).some(w => w.includes('patch35'))).toBe(false);
    expect(calls.filter(c => c.table === 'shift_types' && c.method === 'select')).toHaveLength(2);
  });
});
