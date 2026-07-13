// Board assistant read tools (Task 4): get_board + find_staff, exercised
// against the chainable fake-supabase fixture (same injection style as
// scheduleAssistant/tools.test.ts). No network, no live DB — every query shape
// here (select/eq/order over public board tables, staff+rooms embeds) is
// covered by the existing fake; no fake extension was needed.
import { describe, it, expect } from 'vitest';
import { createBoardExecutors, boardTools, MUTATING_BOARD_TOOLS, type BoardCtx } from './tools';
import { makeFakeSupabase } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

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
  it('exposes exactly the two read tools, both strict', () => {
    expect(boardTools.map((t) => t.name).sort()).toEqual(['find_staff', 'get_board']);
    for (const t of boardTools) expect(t.strict).toBe(true);
  });

  it('has no mutating tools yet', () => {
    expect(MUTATING_BOARD_TOOLS.size).toBe(0);
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
  // relieved (BoardClient.tsx:431-433: relievedIds ← reliefLog, hospitalStaff,
  // activeStaff) and mounts it at :682 — there is NO daily_active/working
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
