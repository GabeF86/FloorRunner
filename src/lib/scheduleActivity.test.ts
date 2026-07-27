// Last-activity derivation for the schedules list (Gabriel 2026-07-27).
//
// The feature shipped reading `schedules.updated_at`, which only moves when
// the schedule ROW changes — so on the two drafts worked in most recently the
// `edited` line was suppressed, the opposite of useful. These tests pin the
// replacement: a MAX across the row stamp, the version stamps, and the two
// per-version aggregates, with every source degrading on its own.
//
// Injected fake supabase client throughout (repo convention) — no DB.
import { describe, it, expect } from 'vitest';
import { makeFakeSupabase, fromCount, callsFor, type Filter, type TableCfg } from './rulesEngine/__fixtures__/fakeSupabase';
import { ACTIVITY_ID_CHUNK, loadLastActivity, withLastActivity, type ScheduleActivityRow } from './scheduleActivity';

// Real numbers from the 2026-07-27 live-DB probe: the schedule row's stamp is
// identical to its created_at while the newest assignment is 6.5h later.
const ROW = '2026-07-26T21:38:00+00:00';
const ASSIGN = '2026-07-27T04:16:00+00:00';
const SLOT = '2026-07-27T02:00:00+00:00';
const VER_CREATED = '2026-07-26T21:38:00+00:00';

const S1 = { id: 'sched-1', updated_at: ROW };

const VERSIONS = [{ id: 'ver-1', schedule_id: 'sched-1', created_at: VER_CREATED, published_at: null }];

function tables(over: Record<string, TableCfg> = {}): Record<string, TableCfg> {
  return {
    schedule_versions: { data: VERSIONS, error: null },
    assignments: { data: [{ schedule_version_id: 'ver-1', max: ASSIGN }], error: null },
    schedule_slots: { data: [{ schedule_version_id: 'ver-1', max: SLOT }], error: null },
    ...over,
  };
}

const run = (over: Record<string, TableCfg> = {}, schedules: ScheduleActivityRow[] = [S1]) => {
  const { sb, calls } = makeFakeSupabase({ tables: tables(over) });
  return loadLastActivity(sb, schedules).then(res => ({ ...res, calls }));
};

// ── source selection ────────────────────────────────────────────────────────

describe('loadLastActivity — which source wins', () => {
  it('THE FIX: the assignment max beats the schedule row stamp', async () => {
    const { lastActivityById, warnings } = await run();
    expect(lastActivityById.get('sched-1')).toBe(ASSIGN);
    expect(warnings).toEqual([]);
  });

  it('the slot max wins when it is the newest (slot lock/label writes no assignment)', async () => {
    const { lastActivityById } = await run({
      assignments: { data: [{ schedule_version_id: 'ver-1', max: '2026-07-27T01:00:00+00:00' }], error: null },
      schedule_slots: { data: [{ schedule_version_id: 'ver-1', max: '2026-07-27T09:30:00+00:00' }], error: null },
    });
    expect(lastActivityById.get('sched-1')).toBe('2026-07-27T09:30:00+00:00');
  });

  it('the schedule row wins when it is the newest (renamed after the last edit)', async () => {
    const renamed = '2026-07-28T15:00:00+00:00';
    const { lastActivityById } = await run({}, [{ id: 'sched-1', updated_at: renamed }]);
    expect(lastActivityById.get('sched-1')).toBe(renamed);
  });

  it('a version stamp counts: published_at moves the line even with no newer assignment', async () => {
    const published = '2026-07-30T12:00:00+00:00';
    const { lastActivityById } = await run({
      schedule_versions: { data: [{ id: 'ver-1', schedule_id: 'sched-1', created_at: VER_CREATED, published_at: published }], error: null },
      assignments: { data: [{ schedule_version_id: 'ver-1', max: ASSIGN }], error: null },
      schedule_slots: { data: [], error: null },
    });
    expect(lastActivityById.get('sched-1')).toBe(published);
  });

  it('rolls up ALL versions of one schedule, and never leaks across schedules', async () => {
    const { lastActivityById } = await run({
      schedule_versions: {
        data: [
          { id: 'ver-1', schedule_id: 'sched-1', created_at: VER_CREATED, published_at: null },
          { id: 'ver-2', schedule_id: 'sched-1', created_at: VER_CREATED, published_at: null },
          { id: 'ver-9', schedule_id: 'sched-2', created_at: VER_CREATED, published_at: null },
        ],
        error: null,
      },
      assignments: {
        data: [
          { schedule_version_id: 'ver-1', max: '2026-07-27T01:00:00+00:00' },
          { schedule_version_id: 'ver-2', max: ASSIGN },              // newer sibling version
          { schedule_version_id: 'ver-9', max: '2026-08-30T00:00:00+00:00' }, // other schedule
          { schedule_version_id: 'ver-unknown', max: '2027-01-01T00:00:00+00:00' },
        ],
        error: null,
      },
      schedule_slots: { data: [], error: null },
    }, [S1, { id: 'sched-2', updated_at: ROW }]);

    expect(lastActivityById.get('sched-1')).toBe(ASSIGN);
    expect(lastActivityById.get('sched-2')).toBe('2026-08-30T00:00:00+00:00');
  });
});

// ── nothing to aggregate ────────────────────────────────────────────────────

describe('loadLastActivity — schedules with no content yet', () => {
  it('a schedule with no assignments falls back to the row/version stamps', async () => {
    const { lastActivityById, warnings } = await run({
      assignments: { data: [], error: null },
      schedule_slots: { data: [], error: null },
    });
    expect(lastActivityById.get('sched-1')).toBe(ROW);
    expect(warnings).toEqual([]); // empty is a legitimate answer, not a degradation
  });

  it('a schedule with no versions at all keeps its row stamp and skips the aggregates', async () => {
    const { lastActivityById, calls } = await run({ schedule_versions: { data: [], error: null } });
    expect(lastActivityById.get('sched-1')).toBe(ROW);
    expect(fromCount(calls, 'assignments')).toBe(0);
    expect(fromCount(calls, 'schedule_slots')).toBe(0);
  });

  it('a null row stamp with nothing else stays null (never "Invalid Date" downstream)', async () => {
    const { lastActivityById } = await run({
      schedule_versions: { data: [{ id: 'ver-1', schedule_id: 'sched-1', created_at: null, published_at: null }], error: null },
      assignments: { data: [], error: null },
      schedule_slots: { data: [], error: null },
    }, [{ id: 'sched-1', updated_at: null }]);
    expect(lastActivityById.get('sched-1')).toBeNull();
  });

  it('an empty list issues no queries at all', async () => {
    const { lastActivityById, calls } = await run({}, []);
    expect(lastActivityById.size).toBe(0);
    expect(calls.filter(c => c.method === 'from')).toHaveLength(0);
  });
});

// ── degradation ─────────────────────────────────────────────────────────────

describe('loadLastActivity — graceful degradation', () => {
  it('a failed version lookup degrades to schedules.updated_at and fires no aggregates', async () => {
    const { lastActivityById, warnings, calls } = await run({
      schedule_versions: { data: null, error: { message: 'connection reset' } },
    });
    expect(lastActivityById.get('sched-1')).toBe(ROW); // the pre-fix value, not a blank row
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('schedule_versions lookup failed');
    expect(fromCount(calls, 'assignments')).toBe(0);
    expect(fromCount(calls, 'schedule_slots')).toBe(0);
  });

  it('a failed assignments aggregate still lets the slot max through', async () => {
    const { lastActivityById, warnings } = await run({
      assignments: { data: null, error: { code: '42703', message: 'column assignments.max does not exist' } },
    });
    expect(lastActivityById.get('sched-1')).toBe(SLOT);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('assignments max(updated_at)');
    // isMissingColumnError split (the genContext idiom): an older DB reads
    // differently in the log from a genuine failure.
    expect(warnings[0]).toContain('not available on this DB');
  });

  it('a non-column failure is labelled a read failure, not a missing column', async () => {
    const { warnings } = await run({
      assignments: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } },
    });
    expect(warnings[0]).toContain('read failed');
  });

  it('both aggregates failing lands exactly on the old behaviour, with both warnings', async () => {
    const { lastActivityById, warnings } = await run({
      assignments: { data: null, error: { message: 'aggregate functions are not enabled' } },
      schedule_slots: { data: null, error: { message: 'aggregate functions are not enabled' } },
    });
    expect(lastActivityById.get('sched-1')).toBe(ROW);
    expect(warnings).toHaveLength(2);
  });

  it('an unrecognised aggregate shape warns instead of silently reading clean', async () => {
    const { lastActivityById, warnings } = await run({
      assignments: { data: [{ some_other_key: 1 }, { another: 2 }], error: null },
      schedule_slots: { data: [], error: null },
    });
    expect(lastActivityById.get('sched-1')).toBe(ROW);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('unrecognised shape');
  });

  it('accepts a NON-flattened embed shape, in case a server ignores the spread', async () => {
    const { lastActivityById, warnings } = await run({
      assignments: { data: [{ schedule_slots: { schedule_version_id: 'ver-1' }, max: ASSIGN }], error: null },
      schedule_slots: { data: [], error: null },
    });
    expect(lastActivityById.get('sched-1')).toBe(ASSIGN);
    expect(warnings).toEqual([]);
  });

  it('accepts the array form of that embed too', async () => {
    const { lastActivityById } = await run({
      assignments: { data: [{ schedule_slots: [{ schedule_version_id: 'ver-1' }], max: ASSIGN }], error: null },
      schedule_slots: { data: [], error: null },
    });
    expect(lastActivityById.get('sched-1')).toBe(ASSIGN);
  });
});

// ── query shape / no N+1 ────────────────────────────────────────────────────

describe('loadLastActivity — query shape', () => {
  it('is 3 queries for the whole list, whatever the list length', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `sched-${i}`, updated_at: ROW }));
    const one = await run({}, [S1]);
    const twentyFive = await run({
      schedule_versions: {
        data: many.map((s, i) => ({ id: `ver-${i}`, schedule_id: s.id, created_at: VER_CREATED, published_at: null })),
        error: null,
      },
      assignments: { data: many.map((_, i) => ({ schedule_version_id: `ver-${i}`, max: ASSIGN })), error: null },
    }, many);

    expect(fromCount(one.calls)).toBe(3);
    expect(fromCount(twentyFive.calls)).toBe(3);          // NOT 25, and not 25×3
    expect(twentyFive.lastActivityById.size).toBe(25);
    expect([...twentyFive.lastActivityById.values()].every(v => v === ASSIGN)).toBe(true);
  });

  it('groups the assignment max by version through the slot embed, filtered to this list', async () => {
    const { calls } = await run();
    const select = String(callsFor(calls, 'assignments', 'select')[0].args[0]);
    expect(select).toContain('updated_at.max()');
    expect(select).toContain('schedule_slots!inner(schedule_version_id)'); // the group-by key
    const filter = callsFor(calls, 'assignments', 'in')[0];
    expect(filter.args[0]).toBe('schedule_slots.schedule_version_id');
    expect(filter.args[1]).toEqual(['ver-1']);
  });

  it('groups the slot max by its own version column, no embed needed', async () => {
    const { calls } = await run();
    expect(String(callsFor(calls, 'schedule_slots', 'select')[0].args[0])).toBe('schedule_version_id, updated_at.max()');
    expect(callsFor(calls, 'schedule_slots', 'in')[0].args[0]).toBe('schedule_version_id');
  });

  it('chunks the id filter so a long list cannot blow the URL length', async () => {
    const n = ACTIVITY_ID_CHUNK + 10;
    const many = Array.from({ length: n }, (_, i) => ({ id: `sched-${i}`, updated_at: ROW }));
    const versionRows = many.map((s, i) => ({ id: `ver-${i}`, schedule_id: s.id, created_at: VER_CREATED, published_at: null }));
    // The fake replays its canned rows per chunk; only the chunking is asserted.
    const { calls } = await run({
      schedule_versions: (filters: Filter[]) => {
        const ids = (filters.find(f => f.method === 'in')?.args[1] as string[]) ?? [];
        return { data: versionRows.filter(v => ids.includes(v.schedule_id)), error: null };
      },
      assignments: { data: [], error: null },
      schedule_slots: { data: [], error: null },
    }, many);

    const chunks = callsFor(calls, 'schedule_versions', 'in').map(c => (c.args[1] as string[]).length);
    expect(chunks).toEqual([ACTIVITY_ID_CHUNK, 10]);
    expect(callsFor(calls, 'assignments', 'in').map(c => (c.args[1] as string[]).length))
      .toEqual([ACTIVITY_ID_CHUNK, 10]);
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
