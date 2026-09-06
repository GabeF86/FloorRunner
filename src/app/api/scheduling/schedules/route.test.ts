// POST /api/scheduling/schedules — slot materialization tests (Task 11).
// A template with required_count N must produce N sibling slot rows
// (slot_index 0..N-1, required_count: 1 each), each with its OWN open
// assignment row (scheduling.assignments has UNIQUE(schedule_slot_id)).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeFakeSupabase, callsFor, fromCount, type Canned } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

const holder = vi.hoisted(() => ({ sb: null as unknown }));
vi.mock('@/lib/supabaseScheduling', () => ({
  sbSchedulingServer: () => holder.sb,
}));

import { GET, POST } from './route';

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

interface SetupOpts {
  /** holiday_calendars rows for the create window. */
  holidays?: Record<string, unknown>[];
  /** provider_availability rows of type 'holiday_call' (patch44 seeding). */
  holidayCall?: Canned;
  /** shift_types id → code map for the site. */
  shiftTypes?: Record<string, unknown>[];
  /** Force the slot-lock update to fail. */
  slotUpdateError?: unknown;
}

function setup(templates: Record<string, unknown>[], opts: SetupOpts = {}) {
  const { sb, calls } = makeFakeSupabase({
    tables: {
      sites: { data: { name: 'Mercy General' }, error: null },
      schedules: { data: { id: 'sched-1', schedule_name: 'Mercy General - Schedule - January 2026', status: 'draft' }, error: null },
      schedule_versions: { data: { id: 'ver-1' }, error: null },
      shift_templates: { data: templates, error: null },
      holiday_calendars: { data: opts.holidays ?? [], error: null },
      provider_availability: opts.holidayCall ?? { data: [], error: null },
      shift_types: { data: opts.shiftTypes ?? [], error: null },
      // Echo back the inserted slot rows (with ids) so both the assignment
      // pairing and the holiday-call seeding match are exercised.
      schedule_slots: (filters) => {
        const ins = filters.find(f => f.method === 'insert');
        if (!ins) return { data: [], error: opts.slotUpdateError ?? null };
        const rows = (ins.args[0] as Record<string, unknown>[]) ?? [];
        return { data: rows.map((r, i) => ({ ...r, id: `slot-${i}` })), error: null };
      },
      // Echo back one assignment id per inserted row, paired to its slot.
      assignments: (filters) => {
        const ins = filters.find(f => f.method === 'insert');
        if (!ins) return { data: [], error: null };
        const rows = (ins.args[0] as Array<{ schedule_slot_id: string }>) ?? [];
        return { data: rows.map((r, i) => ({ id: `asg-${i}`, schedule_slot_id: r.schedule_slot_id })), error: null };
      },
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

// ── Nameable schedules (Gabriel 2026-07-22) ─────────────────────────────────
// "I also want to be able to name the draft schedule I am creating so I can
// keep track of the different schedules." An optional schedule_name in the
// POST body overrides the generated default when non-empty (trimmed, capped
// at 120, route-hardened); blank/absent keeps the historical generated name.
// The rest of the creation flow (slot/assignment seeding) is byte-identical.
describe('POST /api/scheduling/schedules — custom schedule_name', () => {
  const scheduleInsertRow = (calls: ReturnType<typeof setup>['calls']) => {
    const inserts = callsFor(calls, 'schedules', 'insert');
    expect(inserts).toHaveLength(1);
    return inserts[0].args[0] as Record<string, unknown>;
  };

  it('a custom name is used TRIMMED', async () => {
    const { calls } = setup([template()]);
    const res = await POST(fakeReq({ ...BODY, schedule_name: '  Fall Draft — plan B  ' }));
    expect(res.status).toBe(200);
    expect(scheduleInsertRow(calls).schedule_name).toBe('Fall Draft — plan B');
  });

  it('absent, blank, and whitespace-only names keep the generated default', async () => {
    for (const body of [
      BODY,
      { ...BODY, schedule_name: '' },
      { ...BODY, schedule_name: '   ' },
    ]) {
      const { calls } = setup([template()]);
      const res = await POST(fakeReq(body));
      expect(res.status).toBe(200);
      expect(scheduleInsertRow(calls).schedule_name).toBe('Mercy General - Schedule - January 2026');
    }
  });

  it('rejects an over-long name with 400 before any write', async () => {
    const { calls } = setup([template()]);
    const res = await POST(fakeReq({ ...BODY, schedule_name: 'x'.repeat(121) }));
    expect(res.status).toBe(400);
    expect(((await res.json()).error as string)).toMatch(/schedule_name/);
    expect(callsFor(calls, 'schedules', 'insert')).toHaveLength(0);
    expect(callsFor(calls, 'schedule_slots', 'insert')).toHaveLength(0);
  });

  it('rejects a non-string name with 400 before any write', async () => {
    const { calls } = setup([template()]);
    const res = await POST(fakeReq({ ...BODY, schedule_name: 42 }));
    expect(res.status).toBe(400);
    expect(callsFor(calls, 'schedules', 'insert')).toHaveLength(0);
  });

  it('a custom name changes ONLY schedule_name — slot/assignment seeding is byte-identical', async () => {
    const { calls: namedCalls } = setup([template({ required_count: 2 })]);
    await POST(fakeReq({ ...BODY, schedule_name: 'My Custom Draft' }));
    const { calls: defaultCalls } = setup([template({ required_count: 2 })]);
    await POST(fakeReq(BODY));

    const rows = (calls: typeof namedCalls, table: string) =>
      callsFor(calls, table, 'insert').map(c => c.args[0]);
    expect(rows(namedCalls, 'schedule_slots')).toEqual(rows(defaultCalls, 'schedule_slots'));
    expect(rows(namedCalls, 'assignments')).toEqual(rows(defaultCalls, 'assignments'));
    expect(rows(namedCalls, 'schedule_versions')).toEqual(rows(defaultCalls, 'schedule_versions'));
    const named = rows(namedCalls, 'schedules')[0] as Record<string, unknown>;
    const dflt = rows(defaultCalls, 'schedules')[0] as Record<string, unknown>;
    expect(named.schedule_name).toBe('My Custom Draft');
    expect({ ...named, schedule_name: null }).toEqual({ ...dflt, schedule_name: null });
  });
});

// ── GET: derived last-activity stamp ─────────────────────────────────────────
// The list's "edited" line must reflect the last CONTENT change, not
// `schedules.updated_at` (which only moves when the schedule row does). The
// four-source MAX itself lives in Postgres — `scheduling.schedule_last_activity`
// (patch39), because this project rejects PostgREST aggregates with HTTP 400
// PGRST123 — so these pin the ROUTE wiring: the field is emitted, ONE RPC
// serves the whole list, and the list still renders (200, degraded to the row
// stamp) whether the function is absent or the call fails.
describe('GET /api/scheduling/schedules — last_activity_at', () => {
  const ROW_STAMP = '2026-07-26T21:38:00+00:00';
  const ASSIGN_STAMP = '2026-07-27T04:16:00+00:00';

  const LIST = [
    { id: 'sched-1', schedule_name: 'v5', updated_at: ROW_STAMP, created_at: ROW_STAMP },
    { id: 'sched-2', schedule_name: 'Paoli 8/10-10/25 V4', updated_at: ROW_STAMP, created_at: ROW_STAMP },
  ];

  // sched-1 was worked in after creation; sched-2 has no row (never generated).
  const RPC_OK = { data: [{ schedule_id: 'sched-1', last_activity_at: ASSIGN_STAMP }], error: null };

  function setupGet(
    { list, rpc }: { list?: unknown; rpc?: { data?: unknown; error?: unknown } } = {},
  ) {
    const { sb, calls } = makeFakeSupabase({
      tables: { schedules: (list as { data: unknown; error: unknown }) ?? { data: LIST, error: null } },
      rpc: { schedule_last_activity: rpc ?? RPC_OK },
    });
    holder.sb = sb;
    return { calls };
  }

  const getReq = () =>
    ({ url: 'http://localhost/api/scheduling/schedules?org_id=org-1' }) as unknown as NextRequest;

  const rpcCalls = (calls: ReturnType<typeof setupGet>['calls']) =>
    calls.filter(c => c.method === 'rpc' && c.fn === 'schedule_last_activity');

  it('emits the derived stamp, and it beats the schedule row stamp', async () => {
    setupGet();
    const body = await (await GET(getReq())).json();
    expect(body).toHaveLength(2);
    expect(body[0].last_activity_at).toBe(ASSIGN_STAMP); // worked in after creation
    expect(body[0].updated_at).toBe(ROW_STAMP);          // untouched, still the row's own
    expect(body[1].last_activity_at).toBe(ROW_STAMP);    // never generated
  });

  it('still returns the list when the RPC fails, falling back to updated_at', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setupGet({ rpc: { data: null, error: { message: 'boom' } } });
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((r: { last_activity_at: string }) => r.last_activity_at)).toEqual([ROW_STAMP, ROW_STAMP]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('read failed');
    warn.mockRestore();
  });

  it('still returns the list on a DB that predates patch39 (function missing)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setupGet({
      rpc: {
        data: null,
        error: {
          code: 'PGRST202',
          message: 'Could not find the function scheduling.schedule_last_activity(p_schedule_ids) in the schema cache',
        },
      },
    });
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((r: { last_activity_at: string }) => r.last_activity_at)).toEqual([ROW_STAMP, ROW_STAMP]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('patch39');
    warn.mockRestore();
  });

  it('is ONE rpc for the whole list, not one per schedule, whatever the length', async () => {
    const { calls } = setupGet();
    await GET(getReq());
    expect(fromCount(calls, 'schedules')).toBe(1);
    expect(rpcCalls(calls)).toHaveLength(1);
    expect(rpcCalls(calls)[0].args[0]).toEqual({ p_schedule_ids: ['sched-1', 'sched-2'] });

    const many = Array.from({ length: 60 }, (_, i) => ({ id: `s-${i}`, updated_at: ROW_STAMP }));
    const { calls: manyCalls } = setupGet({
      list: { data: many, error: null },
      rpc: { data: many.map(s => ({ schedule_id: s.id, last_activity_at: ASSIGN_STAMP })), error: null },
    });
    const body = await (await GET(getReq())).json();
    expect(body).toHaveLength(60);
    expect(rpcCalls(manyCalls)).toHaveLength(1);
    expect(fromCount(manyCalls)).toBe(1); // the list query, and nothing else
  });

  it('surfaces a 500 from the list query itself unchanged, and never calls the RPC', async () => {
    const { calls } = setupGet({ list: { data: null, error: { message: 'list blew up' } } });
    const res = await GET(getReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('list blew up');
    expect(rpcCalls(calls)).toHaveLength(0);
  });
});

// ── Holiday call seeding (patch44) ──────────────────────────────────────────
// Recorded holiday-call decisions live on provider_availability because they
// are made long before the schedule exists. Schedule creation is where they
// become real assignments; from there the engine's ordinary seed walk carries
// them (no new engine path). See src/lib/holidayCall.ts.
describe('POST /api/scheduling/schedules — holiday call seeding', () => {
  const SHIFT_TYPES = [{ id: 'st-C1', code: 'C1' }, { id: 'st-D1', code: 'D1' }];
  // The seeding pass splices site_id into a PostgREST .or() filter, so it only
  // runs for a real UUID (the rest of this file's fixtures use 'site-1').
  const SITE = '2ddd2427-22fb-4290-9c4c-03a957e5af4e';
  const SEED_BODY = { ...BODY, site_id: SITE };

  function updatesFor(calls: ReturnType<typeof setup>['calls'], table: string) {
    return callsFor(calls, table, 'update').map(c => c.args[0] as Record<string, unknown>);
  }

  it('writes the recorded provider onto the matching slot as a locked manual assignment', async () => {
    const { calls } = setup([template()], {
      shiftTypes: SHIFT_TYPES,
      holidayCall: { data: [{ provider_id: 'prov-1', start_date: '2026-01-07', reason_code: 'C1' }], error: null },
    });
    const res = await POST(fakeReq(SEED_BODY));
    expect(res.status).toBe(200);
    expect((await res.json()).holiday_call).toEqual({ seeded: 1, skipped: [] });

    const [update] = updatesFor(calls, 'assignments');
    expect(update.provider_id).toBe('prov-1');
    expect(update.assignment_status).toBe('assigned');
    // source_type 'manual' is what keeps generation from evicting it
    // (preFillEviction gate (a) only evicts auto_generated occupants).
    expect(update.source_type).toBe('manual');
    expect(update.manually_overridden).toBe(true);

    expect(updatesFor(calls, 'schedule_slots')).toEqual([{ locked: true }]);
  });

  it('reports a decision it could not place instead of dropping it', async () => {
    const { calls } = setup([template()], {
      shiftTypes: SHIFT_TYPES,
      // The site has no PC slot on that date — the slate stays authoritative.
      holidayCall: { data: [{ provider_id: 'prov-1', start_date: '2026-01-07', reason_code: 'PC' }], error: null },
    });
    const res = await POST(fakeReq(SEED_BODY));
    const json = await res.json();
    expect(json.holiday_call.seeded).toBe(0);
    expect(json.holiday_call.skipped).toEqual([
      { provider_id: 'prov-1', date: '2026-01-07', code: 'PC', reason: 'no PC slot on this date in the new schedule' },
    ]);
    expect(updatesFor(calls, 'assignments')).toHaveLength(0);
  });

  it('touches nothing when no holiday call is recorded', async () => {
    const { calls } = setup([template()], { shiftTypes: SHIFT_TYPES });
    const res = await POST(fakeReq(SEED_BODY));
    expect((await res.json()).holiday_call).toEqual({ seeded: 0, skipped: [] });
    expect(updatesFor(calls, 'assignments')).toHaveLength(0);
    expect(updatesFor(calls, 'schedule_slots')).toHaveLength(0);
  });

  it('still creates the schedule when the availability read fails (pre-patch44 DB)', async () => {
    // Before the enum value exists the query errors rather than returning [].
    const { calls } = setup([template()], {
      shiftTypes: SHIFT_TYPES,
      holidayCall: { data: null, error: { message: 'invalid input value for enum: "holiday_call"' } },
    });
    const res = await POST(fakeReq(SEED_BODY));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.version_id).toBe('ver-1');
    expect(json.holiday_call.seeded).toBe(0);
    expect(json.holiday_call.error).toMatch(/holiday_call/);
    expect(updatesFor(calls, 'assignments')).toHaveLength(0);
  });

  it('reports rather than splices a site_id that is not a UUID', async () => {
    const { calls } = setup([template()], {
      shiftTypes: SHIFT_TYPES,
      holidayCall: { data: [{ provider_id: 'prov-1', start_date: '2026-01-07', reason_code: 'C1' }], error: null },
    });
    // BODY carries the non-UUID 'site-1'.
    const json = await (await POST(fakeReq())).json();
    expect(json.version_id).toBe('ver-1');
    expect(json.holiday_call).toEqual({ seeded: 0, skipped: [], error: 'site_id is not a UUID — holiday call not seeded' });
    expect(updatesFor(calls, 'assignments')).toHaveLength(0);
  });

  it('groups the assignment update per provider rather than per row', async () => {
    const { calls } = setup([template({ required_count: 2 })], {
      shiftTypes: SHIFT_TYPES,
      holidayCall: {
        data: [
          { provider_id: 'prov-1', start_date: '2026-01-07', reason_code: 'C1' },
          { provider_id: 'prov-2', start_date: '2026-01-07', reason_code: 'C1' },
        ],
        error: null,
      },
    });
    const res = await POST(fakeReq(SEED_BODY));
    expect((await res.json()).holiday_call.seeded).toBe(2);
    const updates = updatesFor(calls, 'assignments');
    expect(updates).toHaveLength(2);
    expect(updates.map(u => u.provider_id).sort()).toEqual(['prov-1', 'prov-2']);
    // Both slots locked in ONE update.
    expect(updatesFor(calls, 'schedule_slots')).toEqual([{ locked: true }]);
  });
});
