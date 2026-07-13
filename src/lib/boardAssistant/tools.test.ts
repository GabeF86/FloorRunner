// Board assistant read tools (Task 4): get_board + find_staff, exercised
// against the chainable fake-supabase fixture (same injection style as
// scheduleAssistant/tools.test.ts). No network, no live DB — every query shape
// here (select/eq/order over public board tables, staff+rooms embeds) is
// covered by the existing fake; no fake extension was needed.
import { describe, it, expect } from 'vitest';
import { createBoardExecutors, boardTools, MUTATING_BOARD_TOOLS, type BoardCtx } from './tools';
import { makeFakeSupabase, callsFor, type RecordedCall } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

const DATE = '2026-07-12';

// ── Shared staff roster ──────────────────────────────────────────────────────
// Paoli physicians + CRNAs, a null-hospital CRNA (UI includes null-hospital
// staff in every hospital scope), and a Bryn Mawr resident (out of Paoli scope).
const STAFF = [
  { id: 'md-farkas', name: 'Gabriel Farkas', initials: 'GF', role: 'physician', hours: '8hr',  hospital: 'Paoli Hospital' },
  { id: 'md-nina',   name: 'Nina Kalawadia', initials: 'NK', role: 'physician', hours: '8hr',  hospital: 'Paoli Hospital' },
  { id: 'md-owen',   name: 'Owen Diaz',      initials: 'OD', role: 'physician', hours: '8hr',  hospital: 'Paoli Hospital' },
  { id: 'md-zed',    name: 'Zed Gray',       initials: 'ZG', role: 'physician', hours: '8hr',  hospital: 'Paoli Hospital' },
  { id: 'md-rita',   name: 'Rita Vaughn',    initials: 'RV', role: 'physician', hours: '8hr',  hospital: 'Paoli Hospital' },
  // Fellow sharing a query token with md-zed ("gray") — pins the role filter.
  { id: 'fel-grace', name: 'Grace Grayson',  initials: 'GG', role: 'fellow', hours: '10hr', hospital: 'Paoli Hospital' },
  { id: 'crna-simon-a', name: 'Simon Bell',  initials: 'SB', role: 'crna', hours: '10hr', hospital: 'Paoli Hospital' },
  { id: 'crna-simon-b', name: 'Simone Ford', initials: 'SF', role: 'crna', hours: '10hr', hospital: 'Paoli Hospital' },
  { id: 'crna-null', name: 'Nina Torres',    initials: 'NT', role: 'crna', hours: '8hr',  hospital: null },
  { id: 'res-bmh',   name: 'Omar Reyes',     initials: 'OR', role: 'resident', hours: '12hr', hospital: 'Bryn Mawr Hospital' },
];

const SITES = [
  { id: 'site-main', name: 'Main OR', is_float: false, hospital: 'Paoli Hospital', position: 1,
    rooms: [{ id: 'r1', name: 'OR 1', position: 1 }, { id: 'r2', name: 'OR 2', position: 2 }] },
  { id: 'site-float', name: 'Float', is_float: true, hospital: null, position: 99, rooms: [] },
  { id: 'site-bmh', name: 'BMH Main', is_float: false, hospital: 'Bryn Mawr Hospital', position: 2,
    rooms: [{ id: 'r9', name: 'BMH OR 1', position: 1 }] },
  // Null-hospital NON-float site: the board shows this only under "All"
  // (sites filter is stricter than staff — no null-hospital passthrough).
  { id: 'site-orphan', name: 'Orphan Suite', is_float: false, hospital: null, position: 3, rooms: [] },
];

// Farkas (MD) supervises OR 1 alongside a CRNA → one CRNA room; Nina (MD) alone
// in OR 2. a4/a5 live in the BMH room r9 (out of Paoli scope); a6 is a float
// assignment — float rows store the SITE id as room_id (BoardClient
// handleDropFloat / floatAssignments).
const ASSIGNMENTS = [
  { id: 'a1', room_id: 'r1', staff_id: 'md-farkas', board_date: DATE,
    staff: { id: 'md-farkas', name: 'Gabriel Farkas', initials: 'GF', role: 'physician', hours: '8hr' } },
  { id: 'a2', room_id: 'r1', staff_id: 'crna-simon-a', board_date: DATE,
    staff: { id: 'crna-simon-a', name: 'Simon Bell', initials: 'SB', role: 'crna', hours: '10hr' } },
  { id: 'a3', room_id: 'r2', staff_id: 'md-nina', board_date: DATE,
    staff: { id: 'md-nina', name: 'Nina Kalawadia', initials: 'NK', role: 'physician', hours: '8hr' } },
  { id: 'a4', room_id: 'r9', staff_id: 'md-bmh', board_date: DATE,
    staff: { id: 'md-bmh', name: 'Bruce Hale', initials: 'BH', role: 'physician', hours: '8hr' } },
  { id: 'a5', room_id: 'r9', staff_id: 'res-bmh', board_date: DATE,
    staff: { id: 'res-bmh', name: 'Omar Reyes', initials: 'OR', role: 'resident', hours: '12hr' } },
  { id: 'a6', room_id: 'site-float', staff_id: 'crna-null', board_date: DATE,
    staff: { id: 'crna-null', name: 'Nina Torres', initials: 'NT', role: 'crna', hours: '8hr' } },
];

const DAILY_ACTIVE = [
  { id: 'ac1', staff_id: 'md-farkas', board_date: DATE },
  { id: 'ac2', staff_id: 'md-nina', board_date: DATE },
  { id: 'ac3', staff_id: 'md-owen', board_date: DATE },
  { id: 'ac4', staff_id: 'crna-simon-a', board_date: DATE },
  // md-zed intentionally NOT working
];

const DESIGNATIONS = [
  { id: 'd1', staff_id: 'md-farkas', board_date: DATE, designation: 'D1' },
  { id: 'd2', staff_id: 'md-nina',   board_date: DATE, designation: 'D3' },
  // Rita is designated D2 but appears in the relief log below → she must NOT
  // surface in the out-order (she already went home).
  { id: 'd3', staff_id: 'md-rita',   board_date: DATE, designation: 'D2' },
];

const SHIFTS = [{ id: 's1', staff_id: 'crna-simon-a', board_date: DATE, hours: '12hr' }];
const BREAKS = [{ id: 'b1', staff_id: 'crna-simon-a', board_date: DATE, break_type: 'lunch', taken: true, taken_at: '2026-07-12T12:00:00Z' }];
const RELIEF = [
  { id: 'rl1', staff_id: 'crna-x', staff_name: 'Rae X', staff_role: 'crna', staff_initials: 'RX',
    board_date: DATE, relieved_at: '2026-07-12T15:00:00Z', designation: null, shift_hours: '8hr' },
  { id: 'rl2', staff_id: 'md-rita', staff_name: 'Rita Vaughn', staff_role: 'physician', staff_initials: 'RV',
    board_date: DATE, relieved_at: '2026-07-12T14:00:00Z', designation: 'D2', shift_hours: '8hr' },
];

function boardFake() {
  return makeFakeSupabase({
    tables: {
      staff:               { data: STAFF },
      daily_active:        { data: DAILY_ACTIVE },
      sites:               { data: SITES },
      assignments:         { data: ASSIGNMENTS },
      daily_designations:  { data: DESIGNATIONS },
      daily_shifts:        { data: SHIFTS },
      breaks:              { data: BREAKS },
      relief_log:          { data: RELIEF },
    },
  });
}

type BoardResult = {
  boardDate: string;
  hospital: string | null;
  currentTime: string;
  staff: Array<{ id: string; name: string; role: string; working: boolean; hospital: string | null }>;
  sites: Array<{ id: string; name: string; is_float: boolean; rooms: Array<{ id: string; name: string }> }>;
  assignments: Array<{ id: string; room_id: string; staff_id: string; staff_name: string; staff_role: string }>;
  designations: Array<{ staff_id: string; designation: string }>;
  shifts: Array<{ staff_id: string; hours: string }>;
  breaks: Array<{ staff_id: string; break_type: string; taken: boolean }>;
  reliefLog: Array<{ staff_id: string; staff_name: string }>;
  supervisionLoads: Record<string, { crnaCount: number; residentCount: number; overCrna: boolean }>;
  outOrder: Array<{ staff_id: string; name: string; designation: string | null; working: boolean }>;
};

async function runGetBoard(ctx: BoardCtx): Promise<BoardResult> {
  const { sb } = boardFake();
  const out = await createBoardExecutors(sb as never, ctx).get_board({});
  return out.result as BoardResult;
}

describe('boardTools schemas', () => {
  it('exposes the two read tools + eight mutations, every one strict', () => {
    expect(boardTools.map((t) => t.name).sort()).toEqual(
      [
        'get_board', 'find_staff',
        'set_working', 'assign_to_room', 'send_to_float', 'unassign',
        'set_designation', 'set_shift_hours', 'mark_break', 'mark_relieved',
      ].sort(),
    );
    for (const t of boardTools) expect(t.strict).toBe(true);
  });

  it('registers the eight mutating tools, each a defined tool', () => {
    expect([...MUTATING_BOARD_TOOLS].sort()).toEqual(
      [
        'set_working', 'assign_to_room', 'send_to_float', 'unassign',
        'set_designation', 'set_shift_hours', 'mark_break', 'mark_relieved',
      ].sort(),
    );
    const names = new Set(boardTools.map((t) => t.name));
    for (const m of MUTATING_BOARD_TOOLS) expect(names.has(m)).toBe(true);
    // Read tools stay OUT of the mutating set (loop only snapshots for these).
    expect(MUTATING_BOARD_TOOLS.has('get_board')).toBe(false);
    expect(MUTATING_BOARD_TOOLS.has('find_staff')).toBe(false);
  });

  // Same API grammar bounds the schedule suite guards (weekendV2Pattern pattern):
  // strict tools compile a grammar that 400s on too many optional params / too
  // large a schema. Keep the board strict tools well under both limits.
  it('keeps strict schemas within the API grammar limits', () => {
    let totalOptional = 0;
    for (const t of boardTools) {
      if (!t.strict) continue;
      const schema = t.input_schema as { properties?: Record<string, unknown>; required?: string[] };
      const props = Object.keys(schema.properties ?? {});
      const required = new Set(schema.required ?? []);
      totalOptional += props.filter((p) => !required.has(p)).length;
      expect(JSON.stringify(t.input_schema).length).toBeLessThanOrEqual(1000);
    }
    expect(totalOptional).toBeLessThanOrEqual(20);
  });
});

describe('get_board (hospital-scoped)', () => {
  const ctx: BoardCtx = { boardDate: DATE, hospital: 'Paoli Hospital' };

  it('returns the working date and a current time', async () => {
    const r = await runGetBoard(ctx);
    expect(r.boardDate).toBe(DATE);
    expect(r.hospital).toBe('Paoli Hospital');
    expect(typeof r.currentTime).toBe('string');
  });

  it('flags working staff via daily_active and includes null-hospital staff, excludes other hospitals', async () => {
    const r = await runGetBoard(ctx);
    const byId = new Map(r.staff.map((s) => [s.id, s]));
    expect(byId.get('md-farkas')?.working).toBe(true);
    expect(byId.get('md-zed')?.working).toBe(false);        // present, not working
    expect(byId.has('crna-null')).toBe(true);               // null hospital → in scope
    expect(byId.has('res-bmh')).toBe(false);                // Bryn Mawr → out of Paoli scope
  });

  it('returns hospital sites + the float site with their rooms, excluding other hospitals and null-hospital non-float sites', async () => {
    const r = await runGetBoard(ctx);
    const siteIds = r.sites.map((s) => s.id).sort();
    expect(siteIds).toEqual(['site-float', 'site-main']); // site-bmh + site-orphan excluded when scoped
    const main = r.sites.find((s) => s.id === 'site-main');
    expect(main?.rooms.map((rm) => rm.name)).toEqual(['OR 1', 'OR 2']);
  });

  it('returns assignments carrying staff names', async () => {
    const r = await runGetBoard(ctx);
    const a1 = r.assignments.find((a) => a.id === 'a1');
    expect(a1?.staff_name).toBe('Gabriel Farkas');
    expect(a1?.staff_role).toBe('physician');
  });

  it('computes supervision loads via boardLogic (one CRNA room for Farkas)', async () => {
    const r = await runGetBoard(ctx);
    expect(r.supervisionLoads['md-farkas']).toMatchObject({ crnaCount: 1, overCrna: false });
  });

  // outOrder mirrors the EFFECTIVE UI pipeline, not OutListPanel in isolation:
  // BoardClient builds the panel's staff prop as hospital-scoped staff MINUS
  // relieved (BoardClient.tsx:432-434: relievedIds ← reliefLog, hospitalStaff,
  // activeStaff) and mounts it at :683 — there is NO daily_active/working
  // filter anywhere in that pipeline. The panel then splits physicians into
  // DESIGNATION_OUT_ORDER hits and an undesignated remainder.
  it('builds out-order: designated MDs by DESIGNATION_OUT_ORDER, then ALL undesignated non-relieved MDs', async () => {
    const r = await runGetBoard(ctx);
    // Rita (D2) is relieved → skipped; D1 farkas, D3 nina, then undesignated
    // owen (working) and zed (not working — still listed, UI parity).
    expect(r.outOrder.map((o) => o.staff_id)).toEqual(['md-farkas', 'md-nina', 'md-owen', 'md-zed']);
    expect(r.outOrder[0]).toMatchObject({ designation: 'D1' });
    expect(r.outOrder[1]).toMatchObject({ designation: 'D3' });
    expect(r.outOrder[2]).toMatchObject({ designation: null, working: true });
    expect(r.outOrder[3]).toMatchObject({ designation: null, working: false });
  });

  it('excludes a relieved-but-designated physician from the out-order (she already went home)', async () => {
    const r = await runGetBoard(ctx);
    expect(r.outOrder.some((o) => o.staff_id === 'md-rita')).toBe(false);
    // …but she still appears in the relief log and staff facets.
    expect(r.reliefLog.some((e) => e.staff_id === 'md-rita')).toBe(true);
    expect(r.staff.some((s) => s.id === 'md-rita')).toBe(true);
  });

  it('scopes the assignments facet to in-scope rooms (incl. float), keeping supervision loads global', async () => {
    const r = await runGetBoard(ctx);
    const ids = r.assignments.map((a) => a.id).sort();
    // a4/a5 sit in BMH's r9 — their site is out of Paoli scope, so returning
    // them would hand the model rows pointing at rooms absent from `sites`.
    expect(ids).toEqual(['a1', 'a2', 'a3', 'a6']); // a6 = float (site id as room_id)
    // supervisionLoads stay computed over the FULL unscoped array
    // (BoardClient.tsx:445 parity) — the out-of-scope BMH MD still has a load.
    expect(r.supervisionLoads['md-bmh']).toMatchObject({ residentCount: 1 });
  });

  it('passes through designations, shifts, breaks and relief log for the date', async () => {
    const r = await runGetBoard(ctx);
    expect(r.designations).toContainEqual(expect.objectContaining({ staff_id: 'md-farkas', designation: 'D1' }));
    expect(r.shifts).toContainEqual(expect.objectContaining({ staff_id: 'crna-simon-a', hours: '12hr' }));
    expect(r.breaks).toContainEqual(expect.objectContaining({ staff_id: 'crna-simon-a', break_type: 'lunch', taken: true }));
    expect(r.reliefLog).toContainEqual(expect.objectContaining({ staff_id: 'crna-x', staff_name: 'Rae X' }));
  });
});

describe('get_board (hospital null = All)', () => {
  it('includes every hospital when unscoped', async () => {
    const r = await runGetBoard({ boardDate: DATE, hospital: null });
    expect(r.staff.some((s) => s.id === 'res-bmh')).toBe(true);
    expect(r.sites.some((s) => s.id === 'site-bmh')).toBe(true);
    expect(r.sites.some((s) => s.id === 'site-orphan')).toBe(true); // null-hospital site shows under All
    // BMH-room assignments come back when unscoped.
    expect(r.assignments.map((a) => a.id).sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  });
});

// ── find_staff ───────────────────────────────────────────────────────────────
type FindResult = {
  count: number;
  candidates: Array<{ id: string; name: string; role: string; working: boolean }>;
};

async function runFindStaff(ctx: BoardCtx, input: unknown): Promise<FindResult> {
  const { sb } = boardFake();
  const out = await createBoardExecutors(sb as never, ctx).find_staff(input);
  return out.result as FindResult;
}

describe('find_staff (fuzzy, hospital-scoped)', () => {
  const paoli: BoardCtx = { boardDate: DATE, hospital: 'Paoli Hospital' };

  it('ranks Nina-like candidates and surfaces the null-hospital Nina too', async () => {
    const r = await runFindStaff(paoli, { query: 'nina' });
    const ids = r.candidates.map((c) => c.id);
    expect(ids).toContain('md-nina');   // Nina Kalawadia
    expect(ids).toContain('crna-null'); // Nina Torres (null hospital, in scope)
    expect(ids).not.toContain('md-farkas');
  });

  it('returns BOTH Simon-ish rows (never silently picks one)', async () => {
    const r = await runFindStaff(paoli, { query: 'simon' });
    const ids = r.candidates.map((c) => c.id);
    expect(ids).toContain('crna-simon-a');
    expect(ids).toContain('crna-simon-b');
  });

  it('is misspelling/partial tolerant: "kalawadia", "kala", "nina k" all resolve Nina', async () => {
    for (const query of ['kalawadia', 'kala', 'nina k', 'Kalawada']) {
      const r = await runFindStaff(paoli, { query });
      expect(r.candidates.map((c) => c.id), `query=${query}`).toContain('md-nina');
    }
  });

  it('ranks an exact/prefix hit above a looser subsequence hit', async () => {
    const r = await runFindStaff(paoli, { query: 'simon' });
    // Simon Bell / Simone Ford are prefix hits; nobody should rank above them.
    expect(['crna-simon-a', 'crna-simon-b']).toContain(r.candidates[0].id);
  });

  it('honours the role filter', async () => {
    const r = await runFindStaff(paoli, { query: 'nina', role: 'physician' });
    const ids = r.candidates.map((c) => c.id);
    expect(ids).toContain('md-nina');
    expect(ids).not.toContain('crna-null'); // Nina Torres is a CRNA
  });

  it('supports the fellow role: returns the seeded fellow and excludes same-query non-fellows', async () => {
    // "gray" hits both Zed Gray (physician) and Grace Grayson (fellow)…
    const unfiltered = await runFindStaff(paoli, { query: 'gray' });
    expect(unfiltered.candidates.map((c) => c.id).sort()).toEqual(['fel-grace', 'md-zed']);
    // …the fellow filter keeps only the fellow.
    const r = await runFindStaff(paoli, { query: 'gray', role: 'fellow' });
    expect(r.candidates.map((c) => c.id)).toEqual(['fel-grace']);
  });

  it('excludes out-of-hospital staff, includes them when unscoped', async () => {
    const scoped = await runFindStaff(paoli, { query: 'omar' });
    expect(scoped.candidates.map((c) => c.id)).not.toContain('res-bmh');
    const all = await runFindStaff({ boardDate: DATE, hospital: null }, { query: 'omar' });
    expect(all.candidates.map((c) => c.id)).toContain('res-bmh');
  });

  it('returns zero candidates for an unknown name (assistant then asks — never auto-creates)', async () => {
    const r = await runFindStaff(paoli, { query: 'zzzznotaperson' });
    expect(r.count).toBe(0);
    expect(r.candidates).toEqual([]);
  });

  it('exposes each candidate\'s role and working flag', async () => {
    const r = await runFindStaff(paoli, { query: 'farkas' });
    expect(r.candidates[0]).toMatchObject({ id: 'md-farkas', role: 'physician', working: true });
  });

  it('rejects an empty query as ToolInputError', async () => {
    const { sb } = boardFake();
    await expect(createBoardExecutors(sb as never, paoli).find_staff({ query: '' }))
      .rejects.toMatchObject({ name: 'ToolInputError' });
  });
});

// ── Mutations (Task 5) ─────────────────────────────────────────────────────────
// Every executor mirrors the write shape of the matching REST route (POST/DELETE
// under src/app/api/{assignments,daily-active,designations,daily-shifts,breaks,
// relief}) or a BoardClient drag handler. The chainable fake RECORDS writes but
// does not apply them, so these tests assert on the recorded `calls` log (upsert
// payloads, delete filters, onConflict keys) — the same idiom scheduleAssistant's
// mutation tests use. Reads (staff existence, room resolution, working check)
// resolve against the kitchen-sink fixture's canned data.
const PAOLI: BoardCtx = { boardDate: DATE, hospital: 'Paoli Hospital' };

function boardExecs(ctx: BoardCtx = PAOLI) {
  const { sb, calls } = boardFake();
  return { execs: createBoardExecutors(sb as never, ctx), calls };
}
const hasEq = (calls: RecordedCall[], table: string, col: string, val: unknown) =>
  calls.some((c) => c.table === table && c.method === 'eq' && c.args[0] === col && c.args[1] === val);
const upserts = (calls: RecordedCall[], table: string) =>
  callsFor(calls, table, 'upsert').map((c) => c.args[0] as Record<string, unknown>);

describe('set_working (daily_active batch, UI checkbox parity)', () => {
  it('upserts working=true and deletes daily_active + assignments for working=false', async () => {
    const { execs, calls } = boardExecs();
    const out = await execs.set_working({
      entries: [
        { staff_id: 'md-zed', working: true },     // was NOT working → activate
        { staff_id: 'md-farkas', working: false },  // was working → deactivate + clear rooms
      ],
    });
    // working=true → daily_active upsert (onConflict staff_id,board_date), route parity.
    const up = upserts(calls, 'daily_active');
    expect(up).toContainEqual({ staff_id: 'md-zed', board_date: DATE });
    const upsertCall = callsFor(calls, 'daily_active', 'upsert')[0];
    expect(upsertCall.args[1]).toMatchObject({ onConflict: 'staff_id,board_date' });
    // working=false → daily_active delete filtered by staff_id + board_date…
    expect(callsFor(calls, 'daily_active', 'delete').length).toBe(1);
    expect(hasEq(calls, 'daily_active', 'staff_id', 'md-farkas')).toBe(true);
    // …AND their assignments cleared for the date (toggleActive uncheck parity).
    expect(callsFor(calls, 'assignments', 'delete').length).toBe(1);
    expect(hasEq(calls, 'assignments', 'staff_id', 'md-farkas')).toBe(true);
    expect(hasEq(calls, 'assignments', 'board_date', DATE)).toBe(true);
    expect(out.summary).toMatch(/Farkas/);
  });

  it('validates every staff id BEFORE any write (unknown id → ToolInputError, nothing written)', async () => {
    const { execs, calls } = boardExecs();
    await expect(
      execs.set_working({ entries: [{ staff_id: 'md-zed', working: true }, { staff_id: 'ghost', working: true }] }),
    ).rejects.toMatchObject({ name: 'ToolInputError' });
    expect(callsFor(calls, 'daily_active', 'upsert').length).toBe(0);
    expect(callsFor(calls, 'daily_active', 'delete').length).toBe(0);
  });

  it('rejects an empty entries array', async () => {
    const { execs } = boardExecs();
    await expect(execs.set_working({ entries: [] })).rejects.toMatchObject({ name: 'ToolInputError' });
  });
});

describe('assign_to_room (POST /api/assignments parity + room-name resolution)', () => {
  it('physician stacks (no prior delete), upserts by resolved room id, auto-adds to daily_active', async () => {
    const { execs, calls } = boardExecs();
    const out = await execs.assign_to_room({ staff_id: 'md-zed', room: 'OR 2' }); // md-zed NOT working
    // physician → NO prior assignment delete
    expect(callsFor(calls, 'assignments', 'delete').length).toBe(0);
    // upsert with the resolved room id (r2) + route's onConflict key
    const a = upserts(calls, 'assignments')[0];
    expect(a).toEqual({ room_id: 'r2', staff_id: 'md-zed', board_date: DATE });
    expect(callsFor(calls, 'assignments', 'upsert')[0].args[1]).toMatchObject({ onConflict: 'staff_id,room_id,board_date' });
    // auto-add to daily_active (md-zed was not working) + reported in the summary
    expect(upserts(calls, 'daily_active')).toContainEqual({ staff_id: 'md-zed', board_date: DATE });
    expect(out.summary).toMatch(/OR 2/);
    expect(out.summary).toMatch(/working/i);
  });

  it('non-physician moves room-to-room (prior assignments cleared first), no auto-add when already working', async () => {
    const { execs, calls } = boardExecs();
    const out = await execs.assign_to_room({ staff_id: 'crna-simon-a', room: 'OR 1' }); // already working
    expect(callsFor(calls, 'assignments', 'delete').length).toBe(1); // prior cleared
    expect(hasEq(calls, 'assignments', 'staff_id', 'crna-simon-a')).toBe(true);
    expect(upserts(calls, 'assignments')[0]).toEqual({ room_id: 'r1', staff_id: 'crna-simon-a', board_date: DATE });
    // already in daily_active → no auto-add
    expect(callsFor(calls, 'daily_active', 'upsert').length).toBe(0);
    expect(out.summary).not.toMatch(/working/i);
  });

  it('unknown room → ToolInputError listing available room names, nothing written', async () => {
    const { execs, calls } = boardExecs();
    const err = await execs.assign_to_room({ staff_id: 'md-zed', room: 'OR 99' }).catch((e) => e);
    expect(err).toMatchObject({ name: 'ToolInputError' });
    expect(err.message).toMatch(/OR 1/);
    expect(err.message).toMatch(/OR 2/);
    expect(callsFor(calls, 'assignments', 'upsert').length).toBe(0);
  });

  it('a room out of hospital scope does not resolve (BMH OR 1 under Paoli)', async () => {
    const { execs } = boardExecs();
    await expect(execs.assign_to_room({ staff_id: 'md-zed', room: 'BMH OR 1' }))
      .rejects.toMatchObject({ name: 'ToolInputError' });
  });

  it('ambiguous room name → ToolInputError listing the candidate sites, nothing written', async () => {
    // Scoped fixture: two in-scope Paoli sites each own a room named "OR 5".
    const { sb, calls } = makeFakeSupabase({
      tables: {
        staff: { data: STAFF },
        daily_active: { data: DAILY_ACTIVE },
        assignments: { data: [] },
        sites: {
          data: [
            { id: 'st-tower', name: 'Tower', is_float: false, hospital: 'Paoli Hospital', position: 1, rooms: [{ id: 't5', name: 'OR 5', position: 1 }] },
            { id: 'st-annex', name: 'Annex', is_float: false, hospital: 'Paoli Hospital', position: 2, rooms: [{ id: 'x5', name: 'OR 5', position: 1 }] },
          ],
        },
      },
    });
    const err = await createBoardExecutors(sb as never, PAOLI).assign_to_room({ staff_id: 'md-zed', room: 'OR 5' }).catch((e) => e);
    expect(err).toMatchObject({ name: 'ToolInputError' });
    expect(err.message).toMatch(/Tower/);
    expect(err.message).toMatch(/Annex/);
    expect(callsFor(calls, 'assignments', 'upsert').length).toBe(0);
  });

  it('unknown staff → ToolInputError before touching rooms', async () => {
    const { execs } = boardExecs();
    await expect(execs.assign_to_room({ staff_id: 'ghost', room: 'OR 1' }))
      .rejects.toMatchObject({ name: 'ToolInputError' });
  });
});

describe('send_to_float (BoardClient.handleDropFloat — SITE id written as room_id)', () => {
  it('writes the float SITE id into room_id; non-physician clears priors first', async () => {
    const { execs, calls } = boardExecs();
    const out = await execs.send_to_float({ staff_id: 'crna-simon-a' });
    expect(callsFor(calls, 'assignments', 'delete').length).toBe(1); // non-physician move
    expect(upserts(calls, 'assignments')[0]).toEqual({ room_id: 'site-float', staff_id: 'crna-simon-a', board_date: DATE });
    expect(out.summary).toMatch(/[Ff]loat/);
  });

  it('physician stacks onto float (no prior delete)', async () => {
    const { execs, calls } = boardExecs();
    await execs.send_to_float({ staff_id: 'md-farkas' });
    expect(callsFor(calls, 'assignments', 'delete').length).toBe(0);
    expect(upserts(calls, 'assignments')[0]).toMatchObject({ room_id: 'site-float' });
  });

  it('no float site in scope → ToolInputError', async () => {
    const { sb } = makeFakeSupabase({
      tables: {
        staff: { data: STAFF },
        daily_active: { data: DAILY_ACTIVE },
        assignments: { data: [] },
        sites: { data: [{ id: 'st-main', name: 'Main', is_float: false, hospital: 'Paoli Hospital', position: 1, rooms: [] }] },
      },
    });
    await expect(createBoardExecutors(sb as never, PAOLI).send_to_float({ staff_id: 'md-farkas' }))
      .rejects.toMatchObject({ name: 'ToolInputError' });
  });
});

describe('unassign (clear a person\'s rooms for the date)', () => {
  it('deletes assignments filtered by staff_id + board_date', async () => {
    const { execs, calls } = boardExecs();
    const out = await execs.unassign({ staff_id: 'crna-simon-a' });
    expect(callsFor(calls, 'assignments', 'delete').length).toBe(1);
    expect(hasEq(calls, 'assignments', 'staff_id', 'crna-simon-a')).toBe(true);
    expect(hasEq(calls, 'assignments', 'board_date', DATE)).toBe(true);
    expect(out.summary).toMatch(/Simon/);
  });

  it('unknown staff → ToolInputError', async () => {
    const { execs } = boardExecs();
    await expect(execs.unassign({ staff_id: 'ghost' })).rejects.toMatchObject({ name: 'ToolInputError' });
  });
});

describe('set_designation (POST /api/designations — physician-only per Sidebar gating)', () => {
  it('upserts daily_designations for a physician (onConflict staff_id,board_date)', async () => {
    const { execs, calls } = boardExecs();
    const out = await execs.set_designation({ staff_id: 'md-zed', designation: 'D5' });
    expect(upserts(calls, 'daily_designations')[0]).toEqual({ staff_id: 'md-zed', board_date: DATE, designation: 'D5' });
    expect(callsFor(calls, 'daily_designations', 'upsert')[0].args[1]).toMatchObject({ onConflict: 'staff_id,board_date' });
    expect(out.summary).toMatch(/D5/);
  });

  it('refuses a fellow (the Sidebar shows fellows the SHIFT picker, not a designation)', async () => {
    const { execs, calls } = boardExecs();
    await expect(execs.set_designation({ staff_id: 'fel-grace', designation: 'D1' }))
      .rejects.toMatchObject({ name: 'ToolInputError' });
    expect(callsFor(calls, 'daily_designations', 'upsert').length).toBe(0);
  });

  it('refuses a CRNA', async () => {
    const { execs } = boardExecs();
    await expect(execs.set_designation({ staff_id: 'crna-simon-a', designation: 'D1' }))
      .rejects.toMatchObject({ name: 'ToolInputError' });
  });

  it('rejects a designation outside MD_DESIGNATIONS', async () => {
    const { execs } = boardExecs();
    await expect(execs.set_designation({ staff_id: 'md-zed', designation: 'Z9' }))
      .rejects.toMatchObject({ name: 'ToolInputError' });
  });

  it('unknown staff → ToolInputError', async () => {
    const { execs } = boardExecs();
    await expect(execs.set_designation({ staff_id: 'ghost', designation: 'D1' }))
      .rejects.toMatchObject({ name: 'ToolInputError' });
  });
});

describe('set_shift_hours (POST /api/daily-shifts — fellow/crna/srna/resident per Sidebar gating)', () => {
  it('upserts daily_shifts for a CRNA (onConflict staff_id,board_date)', async () => {
    const { execs, calls } = boardExecs();
    const out = await execs.set_shift_hours({ staff_id: 'crna-simon-a', hours: '12hr' });
    expect(upserts(calls, 'daily_shifts')[0]).toEqual({ staff_id: 'crna-simon-a', board_date: DATE, hours: '12hr' });
    expect(callsFor(calls, 'daily_shifts', 'upsert')[0].args[1]).toMatchObject({ onConflict: 'staff_id,board_date' });
    expect(out.summary).toMatch(/12hr/);
  });

  it('allows a fellow (the Sidebar shows fellows the shift picker)', async () => {
    const { execs, calls } = boardExecs();
    await execs.set_shift_hours({ staff_id: 'fel-grace', hours: '10hr' });
    expect(upserts(calls, 'daily_shifts')[0]).toMatchObject({ staff_id: 'fel-grace', hours: '10hr' });
  });

  it('refuses a physician (physicians get a designation, not shift hours)', async () => {
    const { execs, calls } = boardExecs();
    await expect(execs.set_shift_hours({ staff_id: 'md-zed', hours: '10hr' }))
      .rejects.toMatchObject({ name: 'ToolInputError' });
    expect(callsFor(calls, 'daily_shifts', 'upsert').length).toBe(0);
  });

  it('refuses a surgeon (no shift picker at all in the Sidebar)', async () => {
    const { sb } = makeFakeSupabase({
      tables: {
        staff: { data: [{ id: 'surg-1', name: 'Sam Cutter', initials: 'SC', role: 'surgeon', hours: '8hr', hospital: 'Paoli Hospital' }] },
        daily_shifts: { data: [] },
      },
    });
    await expect(createBoardExecutors(sb as never, PAOLI).set_shift_hours({ staff_id: 'surg-1', hours: '10hr' }))
      .rejects.toMatchObject({ name: 'ToolInputError' });
  });

  it('rejects hours outside HOUR_OPTIONS', async () => {
    const { execs } = boardExecs();
    await expect(execs.set_shift_hours({ staff_id: 'crna-simon-a', hours: '9hr' }))
      .rejects.toMatchObject({ name: 'ToolInputError' });
  });
});

describe('mark_break (POST /api/breaks — taken_at stamping)', () => {
  it('upserts with taken_at set when taken=true (onConflict staff_id,board_date,break_type)', async () => {
    const { execs, calls } = boardExecs();
    const out = await execs.mark_break({ staff_id: 'crna-simon-a', break_type: 'lunch', taken: true });
    const b = upserts(calls, 'breaks')[0];
    expect(b).toMatchObject({ staff_id: 'crna-simon-a', board_date: DATE, break_type: 'lunch', taken: true });
    expect(typeof b.taken_at).toBe('string'); // stamped now, like the route
    expect(callsFor(calls, 'breaks', 'upsert')[0].args[1]).toMatchObject({ onConflict: 'staff_id,board_date,break_type' });
    expect(out.summary).toMatch(/lunch/);
  });

  it('clears taken_at (null) when taken=false', async () => {
    const { execs, calls } = boardExecs();
    await execs.mark_break({ staff_id: 'crna-simon-a', break_type: 'morning', taken: false });
    expect(upserts(calls, 'breaks')[0].taken_at).toBeNull();
  });

  it('rejects an unknown break_type', async () => {
    const { execs } = boardExecs();
    await expect(execs.mark_break({ staff_id: 'crna-simon-a', break_type: 'brunch', taken: true }))
      .rejects.toMatchObject({ name: 'ToolInputError' });
  });

  it('unknown staff → ToolInputError', async () => {
    const { execs } = boardExecs();
    await expect(execs.mark_break({ staff_id: 'ghost', break_type: 'lunch', taken: true }))
      .rejects.toMatchObject({ name: 'ToolInputError' });
  });
});

describe('mark_relieved (BoardClient.handleDropRelieved — unassign + denormalized relief_log)', () => {
  it('deletes assignments and inserts a relief row snapshotting name/role/initials/designation/shift', async () => {
    const { execs, calls } = boardExecs();
    const out = await execs.mark_relieved({ staff_id: 'md-nina' }); // physician D3, base 8hr, no shift override
    // rooms cleared for the date
    expect(callsFor(calls, 'assignments', 'delete').length).toBe(1);
    expect(hasEq(calls, 'assignments', 'staff_id', 'md-nina')).toBe(true);
    // relief_log insert with the denormalized fields captured at time of relief
    const r = callsFor(calls, 'relief_log', 'insert')[0].args[0] as Record<string, unknown>;
    expect(r).toMatchObject({
      staff_id: 'md-nina', staff_name: 'Nina Kalawadia', staff_role: 'physician',
      staff_initials: 'NK', board_date: DATE, designation: 'D3', shift_hours: '8hr',
    });
    expect(typeof r.relieved_at).toBe('string');
    expect(out.summary).toMatch(/Nina/);
  });

  it('uses the daily_shift override for shift_hours and null designation for a non-MD', async () => {
    const { execs, calls } = boardExecs();
    // crna-simon-a: base hours 10hr but daily_shifts override 12hr; no designation.
    await execs.mark_relieved({ staff_id: 'crna-simon-a' });
    const r = callsFor(calls, 'relief_log', 'insert')[0].args[0] as Record<string, unknown>;
    expect(r).toMatchObject({ staff_id: 'crna-simon-a', shift_hours: '12hr', designation: null });
  });

  it('unknown staff → ToolInputError', async () => {
    const { execs } = boardExecs();
    await expect(execs.mark_relieved({ staff_id: 'ghost' })).rejects.toMatchObject({ name: 'ToolInputError' });
  });
});
