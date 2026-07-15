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
  type Filter,
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

// Canned config for PAGINATED reads. Every multi-row read in these tools —
// version-scoped slot loads included (a single version can exceed PostgREST's
// ~1000-row default cap; live repro: 2,201 slot rows) — selects with
// count:'exact' + .range and throws when the count is missing: truncation
// must never understate as fact.
function canned(rows: unknown[]): TableCfg {
  return { data: rows, count: rows.length };
}

// Serve pages off the recorded .range args, like a real capped API.
function pagedTable(all: unknown[]): TableCfg {
  return (filters) => {
    const rangeF = filters.find(f => f.method === 'range');
    const from = (rangeF?.args[0] as number) ?? 0;
    const to = (rangeF?.args[1] as number) ?? all.length - 1;
    return { data: all.slice(from, to + 1), count: all.length };
  };
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
      schedule_slots: canned([
          coverageSlot('s1', '2026-01-05', 'weekday', 'C1', ASSIGNED),          // object embed
          coverageSlot('s2', '2026-01-06', 'weekday', 'C1', [ASSIGNED]),        // array embed
          coverageSlot('s3', '2026-01-07', 'weekday', 'C1', null),              // open (no row)
          coverageSlot('s4', '2026-01-10', 'saturday', 'C2',
            [{ provider_id: null, assignment_status: 'open' }]),                // open (open row)
        ]),
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
    const { executors, sb, calls } = run({ schedule_slots: canned([]) });
    await executors.get_coverage_summary(sb, ctx, { date_start: '2026-01-10', date_end: '2026-01-20' });
    const eqs = callsFor(calls, 'schedule_slots', 'eq');
    expect(eqs.some(c => c.args[0] === 'schedule_version_id' && c.args[1] === 'ver-1')).toBe(true);
    expect(callsFor(calls, 'schedule_slots', 'gte')[0].args).toEqual(['slot_date', '2026-01-10']);
    expect(callsFor(calls, 'schedule_slots', 'lte')[0].args).toEqual(['slot_date', '2026-01-20']);
  });

  it('defaults the range to the schedule dates', async () => {
    const { executors, sb, calls } = run({ schedule_slots: canned([]) });
    const out = await executors.get_coverage_summary(sb, ctx, {});
    expect(callsFor(calls, 'schedule_slots', 'gte')[0].args).toEqual(['slot_date', '2026-01-01']);
    expect(callsFor(calls, 'schedule_slots', 'lte')[0].args).toEqual(['slot_date', '2026-01-31']);
    const r = out.result as { date_start: string; date_end: string };
    expect(r.date_start).toBe('2026-01-01');
    expect(r.date_end).toBe('2026-01-31');
  });

  it('rejects a malformed date as ToolInputError (model self-corrects)', async () => {
    const { executors, sb } = run({ schedule_slots: canned([]) });
    await expect(executors.get_coverage_summary(sb, ctx, { date_start: 'Jan 5' }))
      .rejects.toBeInstanceOf(ToolInputError);
  });

  it('rejects an inverted range as ToolInputError', async () => {
    const { executors, sb } = run({ schedule_slots: canned([]) });
    await expect(executors.get_coverage_summary(sb, ctx, { date_start: '2026-01-20', date_end: '2026-01-10' }))
      .rejects.toBeInstanceOf(ToolInputError);
  });

  it('throws on a failed slots read — never zeros-as-fact', async () => {
    const { executors, sb } = run({ schedule_slots: { error: { message: 'boom' } } });
    await expect(executors.get_coverage_summary(sb, ctx, {})).rejects.toThrow(/boom/);
  });

  // Final-review fix: version-scoped slot reads share the PostgREST ~1000-row
  // cap risk (live repro: 2,201 slot rows in current versions) — a silently
  // capped read would report coverage/fairness numbers that are confidently
  // wrong. loadVersionSlotRows must page and must refuse count-less results.
  it('pages a >1000-slot version and counts every row', async () => {
    const ALL = Array.from({ length: 1050 }, (_, i) =>
      coverageSlot(`s${String(i).padStart(4, '0')}`, '2026-01-05', 'weekday', 'C1', ASSIGNED));
    const { executors, sb, calls } = run({ schedule_slots: pagedTable(ALL) });
    const out = await executors.get_coverage_summary(sb, ctx, {});
    const r = out.result as { total_slots: number; filled: number };
    expect(r.total_slots).toBe(1050);
    expect(r.filled).toBe(1050);
    expect(callsFor(calls, 'schedule_slots', 'range')).toHaveLength(2); // full + short page
  });

  it('throws when the slot row count is unavailable — truncation must not read as fact', async () => {
    const { executors, sb } = run({ schedule_slots: { data: [], count: null } });
    await expect(executors.get_coverage_summary(sb, ctx, {})).rejects.toThrow(/count|truncat/i);
  });
});

// ── get_fairness_report ──────────────────────────────────────────────────────

// Providers: p1 (fte 1, pool), p2 (fte "0.5" string + ARRAY embed, pool via
// partial_call_taker), p3 (other home site → out of pool), p4 (no profile →
// excluded entirely). All active — the inactive gate has its own fixture below.
const FAIRNESS_PROVIDERS = [
  { id: 'p1', last_name: 'Smith', short_display_name: 'Smith', provider_type: 'physician', status: 'active',
    provider_employment_profiles: { fte_value: 1, home_site_id: 'site-1', call_taker: true, partial_call_taker: false } },
  { id: 'p2', last_name: 'Jones', short_display_name: 'Jones', provider_type: 'physician', status: 'active',
    provider_employment_profiles: [{ fte_value: '0.5', home_site_id: 'site-1', call_taker: false, partial_call_taker: true }] },
  { id: 'p3', last_name: 'Wu', short_display_name: 'Wu', provider_type: 'physician', status: 'active',
    provider_employment_profiles: { fte_value: 1, home_site_id: 'site-2', call_taker: true, partial_call_taker: false } },
  { id: 'p4', last_name: 'NoProfile', short_display_name: 'NP', provider_type: 'physician', status: 'active',
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

interface FairnessResult {
  total_call_assignments: number; pool_size: number; pool_fte: number;
  stdev_calls_per_fte: number; providers: FairnessRow[];
}

describe('get_fairness_report', () => {
  async function report() {
    const { executors, sb } = run({
      providers: canned(FAIRNESS_PROVIDERS),
      schedule_slots: canned(FAIRNESS_SLOTS),
    });
    const out = await executors.get_fairness_report(sb, ctx, {});
    return out.result as FairnessResult;
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
      providers: canned(FAIRNESS_PROVIDERS.slice(0, 1)),
      schedule_slots: canned([]),
    });
    await executors.get_fairness_report(sb, { ...ctx, overrideProviderIds: ['p1'] }, {});
    const ins = callsFor(calls, 'providers', 'in');
    expect(ins.some(c => c.args[0] === 'id' && Array.isArray(c.args[1]) && (c.args[1] as string[]).includes('p1'))).toBe(true);
  });

  // Review IMPORTANT 1: genContext §3 gates the real pool on status='active'
  // (providers query, genContext.ts). Without the same gate a departed
  // provider with a lingering call_taker profile inflates pool_fte, deflates
  // everyone's expected, and the prompt's "propose named fixes" step would
  // steer the model toward recommending a departed provider.
  it('excludes inactive providers from pool/expected/stdev but still names them on held calls', async () => {
    const providers = [
      { id: 'p1', last_name: 'Active', short_display_name: 'Act', provider_type: 'physician', status: 'active',
        provider_employment_profiles: { fte_value: 1, home_site_id: 'site-1', call_taker: true, partial_call_taker: false } },
      { id: 'p9', last_name: 'Departed', short_display_name: 'Gone', provider_type: 'physician', status: 'inactive',
        provider_employment_profiles: { fte_value: 1, home_site_id: 'site-1', call_taker: true, partial_call_taker: false } },
      { id: 'p10', last_name: 'DepartedIdle', short_display_name: 'GoneIdle', provider_type: 'physician', status: 'inactive',
        provider_employment_profiles: { fte_value: 1, home_site_id: 'site-1', call_taker: true, partial_call_taker: false } },
    ];
    const slots = [
      { id: 's1', slot_date: '2026-01-05', derived_day_type: 'weekday',
        shift_types: { code: 'C1', category: 'call' },
        assignments: [{ provider_id: 'p1', assignment_status: 'assigned' }] },
      { id: 's2', slot_date: '2026-01-06', derived_day_type: 'weekday',
        shift_types: { code: 'C1', category: 'call' },
        assignments: [{ provider_id: 'p9', assignment_status: 'assigned' }] },
    ];
    const { executors, sb, calls } = run({
      providers: canned(providers),
      schedule_slots: canned(slots),
    });
    const out = await executors.get_fairness_report(sb, ctx, {});
    const r = out.result as FairnessResult;

    // The select must actually carry `status` (the JS gate reads it).
    const sel = callsFor(calls, 'providers', 'select')[0];
    expect(String(sel.args[0])).toMatch(/\bstatus\b/);

    expect(r.pool_size).toBe(1);
    expect(r.pool_fte).toBeCloseTo(1, 10);
    expect(r.total_call_assignments).toBe(2);
    const p1 = row(r, 'p1')!;
    expect(p1.in_pool).toBe(true);
    expect(p1.expected).toBeCloseTo(2, 10); // 2 calls × 1/1 pool FTE
    expect(p1.delta).toBeCloseTo(-1, 10);
    const p9 = row(r, 'p9')!;
    expect(p9.in_pool).toBe(false);
    expect(p9.calls_total).toBe(1);
    expect(p9.name).toBe('Gone');           // still named on the call they hold
    expect(p9.expected).toBeNull();
    expect(r.stdev_calls_per_fte).toBeCloseTo(0, 10); // pool ratios: [1/1] only
    expect(row(r, 'p10')).toBeUndefined();  // inactive AND idle → absent
  });

  // Review minor (b): a missing shift_types embed must not fabricate
  // call-ness — the category falls back to a non-call sentinel.
  it('does not count assignments with a missing shift_types embed as calls', async () => {
    const { executors, sb } = run({
      providers: canned(FAIRNESS_PROVIDERS.slice(0, 1)),
      schedule_slots: canned([{ id: 'sx', slot_date: '2026-01-05', derived_day_type: 'weekday',
          shift_types: null,
          assignments: { provider_id: 'p1', assignment_status: 'assigned' } }]),
    });
    const out = await executors.get_fairness_report(sb, ctx, {});
    const r = out.result as FairnessResult;
    expect(r.total_call_assignments).toBe(0);
    expect(row(r, 'p1')!.calls_total).toBe(0);
  });

  it('throws on a failed providers read — never an empty report as fact', async () => {
    const { executors, sb } = run({
      providers: { error: { message: 'providers down' } },
      schedule_slots: canned([]),
    });
    await expect(executors.get_fairness_report(sb, ctx, {})).rejects.toThrow(/providers down/);
  });

  it('throws on a failed slots read', async () => {
    const { executors, sb } = run({
      providers: canned(FAIRNESS_PROVIDERS),
      schedule_slots: { error: { message: 'slots down' } },
    });
    await expect(executors.get_fairness_report(sb, ctx, {})).rejects.toThrow(/slots down/);
  });
});

// ── find_unfilled ────────────────────────────────────────────────────────────

const POOL_PROVIDERS = ['p1', 'p2', 'p3', 'p4'].map((id, i) => ({
  id, last_name: `L${id}`, short_display_name: `P${i + 1}`, provider_type: 'physician', status: 'active',
  provider_employment_profiles: { fte_value: 1, home_site_id: 'site-1', call_taker: true, partial_call_taker: false },
}));

describe('find_unfilled', () => {
  it('lists open slots with ≤3 cheap context hints (PTO counts, same-day assigned, post-call, stored flags)', async () => {
    const { executors, sb } = run({
      schedule_slots: canned([
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
        ]),
      providers: canned(POOL_PROVIDERS),
      provider_availability: canned([
        // PENDING PTO blocks (clinical invariant 2).
        { provider_id: 'p3', availability_type: 'pto', start_date: '2026-01-05',
          end_date: '2026-01-06', approval_status: 'pending' },
        // Denied PTO is dismissed — must NOT count.
        { provider_id: 'p4', availability_type: 'pto', start_date: '2026-01-05',
          end_date: '2026-01-05', approval_status: 'denied' },
      ]),
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
      schedule_slots: canned([{ id: 's-open', slot_date: '2026-01-05', derived_day_type: 'weekday',
          shift_types: { code: 'C1', category: 'call', requires_post_call_rule: false },
          assignments: null }]),
      providers: canned(POOL_PROVIDERS),
      provider_availability: canned([]),
    });
    const out = await executors.find_unfilled(sb, ctx, {});
    const r = out.result as { slots: Array<{ hints: string[] }> };
    expect(r.slots[0].hints).toEqual([]);
  });

  // Review minor (a): with an empty pool the PTO hint must not read
  // "N of 0 pool providers" — it drops the pool framing instead.
  it('rephrases the PTO hint when the pool is empty', async () => {
    const { executors, sb } = run({
      schedule_slots: canned([{ id: 's-open', slot_date: '2026-01-05', derived_day_type: 'weekday',
          shift_types: { code: 'C1', category: 'call', requires_post_call_rule: false },
          assignments: null }]),
      providers: canned([]), // no pool at all
      provider_availability: canned([
        { provider_id: 'p9', availability_type: 'pto', start_date: '2026-01-05',
          end_date: '2026-01-05', approval_status: 'approved' },
      ]),
    });
    const out = await executors.find_unfilled(sb, ctx, {});
    const r = out.result as { pool_size: number; slots: Array<{ hints: string[] }> };
    expect(r.pool_size).toBe(0);
    const all = r.slots[0].hints.join(' | ');
    expect(all).toMatch(/blocked by PTO/i);
    expect(all).not.toMatch(/of 0/);
  });

  it('reports zero open slots without touching availability', async () => {
    const { executors, sb, calls } = run({
      schedule_slots: canned([{ id: 's1', slot_date: '2026-01-05', derived_day_type: 'weekday',
          shift_types: { code: 'C1', category: 'call', requires_post_call_rule: false },
          assignments: { provider_id: 'p1', assignment_status: 'assigned' } }]),
      providers: canned(POOL_PROVIDERS),
    });
    const out = await executors.find_unfilled(sb, ctx, {});
    expect((out.result as { open_count: number }).open_count).toBe(0);
    expect(callsFor(calls, 'provider_availability', 'select')).toHaveLength(0);
  });

  it('throws on a failed availability read — hints must not silently drop', async () => {
    const { executors, sb } = run({
      schedule_slots: canned([{ id: 's-open', slot_date: '2026-01-05', derived_day_type: 'weekday',
          shift_types: { code: 'C1', category: 'call', requires_post_call_rule: false },
          assignments: null }]),
      providers: canned(POOL_PROVIDERS),
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
//
// Draft isolation (2026-07-15 spec §4, user-approved behavior change): the tool
// reads the COMMITTED scope — assignments in PUBLISHED versions (any site) plus
// this schedule's current version. An unpublished draft of ANOTHER schedule is
// not a real booking and must be invisible; both directions are pinned below.
// The executor runs two paged legs per mode (published + current-version) and
// dedupes, so the fakes emulate the version_status / schedule_version_id eq
// filters — exclusion is pinned against the emitted query shape, not the fake's
// goodwill.

// Shared predicate for both fake shapes: assignment rows carry the version info
// under the schedule_slots embed; slot rows carry it flat.
function matchesVersionFilters(r: Record<string, unknown>, filters: Filter[]): boolean {
  const slot = (r.schedule_slots ?? r) as Record<string, unknown>;
  return filters.every(f => {
    if (f.method !== 'eq') return true;
    const [col, val] = f.args as [string, unknown];
    if (col.endsWith('schedule_versions.version_status')) {
      return (slot.schedule_versions as { version_status?: string } | undefined)?.version_status === val;
    }
    if (col.endsWith('schedule_version_id')) return slot.schedule_version_id === val;
    return true;
  });
}
function committedAware(rows: Array<Record<string, unknown>>): TableCfg {
  return (filters) => {
    const out = rows.filter(r => matchesVersionFilters(r, filters));
    return { data: out, count: out.length };
  };
}
// Filter-aware AND range-paged (for the row-cap test).
function pagedCommitted(all: Array<Record<string, unknown>>): TableCfg {
  return (filters) => {
    const matching = all.filter(r => matchesVersionFilters(r, filters));
    const rangeF = filters.find(f => f.method === 'range');
    const from = (rangeF?.args[0] as number) ?? 0;
    const to = (rangeF?.args[1] as number) ?? matching.length - 1;
    return { data: matching.slice(from, to + 1), count: matching.length };
  };
}

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

  it('provider mode: committed scope — current-version draft + published other-version rows; another schedule\'s DRAFT is excluded', async () => {
    const { executors, sb, calls } = run({
      assignments: committedAware([
        { id: 'a1', provider_id: 'p1', assignment_status: 'assigned',
          providers: { last_name: 'Smith', short_display_name: 'S. Smith' },   // object embed
          schedule_slots: { id: 'sl1', slot_date: '2026-01-05', site_id: 'site-1',
            derived_day_type: 'weekday', schedule_version_id: 'ver-1',
            schedule_versions: { version_status: 'draft' },                    // current version, still draft → included
            shift_types: { code: 'C1' }, sites: { name: 'Main', short_name: 'MAIN' } } },
        { id: 'a2', provider_id: 'p1', assignment_status: 'assigned',
          providers: [{ last_name: 'Smith', short_display_name: 'S. Smith' }], // array embed
          schedule_slots: { id: 'sl2', slot_date: '2026-01-06', site_id: 'site-2',
            derived_day_type: 'weekday', schedule_version_id: 'ver-9',
            schedule_versions: { version_status: 'published' },                // committed elsewhere → included, flagged false
            shift_types: { code: 'C2' }, sites: { name: 'North', short_name: 'NORTH' } } },
        { id: 'a3', provider_id: 'p1', assignment_status: 'assigned',
          providers: { short_display_name: 'S. Smith' },
          schedule_slots: { id: 'sl3', slot_date: '2026-01-06', site_id: 'site-3',
            derived_day_type: 'weekday', schedule_version_id: 'ver-8',
            schedule_versions: { version_status: 'draft' },                    // ANOTHER schedule's draft → invisible
            shift_types: { code: 'C9' }, sites: { short_name: 'WEST' } } },
      ]),
    });
    const out = await executors.who_is_on(sb, ctx, { provider_id: 'p1', date: '2026-01-05', window_days: 1 });
    const r = out.result as {
      rows: Array<{ date: string; code: string; site: string; provider: string;
        schedule_version_id: string; in_current_version: boolean }>;
    };
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      date: '2026-01-05', code: 'C1', site: 'MAIN', provider: 'S. Smith',
      schedule_version_id: 'ver-1', in_current_version: true,
    });
    expect(r.rows[1]).toMatchObject({
      date: '2026-01-06', code: 'C2', site: 'NORTH',
      schedule_version_id: 'ver-9', in_current_version: false,
    });
    // The other-schedule draft row is ABSENT (draft isolation).
    expect(r.rows.some(row => row.schedule_version_id === 'ver-8')).toBe(false);
    // Filters: provider eq + date window on the joined slot date, plus the
    // committed predicate on one leg and the current-version eq on the other.
    const eqs = callsFor(calls, 'assignments', 'eq');
    expect(eqs.some(c => c.args[0] === 'provider_id' && c.args[1] === 'p1')).toBe(true);
    expect(callsFor(calls, 'assignments', 'gte')[0].args).toEqual(['schedule_slots.slot_date', '2026-01-04']);
    expect(callsFor(calls, 'assignments', 'lte')[0].args).toEqual(['schedule_slots.slot_date', '2026-01-06']);
    expect(eqs.some(c => c.args[0] === 'schedule_slots.schedule_versions.version_status' && c.args[1] === 'published')).toBe(true);
    expect(eqs.some(c => c.args[0] === 'schedule_slots.schedule_version_id' && c.args[1] === 'ver-1')).toBe(true);
  });

  it('provider mode dedupes a row that is both PUBLISHED and in the current version', async () => {
    const { executors, sb } = run({
      assignments: committedAware([
        { id: 'a1', provider_id: 'p1', assignment_status: 'assigned',
          providers: { short_display_name: 'S. Smith' },
          schedule_slots: { id: 'sl1', slot_date: '2026-01-05', site_id: 'site-1',
            derived_day_type: 'weekday', schedule_version_id: 'ver-1',
            schedule_versions: { version_status: 'published' },                // satisfies BOTH legs
            shift_types: { code: 'C1' }, sites: { short_name: 'MAIN' } } },
      ]),
    });
    const out = await executors.who_is_on(sb, ctx, { provider_id: 'p1' });
    const r = out.result as { total: number; rows: unknown[] };
    expect(r.total).toBe(1);
    expect(r.rows).toHaveLength(1);
  });

  it('provider mode without a date defaults the window to the schedule range', async () => {
    const { executors, sb, calls } = run({ assignments: canned([]) });
    await executors.who_is_on(sb, ctx, { provider_id: 'p1' });
    expect(callsFor(calls, 'assignments', 'gte')[0].args).toEqual(['schedule_slots.slot_date', '2026-01-01']);
    expect(callsFor(calls, 'assignments', 'lte')[0].args).toEqual(['schedule_slots.slot_date', '2026-01-31']);
  });

  it('date mode: committed scope — published + current-version slots included, another schedule\'s DRAFT slots excluded', async () => {
    const slot = (id: string, version: string, status: string, code: string) => ({
      id, slot_date: '2026-01-05', site_id: 'site-1', derived_day_type: 'weekday',
      schedule_version_id: version, schedule_versions: { version_status: status },
      shift_types: { code }, sites: { short_name: 'MAIN' },
    });
    const { executors, sb } = run({
      schedule_slots: committedAware([
        slot('sl1', 'ver-1', 'draft', 'C1'),      // current version (draft) → included
        slot('sl2', 'ver-9', 'published', 'C2'),  // committed elsewhere → included
        slot('sl3', 'ver-8', 'draft', 'C3'),      // another schedule's draft → invisible
      ]),
      // Serve one assigned row per slot id the executor asks for.
      assignments: (filters) => {
        const inF = filters.find(f => f.method === 'in');
        const ids = (inF?.args[1] as string[]) ?? [];
        return {
          data: ids.map(id => ({ id: `a-${id}`, schedule_slot_id: id, provider_id: 'p1',
            assignment_status: 'assigned', providers: { short_display_name: 'S. Smith' } })),
        };
      },
    });
    const out = await executors.who_is_on(sb, ctx, { date: '2026-01-05' });
    const r = out.result as {
      rows: Array<{ code: string; schedule_version_id: string; in_current_version: boolean }>;
    };
    expect(r.rows.map(x => x.code).sort()).toEqual(['C1', 'C2']);
    expect(r.rows.find(x => x.code === 'C1')).toMatchObject({ schedule_version_id: 'ver-1', in_current_version: true });
    expect(r.rows.find(x => x.code === 'C2')).toMatchObject({ schedule_version_id: 'ver-9', in_current_version: false });
    expect(r.rows.some(x => x.schedule_version_id === 'ver-8')).toBe(false);
  });

  it('date mode: chunks assignment reads at READ_CHUNK over the slot ids', async () => {
    const manySlots = Array.from({ length: READ_CHUNK + 50 }, (_, i) => ({
      id: `sl${i}`, slot_date: '2026-01-05', site_id: 'site-1',
      derived_day_type: 'weekday', schedule_version_id: 'ver-1',  // all current-version (the published leg matches none)
      shift_types: { code: 'C1' }, sites: { short_name: 'MAIN' },
    }));
    // Function-config: serve one assigned row per recorded `.in` chunk.
    const { executors, sb, calls } = run({
      schedule_slots: committedAware(manySlots),
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

  // Review IMPORTANT 2: the date-mode slots read spans sites and (published)
  // schedules — PostgREST's ~1000-row default cap would silently understate.
  // Both legs must page with count:'exact' + .range() until every row arrived
  // (dashboard fetchRollupRows precedent).
  it('date mode pages the slots reads past the PostgREST row cap', async () => {
    const ALL = Array.from({ length: 1050 }, (_, i) => ({
      id: `sl${String(i).padStart(4, '0')}`, slot_date: '2026-01-05', site_id: 'site-1',
      derived_day_type: 'weekday', schedule_version_id: 'ver-1',  // current-version leg carries all 1050
      shift_types: { code: 'C1' }, sites: { short_name: 'MAIN' },
    }));
    const { executors, sb, calls } = run({
      schedule_slots: pagedCommitted(ALL),
      assignments: canned([]),
    });
    await executors.who_is_on(sb, ctx, { date: '2026-01-05' });
    const ranges = callsFor(calls, 'schedule_slots', 'range');
    // Published leg: one (empty) page. Current-version leg: 1050 rows → full
    // page + short page.
    expect(ranges.length).toBe(3);
    // Every slot id flowed into the chunked assignment reads: 1050 → 6 chunks.
    expect(callsFor(calls, 'assignments', 'in')).toHaveLength(6);
  });

  it('throws when the row count is unavailable — truncation must not read as fact', async () => {
    const { executors, sb } = run({
      // data but count:null (what a non-exact select would return).
      schedule_slots: { data: [], count: null },
    });
    await expect(executors.who_is_on(sb, ctx, { date: '2026-01-05' }))
      .rejects.toThrow(/count|truncat/i);
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
