// GET /api/scheduling/master-schedule — combined published-schedule view.
// Regression: the live DB's UNIQUE(schedule_slot_id) makes PostgREST return
// the schedule_slots → assignments embed as a SINGLE OBJECT (or null), not an
// array. The route must normalize both shapes (the object shape used to throw
// in the provider-collection loop → 500).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeFakeSupabase, type TableCfg } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

const holder = vi.hoisted(() => ({ sb: null as unknown }));
vi.mock('@/lib/supabaseScheduling', () => ({
  sbSchedulingServer: () => holder.sb,
}));

import { GET } from './route';

const ASSIGNMENT_ROW = {
  id: 'a-1', provider_id: 'p1', assignment_status: 'assigned',
  is_open_call: false, source_type: 'manual',
  providers: { id: 'p1', short_display_name: 'S. Smith', initials: 'SS', provider_type: 'physician' },
};

const SCHEDULES_CFG: TableCfg = {
  data: [{
    id: 'sched-1', schedule_name: 'S', schedule_type: 'call', provider_group: 'physician',
    date_start: '2026-01-01', date_end: '2026-01-31', status: 'published',
    published_version_number: 1,
  }],
  error: null,
};
const PROVIDERS_CFG: TableCfg = {
  data: [{ id: 'p1', first_name: 'Sam', last_name: 'Smith', short_display_name: 'S. Smith', initials: 'SS', provider_type: 'physician' }],
  error: null,
};

function slotsCfg(assignmentsEmbed: unknown): TableCfg {
  return {
    data: [{
      id: 'slot-1', slot_date: '2026-01-05', slot_index: 0,
      shift_types: { id: 'st-C1', code: 'C1' },
      assignments: assignmentsEmbed,
    }],
    error: null,
  };
}

function setupTables(tables: Record<string, TableCfg>) {
  const { sb, calls } = makeFakeSupabase({ tables });
  holder.sb = sb;
  return calls;
}

function setup(assignmentsEmbed: unknown) {
  setupTables({
    schedules: SCHEDULES_CFG,
    schedule_versions: { data: { id: 'ver-1' }, error: null },
    schedule_slots: slotsCfg(assignmentsEmbed),
    providers: PROVIDERS_CFG,
  });
}

async function get() {
  const req = {
    url: 'http://localhost/api/scheduling/master-schedule?site_id=site-1&from=2026-01-01&to=2026-01-31',
  } as NextRequest;
  const res = await GET(req);
  return { res, json: await res.json() };
}

beforeEach(() => { holder.sb = null; });

describe('GET /api/scheduling/master-schedule — assignments embed shapes', () => {
  it('array-shaped embed (dev fakes / pre-constraint DBs) works as before', async () => {
    setup([ASSIGNMENT_ROW]);
    const { res, json } = await get();
    expect(res.status).toBe(200);
    expect(json.slots).toHaveLength(1);
    expect(json.slots[0].assignments).toEqual([ASSIGNMENT_ROW]);
    expect(json.providers.map((p: { id: string }) => p.id)).toContain('p1');
  });

  it('single-OBJECT embed (live one-to-one shape) is normalized into an array and its provider is still collected', async () => {
    setup(ASSIGNMENT_ROW); // object, not [object]
    const { res, json } = await get();
    expect(res.status).toBe(200);
    expect(Array.isArray(json.slots[0].assignments)).toBe(true);
    expect(json.slots[0].assignments).toEqual([ASSIGNMENT_ROW]);
    expect(json.providers.map((p: { id: string }) => p.id)).toContain('p1');
  });

  it('null embed (one-to-one, no assignment row) normalizes to an empty array', async () => {
    setup(null);
    const { res, json } = await get();
    expect(res.status).toBe(200);
    expect(json.slots[0].assignments).toEqual([]);
  });
});

// A read that fails must never render as a schedule with fewer slots. Every one
// of these used to return 200 with a silently shorter payload, which on the
// master schedule reads as "nobody is on that day".
describe('GET /api/scheduling/master-schedule — failed reads never degrade into a thin 200', () => {
  it('a schedule_versions error is a 500, not a skipped schedule', async () => {
    setupTables({
      schedules: SCHEDULES_CFG,
      schedule_versions: { data: null, error: { message: 'versions boom' } },
      schedule_slots: slotsCfg([ASSIGNMENT_ROW]),
      providers: PROVIDERS_CFG,
    });
    const { res, json } = await get();
    expect(res.status).toBe(500);
    expect(json.error).toContain('versions boom');
    expect(json.slots).toBeUndefined();
  });

  it('a schedule with no published version is still a clean 200 with no slots', async () => {
    setupTables({
      schedules: SCHEDULES_CFG,
      schedule_versions: { data: null, error: null },
      schedule_slots: slotsCfg([ASSIGNMENT_ROW]),
      providers: PROVIDERS_CFG,
    });
    const { res, json } = await get();
    expect(res.status).toBe(200);
    expect(json.slots).toEqual([]);
    expect(json.schedules).toHaveLength(1);
  });

  it('a schedule_slots error is a 500, not a slot-free 200', async () => {
    setupTables({
      schedules: SCHEDULES_CFG,
      schedule_versions: { data: { id: 'ver-1' }, error: null },
      schedule_slots: { data: null, error: { message: 'slots boom' } },
      providers: PROVIDERS_CFG,
    });
    const { res, json } = await get();
    expect(res.status).toBe(500);
    expect(json.error).toContain('slots boom');
  });

  it('a providers error is a 500, not slots stripped of their names', async () => {
    setupTables({
      schedules: SCHEDULES_CFG,
      schedule_versions: { data: { id: 'ver-1' }, error: null },
      schedule_slots: slotsCfg([ASSIGNMENT_ROW]),
      providers: { data: null, error: { message: 'providers boom' } },
    });
    const { res, json } = await get();
    expect(res.status).toBe(500);
    expect(json.error).toContain('providers boom');
  });
});

describe('GET /api/scheduling/master-schedule — slot reads page past PostgREST\'s cap', () => {
  it('collects every page instead of stopping at the first', async () => {
    const rows = [0, 1, 2].map(i => ({
      id: `slot-${i}`, slot_date: '2026-01-05', slot_index: i,
      shift_types: { id: 'st-C1', code: 'C1' },
      assignments: null,
    }));
    setupTables({
      schedules: SCHEDULES_CFG,
      schedule_versions: { data: { id: 'ver-1' }, error: null },
      // Two pages of a 3-row result, sliced off the recorded .range() args so
      // the test fails if the route ever stops passing a range through.
      schedule_slots: filters => {
        const range = filters.find(f => f.method === 'range');
        const [from, to] = (range?.args ?? [0, 1]) as [number, number];
        // Shrink the window to 2 so two pages are needed without faking 1000 rows.
        const start = from === 0 ? 0 : 2;
        const end = to === 999 ? 2 : 3;
        return { data: rows.slice(start, end), error: null, count: 3 };
      },
      providers: PROVIDERS_CFG,
    });
    const { res, json } = await get();
    expect(res.status).toBe(200);
    expect(json.slots.map((s: { id: string }) => s.id)).toEqual(['slot-0', 'slot-1', 'slot-2']);
  });

  it('a stalled page is a 500, never the rows read so far', async () => {
    setupTables({
      schedules: SCHEDULES_CFG,
      schedule_versions: { data: { id: 'ver-1' }, error: null },
      // Reports 5 rows but only ever hands back 1 — the shape of a truncated
      // read. The route must refuse it rather than serve a 1-slot schedule.
      schedule_slots: filters => {
        const range = filters.find(f => f.method === 'range');
        const from = ((range?.args ?? [0])[0]) as number;
        return {
          data: from === 0
            ? [{ id: 'slot-0', slot_date: '2026-01-05', slot_index: 0, shift_types: null, assignments: null }]
            : [],
          error: null,
          count: 5,
        };
      },
      providers: PROVIDERS_CFG,
    });
    const { res, json } = await get();
    expect(res.status).toBe(500);
    expect(json.error).toContain('1 of 5');
  });
});
