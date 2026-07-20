// PATCH /api/scheduling/availability/[id] — the hardened single-row edit
// route the profile Availability tab's inline edit flows depend on
// (2026-07-20 audit follow-up). Pins the behaviors the UI relies on:
// whitelist-only updates (no mass assignment), 400 before any write on bad
// input, honest 404 on a missing id, and the merged-row end>=start check.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeFakeSupabase, callsFor, type Filter, type TableCfg } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

const holder = vi.hoisted(() => ({ sb: null as unknown }));
vi.mock('@/lib/supabaseScheduling', () => ({
  sbSchedulingServer: () => holder.sb,
}));

import { PATCH } from './route';

const EXISTING = { id: 'avail-1', start_date: '2026-08-03', end_date: '2026-08-07' };

function fakeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: 'avail-1' }) };

function setup(existing: Record<string, unknown> | null = EXISTING) {
  const tables: Record<string, TableCfg> = {
    provider_availability: (filters: Filter[]) =>
      filters.some(f => f.method === 'update')
        ? { data: { ...EXISTING, updated: true }, error: null }
        : { data: existing, error: null },
  };
  const { sb, calls } = makeFakeSupabase({ tables });
  holder.sb = sb;
  return { calls };
}

function updateCalls(calls: ReturnType<typeof setup>['calls']) {
  return callsFor(calls, 'provider_availability', 'update');
}

beforeEach(() => { holder.sb = null; });

describe('PATCH /api/scheduling/availability/[id]', () => {
  it('400s on invalid JSON with no reads or writes', async () => {
    const { calls } = setup();
    const req = { json: async () => { throw new Error('bad json'); } } as unknown as NextRequest;
    const res = await PATCH(req, params);
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  it('400s on an unknown field (mass-assignment guard) with no write', async () => {
    const { calls } = setup();
    const res = await PATCH(fakeReq({ provider_id: 'someone-else', start_date: '2026-08-04' }), params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown field: provider_id/);
    expect(updateCalls(calls).length).toBe(0);
  });

  it('400s on a malformed date with no write', async () => {
    const { calls } = setup();
    const res = await PATCH(fakeReq({ start_date: '08/04/2026' }), params);
    expect(res.status).toBe(400);
    expect(updateCalls(calls).length).toBe(0);
  });

  it('400s on an availability_type outside the enum with no write', async () => {
    const { calls } = setup();
    const res = await PATCH(fakeReq({ availability_type: 'vacation' }), params);
    expect(res.status).toBe(400);
    expect(updateCalls(calls).length).toBe(0);
  });

  it('404s honestly when the row does not exist, with no write', async () => {
    const { calls } = setup(null);
    const res = await PATCH(fakeReq({ start_date: '2026-08-04' }), params);
    expect(res.status).toBe(404);
    expect(updateCalls(calls).length).toBe(0);
  });

  it('400s when the MERGED row would have end < start (only one endpoint patched)', async () => {
    // Existing end is 2026-08-07; moving start past it must fail even though
    // the patch itself contains no end_date.
    const { calls } = setup();
    const res = await PATCH(fakeReq({ start_date: '2026-08-10' }), params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/end_date must be on or after/);
    expect(updateCalls(calls).length).toBe(0);
  });

  it('updates with exactly the cleaned whitelist fields (inline-edit happy path)', async () => {
    const { calls } = setup();
    const res = await PATCH(fakeReq({ start_date: '2026-08-04', end_date: '2026-08-08', notes: '' }), params);
    expect(res.status).toBe(200);
    const updates = updateCalls(calls);
    expect(updates.length).toBe(1);
    // '' notes normalizes to null; nothing beyond the submitted whitelist
    // fields reaches .update().
    expect(updates[0].args[0]).toEqual({
      start_date: '2026-08-04',
      end_date: '2026-08-08',
      notes: null,
    });
  });

  it('accepts pto_sellback as an availability_type (patch31 vocabulary)', async () => {
    const { calls } = setup();
    const res = await PATCH(fakeReq({ availability_type: 'pto_sellback' }), params);
    expect(res.status).toBe(200);
    expect(updateCalls(calls)[0].args[0]).toEqual({ availability_type: 'pto_sellback' });
  });
});
