// Board assistant snapshot / undo (Task 6). Exercised against the STATEFUL
// in-memory fake (__fixtures__/statefulBoard) — the round-trip needs writes to
// actually apply so "mutate → revert → deep-equals the seed" is a real check.
// The Task 5 executors are the mutators (spec: revert must undo whatever the
// tools did), and mark_relieved's relief_log row is recorded/deleted through the
// same actionRef seam the SSE route will wire.
import { describe, it, expect } from 'vitest';
import { createBoardExecutors, type BoardCtx, type BoardActionRef } from './tools';
import { takeBoardSnapshot, recordReliefInsert, revertBoardAction, SNAPSHOT_TABLES } from './snapshot';
import { makeStatefulSupabase } from './__fixtures__/statefulBoard';

const DATE = '2026-07-12';
const PAOLI: BoardCtx = { boardDate: DATE, hospital: 'Paoli Hospital' };

// Seed: Paoli + null-hospital staff are in scope; the Bryn Mawr rows (md-bmh)
// are out of scope and must be untouched by snapshot AND revert.
function seed() {
  return {
    staff: [
      { id: 'md-a', name: 'Amy Ash', initials: 'AA', role: 'physician', hours: '8hr', hospital: 'Paoli Hospital' },
      { id: 'md-b', name: 'Ben Bay', initials: 'BB', role: 'physician', hours: '8hr', hospital: 'Paoli Hospital' },
      { id: 'crna-a', name: 'Cara Cole', initials: 'CC', role: 'crna', hours: '10hr', hospital: 'Paoli Hospital' },
      { id: 'crna-null', name: 'Dana Dew', initials: 'DD', role: 'crna', hours: '8hr', hospital: null },
      { id: 'md-bmh', name: 'Bruce Hale', initials: 'BH', role: 'physician', hours: '8hr', hospital: 'Bryn Mawr Hospital' },
    ],
    sites: [
      { id: 'site-main', name: 'Main OR', is_float: false, hospital: 'Paoli Hospital', position: 1,
        rooms: [{ id: 'r1', name: 'OR 1', position: 1 }, { id: 'r2', name: 'OR 2', position: 2 }] },
      { id: 'site-float', name: 'Float', is_float: true, hospital: null, position: 99, rooms: [] },
      { id: 'site-bmh', name: 'BMH', is_float: false, hospital: 'Bryn Mawr Hospital', position: 2,
        rooms: [{ id: 'r9', name: 'BMH OR 1', position: 1 }] },
    ],
    daily_active: [
      { id: 'ac1', staff_id: 'md-a', board_date: DATE },
      { id: 'ac2', staff_id: 'crna-a', board_date: DATE },
      { id: 'ac-bmh', staff_id: 'md-bmh', board_date: DATE }, // out of scope
    ],
    assignments: [
      { id: 'a1', room_id: 'r1', staff_id: 'md-a', board_date: DATE },
      { id: 'a2', room_id: 'r1', staff_id: 'crna-a', board_date: DATE },
      { id: 'a-bmh', room_id: 'r9', staff_id: 'md-bmh', board_date: DATE }, // out of scope
    ],
    daily_designations: [{ id: 'dg1', staff_id: 'md-a', board_date: DATE, designation: 'D1' }],
    daily_shifts: [{ id: 'sh1', staff_id: 'crna-a', board_date: DATE, hours: '10hr' }],
    breaks: [] as Array<Record<string, unknown>>,
    relief_log: [
      { id: 'rl0', staff_id: 'crna-null', staff_name: 'Dana Dew', staff_role: 'crna', staff_initials: 'DD',
        board_date: DATE, relieved_at: '2026-07-12T13:00:00Z', designation: null, shift_hours: '8hr' },
    ],
    board_assistant_actions: [] as Array<Record<string, unknown>>,
  };
}

const DAY_TABLES = [...SNAPSHOT_TABLES, 'relief_log'] as const;
function dayState(dump: (t: string) => Array<Record<string, unknown>>) {
  return Object.fromEntries(DAY_TABLES.map((t) => [t, dump(t)]));
}

describe('takeBoardSnapshot', () => {
  it('inserts one board_assistant_actions row with the in-scope day rows + empty reliefIds, returns the id', async () => {
    const { sb, dump } = makeStatefulSupabase(seed());
    const id = await takeBoardSnapshot(sb as never, PAOLI, 'Assistant: seed roster');
    expect(typeof id).toBe('string');

    const action = dump('board_assistant_actions').find((r) => r.id === id)!;
    expect(action.board_date).toBe(DATE);
    expect(action.hospital).toBe('Paoli Hospital');
    const snap = action.snapshot as Record<string, Array<{ staff_id: string }>>;
    // Scoped: BMH rows excluded from every day table.
    expect(snap.daily_active.map((r) => r.staff_id).sort()).toEqual(['crna-a', 'md-a']);
    expect(snap.assignments.map((r) => r.staff_id).sort()).toEqual(['crna-a', 'md-a']);
    expect(snap.assignments.some((r) => r.staff_id === 'md-bmh')).toBe(false);
    expect(snap.daily_designations.map((r) => r.staff_id)).toEqual(['md-a']);
    expect(snap.daily_shifts.map((r) => r.staff_id)).toEqual(['crna-a']);
    expect(snap.breaks).toEqual([]);
    expect((snap as unknown as { reliefIds: string[] }).reliefIds).toEqual([]);
  });

  it('stores full rows (not just ids), so revert can re-insert them verbatim', async () => {
    const { sb, dump } = makeStatefulSupabase(seed());
    const id = await takeBoardSnapshot(sb as never, PAOLI, 's');
    const action = dump('board_assistant_actions').find((r) => r.id === id)!;
    const snap = action.snapshot as { assignments: Array<Record<string, unknown>> };
    expect(snap.assignments.find((r) => r.id === 'a1')).toEqual({
      id: 'a1', room_id: 'r1', staff_id: 'md-a', board_date: DATE,
    });
  });

  it('under "All hospitals" scope captures every hospital and stores null hospital', async () => {
    const { sb, dump } = makeStatefulSupabase(seed());
    const id = await takeBoardSnapshot(sb as never, { boardDate: DATE, hospital: null }, 's');
    const action = dump('board_assistant_actions').find((r) => r.id === id)!;
    expect(action.hospital).toBeNull();
    const snap = action.snapshot as { assignments: Array<{ staff_id: string }> };
    expect(snap.assignments.some((r) => r.staff_id === 'md-bmh')).toBe(true); // BMH now in scope
  });
});

describe('recordReliefInsert', () => {
  it('appends the relief id to the open snapshot (idempotently)', async () => {
    const { sb, dump } = makeStatefulSupabase(seed());
    const id = await takeBoardSnapshot(sb as never, PAOLI, 's');
    await recordReliefInsert(sb as never, id, 'rl-new');
    await recordReliefInsert(sb as never, id, 'rl-new'); // duplicate → no-op
    const action = dump('board_assistant_actions').find((r) => r.id === id)!;
    expect((action.snapshot as { reliefIds: string[] }).reliefIds).toEqual(['rl-new']);
  });

  it('throws on an unknown action id', async () => {
    const { sb } = makeStatefulSupabase(seed());
    await expect(recordReliefInsert(sb as never, 'nope', 'rl-new')).rejects.toThrow(/not found/);
  });
});

describe('revertBoardAction', () => {
  it('round-trips: snapshot → mutate via Task 5 executors → revert → day-state deep-equals the seed', async () => {
    const { sb, dump } = makeStatefulSupabase(seed());
    const before = dayState(dump);

    const actionRef: BoardActionRef = { actionId: null };
    const id = await takeBoardSnapshot(sb as never, PAOLI, 'Assistant: shuffle the board');
    actionRef.actionId = id;
    const execs = createBoardExecutors(sb as never, PAOLI, actionRef);

    // A mix that touches every day table: a new assignment + roster add, a break,
    // a modified designation, a modified shift, and a relief (delete + relief_log
    // insert recorded via actionRef).
    await execs.assign_to_room({ staff_id: 'md-b', room: 'OR 2' });     // new assignment + daily_active
    await execs.mark_break({ staff_id: 'md-a', break_type: 'lunch', taken: true }); // new breaks row
    await execs.set_designation({ staff_id: 'md-a', designation: 'D3' });  // modify dg1
    await execs.set_shift_hours({ staff_id: 'crna-a', hours: '12hr' });    // modify sh1
    await execs.mark_relieved({ staff_id: 'crna-a' });                     // delete a2 + relief_log insert

    // Sanity: the day genuinely changed before revert.
    expect(dump('assignments').some((r) => r.staff_id === 'md-b')).toBe(true);
    expect(dump('relief_log').length).toBe(2);
    const openAction = dump('board_assistant_actions').find((r) => r.id === id)!;
    expect((openAction.snapshot as { reliefIds: string[] }).reliefIds.length).toBe(1); // relief recorded

    const res = await revertBoardAction(sb as never, id);
    expect(res.ok).toBe(true);
    expect(res.restored).toEqual({
      daily_active: 2, assignments: 2, daily_designations: 1, daily_shifts: 1, breaks: 0,
    });
    expect(res.reliefDeleted).toBe(1);

    // The whole day (incl. the untouched BMH out-of-scope rows) is back to seed.
    expect(dayState(dump)).toEqual(before);
  });

  it('never touches out-of-scope (other-hospital) rows on revert', async () => {
    const { sb, dump } = makeStatefulSupabase(seed());
    const id = await takeBoardSnapshot(sb as never, PAOLI, 's');
    await revertBoardAction(sb as never, id);
    // md-bmh's daily_active + assignment survive (scoped delete never saw them).
    expect(dump('daily_active').some((r) => r.staff_id === 'md-bmh')).toBe(true);
    expect(dump('assignments').some((r) => r.staff_id === 'md-bmh')).toBe(true);
  });

  it('stamps reverted_at and refuses a second revert (already reverted)', async () => {
    const { sb, dump } = makeStatefulSupabase(seed());
    const id = await takeBoardSnapshot(sb as never, PAOLI, 's');
    const first = await revertBoardAction(sb as never, id);
    expect(first.ok).toBe(true);
    expect(dump('board_assistant_actions').find((r) => r.id === id)!.reverted_at).toBeTruthy();

    const second = await revertBoardAction(sb as never, id);
    expect(second.ok).toBe(false);
    expect(second.alreadyReverted).toBe(true);
    expect(second.errors.join(' ')).toMatch(/already reverted/i);
  });

  it('reports notFound for an unknown action id', async () => {
    const { sb } = makeStatefulSupabase(seed());
    const res = await revertBoardAction(sb as never, 'does-not-exist');
    expect(res.ok).toBe(false);
    expect(res.notFound).toBe(true);
  });

  it('does NOT silently succeed when the staff scope is empty at revert time but the snapshot holds rows', async () => {
    const { sb, dump, tables } = makeStatefulSupabase(seed());
    const id = await takeBoardSnapshot(sb as never, PAOLI, 's'); // snapshot holds rows
    // All in-scope staff rows vanish before the revert (only the out-of-scope
    // BMH physician remains) → scopedStaffIds resolves empty for the action's scope.
    tables.staff = tables.staff.filter((r) => r.id === 'md-bmh');

    const res = await revertBoardAction(sb as never, id);
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/no in-scope staff at revert time/);
    // Every snapshot table that held rows reports the skip; breaks was empty →
    // genuinely nothing to do, no error for it.
    expect(res.errors.length).toBe(4);
    expect(res.restored).toEqual({
      daily_active: 0, assignments: 0, daily_designations: 0, daily_shifts: 0, breaks: 0,
    });
    // reverted_at stays unstamped → the Undo remains retryable.
    expect(dump('board_assistant_actions').find((r) => r.id === id)!.reverted_at).toBeUndefined();
  });
});
