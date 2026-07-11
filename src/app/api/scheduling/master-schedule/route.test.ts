// GET /api/scheduling/master-schedule — combined published-schedule view.
// Regression: the live DB's UNIQUE(schedule_slot_id) makes PostgREST return
// the schedule_slots → assignments embed as a SINGLE OBJECT (or null), not an
// array. The route must normalize both shapes (the object shape used to throw
// in the provider-collection loop → 500).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeFakeSupabase } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

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

function setup(assignmentsEmbed: unknown) {
  const { sb } = makeFakeSupabase({
    tables: {
      schedules: {
        data: [{
          id: 'sched-1', schedule_name: 'S', schedule_type: 'call', provider_group: 'physician',
          date_start: '2026-01-01', date_end: '2026-01-31', status: 'published',
          published_version_number: 1,
        }],
        error: null,
      },
      schedule_versions: { data: { id: 'ver-1' }, error: null },
      schedule_slots: {
        data: [{
          id: 'slot-1', slot_date: '2026-01-05', slot_index: 0,
          shift_types: { id: 'st-C1', code: 'C1' },
          assignments: assignmentsEmbed,
        }],
        error: null,
      },
      providers: { data: [{ id: 'p1', first_name: 'Sam', last_name: 'Smith', short_display_name: 'S. Smith', initials: 'SS', provider_type: 'physician' }], error: null },
    },
  });
  holder.sb = sb;
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
