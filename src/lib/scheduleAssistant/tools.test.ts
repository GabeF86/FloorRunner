// get_grid — regression for the live DB's one-to-one assignments embed.
// UNIQUE(schedule_slot_id) makes PostgREST return schedule_slots →
// assignments as ONE OBJECT (or null), not an array. The old
// `(r.assignments ?? [])[0]` read `[0]` off an object → undefined → every
// assigned slot silently rendered as OPEN for the assistant.
//
// Also: completeness guards for the version-scoped slot reads (get_grid,
// get_schedule_context). PostgREST caps un-ranged selects (~1000 rows) and a
// single version can exceed that (live repro: 2,201 slot rows across current
// versions), so both reads page with count:'exact' + .range and must throw
// rather than report a partial grid / partial slot count as fact.
import { describe, it, expect } from 'vitest';
import { createToolExecutors, loadScheduleCtx, type ScheduleCtx } from './tools';
import { makeFakeSupabase, callsFor, type Filter } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

const ctx: ScheduleCtx = {
  scheduleId: 'sched-1', siteId: 'site-1', versionId: 'ver-1',
  scheduleName: 'S', dateStart: '2026-01-01', dateEnd: '2026-01-31',
};

const ASSIGNED_ROW = {
  provider_id: 'p1', assignment_status: 'assigned',
  providers: { last_name: 'Smith', short_display_name: 'S. Smith' },
};

function slotRow(assignmentsEmbed: unknown) {
  return {
    id: 'slot-1', slot_date: '2026-01-05', slot_index: 0, derived_day_type: 'weekday',
    shift_types: { code: 'C1' },
    assignments: assignmentsEmbed,
  };
}

async function runGetGrid(assignmentsEmbed: unknown) {
  const { sb } = makeFakeSupabase({
    tables: { schedule_slots: { data: [slotRow(assignmentsEmbed)], error: null, count: 1 } },
  });
  const executors = createToolExecutors();
  return executors.get_grid(sb as never, ctx, {});
}

describe('get_grid — assignments embed shapes', () => {
  it('array-shaped embed shows the assigned provider', async () => {
    const out = await runGetGrid([ASSIGNED_ROW]);
    expect((out.result as { grid: string }).grid).toContain('S. Smith');
  });

  it('single-OBJECT embed (live one-to-one shape) shows the assigned provider, not OPEN', async () => {
    const out = await runGetGrid(ASSIGNED_ROW); // object, not [object]
    const grid = (out.result as { grid: string }).grid;
    expect(grid).toContain('S. Smith');
    expect(grid).not.toContain('OPEN');
  });

  it('null embed (one-to-one, no row) renders OPEN', async () => {
    const out = await runGetGrid(null);
    expect((out.result as { grid: string }).grid).toContain('OPEN');
  });
});

// Serve pages off the recorded .range args, like a real capped API.
function pagedTable(all: unknown[]) {
  return (filters: Filter[]) => {
    const rangeF = filters.find(f => f.method === 'range');
    const from = (rangeF?.args[0] as number) ?? 0;
    const to = (rangeF?.args[1] as number) ?? all.length - 1;
    return { data: all.slice(from, to + 1), count: all.length };
  };
}

describe('version-scoped slot reads — completeness guards', () => {
  it('get_grid throws when the slot row count is unavailable (possible truncation)', async () => {
    const { sb } = makeFakeSupabase({
      tables: { schedule_slots: { data: [slotRow(null)], error: null, count: null } },
    });
    const executors = createToolExecutors();
    await expect(executors.get_grid(sb as never, ctx, {})).rejects.toThrow(/count|truncat/i);
  });

  it('get_grid pages a >1000-slot version and renders every row', async () => {
    const ALL = Array.from({ length: 1050 }, (_, i) => ({
      id: `slot-${String(i).padStart(4, '0')}`, slot_date: '2026-01-05', slot_index: 0,
      derived_day_type: 'weekday', shift_types: { code: 'C1' }, assignments: null,
    }));
    const { sb, calls } = makeFakeSupabase({ tables: { schedule_slots: pagedTable(ALL) } });
    const executors = createToolExecutors();
    const out = await executors.get_grid(sb as never, ctx, {});
    expect((out.result as { slots: number }).slots).toBe(1050);
    expect(callsFor(calls, 'schedule_slots', 'range')).toHaveLength(2); // full page + short page
  });

  it('get_schedule_context throws when the slot row count is unavailable', async () => {
    const { sb } = makeFakeSupabase({
      tables: { schedule_slots: { data: [], error: null, count: null } },
    });
    const executors = createToolExecutors();
    await expect(executors.get_schedule_context(sb as never, ctx, {})).rejects.toThrow(/count|truncat/i);
  });

  it('get_schedule_context pages a >1000-slot version into an exact total_slots', async () => {
    const ALL = Array.from({ length: 1050 }, (_, i) => ({ id: `slot-${String(i).padStart(4, '0')}` }));
    const { sb, calls } = makeFakeSupabase({ tables: { schedule_slots: pagedTable(ALL) } });
    const executors = createToolExecutors();
    const out = await executors.get_schedule_context(sb as never, ctx, {});
    const metrics = (out.result as { metrics: { total_slots: number } }).metrics;
    expect(metrics.total_slots).toBe(1050);
    expect(callsFor(calls, 'schedule_slots', 'range')).toHaveLength(2);
    // All 1050 slot ids flowed into the chunked assignment count (6 chunks).
    expect(callsFor(calls, 'assignments', 'in')).toHaveLength(6);
  });
});

// The Anthropic API compiles a grammar for strict:true tools and rejects the
// whole request (400 invalid_request_error) when the strict tool set carries
// too many OPTIONAL parameters — "limit: 24" by the API's own counting, which
// ran ~3 higher than a local properties-minus-required count when this first
// hit production (live repro 2026-07-12: 31 counted vs 28 local). Bound at 20
// locally to keep margin for that skew. Tools that need wide optional
// surfaces (the upserts) must drop strict and rely on their zod executors.
describe('assistant tool schemas — strict grammar limit', () => {
  it('keeps total optional params across strict tools under the API limit', async () => {
    const { assistantTools } = await import('./tools');
    let totalOptional = 0;
    for (const t of assistantTools) {
      if (!t.strict) continue;
      const schema = t.input_schema as { properties?: Record<string, unknown>; required?: string[] };
      const props = Object.keys(schema.properties ?? {});
      const required = new Set(schema.required ?? []);
      totalOptional += props.filter((p) => !required.has(p)).length;
    }
    // Count breakdown across the strict tools (non-strict upserts don't count):
    //   analysis reads:  get_coverage_summary 2 + who_is_on 3            = 5
    //   intake:          list_availability 3 + record_availability 1
    //                    + cancel_availability 0 + update_provider_profile 4
    //                    + update_site_credentials 3                     = 11
    //   (update_site_credentials deliberately EXCLUDES can_take_backup_call —
    //    dead in the engine: eligibility.ts gates call/weekend/holiday only)
    //   (get_schedule_context / get_grid / get_fairness_report /
    //    find_unfilled / assign_provider / clear_assignment /
    //    regenerate_schedule contribute 0 optionals each)
    // → 16 total, comfortably under the API's grammar bound (locally 20).
    expect(totalOptional).toBe(16);
    expect(totalOptional).toBeLessThanOrEqual(20);
  });

  // Second grammar limit hit live the same day: "The compiled grammar is too
  // large" — update_call_pattern's embedded CallPatternDoc schema (~2.8KB of
  // nested unions) was the outlier; every intentionally-strict tool is ≤342
  // bytes serialized. Cap gives 3× headroom without allowing another
  // deep-nested document schema to sneak back in as strict.
  it('keeps each strict tool schema small enough to grammar-compile', async () => {
    const { assistantTools } = await import('./tools');
    for (const t of assistantTools) {
      if (!t.strict) continue;
      expect(
        JSON.stringify(t.input_schema).length,
        `${t.name} strict schema too large — drop strict and validate in the executor`,
      ).toBeLessThanOrEqual(1000);
    }
  });
});

// ── provider_limits (2026-07-22, patch34) — read-only assistant surface ──────
// NO new tool (16/20 strict-tool budget): loadScheduleCtx carries the parsed
// limits (narrow-retry when the column predates patch34) and
// get_schedule_context summarizes them read-only.

describe('loadScheduleCtx — provider_limits', () => {
  const SCHED_ROW = {
    id: 'sched-1', site_id: 'site-1', schedule_name: 'S',
    date_start: '2026-01-01', date_end: '2026-01-31',
    included_provider_ids: null,
  };

  it('parses stored limits onto the ctx', async () => {
    const { sb } = makeFakeSupabase({ tables: {
      schedules: { data: { ...SCHED_ROW, provider_limits: { p1: { calls: { C1: 2 }, daysOff: 3 } } }, error: null },
      schedule_versions: { data: { id: 'ver-1', version_number: 1 }, error: null },
    } });
    const loaded = await loadScheduleCtx(sb as never, 'sched-1');
    expect(loaded.providerLimits).toEqual({ p1: { calls: { C1: 2 }, daysOff: 3 } });
  });

  it('narrow-retries when the column is missing (pre-patch34) — ctx loads, limits undefined', async () => {
    const { sb, calls } = makeFakeSupabase({ tables: {
      schedules: (filters: Filter[]) => {
        const sel = filters.find(f => f.method === 'select');
        return String(sel?.args[0]).includes('provider_limits')
          ? { data: null, error: { message: 'column schedules.provider_limits does not exist' } }
          : { data: SCHED_ROW, error: null };
      },
      schedule_versions: { data: { id: 'ver-1', version_number: 1 }, error: null },
    } });
    const loaded = await loadScheduleCtx(sb as never, 'sched-1');
    expect(loaded.siteId).toBe('site-1');
    expect(loaded.providerLimits).toBeUndefined();
    expect(callsFor(calls, 'schedules', 'select')).toHaveLength(2); // wide, then narrow retry
  });

  it('malformed stored limits are ignored (ctx still loads)', async () => {
    const { sb } = makeFakeSupabase({ tables: {
      schedules: { data: { ...SCHED_ROW, provider_limits: 'garbage' }, error: null },
      schedule_versions: { data: { id: 'ver-1', version_number: 1 }, error: null },
    } });
    const loaded = await loadScheduleCtx(sb as never, 'sched-1');
    expect(loaded.providerLimits).toBeUndefined();
  });
});

describe('get_schedule_context — provider_limits summary', () => {
  const contextTables = {
    sites: { data: { id: 'site-1', name: 'Main', short_name: 'M' }, error: null },
    shift_types: { data: [], error: null },
    call_patterns: { data: null, error: null },
    rule_sets: { data: [], error: null },
    providers: { data: [], error: null },
    schedule_slots: { data: [], error: null, count: 0 },
    assignments: { data: [], error: null },
  };

  it('surfaces the ctx limits read-only on the result', async () => {
    const { sb } = makeFakeSupabase({ tables: contextTables });
    const executors = createToolExecutors();
    const out = await executors.get_schedule_context(sb as never, {
      ...ctx, providerLimits: { p1: { workingDays: 12 } },
    }, {});
    expect((out.result as { provider_limits: unknown }).provider_limits)
      .toEqual({ p1: { workingDays: 12 } });
  });

  it('reports null when no limits are stated', async () => {
    const { sb } = makeFakeSupabase({ tables: contextTables });
    const executors = createToolExecutors();
    const out = await executors.get_schedule_context(sb as never, ctx, {});
    expect((out.result as { provider_limits: unknown }).provider_limits).toBeNull();
  });
});
