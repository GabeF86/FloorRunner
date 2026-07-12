// Executor tests for the four READ-ONLY analysis tools (ui-v1 Task 8):
// get_coverage_summary, get_fairness_report, find_unfilled, who_is_on.
// Canned rows via the shared chainable fake supabase client. Every tool:
// - handles BOTH PostgREST embed shapes (object one-to-one vs array) via
//   embedArray — the live-DB regression class tools.test.ts pinned for get_grid;
// - surfaces query errors as throws (is_error upstream), never zeros-as-fact
//   (get_schedule_context's hardened pattern);
// - never writes (read-only; NOT in MUTATING_TOOLS — pinned here too).
import { describe, it, expect } from 'vitest';
import { createToolExecutors, MUTATING_TOOLS, ToolInputError, type ScheduleCtx } from './tools';
import { READ_CHUNK } from './snapshot';
import {
  makeFakeSupabase,
  callsFor,
  type TableCfg,
} from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

const ctx: ScheduleCtx = {
  scheduleId: 'sched-1', siteId: 'site-1', versionId: 'ver-1',
  scheduleName: 'S', dateStart: '2026-01-01', dateEnd: '2026-01-31',
};

function run(tables: Record<string, TableCfg>) {
  const { sb, calls } = makeFakeSupabase({ tables });
  const executors = createToolExecutors();
  return { executors, sb: sb as never, calls };
}

// ── Tool registry invariants ─────────────────────────────────────────────────

describe('analysis tools — registry', () => {
  it('all four are registered as executors and NONE is in MUTATING_TOOLS', () => {
    const executors = createToolExecutors();
    for (const name of ['get_coverage_summary', 'get_fairness_report', 'find_unfilled', 'who_is_on']) {
      expect(executors[name], name).toBeTypeOf('function');
      expect(MUTATING_TOOLS.has(name), `${name} must be read-only`).toBe(false);
    }
  });
});

// ── get_coverage_summary ─────────────────────────────────────────────────────

function coverageSlot(
  id: string, date: string, dayType: string, code: string, assignments: unknown,
) {
  return {
    id, slot_date: date, derived_day_type: dayType,
    shift_types: { code, category: 'call', requires_post_call_rule: false },
    assignments,
  };
}

describe('get_coverage_summary', () => {
  const ASSIGNED = { provider_id: 'p1', assignment_status: 'assigned' };

  it('aggregates per-code filled/open + gaps list, handling both embed shapes', async () => {
    const { executors, sb } = run({
      schedule_slots: {
        data: [
          coverageSlot('s1', '2026-01-05', 'weekday', 'C1', ASSIGNED),          // object embed
          coverageSlot('s2', '2026-01-06', 'weekday', 'C1', [ASSIGNED]),        // array embed
          coverageSlot('s3', '2026-01-07', 'weekday', 'C1', null),              // open (no row)
          coverageSlot('s4', '2026-01-10', 'saturday', 'C2',
            [{ provider_id: null, assignment_status: 'open' }]),                // open (open row)
        ],
      },
    });
    const out = await executors.get_coverage_summary(sb, ctx, {});
    const r = out.result as {
      total_slots: number; filled: number; open: number;
      by_code: Record<string, { filled: number; open: number }>;
      gaps: Array<{ slot_id: string; date: string; code: string; day_type: string }>;
      omitted_gaps: number;
    };
    expect(r.total_slots).toBe(4);
    expect(r.filled).toBe(2);
    expect(r.open).toBe(2);
    expect(r.by_code.C1).toEqual({ filled: 2, open: 1 });
    expect(r.by_code.C2).toEqual({ filled: 0, open: 1 });
    expect(r.gaps).toEqual([
      { slot_id: 's3', date: '2026-01-07', day_type: 'weekday', code: 'C1' },
      { slot_id: 's4', date: '2026-01-10', day_type: 'saturday', code: 'C2' },
    ]);
    expect(r.omitted_gaps).toBe(0);
  });

  it('scopes the query to the version and applies the requested date range', async () => {
    const { executors, sb, calls } = run({ schedule_slots: { data: [] } });
    await executors.get_coverage_summary(sb, ctx, { date_start: '2026-01-10', date_end: '2026-01-20' });
    const eqs = callsFor(calls, 'schedule_slots', 'eq');
    expect(eqs.some(c => c.args[0] === 'schedule_version_id' && c.args[1] === 'ver-1')).toBe(true);
    expect(callsFor(calls, 'schedule_slots', 'gte')[0].args).toEqual(['slot_date', '2026-01-10']);
    expect(callsFor(calls, 'schedule_slots', 'lte')[0].args).toEqual(['slot_date', '2026-01-20']);
  });

  it('defaults the range to the schedule dates', async () => {
    const { executors, sb, calls } = run({ schedule_slots: { data: [] } });
    const out = await executors.get_coverage_summary(sb, ctx, {});
    expect(callsFor(calls, 'schedule_slots', 'gte')[0].args).toEqual(['slot_date', '2026-01-01']);
    expect(callsFor(calls, 'schedule_slots', 'lte')[0].args).toEqual(['slot_date', '2026-01-31']);
    const r = out.result as { date_start: string; date_end: string };
    expect(r.date_start).toBe('2026-01-01');
    expect(r.date_end).toBe('2026-01-31');
  });

  it('rejects a malformed date as ToolInputError (model self-corrects)', async () => {
    const { executors, sb } = run({ schedule_slots: { data: [] } });
    await expect(executors.get_coverage_summary(sb, ctx, { date_start: 'Jan 5' }))
      .rejects.toBeInstanceOf(ToolInputError);
  });

  it('rejects an inverted range as ToolInputError', async () => {
    const { executors, sb } = run({ schedule_slots: { data: [] } });
    await expect(executors.get_coverage_summary(sb, ctx, { date_start: '2026-01-20', date_end: '2026-01-10' }))
      .rejects.toBeInstanceOf(ToolInputError);
  });

  it('throws on a failed slots read — never zeros-as-fact', async () => {
    const { executors, sb } = run({ schedule_slots: { error: { message: 'boom' } } });
    await expect(executors.get_coverage_summary(sb, ctx, {})).rejects.toThrow(/boom/);
  });
});

// ── get_fairness_report ──────────────────────────────────────────────────────

// Providers: p1 (fte 1, pool), p2 (fte "0.5" string + ARRAY embed, pool via
// partial_call_taker), p3 (other home site → out of pool), p4 (no profile →
// excluded entirely).
const FAIRNESS_PROVIDERS = [
  { id: 'p1', last_name: 'Smith', short_display_name: 'Smith', provider_type: 'physician',
    provider_employment_profiles: { fte_value: 1, home_site_id: 'site-1', call_taker: true, partial_call_taker: false } },
  { id: 'p2', last_name: 'Jones', short_display_name: 'Jones', provider_type: 'physician',
    provider_employment_profiles: [{ fte_value: '0.5', home_site_id: 'site-1', call_taker: false, partial_call_taker: true }] },
  { id: 'p3', last_name: 'Wu', short_display_name: 'Wu', provider_type: 'physician',
    provider_employment_profiles: { fte_value: 1, home_site_id: 'site-2', call_taker: true, partial_call_taker: false } },
  { id: 'p4', last_name: 'NoProfile', short_display_name: 'NP', provider_type: 'physician',
    provider_employment_profiles: null },
];

// Calls: p1×3 (one saturday → 'weekend' bucket, two weekday), p3×1 (weekday,
// out-of-pool), plus a non-call D1 for p2 that must NOT count.
const FAIRNESS_SLOTS = [
  { id: 's1', slot_date: '2026-01-03', derived_day_type: 'saturday',
    shift_types: { code: 'C1', category: 'call' },
    assignments: { provider_id: 'p1', assignment_status: 'assigned' } },       // object embed
  { id: 's2', slot_date: '2026-01-05', derived_day_type: 'weekday',
    shift_types: { code: 'C1', category: 'call' },
    assignments: [{ provider_id: 'p1', assignment_status: 'assigned' }] },     // array embed
  { id: 's3', slot_date: '2026-01-06', derived_day_type: 'weekday',
    shift_types: { code: 'C1', category: 'call' },
    assignments: [{ provider_id: 'p1', assignment_status: 'assigned' }] },
  { id: 's4', slot_date: '2026-01-07', derived_day_type: 'weekday',
    shift_types: { code: 'C1', category: 'call' },
    assignments: [{ provider_id: 'p3', assignment_status: 'assigned' }] },
  { id: 's5', slot_date: '2026-01-08', derived_day_type: 'weekday',
    shift_types: { code: 'D1', category: 'regular' },
    assignments: [{ provider_id: 'p2', assignment_status: 'assigned' }] },
  { id: 's6', slot_date: '2026-01-09', derived_day_type: 'weekday',
    shift_types: { code: 'C1', category: 'call' },
    assignments: null },                                                        // open
];

interface FairnessRow {
  provider_id: string; name: string; fte: number | null; in_pool: boolean;
  calls_total: number; calls_by_bucket: Record<string, number>;
  expected: number | null; delta: number | null;
}

describe('get_fairness_report', () => {
  async function report() {
    const { executors, sb } = run({
      providers: { data: FAIRNESS_PROVIDERS },
      schedule_slots: { data: FAIRNESS_SLOTS },
    });
    const out = await executors.get_fairness_report(sb, ctx, {});
    return out.result as {
      total_call_assignments: number; pool_size: number; pool_fte: number;
      stdev_calls_per_fte: number; providers: FairnessRow[];
    };
  }
  const row = (r: { providers: FairnessRow[] }, id: string) =>
    r.providers.find(p => p.provider_id === id);

  it('counts call-category assignments per provider, bucketed by dayTypeBucket', async () => {
    const r = await report();
    expect(r.total_call_assignments).toBe(4);
    const p1 = row(r, 'p1')!;
    expect(p1.calls_total).toBe(3);
    expect(p1.calls_by_bucket).toEqual({ weekend: 1, weekday: 2 }); // saturday→weekend
    // Non-call D1 never counts.
    expect(row(r, 'p2')!.calls_total).toBe(0);
  });

  it('pool = home-site call-takers; FTE parsed from either embed shape (incl. numeric string)', async () => {
    const r = await report();
    expect(r.pool_size).toBe(2); // p1, p2
    expect(r.pool_fte).toBeCloseTo(1.5, 10);
    expect(row(r, 'p1')!.fte).toBe(1);
    expect(row(r, 'p2')!.fte).toBe(0.5); // array embed + string fte_value
    expect(row(r, 'p1')!.in_pool).toBe(true);
    expect(row(r, 'p2')!.in_pool).toBe(true);
  });

  it('expected = total × fte / pool_fte for pool members; delta = actual − expected', async () => {
    const r = await report();
    const p1 = row(r, 'p1')!;
    const p2 = row(r, 'p2')!;
    expect(p1.expected).toBeCloseTo(4 * 1 / 1.5, 10);
    expect(p1.delta).toBeCloseTo(3 - 4 / 1.5, 10);
    expect(p2.expected).toBeCloseTo(4 * 0.5 / 1.5, 10);
    expect(p2.delta).toBeCloseTo(0 - 2 / 1.5, 10);
  });

  it('reports out-of-pool providers holding calls (flagged), excludes profile-less idle ones', async () => {
    const r = await report();
    const p3 = row(r, 'p3')!;
    expect(p3.in_pool).toBe(false);
    expect(p3.calls_total).toBe(1);
    expect(row(r, 'p4')).toBeUndefined();
  });

  it('stdev over pool calls-per-fte ratios matches metrics.ts populationStdev math', async () => {
    const r = await report();
    // ratios: p1 = 3/1 = 3, p2 = 0/0.5 = 0 → mean 1.5 → population stdev 1.5
    expect(r.stdev_calls_per_fte).toBeCloseTo(1.5, 10);
  });

  it('scopes the pool query when the schedule has a provider override', async () => {
    const { executors, sb, calls } = run({
      providers: { data: FAIRNESS_PROVIDERS.slice(0, 1) },
      schedule_slots: { data: [] },
    });
    await executors.get_fairness_report(sb, { ...ctx, overrideProviderIds: ['p1'] }, {});
    const ins = callsFor(calls, 'providers', 'in');
    expect(ins.some(c => c.args[0] === 'id' && Array.isArray(c.args[1]) && (c.args[1] as string[]).includes('p1'))).toBe(true);
  });

  it('throws on a failed providers read — never an empty report as fact', async () => {
    const { executors, sb } = run({
      providers: { error: { message: 'providers down' } },
      schedule_slots: { data: [] },
    });
    await expect(executors.get_fairness_report(sb, ctx, {})).rejects.toThrow(/providers down/);
  });

  it('throws on a failed slots read', async () => {
    const { executors, sb } = run({
      providers: { data: FAIRNESS_PROVIDERS },
      schedule_slots: { error: { message: 'slots down' } },
    });
    await expect(executors.get_fairness_report(sb, ctx, {})).rejects.toThrow(/slots down/);
  });
});

// ── find_unfilled ────────────────────────────────────────────────────────────

const POOL_PROVIDERS = ['p1', 'p2', 'p3', 'p4'].map((id, i) => ({
  id, last_name: `L${id}`, short_display_name: `P${i + 1}`, provider_type: 'physician',
  provider_employment_profiles: { fte_value: 1, home_site_id: 'site-1', call_taker: true, partial_call_taker: false },
}));

describe('find_unfilled', () => {
  it('lists open slots with ≤3 cheap context hints (PTO counts, same-day assigned, post-call, stored flags)', async () => {
    const { executors, sb } = run({
      schedule_slots: {
        data: [
          // The open slot under scrutiny — its open row carries stored flags.
          { id: 's-open', slot_date: '2026-01-05', derived_day_type: 'weekday',
            shift_types: { code: 'C1', category: 'call', requires_post_call_rule: true },
            assignments: { provider_id: null, assignment_status: 'open',
              validation_flags: [{ severity: 'hard' }, { severity: 'soft' }] } },
          // p1 took a 24h call the day before → post-call blocked on 01-05.
          { id: 's-prev', slot_date: '2026-01-04', derived_day_type: 'sunday',
            shift_types: { code: 'C2', category: 'call', requires_post_call_rule: true },
            assignments: [{ provider_id: 'p1', assignment_status: 'assigned' }] },
          // p2 already works 01-05 in this schedule.
          { id: 's-same', slot_date: '2026-01-05', derived_day_type: 'weekday',
            shift_types: { code: 'D1', category: 'regular', requires_post_call_rule: false },
            assignments: [{ provider_id: 'p2', assignment_status: 'assigned' }] },
        ],
      },
      providers: { data: POOL_PROVIDERS },
      provider_availability: {
        data: [
          // PENDING PTO blocks (clinical invariant 2).
          { provider_id: 'p3', availability_type: 'pto', start_date: '2026-01-05',
            end_date: '2026-01-06', approval_status: 'pending' },
          // Denied PTO is dismissed — must NOT count.
          { provider_id: 'p4', availability_type: 'pto', start_date: '2026-01-05',
            end_date: '2026-01-05', approval_status: 'denied' },
        ],
      },
    });
    const out = await executors.find_unfilled(sb, ctx, {});
    const r = out.result as {
      open_count: number; pool_size: number;
      slots: Array<{ slot_id: string; date: string; code: string; hints: string[] }>;
      omitted_slots: number;
    };
    expect(r.open_count).toBe(1);
    expect(r.pool_size).toBe(4);
    expect(r.slots).toHaveLength(1);
    const slot = r.slots[0];
    expect(slot.slot_id).toBe('s-open');
    expect(slot.code).toBe('C1');
    // Four hint sources fire; the cap keeps ≤3 (MAX_CANDIDATE_REASONS).
    expect(slot.hints.length).toBe(3);
    const all = slot.hints.join(' | ');
    expect(all).toMatch(/1 of 4/);            // p3 blocked, p4's denied PTO ignored
    expect(all).toMatch(/PTO|unavailab/i);
    expect(all).toMatch(/already assigned/i); // p2
    expect(all).toMatch(/post-call/i);        // p1
  });

  it('emits NO hints when there is no derivable context — never fabricates blockers', async () => {
    const { executors, sb } = run({
      schedule_slots: {
        data: [{ id: 's-open', slot_date: '2026-01-05', derived_day_type: 'weekday',
          shift_types: { code: 'C1', category: 'call', requires_post_call_rule: false },
          assignments: null }],
      },
      providers: { data: POOL_PROVIDERS },
      provider_availability: { data: [] },
    });
    const out = await executors.find_unfilled(sb, ctx, {});
    const r = out.result as { slots: Array<{ hints: string[] }> };
    expect(r.slots[0].hints).toEqual([]);
  });

  it('reports zero open slots without touching availability', async () => {
    const { executors, sb, calls } = run({
      schedule_slots: {
        data: [{ id: 's1', slot_date: '2026-01-05', derived_day_type: 'weekday',
          shift_types: { code: 'C1', category: 'call', requires_post_call_rule: false },
          assignments: { provider_id: 'p1', assignment_status: 'assigned' } }],
      },
      providers: { data: POOL_PROVIDERS },
    });
    const out = await executors.find_unfilled(sb, ctx, {});
    expect((out.result as { open_count: number }).open_count).toBe(0);
    expect(callsFor(calls, 'provider_availability', 'select')).toHaveLength(0);
  });

  it('throws on a failed availability read — hints must not silently drop', async () => {
    const { executors, sb } = run({
      schedule_slots: {
        data: [{ id: 's-open', slot_date: '2026-01-05', derived_day_type: 'weekday',
          shift_types: { code: 'C1', category: 'call', requires_post_call_rule: false },
          assignments: null }],
      },
      providers: { data: POOL_PROVIDERS },
      provider_availability: { error: { message: 'avail down' } },
    });
    await expect(executors.find_unfilled(sb, ctx, {})).rejects.toThrow(/avail down/);
  });

  it('throws on a failed slots read', async () => {
    const { executors, sb } = run({ schedule_slots: { error: { message: 'slots down' } } });
    await expect(executors.find_unfilled(sb, ctx, {})).rejects.toThrow(/slots down/);
  });
});

// ── who_is_on ────────────────────────────────────────────────────────────────

describe('who_is_on', () => {
  it('requires at least one of provider_id / date (schema cannot express oneOf in strict mode)', async () => {
    const { executors, sb } = run({});
    await expect(executors.who_is_on(sb, ctx, {})).rejects.toBeInstanceOf(ToolInputError);
    await expect(executors.who_is_on(sb, ctx, {})).rejects.toThrow(/provider_id|date/);
  });

  it('rejects malformed date and out-of-range window_days', async () => {
    const { executors, sb } = run({});
    await expect(executors.who_is_on(sb, ctx, { date: 'tomorrow' })).rejects.toBeInstanceOf(ToolInputError);
    await expect(executors.who_is_on(sb, ctx, { date: '2026-01-05', window_days: 99 }))
      .rejects.toBeInstanceOf(ToolInputError);
  });

  it('provider mode: one joined query, cross-version + cross-site rows, flags the current schedule', async () => {
    const { executors, sb, calls } = run({
      assignments: {
        data: [
          { id: 'a1', provider_id: 'p1', assignment_status: 'assigned',
            providers: { last_name: 'Smith', short_display_name: 'S. Smith' },   // object embed
            schedule_slots: { id: 'sl1', slot_date: '2026-01-05', site_id: 'site-1',
              derived_day_type: 'weekday', schedule_version_id: 'ver-1',
              shift_types: { code: 'C1' }, sites: { name: 'Main', short_name: 'MAIN' } } },
          { id: 'a2', provider_id: 'p1', assignment_status: 'assigned',
            providers: [{ last_name: 'Smith', short_display_name: 'S. Smith' }], // array embed
            schedule_slots: { id: 'sl2', slot_date: '2026-01-06', site_id: 'site-2',
              derived_day_type: 'weekday', schedule_version_id: 'ver-9',
              shift_types: { code: 'C2' }, sites: { name: 'North', short_name: 'NORTH' } } },
        ],
      },
    });
    const out = await executors.who_is_on(sb, ctx, { provider_id: 'p1', date: '2026-01-05', window_days: 1 });
    const r = out.result as {
      rows: Array<{ date: string; code: string; site: string; provider: string;
        schedule_version_id: string; in_this_schedule: boolean }>;
    };
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      date: '2026-01-05', code: 'C1', site: 'MAIN', provider: 'S. Smith',
      schedule_version_id: 'ver-1', in_this_schedule: true,
    });
    expect(r.rows[1]).toMatchObject({
      date: '2026-01-06', code: 'C2', site: 'NORTH',
      schedule_version_id: 'ver-9', in_this_schedule: false,
    });
    // Filters: provider eq + date window on the joined slot date.
    expect(callsFor(calls, 'assignments', 'eq').some(c => c.args[0] === 'provider_id' && c.args[1] === 'p1')).toBe(true);
    expect(callsFor(calls, 'assignments', 'gte')[0].args).toEqual(['schedule_slots.slot_date', '2026-01-04']);
    expect(callsFor(calls, 'assignments', 'lte')[0].args).toEqual(['schedule_slots.slot_date', '2026-01-06']);
  });

  it('provider mode without a date defaults the window to the schedule range', async () => {
    const { executors, sb, calls } = run({ assignments: { data: [] } });
    await executors.who_is_on(sb, ctx, { provider_id: 'p1' });
    expect(callsFor(calls, 'assignments', 'gte')[0].args).toEqual(['schedule_slots.slot_date', '2026-01-01']);
    expect(callsFor(calls, 'assignments', 'lte')[0].args).toEqual(['schedule_slots.slot_date', '2026-01-31']);
  });

  it('date mode: chunks assignment reads at READ_CHUNK over the slot ids', async () => {
    const manySlots = Array.from({ length: READ_CHUNK + 50 }, (_, i) => ({
      id: `sl${i}`, slot_date: '2026-01-05', site_id: 'site-1',
      derived_day_type: 'weekday', schedule_version_id: 'ver-1',
      shift_types: { code: 'C1' }, sites: { short_name: 'MAIN' },
    }));
    // Function-config: serve one assigned row per recorded `.in` chunk.
    const { executors, sb, calls } = run({
      schedule_slots: { data: manySlots },
      assignments: (filters) => {
        const inF = filters.find(f => f.method === 'in');
        const ids = (inF?.args[1] as string[]) ?? [];
        return {
          data: ids.slice(0, 1).map(id => ({
            id: `a-${id}`, schedule_slot_id: id, provider_id: 'p1',
            assignment_status: 'assigned',
            providers: { short_display_name: 'S. Smith' },
          })),
        };
      },
    });

    const out = await executors.who_is_on(sb, ctx, { date: '2026-01-05' });
    const inCalls = callsFor(calls, 'assignments', 'in');
    expect(inCalls).toHaveLength(2); // 250 ids → 200 + 50
    expect((inCalls[0].args[1] as string[]).length).toBe(READ_CHUNK);
    expect((inCalls[1].args[1] as string[]).length).toBe(50);
    const r = out.result as { rows: Array<{ provider: string }> };
    expect(r.rows).toHaveLength(2); // one per chunk from the fn-config
    expect(r.rows[0].provider).toBe('S. Smith');
  });

  it('date mode throws on a failed slots read; provider mode throws on a failed assignments read', async () => {
    const bad1 = run({ schedule_slots: { error: { message: 'slots down' } } });
    await expect(bad1.executors.who_is_on(bad1.sb, ctx, { date: '2026-01-05' }))
      .rejects.toThrow(/slots down/);
    const bad2 = run({ assignments: { error: { message: 'assignments down' } } });
    await expect(bad2.executors.who_is_on(bad2.sb, ctx, { provider_id: 'p1' }))
      .rejects.toThrow(/assignments down/);
  });
});
