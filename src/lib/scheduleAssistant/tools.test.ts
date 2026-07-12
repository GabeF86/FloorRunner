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
import { createToolExecutors, type ScheduleCtx } from './tools';
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
