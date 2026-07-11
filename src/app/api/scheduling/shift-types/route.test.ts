// POST /api/scheduling/shift-types — zod gate wiring (Task 13).
// Invalid bodies must 400 with {error, issues} BEFORE touching the DB;
// valid bodies keep the existing pass-through insert + row response.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeFakeSupabase, callsFor } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

const holder = vi.hoisted(() => ({ sb: null as unknown }));
vi.mock('@/lib/supabaseScheduling', () => ({
  sbSchedulingServer: () => holder.sb,
}));

import { POST } from './route';
import { PATCH } from './[id]/route';

const VALID_BODY = {
  site_id: 'site-1',
  name: 'Call - Weekday',
  code: 'C1',
  category: 'call',
  generation_engine: 'call',
};

function fakeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function setup(row: Record<string, unknown> = { id: 'st-1', ...VALID_BODY }) {
  const { sb, calls } = makeFakeSupabase({
    tables: { shift_types: { data: row, error: null } },
  });
  holder.sb = sb;
  return { calls };
}

beforeEach(() => { holder.sb = null; });

describe('POST /api/scheduling/shift-types', () => {
  it('inserts a valid body and returns the row (shape unchanged)', async () => {
    const { calls } = setup();
    const res = await POST(fakeReq(VALID_BODY));
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('st-1');
    const inserts = callsFor(calls, 'shift_types', 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].args[0]).toEqual(VALID_BODY);
  });

  it('rejects an unknown column with 400 and does not touch the DB', async () => {
    const { calls } = setup();
    const res = await POST(fakeReq({ ...VALID_BODY, evil_column: 'x' }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(typeof json.error).toBe('string');
    expect(Array.isArray(json.issues)).toBe(true);
    expect(callsFor(calls, 'shift_types', 'insert')).toHaveLength(0);
  });

  it('rejects a wrong generation_engine enum with 400', async () => {
    setup();
    const res = await POST(fakeReq({ ...VALID_BODY, generation_engine: 'magic' }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.issues.map((i: { path: string }) => i.path)).toContain('generation_engine');
  });
});

describe('PATCH /api/scheduling/shift-types/[id]', () => {
  const params = { params: Promise.resolve({ id: 'st-1' }) };

  it('updates with a partial body and returns the row (shape unchanged)', async () => {
    const { calls } = setup({ id: 'st-1', is_active: false });
    const res = await PATCH(fakeReq({ is_active: false }), params);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('st-1');
    const updates = callsFor(calls, 'shift_types', 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].args[0]).toEqual({ is_active: false });
  });

  it('rejects an unknown column with 400 and does not touch the DB', async () => {
    const { calls } = setup();
    const res = await PATCH(fakeReq({ evil_column: 'x' }), params);
    expect(res.status).toBe(400);
    expect(callsFor(calls, 'shift_types', 'update')).toHaveLength(0);
  });
});
