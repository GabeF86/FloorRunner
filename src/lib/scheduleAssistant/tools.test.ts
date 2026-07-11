// get_grid — regression for the live DB's one-to-one assignments embed.
// UNIQUE(schedule_slot_id) makes PostgREST return schedule_slots →
// assignments as ONE OBJECT (or null), not an array. The old
// `(r.assignments ?? [])[0]` read `[0]` off an object → undefined → every
// assigned slot silently rendered as OPEN for the assistant.
import { describe, it, expect } from 'vitest';
import { createToolExecutors, type ScheduleCtx } from './tools';
import { makeFakeSupabase } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

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
    tables: { schedule_slots: { data: [slotRow(assignmentsEmbed)], error: null } },
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
