// Last-activity derivation for the schedules list (Gabriel 2026-07-27).
//
// The feature shipped reading `schedules.updated_at`, which only moves when
// the schedule ROW changes — so on the two drafts worked in most recently the
// `edited` line was suppressed, the opposite of useful.
//
// WHAT THESE TESTS COVER, AND WHAT THEY CAN'T. The four-source MAX now runs in
// Postgres (`scheduling.schedule_last_activity`, patch39) because this project
// answers PostgREST aggregates with HTTP 400 PGRST123. So the "which of the
// four sources wins" cases that used to live here are SQL properties, and SQL
// is not reachable from vitest (no DB in this suite, by convention). They are
// pinned instead by VERIFICATION query 2 in the patch file, which re-derives
// the same answer with a UNION ALL and diffs it row for row against the
// function — run that when applying.
//
// What IS still client-side, and is what's tested below:
//   * the degradation floor — every schedule keeps `schedules.updated_at` no
//     matter what the RPC does, so the list can never render emptier than it
//     did before this feature existed;
//   * the missing-function / failed-call split in the warnings;
//   * one round trip for the whole list, never one per schedule;
//   * the response shaping in withLastActivity.
//
// Injected fake supabase client throughout (repo convention) — no DB.
import { describe, it, expect } from 'vitest';
import { makeFakeSupabase, fromCount, type Canned } from './rulesEngine/__fixtures__/fakeSupabase';
import { LAST_ACTIVITY_RPC, loadLastActivity, withLastActivity, type ScheduleActivityRow } from './scheduleActivity';

// Real numbers from the 2026-07-27 live-DB probe: the schedule row's stamp is
// identical to its created_at while the newest assignment is 6.5h later.
const ROW = '2026-07-26T21:38:00+00:00';
const ASSIGN = '2026-07-27T04:16:00+00:00';

const S1 = { id: 'sched-1', updated_at: ROW };

/** Default: the RPC answers with the real (later) content stamp for sched-1. */
const OK: Canned = { data: [{ schedule_id: 'sched-1', last_activity_at: ASSIGN }], error: null };

const run = (rpc: Canned = OK, schedules: ScheduleActivityRow[] = [S1]) => {
  const { sb, calls } = makeFakeSupabase({ rpc: { [LAST_ACTIVITY_RPC]: rpc } });
  return loadLastActivity(sb, schedules).then(res => ({ ...res, calls }));
};

const rpcCalls = (calls: { method: string; fn?: string; args: unknown[] }[]) =>
  calls.filter(c => c.method === 'rpc' && c.fn === LAST_ACTIVITY_RPC);

// ── the RPC answer, and the floor under it ──────────────────────────────────

describe('loadLastActivity — the derived stamp', () => {
  it('THE FIX: the derived stamp beats the schedule row stamp', async () => {
    const { lastActivityById, warnings } = await run();
    expect(lastActivityById.get('sched-1')).toBe(ASSIGN);
    expect(warnings).toEqual([]);
  });

  it('sends the whole id list to the patch39 RPC, under its parameter name', async () => {
    const { calls } = await run(OK, [S1, { id: 'sched-2', updated_at: ROW }]);
    const rpcs = rpcCalls(calls);
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0].args[0]).toEqual({ p_schedule_ids: ['sched-1', 'sched-2'] });
  });

  it('keeps the stamp VERBATIM (Postgres microsecond precision survives)', async () => {
    const micros = '2026-07-27T04:16:00.123456+00:00';
    const { lastActivityById } = await run({
      data: [{ schedule_id: 'sched-1', last_activity_at: micros }], error: null,
    });
    expect(lastActivityById.get('sched-1')).toBe(micros);
  });

  it('the schedule row is a FLOOR: an older RPC answer never drags it back', async () => {
    // The function's max includes schedules.updated_at, so this shouldn't
    // happen — the guard is what makes "never emptier than before" true
    // regardless of what the DB returns.
    const { lastActivityById } = await run({
      data: [{ schedule_id: 'sched-1', last_activity_at: '2026-01-01T00:00:00+00:00' }], error: null,
    });
    expect(lastActivityById.get('sched-1')).toBe(ROW);
  });

  it('resolves each schedule independently and ignores ids it never asked for', async () => {
    const { lastActivityById } = await run({
      data: [
        { schedule_id: 'sched-1', last_activity_at: ASSIGN },
        { schedule_id: 'sched-2', last_activity_at: '2026-08-30T00:00:00+00:00' },
        { schedule_id: 'sched-unknown', last_activity_at: '2027-01-01T00:00:00+00:00' },
      ],
      error: null,
    }, [S1, { id: 'sched-2', updated_at: ROW }]);

    expect([...lastActivityById.keys()]).toEqual(['sched-1', 'sched-2']);
    expect(lastActivityById.get('sched-1')).toBe(ASSIGN);
    expect(lastActivityById.get('sched-2')).toBe('2026-08-30T00:00:00+00:00');
  });
});

// ── nothing to aggregate ────────────────────────────────────────────────────

describe('loadLastActivity — schedules with no content yet', () => {
  it('a schedule the RPC returns no row for falls back to its row stamp', async () => {
    const { lastActivityById, warnings } = await run({ data: [], error: null });
    expect(lastActivityById.get('sched-1')).toBe(ROW);
    expect(warnings).toEqual([]); // empty is a legitimate answer, not a degradation
  });

  it('a null stamp for a KNOWN id is legitimate, not an unrecognised shape', async () => {
    const { lastActivityById, warnings } = await run({
      data: [{ schedule_id: 'sched-1', last_activity_at: null }], error: null,
    });
    expect(lastActivityById.get('sched-1')).toBe(ROW);
    expect(warnings).toEqual([]);
  });

  it('a null row stamp with nothing else stays null (never "Invalid Date" downstream)', async () => {
    const { lastActivityById } = await run(
      { data: [{ schedule_id: 'sched-1', last_activity_at: null }], error: null },
      [{ id: 'sched-1', updated_at: null }],
    );
    expect(lastActivityById.get('sched-1')).toBeNull();
  });

  it('an empty list issues no query at all', async () => {
    const { lastActivityById, calls } = await run(OK, []);
    expect(lastActivityById.size).toBe(0);
    expect(rpcCalls(calls)).toHaveLength(0);
    expect(fromCount(calls)).toBe(0);
  });
});

// ── degradation ─────────────────────────────────────────────────────────────

describe('loadLastActivity — graceful degradation', () => {
  it('a MISSING function (DB predates patch39) degrades to updated_at and names the patch', async () => {
    const { lastActivityById, warnings } = await run({
      data: null,
      error: {
        code: 'PGRST202',
        message: 'Could not find the function scheduling.schedule_last_activity(p_schedule_ids) in the schema cache',
      },
    });
    expect(lastActivityById.get('sched-1')).toBe(ROW); // the pre-fix value, not a blank row
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(LAST_ACTIVITY_RPC);
    expect(warnings[0]).toContain('not present on this DB');
    expect(warnings[0]).toContain('patch39');
  });

  it('the raw Postgres undefined_function code reads the same way', async () => {
    const { warnings } = await run({
      data: null,
      error: { code: '42883', message: 'function scheduling.schedule_last_activity(uuid[]) does not exist' },
    });
    expect(warnings[0]).toContain('not present on this DB');
  });

  it('a genuine failure is labelled a read failure, NOT a missing function', async () => {
    const { lastActivityById, warnings } = await run({
      data: null,
      error: { code: '57014', message: 'canceling statement due to statement timeout' },
    });
    expect(lastActivityById.get('sched-1')).toBe(ROW);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('read failed');
    expect(warnings[0]).toContain('statement timeout'); // the real error still surfaces
  });

  it('a THROW from the client layer degrades like an error result, never propagates', async () => {
    const sb = { rpc: () => { throw new Error('fetch failed'); } };
    const { lastActivityById, warnings } = await loadLastActivity(sb, [S1]);
    expect(lastActivityById.get('sched-1')).toBe(ROW);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('fetch failed');
  });

  it('an unrecognised row shape warns instead of silently reading clean', async () => {
    const { lastActivityById, warnings } = await run({
      data: [{ some_other_key: 1 }, { another: 2 }], error: null,
    });
    expect(lastActivityById.get('sched-1')).toBe(ROW);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('unrecognised shape');
  });
});

// ── query shape / no N+1 ────────────────────────────────────────────────────

describe('loadLastActivity — query shape', () => {
  it('is ONE round trip for the whole list, whatever the list length', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `sched-${i}`, updated_at: ROW }));
    const one = await run();
    const lots = await run(
      { data: many.map(s => ({ schedule_id: s.id, last_activity_at: ASSIGN })), error: null },
      many,
    );

    expect(rpcCalls(one.calls)).toHaveLength(1);
    expect(rpcCalls(lots.calls)).toHaveLength(1);   // NOT 250, and not chunked
    expect(lots.lastActivityById.size).toBe(250);
    expect([...lots.lastActivityById.values()].every(v => v === ASSIGN)).toBe(true);
  });

  it('reads no table directly — the whole derivation is the one function', async () => {
    const { calls } = await run();
    expect(fromCount(calls)).toBe(0);
  });
});

// ── response shaping ────────────────────────────────────────────────────────

describe('withLastActivity', () => {
  it('adds the derived stamp without disturbing the rest of the row', () => {
    const rows = [{ id: 'sched-1', updated_at: ROW, schedule_name: 'v5', sites: { name: 'Paoli' } }];
    const out = withLastActivity(rows, new Map([['sched-1', ASSIGN]]));
    expect(out[0]).toEqual({ ...rows[0], last_activity_at: ASSIGN });
  });

  it('falls back to the row stamp when the derivation produced nothing', () => {
    const rows = [{ id: 'sched-1', updated_at: ROW }];
    expect(withLastActivity(rows, new Map()) [0].last_activity_at).toBe(ROW);
    expect(withLastActivity(rows, new Map([['sched-1', null]]))[0].last_activity_at).toBe(ROW);
  });

  it('is null only when there is genuinely no stamp anywhere', () => {
    expect(withLastActivity([{ id: 'sched-1', updated_at: null }], new Map())[0].last_activity_at).toBeNull();
  });
});
