import { describe, it, expect } from 'vitest';
import { emptySolveState } from './genTypes';
import { loadGenerationContext, computeBucketTargets, effectiveParLevel, floorBucketTargets } from './genContext';
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

// ── 2026-07-16 quota starvation fixes: par clamp + at-least-one floor ─────────
describe('effectiveParLevel — quota denominator clamped to the pool', () => {
  it('clamps DOWN to Σ pool FTE when the stored par exceeds it', () => {
    // Paoli shape: stored par 12, pool 8.82 FTE → Σ targets covered only 73%
    // of every bucket. The denominator must reflect the real pool.
    expect(effectiveParLevel(12, [prov('p1', 1), prov('p2', 0.5)])).toBeCloseTo(1.5);
  });
  it('never clamps UP — a par below pool FTE is a legitimate spread-thinner choice', () => {
    expect(effectiveParLevel(2, [prov('p1', 1), prov('p2', 1), prov('p3', 1)])).toBe(2);
  });
  it('keeps the stored par when the pool has no FTE (nothing to clamp to)', () => {
    expect(effectiveParLevel(12, [])).toBe(12);
    expect(effectiveParLevel(12, [prov('p1', 0)])).toBe(12);
  });
});

describe('floorBucketTargets — every positive-FTE provider gets ≥ 1 per bucket', () => {
  it('floors sub-1 targets to 1 and leaves ≥1 targets untouched', () => {
    // patch24's sat/sun split shrank weekend buckets to 4-5 slots, driving
    // per-provider targets to 0.33-0.42 — strict `assigned+1 > target` then
    // gave EVERY provider zero weekend capacity. The floor restores the
    // at-least-one-per-bucket guarantee the merged bucket used to provide.
    const floored = floorBucketTargets(
      new Map([['p1|saturday|C1', 0.33], ['p1|weekday|C1', 4.2]]),
      [prov('p1', 1)],
    );
    expect(floored.get('p1|saturday|C1')).toBe(1);
    expect(floored.get('p1|weekday|C1')).toBeCloseTo(4.2);
  });
  it('does NOT floor a zero-FTE provider (no capacity means no quota grant)', () => {
    const floored = floorBucketTargets(
      new Map([['p0|saturday|C1', 0]]),
      [prov('p0', 0)],
    );
    expect(floored.get('p0|saturday|C1')).toBe(0);
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
    // Parent-schedule lookup for the conflict scan's schedule-scoped exclusion.
    schedule_versions: { data: { schedule_id: 'sched1' }, error: null },
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

  it("callFillOrder='call_rank' + a null-ranked call code → load-time warning (wiring)", async () => {
    const doc = { ...CLASSIC_PATTERN, callFillOrder: 'call_rank' as const };
    const { res } = await run({
      call_patterns: { data: { definition: doc }, error: null },
      shift_types: { data: [...BASE_SHIFT_TYPES,
        { code: 'C9', category: 'call', call_rank: null, relief_rank: null, is_overlay: false,
          generation_engine: 'call', requires_post_call_rule: true, call_coverage_type: null },
      ], error: null },
    });
    const warnings = res.ctx!.warnings ?? [];
    expect(warnings.some(w => w.includes('C9') && w.includes("callFillOrder='call_rank'"))).toBe(true);
    // Ranked call codes and rank-less non-call codes stay quiet.
    expect(warnings.some(w => w.includes('callFillOrder') && !w.includes('C9'))).toBe(false);
  });
});

// dayTypeFillOrder (spec 2026-07-15 friday-first Doc A): the pattern may
// re-order the ACROSS-DATE fill; absent = the default order EXACTLY.
describe('loadGenerationContext — dayTypeFillOrder sort (pattern-data fill order)', () => {
  // Input rows deliberately shuffled (fri, sun, sat) so the assertion can only
  // pass if the sort re-ordered them.
  const daySlots = () => [
    rawSlot({ id: 'fri', date: '2026-01-09', code: 'C1', category: 'call', dayType: 'friday' }),
    rawSlot({ id: 'sun', date: '2026-01-11', code: 'C1', category: 'call', dayType: 'sunday' }),
    rawSlot({ id: 'sat', date: '2026-01-10', code: 'C1', category: 'call', dayType: 'saturday' }),
  ];
  const orderOf = (res: Awaited<ReturnType<typeof run>>['res']) =>
    res.ctx!.slotsToFill.map(s => s.derived_day_type);

  it('absent field → the default order EXACTLY (saturday, sunday, friday)', async () => {
    const { res } = await run({
      schedule_slots: { data: daySlots(), error: null },
      call_patterns: { data: { definition: CLASSIC_PATTERN }, error: null },
    });
    expect(orderOf(res)).toEqual(['saturday', 'sunday', 'friday']);
  });

  it('honors the pattern order (saturday, friday, sunday — the weekendV2 shape)', async () => {
    const doc = { ...CLASSIC_PATTERN, dayTypeFillOrder: ['saturday', 'friday', 'sunday'] };
    const { res } = await run({
      schedule_slots: { data: daySlots(), error: null },
      call_patterns: { data: { definition: doc }, error: null },
    });
    expect(orderOf(res)).toEqual(['saturday', 'friday', 'sunday']);
  });

  it('unlisted day types fall to the tail (after every listed one)', async () => {
    const doc = { ...CLASSIC_PATTERN, dayTypeFillOrder: ['friday'] };
    const { res } = await run({
      schedule_slots: {
        data: [
          rawSlot({ id: 'wk', date: '2026-01-07', code: 'C1', category: 'call', dayType: 'weekday' }),
          rawSlot({ id: 'fri', date: '2026-01-09', code: 'C1', category: 'call', dayType: 'friday' }),
          rawSlot({ id: 'sat', date: '2026-01-10', code: 'C1', category: 'call', dayType: 'saturday' }),
        ],
        error: null,
      },
      call_patterns: { data: { definition: doc }, error: null },
    });
    const order = orderOf(res);
    // friday leads; the two unlisted types share the tail and fall back to
    // date order among themselves.
    expect(order[0]).toBe('friday');
    expect(order.slice(1).sort()).toEqual(['saturday', 'weekday']);
    expect(order.slice(1)).toEqual(['weekday', 'saturday']); // date tiebreak
  });

  it('an unknown day-type name surfaces a load warning (wiring)', async () => {
    const doc = { ...CLASSIC_PATTERN, dayTypeFillOrder: ['saturady', 'friday'] };
    const { res } = await run({
      call_patterns: { data: { definition: doc }, error: null },
    });
    const warnings = res.ctx!.warnings ?? [];
    expect(warnings.some(w => w.includes("unknown day type 'saturady'"))).toBe(true);
  });
});

describe('loadGenerationContext — historical fairness RPC (requirement 4)', () => {
  // patch24: the RPC now emits split saturday/sunday buckets (not merged
  // 'weekend'). p1's history is on Saturdays, p2's on a Sunday.
  const histRpcRows = [
    { provider_id: 'p1', bucket: 'saturday', code: 'C1', n: 3 },
    { provider_id: 'p1', bucket: 'weekday', code: 'C2', n: 2 },
    { provider_id: 'p2', bucket: 'sunday', code: 'C1', n: 1 },
  ];
  // Legacy raw rows equivalent to the aggregate above (dayTypeBucket now keeps
  // saturday and sunday as their own buckets).
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
    expect(ctx.historicalAssignedByPid.get('p1')!.get('saturday|C1')).toBe(3);
    expect(ctx.historicalAssignedByPid.get('p1')!.get('weekday|C2')).toBe(2);
    expect(ctx.historicalAssignedByPid.get('p2')!.get('sunday|C1')).toBe(1);
    // Saturday and Sunday no longer share a bucket: p1's Saturdays and p2's
    // Sunday land in separate totals instead of a merged weekend|C1 of 4.
    expect(ctx.historicalTotalByBucket.get('saturday|C1')).toBe(3);
    expect(ctx.historicalTotalByBucket.get('sunday|C1')).toBe(1);
    expect(ctx.historicalTotalByBucket.get('weekend|C1')).toBeUndefined();
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

  // Draft isolation (invariant 3): the RPC (patch21) counts published call only;
  // the in-code legacy fallback must carry the SAME predicate — a past DRAFT's
  // call rows do not skew historical fairness, a PUBLISHED schedule's do.
  it('legacy fallback counts only PUBLISHED past call (drafts do not skew fairness)', async () => {
    const publishedRow = { provider_id: 'p1', schedule_slots: {
      slot_date: '2025-12-01', site_id: 'site1', derived_day_type: 'saturday',
      schedule_versions: { version_status: 'published' }, shift_types: { code: 'C1', category: 'call' } } };
    const draftRow = { provider_id: 'p2', schedule_slots: {
      slot_date: '2025-12-02', site_id: 'site1', derived_day_type: 'weekday',
      schedule_versions: { version_status: 'draft' }, shift_types: { code: 'C2', category: 'call' } } };
    const { res, calls } = await run({
      ...twoCallSlots,
      // Emulate the DB's version_status filter so the test is sensitive to the
      // committed predicate (mirrors the conflict-scan fake below).
      assignments: (filters) => {
        const sel = (filters.find(f => f.method === 'select')?.args[0] as string) ?? '';
        if (!sel.includes('derived_day_type')) return { data: [], error: null }; // cross-site scan
        const eqs = filters.filter(f => f.method === 'eq');
        const rows = [publishedRow, draftRow].filter(r =>
          eqs.every(f => {
            const [col, val] = f.args as [string, unknown];
            if (col === 'schedule_slots.schedule_versions.version_status') {
              return r.schedule_slots.schedule_versions.version_status === val;
            }
            return true;
          }));
        return { data: rows, error: null };
      },
    }, { historical_call_counts: { data: null, error: { message: 'function scheduling.historical_call_counts(uuid, date) does not exist', code: '42883' } } });

    // Published row counted; draft row NOT. publishedRow is a Saturday, so it
    // lands in the split saturday|C1 bucket (no longer merged weekend|C1).
    expect(res.ctx!.historicalAssignedByPid.get('p1')?.get('saturday|C1')).toBe(1);
    expect(res.ctx!.historicalAssignedByPid.has('p2')).toBe(false);
    // The committed predicate + inner join were emitted on the fallback scan.
    const histSelect = calls.find(c => c.table === 'assignments' && c.method === 'select'
      && (c.args[0] as string).includes('derived_day_type'));
    expect(histSelect!.args[0] as string).toContain('schedule_versions!inner(version_status)');
    const pub = calls.filter(c => c.table === 'assignments' && c.method === 'eq'
      && c.args[0] === 'schedule_slots.schedule_versions.version_status' && c.args[1] === 'published');
    // Both the cross-site scan (§1) and this fallback apply the predicate.
    expect(pub.length).toBeGreaterThanOrEqual(1);
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

// Invariant 3: no double-booking across ANY site and ANY schedule version.
// The conflict scan excludes by parent SCHEDULE (sibling versions of this
// schedule are clones — the versions route copies slots+assignments), so a
// same-site assignment in ANOTHER schedule now conflicts, while a sibling
// version of this schedule never self-conflicts. Mirrors dayShiftAutoGen.
describe('loadGenerationContext — conflict scan scope (other schedules, same site included)', () => {
  // status defaults to 'published' (a committed booking); pass 'draft' to model
  // an unpublished overlapping draft that draft isolation must ignore.
  const conflictRow = (scheduleId: string, status = 'published') => ({
    provider_id: 'p1',
    schedule_slots: {
      slot_date: '2026-01-07', site_id: 'site1',
      schedule_versions: { schedule_id: scheduleId, version_status: status },
    },
  });
  // Emulate the DB's eq/neq filters so the test is sensitive to the query shape:
  // the published predicate (version_status = 'published') AND the exclusions.
  const conflictAwareAssignments = (rows: Array<ReturnType<typeof conflictRow>>): TableCfg =>
    (filters: Filter[]) => {
      const eqs = filters.filter(f => f.method === 'eq');
      const neqs = filters.filter(f => f.method === 'neq');
      return {
        data: rows.filter(r =>
          eqs.every(f => {
            const [col, val] = f.args as [string, unknown];
            if (col === 'schedule_slots.schedule_versions.version_status') {
              return r.schedule_slots.schedule_versions.version_status === val;
            }
            return true;
          })
          && neqs.every(f => {
            const [col, val] = f.args as [string, unknown];
            if (col === 'schedule_slots.site_id') return r.schedule_slots.site_id !== val;
            if (col === 'schedule_slots.schedule_versions.schedule_id') {
              return r.schedule_slots.schedule_versions.schedule_id !== val;
            }
            return true;
          })),
        error: null,
      };
    };

  it('a PUBLISHED same-site assignment in ANOTHER schedule lands in crossSiteByDate; a sibling version of THIS schedule does not', async () => {
    const { res, calls } = await run({
      assignments: conflictAwareAssignments([
        conflictRow('schedOther'), // other schedule, same site, published → conflict
      ]),
    });
    expect(res.ctx!.crossSiteByDate.get('p1')?.has('2026-01-07')).toBe(true);
    const neqs = calls.filter(c => c.table === 'assignments' && c.method === 'neq');
    expect(neqs.some(c => c.args[0] === 'schedule_slots.schedule_versions.schedule_id' && c.args[1] === 'sched1')).toBe(true);
    expect(neqs.some(c => c.args[0] === 'schedule_slots.site_id')).toBe(false);
    // The committed predicate is applied.
    const pub = calls.filter(c => c.table === 'assignments' && c.method === 'eq'
      && c.args[0] === 'schedule_slots.schedule_versions.version_status' && c.args[1] === 'published');
    expect(pub).toHaveLength(1);
  });

  it('a DRAFT overlapping schedule at the same site does NOT block (draft isolation, invariant 3)', async () => {
    const { res } = await run({
      assignments: conflictAwareAssignments([conflictRow('schedOther', 'draft')]),
    });
    expect(res.ctx!.crossSiteByDate.get('p1')?.has('2026-01-07') ?? false).toBe(false);
  });

  it('sibling versions of the SAME schedule are clones — excluded from the conflict map', async () => {
    const { res } = await run({
      assignments: conflictAwareAssignments([conflictRow('sched1')]),
    });
    expect(res.ctx!.crossSiteByDate.get('p1')?.has('2026-01-07') ?? false).toBe(false);
  });

  it('falls back to the legacy other-sites-only scope (with a warning) when the version row is unreadable', async () => {
    const { res, calls } = await run({
      schedule_versions: { data: null, error: { message: 'gone' } },
      assignments: conflictAwareAssignments([conflictRow('schedOther')]),
    });
    // Same-site row is invisible again (degraded), but generation still runs
    // and says so instead of silently changing scope.
    expect(res.ctx!.crossSiteByDate.get('p1')?.has('2026-01-07') ?? false).toBe(false);
    expect((res.ctx!.warnings ?? []).some(w => w.includes('conflict scan degraded'))).toBe(true);
    const neqs = calls.filter(c => c.table === 'assignments' && c.method === 'neq');
    expect(neqs.some(c => c.args[0] === 'schedule_slots.site_id' && c.args[1] === 'site1')).toBe(true);
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

  // 2026-07-16: a stale par must stay VISIBLE but never starve quotas — the
  // shortfall warning is computed from the STORED par while the actual targets
  // are clamped to pool FTE and floored at 1.
  it('stale par: warning fires from the STORED par, targets are clamped + floored', async () => {
    const { res } = await run({
      sites: { data: { call_par_level: 12 }, error: null }, // pool FTE is 1.5 (p1 1.0 + p2 0.5)
      schedule_slots: { data: [
        rawSlot({ id: 's1', date: '2026-01-07', code: 'C1', category: 'call' }),
        rawSlot({ id: 's2', date: '2026-01-14', code: 'C1', category: 'call' }),
      ], error: null },
    });
    const ctx = res.ctx!;
    const warnings = ctx.warnings ?? [];
    // Raw math at stored par 12: Σ = (2/12)×1.5 = 0.25 < 2 → warning fires and
    // names both the stored par and the clamp so the operator fixes the row.
    const w = warnings.find(x => /Bucket weekday\|C1: FTE-weighted quota .* cannot cover 2 slots/.test(x));
    expect(w).toBeDefined();
    expect(w).toContain('clamped');
    // Effective targets: par clamped to 1.5 → p1 (2/1.5)×1 = 1.33 (no floor
    // needed), p2 (2/1.5)×0.5 = 0.67 → floored to 1.
    expect(ctx.bucketTarget.get('p1|weekday|C1')).toBeCloseTo(4 / 3);
    expect(ctx.bucketTarget.get('p2|weekday|C1')).toBe(1);
  });

  it('honest par: no shortfall warning, floor still guarantees ≥1 per bucket', async () => {
    const { res } = await run(); // base: par 1, pool FTE 1.5, one C1 slot
    const ctx = res.ctx!;
    expect((ctx.warnings ?? []).some(w => w.includes('cannot cover'))).toBe(false);
    // p2 (0.5 FTE): raw (1/1)×0.5 = 0.5 → floored to 1.
    expect(ctx.bucketTarget.get('p2|weekday|C1')).toBe(1);
    expect(ctx.bucketTarget.get('p1|weekday|C1')).toBe(1);
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

// ── one-to-one assignments embed (live UNIQUE(schedule_slot_id)) ────────────
// PostgREST returns each slot's assignments embed as ONE OBJECT (or null),
// not an array, against the live DB. loadGenerationContext must normalize —
// an object here used to break open-slot detection and seed collection.
describe('loadGenerationContext — one-to-one assignments embed', () => {
  it('single-OBJECT assigned embed: seed collected, slot NOT re-queued as open', async () => {
    const { res } = await run({
      schedule_slots: { data: [
        {
          ...rawSlot({ id: 's1', date: '2026-01-07', code: 'C1', category: 'call' }),
          assignments: { id: 'a1', provider_id: 'p1', assignment_status: 'assigned' }, // live shape
        },
        // A second, open slot keeps the version from being fully assigned —
        // a zero-open version takes an early return that skips seed collection
        // (pre-existing behavior, independent of embed shape).
        rawSlot({ id: 's2', date: '2026-01-08', code: 'C1', category: 'call' }),
      ], error: null },
    });
    expect(res.ctx).not.toBeNull();
    expect(res.ctx!.seedAssignments).toContainEqual(expect.objectContaining({
      provider_id: 'p1', shift_type_code: 'C1', slot_date: '2026-01-07',
    }));
    expect(res.ctx!.slotsToFill.map(s => s.slot_id)).not.toContain('s1');
  });

  it('single-OBJECT open-row embed: slot queued as open with that row id', async () => {
    const { res } = await run({
      schedule_slots: { data: [{
        ...rawSlot({ id: 's1', date: '2026-01-07', code: 'C1', category: 'call' }),
        assignments: { id: 'a-open', provider_id: null, assignment_status: 'open' }, // live shape
      }], error: null },
    });
    expect(res.ctx).not.toBeNull();
    expect(res.ctx!.seedAssignments).toEqual([]);
    const s1 = res.ctx!.slotsToFill.find(s => s.slot_id === 's1');
    expect(s1).toBeDefined();
  });

  it('null embed (one-to-one, no row): slot queued as open, no seeds', async () => {
    const { res } = await run({
      schedule_slots: { data: [{
        ...rawSlot({ id: 's1', date: '2026-01-07', code: 'C1', category: 'call' }),
        assignments: null, // live shape
      }], error: null },
    });
    expect(res.ctx).not.toBeNull();
    expect(res.ctx!.seedAssignments).toEqual([]);
    expect(res.ctx!.slotsToFill.map(s => s.slot_id)).toContain('s1');
  });
});

// ── FTE working-days budget (2026-07-17) ─────────────────────────────────────
// A block spanning 2026-05-22 (Fri) .. 2026-05-29 (Fri). Memorial Day
// 2026-05-25 (Mon) is a MAJOR holiday. Working days = 22, 26, 27, 28, 29 = 5
// (weekends + the major Monday excluded; minor holidays would stay in).
describe('loadGenerationContext — workDayBudget', () => {
  const budgetSlots = [
    rawSlot({ id: 'm22', date: '2026-05-22', code: 'C1', category: 'call', dayType: 'friday' }),
    rawSlot({ id: 'm25', date: '2026-05-25', code: 'C1', category: 'call', dayType: 'major_holiday' }),
    rawSlot({ id: 'm26', date: '2026-05-26', code: 'C1', category: 'call' }),
    rawSlot({ id: 'm27', date: '2026-05-27', code: 'C1', category: 'call' }),
    rawSlot({ id: 'm28', date: '2026-05-28', code: 'C1', category: 'call' }),
    rawSlot({ id: 'm29', date: '2026-05-29', code: 'C1', category: 'call', dayType: 'friday' }),
  ];
  const withSite = {
    schedule_slots: { data: budgetSlots, error: null },
    sites: { data: { call_par_level: 1, organization_id: 'org1' }, error: null },
    holiday_calendars: {
      data: [{ holiday_date: '2026-05-25', holiday_name: 'Memorial Day', is_major_holiday: true }],
      error: null,
    },
  };

  it('stamps working days minus major holidays, per-provider required + entitledOff', async () => {
    const { res } = await run({
      ...withSite,
      // p1 PTO Tue+Wed (both working days) → nets 2.
      provider_availability: { data: [
        { provider_id: 'p1', availability_type: 'pto', start_date: '2026-05-26', end_date: '2026-05-27', approval_status: 'approved' },
      ], error: null },
    });
    const b = res.ctx!.workDayBudget!;
    expect(b).toBeTruthy();
    expect(b.workingDays).toBe(5);
    expect(b.majorHolidayDates.has('2026-05-25')).toBe(true);
    expect(b.workingDaySet.has('2026-05-22')).toBe(true);
    expect(b.workingDaySet.has('2026-05-25')).toBe(false); // major holiday
    expect(b.workingDaySet.has('2026-05-23')).toBe(false); // Saturday

    // p1 (1.0): round(1×5) − 2 PTO = 3; entitledOff 5 − 5 = 0.
    expect(b.byProvider.get('p1')).toEqual({
      fte: 1.0, workingDays: 5, ptoWeekdays: 2, required: 3, entitledOff: 0,
    });
    // p2 (0.5): round(0.5×5)=round(2.5)=3; no PTO; entitledOff 5 − 3 = 2.
    expect(b.byProvider.get('p2')).toEqual({
      fte: 0.5, workingDays: 5, ptoWeekdays: 0, required: 3, entitledOff: 2,
    });
  });

  it('ICU (blocked/icu_week) rows do NOT net against required (they credit as worked, not PTO)', async () => {
    const { res } = await run({
      ...withSite,
      provider_availability: { data: [
        { provider_id: 'p2', availability_type: 'blocked', reason_code: 'icu_week', start_date: '2026-05-26', end_date: '2026-05-28', approval_status: 'approved' },
      ], error: null },
    });
    const b = res.ctx!.workDayBudget!;
    expect(b.byProvider.get('p2')!.ptoWeekdays).toBe(0); // ICU is not netting PTO
    expect(b.byProvider.get('p2')!.required).toBe(3);
  });

  it('carries reason_code through availByPid so solve can credit ICU', async () => {
    const { res } = await run({
      ...withSite,
      provider_availability: { data: [
        { provider_id: 'p2', availability_type: 'blocked', reason_code: 'icu_week', start_date: '2026-05-26', end_date: '2026-05-28', approval_status: 'approved' },
      ], error: null },
    });
    expect(res.ctx!.availByPid.get('p2')![0].reason_code).toBe('icu_week');
  });
});
