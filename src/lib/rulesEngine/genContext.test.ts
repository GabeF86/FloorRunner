import { describe, it, expect } from 'vitest';
import { emptySolveState } from './genTypes';
import { loadGenerationContext, computeBucketTargets } from './genContext';
import { buildPrePtoByThursday } from './shared';
import { CLASSIC_PATTERN } from './callPattern';
import type {
  CandidateProvider, AssignmentExplanation, CandidateRejection, SolutionMetrics,
  AvailabilityEntry, SlotToFill,
} from './genTypes';

describe('emptySolveState', () => {
  it('creates independent empty state', () => {
    const a = emptySolveState();
    const b = emptySolveState();
    a.bucketAssigned.set('x', 1);
    expect(b.bucketAssigned.size).toBe(0);
    expect(a.assignedOnDate.size).toBe(0);
    expect(a.handledSlotIds.size).toBe(0);
    expect(a.callDatesByProvider.size).toBe(0);
  });
});

function prov(id: string, fte: number): CandidateProvider {
  return {
    id, provider_type: 'physician', short_display_name: id, fte_value: fte,
    home_site_id: 'site1', available_weekdays: [true, true, true, true, true, true, true],
  };
}

describe('computeBucketTargets', () => {
  it('computes FTE-weighted base share with par level', () => {
    const targets = computeBucketTargets(
      new Map([['weekday|C1', 12]]),
      new Map(),
      new Map(),
      [prov('p1', 1), prov('p2', 0.5)],
      12,
    );
    expect(targets.get('p1|weekday|C1')).toBeCloseTo(1.0);
    expect(targets.get('p2|weekday|C1')).toBeCloseTo(0.5);
  });

  it('adds historical deficit so under-allocated part-timers catch up', () => {
    const targets = computeBucketTargets(
      new Map([['weekday|C1', 12]]),
      new Map([['weekday|C1', 24]]),
      new Map([['p1', new Map([['weekday|C1', 0]])]]),
      [prov('p1', 0.5)],
      12,
    );
    expect(targets.get('p1|weekday|C1')).toBeCloseTo(1.5);
  });

  it('never lets historical over-allocation shrink the base', () => {
    const targets = computeBucketTargets(
      new Map([['weekday|C1', 12]]),
      new Map([['weekday|C1', 12]]),
      new Map([['p1', new Map([['weekday|C1', 99]])]]),
      [prov('p1', 1)],
      12,
    );
    expect(targets.get('p1|weekday|C1')).toBeCloseTo(1.0);
  });
});

describe('phase 2a types', () => {
  it('AssignmentExplanation / CandidateRejection / SolutionMetrics are constructible', () => {
    const e: AssignmentExplanation = {
      ratioAtAssignment: 1.5, daysSinceLastCall: 7, competingCandidates: 3,
    };
    const c: CandidateRejection = {
      provider_id: 'p1', provider_name: 'DOCA', reason: 'bucket-quota',
    };
    const m: SolutionMetrics = {
      filled: 10, skipped: 1, fairnessStdev: 0.25, burnout: 0, providersUsed: 4,
    };
    expect(e.competingCandidates).toBe(3);
    expect(c.reason).toBe('bucket-quota');
    expect(m.fairnessStdev).toBeCloseTo(0.25);
  });
});

// ── buildPrePtoByThursday (pure helper shared by genContext + solve) ─────────
describe('buildPrePtoByThursday', () => {
  it('maps the prior-week Thursday to providers with approved blocking leave', () => {
    const providers: CandidateProvider[] = [prov('p1', 1)];
    const avail = new Map<string, AvailabilityEntry[]>([
      ['p1', [{ availability_type: 'pto', start_date: '2026-01-14', end_date: '2026-01-16', approval_status: 'approved' }]],
    ]);
    // 2026-01-14 is a Wed → week Mon 01-12 → Thursday of the PRIOR week = 01-08.
    const slotIndex = new Map<string, Map<string, SlotToFill>>([['2026-01-08', new Map()]]);
    const out = buildPrePtoByThursday(providers, avail, slotIndex);
    expect(out.get('2026-01-08')!.has('p1')).toBe(true);
  });

  it('includes pending leave — pending blocks everywhere so it also drives placement (spec §6.7)', () => {
    const providers: CandidateProvider[] = [prov('p1', 1)];
    const avail = new Map<string, AvailabilityEntry[]>([
      ['p1', [{ availability_type: 'pto', start_date: '2026-01-14', end_date: '2026-01-16', approval_status: 'pending' }]],
    ]);
    const slotIndex = new Map<string, Map<string, SlotToFill>>([['2026-01-08', new Map()]]);
    expect(buildPrePtoByThursday(providers, avail, slotIndex).get('2026-01-08')!.has('p1')).toBe(true);
  });

  it('ignores denied and canceled leave', () => {
    const providers: CandidateProvider[] = [prov('p1', 1)];
    for (const status of ['denied', 'canceled']) {
      const avail = new Map<string, AvailabilityEntry[]>([
        ['p1', [{ availability_type: 'pto', start_date: '2026-01-14', end_date: '2026-01-16', approval_status: status }]],
      ]);
      const slotIndex = new Map<string, Map<string, SlotToFill>>([['2026-01-08', new Map()]]);
      expect(buildPrePtoByThursday(providers, avail, slotIndex).size).toBe(0);
    }
  });

  it('ignores non-blocking availability types', () => {
    const providers: CandidateProvider[] = [prov('p1', 1)];
    const avail = new Map<string, AvailabilityEntry[]>([
      ['p1', [{ availability_type: 'preference', start_date: '2026-01-14', end_date: '2026-01-16', approval_status: 'approved' }]],
    ]);
    const slotIndex = new Map<string, Map<string, SlotToFill>>([['2026-01-08', new Map()]]);
    expect(buildPrePtoByThursday(providers, avail, slotIndex).size).toBe(0);
  });
});

// ── loadGenerationContext (I/O) — driven by a chainable recording fake ───────

type Canned = { data?: unknown; error?: unknown };
type Filter = { method: string; args: unknown[] };
type TableCfg = Canned | ((filters: Filter[]) => Canned);
interface RecordedCall { table?: string; fn?: string; method: string; args: unknown[] }

/**
 * Minimal chainable recording fake mirroring genContext's real call shapes:
 *   from().select().eq().in().or().lt().lte().gte().neq().order().single()/.maybeSingle()
 *   rpc(fn, params)
 * Every method records {table/fn, method, args}. Terminal awaits resolve the
 * table's canned {data,error} (computed lazily so a fn-config can branch on the
 * recorded filters — e.g. wide-vs-narrow select for the patch18 column guard).
 */
function makeFakeSupabase(config: { tables?: Record<string, TableCfg>; rpc?: Record<string, Canned> }) {
  const calls: RecordedCall[] = [];
  const tables = config.tables ?? {};
  const rpcCfg = config.rpc ?? {};

  function makeBuilder(table: string) {
    const filters: Filter[] = [];
    const cfg = tables[table];
    const resolve = (): { data: unknown; error: unknown } => {
      const c: Canned = typeof cfg === 'function' ? cfg(filters) : (cfg ?? { data: [], error: null });
      return { data: c.data ?? null, error: c.error ?? null };
    };
    const rec = (method: string, args: unknown[]) => {
      filters.push({ method, args });
      calls.push({ table, method, args });
    };
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'in', 'or', 'lt', 'lte', 'gte', 'order']) {
      builder[m] = (...args: unknown[]) => { rec(m, args); return builder; };
    }
    builder.single = (...args: unknown[]) => { rec('single', args); return Promise.resolve(resolve()); };
    builder.maybeSingle = (...args: unknown[]) => { rec('maybeSingle', args); return Promise.resolve(resolve()); };
    builder.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onF, onR);
    return builder;
  }

  const sb = {
    from: (table: string) => makeBuilder(table),
    rpc: (fn: string, params: unknown) => {
      calls.push({ fn, method: 'rpc', args: [params] });
      const c = rpcCfg[fn] ?? { data: [], error: null };
      return Promise.resolve({ data: c.data ?? null, error: c.error ?? null });
    },
  };
  return { sb, calls };
}

function rawSlot(o: {
  id: string; date: string; code: string; category: string;
  required?: number; locked?: boolean; dayType?: string;
  assignments?: Array<{ id: string; provider_id: string | null; assignment_status?: string }>;
}) {
  return {
    id: o.id, slot_date: o.date, shift_type_id: `st-${o.code}`,
    provider_group: 'physician', required_count: o.required ?? 1,
    locked: o.locked ?? false, derived_day_type: o.dayType ?? 'weekday',
    site_id: 'site1', shift_types: { code: o.code, category: o.category },
    assignments: o.assignments ?? [],
  };
}

const BASE_PROFILES = [
  { provider_id: 'p1', fte_value: 1.0, home_site_id: 'site1', call_taker: true, partial_call_taker: false, available_weekdays: null },
  { provider_id: 'p2', fte_value: 0.5, home_site_id: 'site1', call_taker: true, partial_call_taker: false, available_weekdays: null },
];
const BASE_PROVIDERS = [
  { id: 'p1', provider_type: 'physician', short_display_name: 'DOCA', status: 'active' },
  { id: 'p2', provider_type: 'physician', short_display_name: 'DOCB', status: 'active' },
];
const BASE_CREDS = [
  { provider_id: 'p1', is_active: true, credentialed: true, can_take_call: true, can_take_weekend_call: true, can_take_holiday_call: true, allowed_shift_types: [], excluded_shift_types: [], skill_tags: [] },
  { provider_id: 'p2', is_active: true, credentialed: true, can_take_call: true, can_take_weekend_call: true, can_take_holiday_call: true, allowed_shift_types: [], excluded_shift_types: [], skill_tags: [] },
];
const BASE_SHIFT_TYPES = [
  { code: 'C1', category: 'call', call_rank: 0, relief_rank: null, is_overlay: false, generation_engine: 'call', requires_post_call_rule: true, call_coverage_type: 'trauma' },
  { code: 'C2', category: 'call', call_rank: 1, relief_rank: null, is_overlay: false, generation_engine: 'call', requires_post_call_rule: true, call_coverage_type: null },
  { code: 'D1', category: 'derived', call_rank: null, relief_rank: null, is_overlay: false, generation_engine: 'call', requires_post_call_rule: false, call_coverage_type: null },
  { code: 'D4', category: 'derived', call_rank: null, relief_rank: 1, is_overlay: false, generation_engine: 'call', requires_post_call_rule: false, call_coverage_type: null },
];

function baseTables(over: Record<string, TableCfg> = {}): Record<string, TableCfg> {
  return {
    // par_level 1 keeps Σ(FTE-target) ≥ bucket totals so the quota warning
    // stays quiet unless a test deliberately raises the par level.
    schedule_slots: { data: [rawSlot({ id: 's1', date: '2026-01-07', code: 'C1', category: 'call' })], error: null },
    sites: { data: { call_par_level: 1 }, error: null },
    shift_types: { data: BASE_SHIFT_TYPES, error: null },
    call_patterns: { data: null, error: null },
    provider_employment_profiles: { data: BASE_PROFILES, error: null },
    providers: { data: BASE_PROVIDERS, error: null },
    provider_site_credentials: { data: BASE_CREDS, error: null },
    provider_availability: { data: [], error: null },
    assignments: { data: [], error: null },
    ...over,
  };
}

async function run(over: Record<string, TableCfg> = {}, rpc: Record<string, Canned> = {}) {
  const { sb, calls } = makeFakeSupabase({ tables: baseTables(over), rpc });
  const res = await loadGenerationContext(sb, 'ver1');
  return { res, calls };
}

describe('loadGenerationContext — shift types (requirement 1)', () => {
  it('loads full shift_types rows into ctx.shiftTypes keyed by code', async () => {
    const { res } = await run();
    expect(res.ctx).toBeTruthy();
    const st = res.ctx!.shiftTypes!;
    expect(st.get('C1')).toEqual({
      code: 'C1', category: 'call', call_rank: 0, relief_rank: null,
      is_overlay: false, generation_engine: 'call',
      requires_post_call_rule: true, call_coverage_type: 'trauma',
    });
    expect(st.get('C2')!.call_rank).toBe(1);
    expect(st.get('D4')!.relief_rank).toBe(1);
  });

  it('leaves ctx.shiftTypes undefined when engine columns are missing (pre-patch18)', async () => {
    // A present-but-rank-less map would make solve's reliefCodesFor() return []
    // and silently kill the relief pass. Undefined engages the documented
    // legacy fallbacks (LEGACY_RELIEF_CODES, call-rank literals) uniformly.
    const { res } = await run({
      shift_types: (filters) => {
        const sel = (filters.find(f => f.method === 'select')?.args[0] as string) ?? '';
        if (sel.includes('call_rank')) {
          return { data: null, error: { message: 'column shift_types.call_rank does not exist', code: '42703' } };
        }
        return { data: [{ code: 'C1', category: 'call' }, { code: 'D4', category: 'derived' }], error: null };
      },
    });
    expect(res.ctx!.warnings).toContain('shift_types engine columns missing — apply patch18');
    expect(res.ctx!.shiftTypes).toBeUndefined();
  });

  it('degraded (columns-missing) mode still cross-checks the pattern against narrow-select codes', async () => {
    const pattern = {
      version: 1, blocks: [], spans: [], placementPasses: [], reliefPass: null,
      optimizerMovableDayTypes: [],
      dayChains: [{ trigger: 'ZZ', dayTypes: ['weekday'] }],
    };
    const { res } = await run({
      call_patterns: { data: { definition: pattern }, error: null },
      shift_types: (filters) => {
        const sel = (filters.find(f => f.method === 'select')?.args[0] as string) ?? '';
        if (sel.includes('call_rank')) {
          return { data: null, error: { message: 'column shift_types.call_rank does not exist', code: '42703' } };
        }
        return { data: [{ code: 'C1', category: 'call' }], error: null };
      },
    });
    expect(res.ctx!.shiftTypes).toBeUndefined();
    expect((res.ctx!.warnings ?? []).some(w => w.includes("'ZZ'") && w.includes('not defined'))).toBe(true);
  });

  it('non-column shift_types failure → undefined shiftTypes + warning with the error, no narrow retry', async () => {
    const { res, calls } = await run({
      shift_types: { data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } },
    });
    expect(res.ctx!.shiftTypes).toBeUndefined();
    expect((res.ctx!.warnings ?? []).some(w =>
      w.includes('shift_types') && w.includes('statement timeout'))).toBe(true);
    // Only the wide select was issued — no pointless narrow retry on transient errors.
    expect(calls.filter(c => c.table === 'shift_types' && c.method === 'select')).toHaveLength(1);
  });
});

describe('loadGenerationContext — call pattern (requirement 2 + 3)', () => {
  it('parses a valid active pattern into ctx.callPattern', async () => {
    const { res } = await run({ call_patterns: { data: { definition: CLASSIC_PATTERN }, error: null } });
    expect(res.ctx!.callPattern).toEqual(CLASSIC_PATTERN);
    expect((res.ctx!.warnings ?? []).some(w => w.startsWith('Active call pattern failed validation'))).toBe(false);
  });

  it('invalid jsonb → undefined callPattern + validation warning', async () => {
    const { res } = await run({ call_patterns: { data: { definition: { version: 2 } }, error: null } });
    expect(res.ctx!.callPattern).toBeUndefined();
    expect((res.ctx!.warnings ?? []).some(w => w.startsWith('Active call pattern failed validation'))).toBe(true);
  });

  it('no active pattern row → undefined callPattern, no crash, no validation warning', async () => {
    const { res } = await run({ call_patterns: { data: null, error: null } });
    expect(res.ctx).toBeTruthy();
    expect(res.ctx!.callPattern).toBeUndefined();
    expect((res.ctx!.warnings ?? []).some(w => w.includes('failed validation') || w.includes('table missing'))).toBe(false);
  });

  it('missing call_patterns table → undefined + table-missing warning', async () => {
    const { res } = await run({
      call_patterns: { data: null, error: { message: 'relation "scheduling.call_patterns" does not exist', code: '42P01' } },
    });
    expect(res.ctx!.callPattern).toBeUndefined();
    expect(res.ctx!.warnings).toContain('call_patterns table missing — apply patch18');
  });
});

describe('loadGenerationContext — historical fairness RPC (requirement 4)', () => {
  const histRpcRows = [
    { provider_id: 'p1', bucket: 'weekend', code: 'C1', n: 3 },
    { provider_id: 'p1', bucket: 'weekday', code: 'C2', n: 2 },
    { provider_id: 'p2', bucket: 'weekend', code: 'C1', n: 1 },
  ];
  // Legacy raw rows equivalent to the aggregate above (dayTypeBucket collapses
  // saturday/sunday → weekend).
  const legacyRows = [
    ...Array.from({ length: 3 }, () => ({ provider_id: 'p1', schedule_slots: { slot_date: '2025-12-01', site_id: 'site1', derived_day_type: 'saturday', shift_types: { code: 'C1', category: 'call' } } })),
    ...Array.from({ length: 2 }, () => ({ provider_id: 'p1', schedule_slots: { slot_date: '2025-12-02', site_id: 'site1', derived_day_type: 'weekday', shift_types: { code: 'C2', category: 'call' } } })),
    { provider_id: 'p2', schedule_slots: { slot_date: '2025-12-03', site_id: 'site1', derived_day_type: 'sunday', shift_types: { code: 'C1', category: 'call' } } },
  ];
  const twoCallSlots: Record<string, TableCfg> = {
    schedule_slots: { data: [
      rawSlot({ id: 's1', date: '2026-01-10', code: 'C1', category: 'call', dayType: 'saturday' }),
      rawSlot({ id: 's2', date: '2026-01-20', code: 'C1', category: 'call' }),
    ], error: null },
  };

  it('populates historical maps from the RPC aggregate + calls it with site/before', async () => {
    const { res, calls } = await run(twoCallSlots, { historical_call_counts: { data: histRpcRows, error: null } });
    const ctx = res.ctx!;
    expect(ctx.historicalAssignedByPid.get('p1')!.get('weekend|C1')).toBe(3);
    expect(ctx.historicalAssignedByPid.get('p1')!.get('weekday|C2')).toBe(2);
    expect(ctx.historicalAssignedByPid.get('p2')!.get('weekend|C1')).toBe(1);
    expect(ctx.historicalTotalByBucket.get('weekend|C1')).toBe(4);
    expect(ctx.historicalTotalByBucket.get('weekday|C2')).toBe(2);
    const rpcCall = calls.find(c => c.method === 'rpc' && c.fn === 'historical_call_counts');
    expect(rpcCall!.args[0]).toEqual({ p_site_id: 'site1', p_before: '2026-01-10' });
  });

  it('matches the legacy row-scan exactly when the RPC is unavailable', async () => {
    const { res: rpcRes } = await run(twoCallSlots, { historical_call_counts: { data: histRpcRows, error: null } });
    const { res: legacyRes } = await run({
      ...twoCallSlots,
      assignments: (filters) => {
        const sel = (filters.find(f => f.method === 'select')?.args[0] as string) ?? '';
        // historical scan selects derived_day_type; cross-site scan does not.
        return sel.includes('derived_day_type') ? { data: legacyRows, error: null } : { data: [], error: null };
      },
    }, { historical_call_counts: { data: null, error: { message: 'function scheduling.historical_call_counts(uuid, date) does not exist', code: '42883' } } });

    expect(legacyRes.ctx!.warnings).toContain('historical_call_counts RPC unavailable — using legacy scan (apply patch18)');
    expect(legacyRes.ctx!.historicalAssignedByPid).toEqual(rpcRes.ctx!.historicalAssignedByPid);
    expect(legacyRes.ctx!.historicalTotalByBucket).toEqual(rpcRes.ctx!.historicalTotalByBucket);
  });

  it('non-missing-function RPC error → warning carries the actual error, not the patch18 hint', async () => {
    const { res } = await run(twoCallSlots, {
      historical_call_counts: { data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } },
    });
    const warnings = res.ctx!.warnings ?? [];
    const rpcWarnings = warnings.filter(w => w.includes('historical_call_counts'));
    expect(rpcWarnings).toHaveLength(1);
    expect(rpcWarnings[0]).toContain('statement timeout');
    expect(rpcWarnings[0]).not.toContain('patch18');
    // Legacy-scan data path still engaged (empty canned assignments → empty maps).
    expect(res.ctx!.historicalAssignedByPid.size).toBe(0);
  });
});

describe('loadGenerationContext — cross-site window (requirement 5)', () => {
  it('widens ±1 day around the FULL slotIndex range (not just call slots)', async () => {
    const { calls } = await run({
      schedule_slots: { data: [
        // call slots span 01-10..01-20
        rawSlot({ id: 'c1', date: '2026-01-10', code: 'C1', category: 'call' }),
        rawSlot({ id: 'c2', date: '2026-01-20', code: 'C1', category: 'call' }),
        // derived (non-call) slots extend the index to 01-05..02-01
        rawSlot({ id: 'd0', date: '2026-01-05', code: 'D1', category: 'derived' }),
        rawSlot({ id: 'd1', date: '2026-02-01', code: 'D1', category: 'derived' }),
      ], error: null },
    });
    const gte = calls.find(c => c.table === 'assignments' && c.method === 'gte');
    const lte = calls.find(c => c.table === 'assignments' && c.method === 'lte');
    expect(gte!.args).toEqual(['schedule_slots.slot_date', '2026-01-04']);
    expect(lte!.args).toEqual(['schedule_slots.slot_date', '2026-02-02']);
  });
});

describe('loadGenerationContext — load-time warnings (requirement 6-9)', () => {
  it('warns on unknown pattern code, quota shortfall, and required_count > 1', async () => {
    const pattern = {
      version: 1, blocks: [], spans: [], placementPasses: [], reliefPass: null,
      optimizerMovableDayTypes: [],
      dayChains: [{ trigger: 'ZZ', dayTypes: ['weekday'] }],
    };
    const { res } = await run({
      sites: { data: { call_par_level: 12 }, error: null }, // low pool FTE vs par → shortfall
      call_patterns: { data: { definition: pattern }, error: null },
      shift_types: { data: [
        { code: 'C1', category: 'call', call_rank: 0, relief_rank: null, is_overlay: false, generation_engine: 'call', requires_post_call_rule: false, call_coverage_type: null },
      ], error: null },
      schedule_slots: { data: [
        rawSlot({ id: 's1', date: '2026-01-07', code: 'C1', category: 'call', required: 2 }),
      ], error: null },
    });
    const warnings = res.ctx!.warnings ?? [];
    expect(warnings.some(w => w.includes("'ZZ'") && w.includes('not defined'))).toBe(true);
    expect(warnings.some(w => /Bucket .* FTE-weighted quota .* cannot cover .* slots/.test(w))).toBe(true);
    expect(warnings.some(w => w.includes('C1') && w.includes('required_count'))).toBe(true);
  });

  it('required_count>1 warning: one aggregate per shift code, open slots only', async () => {
    const { res } = await run({
      schedule_slots: { data: [
        // Fully-satisfied multi-count slot → generation unaffected → no warning.
        rawSlot({ id: 's1', date: '2026-01-06', code: 'C1', category: 'call', required: 2,
          assignments: [{ id: 'a1', provider_id: 'p1' }, { id: 'a2', provider_id: 'p2' }] }),
        // Two open multi-count C2 slots → ONE aggregated warning for C2.
        rawSlot({ id: 's2', date: '2026-01-07', code: 'C2', category: 'call', required: 2 }),
        rawSlot({ id: 's3', date: '2026-01-08', code: 'C2', category: 'call', required: 3 }),
      ], error: null },
    });
    const warnings = (res.ctx!.warnings ?? []).filter(w => w.includes('required_count'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('C2');
    expect(warnings[0]).toContain('2 open slots');
    expect(warnings[0]).not.toContain('C1');
    // Task 11: sibling slots ARE the multi-coverage mechanism now — the
    // warning must point the operator at splitting, not at a future task.
    expect(warnings[0]).toContain('legacy');
    expect(warnings[0]).toContain('split into sibling slots');
    expect(warnings[0]).not.toContain('not yet supported');
  });

  it('precomputes providerById, sorted scheduleDates, prePtoByThursday; always sets warnings', async () => {
    const { res } = await run({
      schedule_slots: { data: [
        rawSlot({ id: 's1', date: '2026-01-07', code: 'C1', category: 'call' }),
        rawSlot({ id: 's2', date: '2026-01-06', code: 'C1', category: 'call' }),
      ], error: null },
    });
    const ctx = res.ctx!;
    expect(Array.isArray(ctx.warnings)).toBe(true);
    expect(ctx.providerById!.get('p1')!.short_display_name).toBe('DOCA');
    expect(ctx.scheduleDates).toEqual(['2026-01-06', '2026-01-07']);
    expect(ctx.prePtoByThursday).toBeInstanceOf(Map);
  });
});
