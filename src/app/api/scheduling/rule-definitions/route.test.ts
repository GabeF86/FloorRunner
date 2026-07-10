// POST /api/scheduling/rule-definitions — zod gate wiring (Task 13).
// Invalid bodies must 400 with {error, issues} BEFORE touching the DB;
// valid bodies keep the existing pass-through insert + row response. The
// rules page's minimal PATCH ({is_active}) must keep working.
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
  rule_set_id: 'rs-1',
  rule_name: 'Post-call day off',
  rule_category: 'rest',
  hard_constraint: true,
  applies_to_shift_types: null,
  condition: {},
  action: {},
};

function fakeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function setup(row: Record<string, unknown> = { id: 'rd-1', ...VALID_BODY }) {
  const { sb, calls } = makeFakeSupabase({
    tables: { rule_definitions: { data: row, error: null } },
  });
  holder.sb = sb;
  return { calls };
}

beforeEach(() => { holder.sb = null; });

describe('POST /api/scheduling/rule-definitions', () => {
  it('inserts a valid body and returns the row (shape unchanged)', async () => {
    const { calls } = setup();
    const res = await POST(fakeReq(VALID_BODY));
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('rd-1');
    const inserts = callsFor(calls, 'rule_definitions', 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].args[0]).toEqual(VALID_BODY);
  });

  it('rejects a body missing rule_set_id with 400 and does not touch the DB', async () => {
    const { calls } = setup();
    const body: Record<string, unknown> = { ...VALID_BODY };
    delete body.rule_set_id;
    const res = await POST(fakeReq(body));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.issues.map((i: { path: string }) => i.path)).toContain('rule_set_id');
    expect(callsFor(calls, 'rule_definitions', 'insert')).toHaveLength(0);
  });

  it('rejects unknown top-level keys with 400', async () => {
    setup();
    const res = await POST(fakeReq({ ...VALID_BODY, sneaky: 1 }));
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/scheduling/rule-definitions/[id]', () => {
  const params = { params: { id: 'rd-1' } };

  it('accepts the is_active toggle the rules page sends', async () => {
    const { calls } = setup({ id: 'rd-1', is_active: false });
    const res = await PATCH(fakeReq({ is_active: false }), params);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('rd-1');
    const updates = callsFor(calls, 'rule_definitions', 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].args[0]).toEqual({ is_active: false });
  });

  it('rejects an unknown column with 400 and does not touch the DB', async () => {
    const { calls } = setup();
    const res = await PATCH(fakeReq({ evil_column: 'x' }), params);
    expect(res.status).toBe(400);
    expect(callsFor(calls, 'rule_definitions', 'update')).toHaveLength(0);
  });
});
