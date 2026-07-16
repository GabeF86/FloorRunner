// POST /api/scheduling/schedules — slot materialization tests (Task 11).
// A template with required_count N must produce N sibling slot rows
// (slot_index 0..N-1, required_count: 1 each), each with its OWN open
// assignment row (scheduling.assignments has UNIQUE(schedule_slot_id)).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeFakeSupabase, callsFor } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

const holder = vi.hoisted(() => ({ sb: null as unknown }));
vi.mock('@/lib/supabaseScheduling', () => ({
  sbSchedulingServer: () => holder.sb,
}));

import { POST } from './route';

// ── Fixture helpers ──────────────────────────────────────────────────────────

const BODY = {
  organization_id: 'org-1',
  site_id: 'site-1',
  schedule_type: 'call',
  provider_group: 'physician',
  date_start: '2026-01-07', // Wednesday
  date_end: '2026-01-07',
};

function fakeReq(body: Record<string, unknown> = BODY): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function template(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tmpl-1',
    site_id: 'site-1',
    shift_type_id: 'st-C1',
    day_type: 'weekday',
    required_count: 1,
    is_active: true,
    shift_types: { name: 'Call 1', display_order: 1 },
    ...overrides,
  };
}

function setup(templates: Record<string, unknown>[]) {
  const { sb, calls } = makeFakeSupabase({
    tables: {
      sites: { data: { name: 'Mercy General' }, error: null },
      schedules: { data: { id: 'sched-1', schedule_name: 'Mercy General - Schedule - January 2026', status: 'draft' }, error: null },
      schedule_versions: { data: { id: 'ver-1' }, error: null },
      shift_templates: { data: templates, error: null },
      holiday_calendars: { data: [], error: null },
      // Echo back one id per inserted slot row so the assignment pairing is exercised.
      schedule_slots: (filters) => {
        const ins = filters.find(f => f.method === 'insert');
        const rows = (ins?.args[0] as unknown[]) ?? [];
        return { data: rows.map((_, i) => ({ id: `slot-${i}` })), error: null };
      },
      assignments: { data: [], error: null },
    },
  });
  holder.sb = sb;
  return { calls };
}

function insertedRows(calls: ReturnType<typeof setup>['calls'], table: string): Record<string, unknown>[] {
  const inserts = callsFor(calls, table, 'insert');
  expect(inserts).toHaveLength(1); // bulk insert, not per-row
  return inserts[0].args[0] as Record<string, unknown>[];
}

beforeEach(() => { holder.sb = null; });

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/scheduling/schedules — required_count → sibling slots', () => {
  it('required_count: 2 produces 2 sibling slot rows (slot_index 0/1, required_count 1 each)', async () => {
    const { calls } = setup([template({ required_count: 2 })]);
    const res = await POST(fakeReq());
    expect(res.status).toBe(200);

    const slots = insertedRows(calls, 'schedule_slots');
    expect(slots).toHaveLength(2);
    expect(slots.map(s => s.slot_index)).toEqual([0, 1]);
    for (const s of slots) {
      expect(s.required_count).toBe(1);
      expect(s.slot_date).toBe('2026-01-07');
      expect(s.shift_type_id).toBe('st-C1');
      expect(s.schedule_version_id).toBe('ver-1');
      expect(s.site_id).toBe('site-1');
      expect(s.derived_day_type).toBe('weekday');
      expect(s.locked).toBe(false);
    }
  });

  it('each sibling slot gets its OWN open assignment row (UNIQUE schedule_slot_id)', async () => {
    const { calls } = setup([template({ required_count: 2 })]);
    await POST(fakeReq());

    const assignments = insertedRows(calls, 'assignments');
    expect(assignments).toHaveLength(2);
    expect(assignments.map(a => a.schedule_slot_id).sort()).toEqual(['slot-0', 'slot-1']);
    for (const a of assignments) {
      expect(a.assignment_status).toBe('open');
      expect(a.source_type).toBe('manual');
    }
  });

  it('required_count 1 (and missing) each produce a single slot with slot_index 0 and required_count 1', async () => {
    const { calls } = setup([
      template({ id: 'tmpl-1', shift_type_id: 'st-C1', required_count: 1 }),
      template({ id: 'tmpl-2', shift_type_id: 'st-D1', required_count: null }),
    ]);
    await POST(fakeReq());

    const slots = insertedRows(calls, 'schedule_slots');
    expect(slots).toHaveLength(2);
    for (const s of slots) {
      expect(s.slot_index).toBe(0);
      expect(s.required_count).toBe(1);
    }
    expect(slots.map(s => s.shift_type_id).sort()).toEqual(['st-C1', 'st-D1']);
  });

  it('required_count 0 template is skipped, not coerced to 1 slot', async () => {
    const { calls } = setup([
      template({ id: 'tmpl-1', shift_type_id: 'st-C1', required_count: 0 }),
      template({ id: 'tmpl-2', shift_type_id: 'st-D1', required_count: 1 }),
    ]);
    const res = await POST(fakeReq());
    expect(res.status).toBe(200);

    const slots = insertedRows(calls, 'schedule_slots');
    expect(slots).toHaveLength(1);
    expect(slots[0].shift_type_id).toBe('st-D1');
  });

  it('response shape stays backward compatible ({...schedule, version_id})', async () => {
    setup([template({ required_count: 2 })]);
    const res = await POST(fakeReq());
    const json = await res.json();
    expect(json.id).toBe('sched-1');
    expect(json.version_id).toBe('ver-1');
    expect(json.status).toBe('draft');
  });
});

// ── Friday template union (2026-07-16 root-cause fix) ────────────────────────
// The old fallback was ALL-OR-NOTHING: any friday-specific template suppressed
// the ENTIRE weekday slate on Fridays (patch25 added friday C3/D4 rows and
// every Friday silently lost C1/C2/D1-D7). The contract is a PER-SHIFT-TYPE
// union: friday-specific templates override their own shift type; weekday
// templates whose shift_type_id has no friday-specific row still materialize.
describe('POST /api/scheduling/schedules — friday template union', () => {
  const FRIDAY_BODY = { ...BODY, date_start: '2026-01-09', date_end: '2026-01-09' }; // Friday

  it('friday-specific templates override per shift type; other weekday templates still materialize', async () => {
    const { calls } = setup([
      template({ id: 'tmpl-c1', shift_type_id: 'st-C1', day_type: 'weekday' }),
      template({ id: 'tmpl-c2', shift_type_id: 'st-C2', day_type: 'weekday' }),
      // C3: weekday row (count 0 = none) AND a friday-specific row (count 1).
      template({ id: 'tmpl-c3-wd', shift_type_id: 'st-C3', day_type: 'weekday', required_count: 0 }),
      template({ id: 'tmpl-c3-fri', shift_type_id: 'st-C3', day_type: 'friday' }),
      template({ id: 'tmpl-d4-fri', shift_type_id: 'st-D4', day_type: 'friday' }),
    ]);
    const res = await POST(fakeReq(FRIDAY_BODY));
    expect(res.status).toBe(200);

    const slots = insertedRows(calls, 'schedule_slots');
    const byShiftType = slots.map(s => s.shift_type_id).sort();
    // Union: friday C3 + friday D4 PLUS the weekday C1 + C2 (no friday row for
    // them). The weekday C3 row is shadowed by the friday-specific C3 row.
    expect(byShiftType).toEqual(['st-C1', 'st-C2', 'st-C3', 'st-D4']);
    for (const s of slots) expect(s.derived_day_type).toBe('friday');
  });

  it('a friday-specific row with required_count 0 SUPPRESSES that shift type (override, not union-add)', async () => {
    const { calls } = setup([
      template({ id: 'tmpl-c1', shift_type_id: 'st-C1', day_type: 'weekday' }),
      // Friday-specific C1 row with count 0: "no C1 slots on Fridays".
      template({ id: 'tmpl-c1-fri', shift_type_id: 'st-C1', day_type: 'friday', required_count: 0 }),
      template({ id: 'tmpl-c2', shift_type_id: 'st-C2', day_type: 'weekday' }),
    ]);
    await POST(fakeReq(FRIDAY_BODY));
    const slots = insertedRows(calls, 'schedule_slots');
    expect(slots.map(s => s.shift_type_id)).toEqual(['st-C2']);
  });

  it('zero friday-specific templates keeps the pure-weekday fallback (existing behavior)', async () => {
    const { calls } = setup([
      template({ id: 'tmpl-c1', shift_type_id: 'st-C1', day_type: 'weekday' }),
      template({ id: 'tmpl-d1', shift_type_id: 'st-D1', day_type: 'weekday' }),
    ]);
    await POST(fakeReq(FRIDAY_BODY));
    const slots = insertedRows(calls, 'schedule_slots');
    expect(slots.map(s => s.shift_type_id).sort()).toEqual(['st-C1', 'st-D1']);
    for (const s of slots) expect(s.derived_day_type).toBe('friday');
  });

  it('saturday/sunday slates are NOT unioned with weekday (friday-only contract)', async () => {
    const SAT_BODY = { ...BODY, date_start: '2026-01-10', date_end: '2026-01-10' }; // Saturday
    const { calls } = setup([
      template({ id: 'tmpl-c1', shift_type_id: 'st-C1', day_type: 'weekday' }),
      template({ id: 'tmpl-c1-sat', shift_type_id: 'st-C1sat', day_type: 'saturday' }),
    ]);
    await POST(fakeReq(SAT_BODY));
    const slots = insertedRows(calls, 'schedule_slots');
    expect(slots.map(s => s.shift_type_id)).toEqual(['st-C1sat']);
  });
});
