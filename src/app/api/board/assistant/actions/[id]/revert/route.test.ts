// POST /api/board/assistant/actions/[id]/revert — status mapping over
// revertBoardAction. sbBoardServer is mocked to a stateful in-memory fake (the
// hoisted-holder pattern the scheduling route tests use); the fake actually
// applies the restore so the happy path exercises revertBoardAction end-to-end.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeStatefulSupabase } from '@/lib/boardAssistant/__fixtures__/statefulBoard';
import { takeBoardSnapshot } from '@/lib/boardAssistant/snapshot';
import type { BoardCtx } from '@/lib/boardAssistant/tools';

const holder = vi.hoisted(() => ({ sb: null as unknown }));
vi.mock('@/lib/supabaseBoard', () => ({
  sbBoardServer: () => holder.sb,
}));

import { POST } from './route';

const DATE = '2026-07-12';
const PAOLI: BoardCtx = { boardDate: DATE, hospital: 'Paoli Hospital' };

function seed() {
  return {
    staff: [{ id: 'md-a', name: 'Amy Ash', initials: 'AA', role: 'physician', hours: '8hr', hospital: 'Paoli Hospital' }],
    daily_active: [{ id: 'ac1', staff_id: 'md-a', board_date: DATE }],
    assignments: [{ id: 'a1', room_id: 'r1', staff_id: 'md-a', board_date: DATE }],
    daily_designations: [{ id: 'dg1', staff_id: 'md-a', board_date: DATE, designation: 'D1' }],
    daily_shifts: [] as Array<Record<string, unknown>>,
    breaks: [] as Array<Record<string, unknown>>,
    relief_log: [] as Array<Record<string, unknown>>,
    board_assistant_actions: [] as Array<Record<string, unknown>>,
  };
}

async function post(id: string) {
  const res = await POST({} as NextRequest, { params: Promise.resolve({ id }) });
  return { res, json: await res.json() };
}

beforeEach(() => { holder.sb = null; });

describe('POST /api/board/assistant/actions/[id]/revert', () => {
  it('200 {ok, restored} for a valid action', async () => {
    const { sb } = makeStatefulSupabase(seed());
    holder.sb = sb;
    const id = await takeBoardSnapshot(sb as never, PAOLI, 's');
    const { res, json } = await post(id);
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.restored).toMatchObject({ daily_active: 1, assignments: 1, daily_designations: 1 });
  });

  it('404 for an unknown action id', async () => {
    const { sb } = makeStatefulSupabase(seed());
    holder.sb = sb;
    const { res, json } = await post('does-not-exist');
    expect(res.status).toBe(404);
    expect(json.error).toMatch(/not found/i);
  });

  it('409 on a second revert (already reverted)', async () => {
    const { sb } = makeStatefulSupabase(seed());
    holder.sb = sb;
    const id = await takeBoardSnapshot(sb as never, PAOLI, 's');
    await post(id);
    const { res, json } = await post(id);
    expect(res.status).toBe(409);
    expect(json.error).toMatch(/already reverted/i);
  });

  it('500 when the client throws', async () => {
    holder.sb = { from: () => { throw new Error('boom'); } };
    const { res, json } = await post('any');
    expect(res.status).toBe(500);
    expect(json.error).toMatch(/boom/);
  });
});
