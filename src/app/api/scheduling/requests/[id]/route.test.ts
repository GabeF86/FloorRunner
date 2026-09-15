// PATCH/DELETE /api/scheduling/requests/:id. The interesting half is the
// approval flow: approving a request mirrors it into provider_availability,
// which is what actually blocks the engine — so the request must never reach
// status 'approved' unless that row is there, and re-approving must not stack
// duplicates.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeFakeSupabase, callsFor, type Filter, type TableCfg } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

const holder = vi.hoisted(() => ({ sb: null as unknown }));
vi.mock('@/lib/supabaseScheduling', () => ({
  sbSchedulingServer: () => holder.sb,
}));

import { PATCH } from './route';

const ID = 'req-1';
const SITE = '2ddd2427-22fb-4290-9c4c-03a957e5af4e';
const REQUEST = {
  provider_id: 'prov-1',
  request_type: 'pto',
  start_date: '2026-10-01',
  end_date: '2026-10-05',
  site_id: SITE,
};

function patchReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}
const params = Promise.resolve({ id: ID });

function has(filters: Filter[], method: string): boolean {
  return filters.some(f => f.method === method);
}

function setup(opts: {
  request?: Record<string, unknown> | null;
  readError?: unknown;
  /** Rows the idempotency guard finds. */
  existingAvailability?: Record<string, unknown>[];
  dupError?: unknown;
  insertError?: unknown;
} = {}) {
  const requests: TableCfg = (filters) => {
    if (has(filters, 'update')) return { data: { id: ID, status: 'approved' }, error: null };
    if (opts.readError) return { data: null, error: opts.readError };
    return { data: opts.request === undefined ? REQUEST : opts.request, error: null };
  };
  const availability: TableCfg = (filters) => {
    if (has(filters, 'insert')) return { data: null, error: opts.insertError ?? null };
    if (opts.dupError) return { data: null, error: opts.dupError };
    return { data: opts.existingAvailability ?? [], error: null };
  };
  const { sb, calls } = makeFakeSupabase({
    tables: { provider_requests: requests, provider_availability: availability },
  });
  holder.sb = sb;
  return { calls };
}

beforeEach(() => { holder.sb = null; });

describe('PATCH approval → availability mirror', () => {
  it('creates the availability row and approves the request', async () => {
    const { calls } = setup();
    const res = await PATCH(patchReq({ status: 'approved' }), { params });
    expect(res.status).toBe(200);

    const [insert] = callsFor(calls, 'provider_availability', 'insert');
    expect(insert.args[0]).toMatchObject({
      provider_id: 'prov-1',
      site_id: SITE,
      availability_type: 'pto',
      start_date: '2026-10-01',
      end_date: '2026-10-05',
      source: 'request',
      approval_status: 'approved',
    });
    expect(callsFor(calls, 'provider_requests', 'update')).toHaveLength(1);
  });

  it('does NOT approve the request when the availability insert fails', async () => {
    const { calls } = setup({ insertError: { message: 'availability down' } });
    const res = await PATCH(patchReq({ status: 'approved' }), { params });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'availability down' });
    // The whole point: no approval without the leave behind it.
    expect(callsFor(calls, 'provider_requests', 'update')).toHaveLength(0);
  });

  it('does NOT approve the request when the request read fails', async () => {
    const { calls } = setup({ readError: { message: 'requests down' } });
    const res = await PATCH(patchReq({ status: 'approved' }), { params });
    expect(res.status).toBe(500);
    expect(callsFor(calls, 'provider_availability', 'insert')).toHaveLength(0);
    expect(callsFor(calls, 'provider_requests', 'update')).toHaveLength(0);
  });

  it('does NOT approve the request when the duplicate check fails', async () => {
    const { calls } = setup({ dupError: { message: 'lookup down' } });
    const res = await PATCH(patchReq({ status: 'approved' }), { params });
    expect(res.status).toBe(500);
    expect(callsFor(calls, 'provider_availability', 'insert')).toHaveLength(0);
    expect(callsFor(calls, 'provider_requests', 'update')).toHaveLength(0);
  });

  it('404s on a request that no longer exists', async () => {
    const { calls } = setup({ request: null });
    const res = await PATCH(patchReq({ status: 'approved' }), { params });
    expect(res.status).toBe(404);
    expect(callsFor(calls, 'provider_availability', 'insert')).toHaveLength(0);
    expect(callsFor(calls, 'provider_requests', 'update')).toHaveLength(0);
  });

  it('is idempotent — a second approval inserts nothing but still succeeds', async () => {
    const { calls } = setup({ existingAvailability: [{ id: 'avail-1' }] });
    const res = await PATCH(patchReq({ status: 'approved' }), { params });
    expect(res.status).toBe(200);
    expect(callsFor(calls, 'provider_availability', 'insert')).toHaveLength(0);
    expect(callsFor(calls, 'provider_requests', 'update')).toHaveLength(1);
  });

  it('matches the duplicate guard on the fields this route writes', async () => {
    const { calls } = setup();
    await PATCH(patchReq({ status: 'approved' }), { params });
    const eqs = callsFor(calls, 'provider_availability', 'eq').map(c => c.args);
    expect(eqs).toContainEqual(['provider_id', 'prov-1']);
    expect(eqs).toContainEqual(['availability_type', 'pto']);
    expect(eqs).toContainEqual(['start_date', '2026-10-01']);
    expect(eqs).toContainEqual(['end_date', '2026-10-05']);
    expect(eqs).toContainEqual(['source', 'request']);
    expect(eqs).toContainEqual(['site_id', SITE]);
  });

  it('matches site-less requests with IS NULL, not eq(null)', async () => {
    const { calls } = setup({ request: { ...REQUEST, site_id: null } });
    await PATCH(patchReq({ status: 'approved' }), { params });
    expect(callsFor(calls, 'provider_availability', 'is').map(c => c.args))
      .toContainEqual(['site_id', null]);
    expect(callsFor(calls, 'provider_availability', 'eq').map(c => c.args))
      .not.toContainEqual(['site_id', null]);
  });

  it('maps request types to their availability types', async () => {
    for (const [reqType, availType] of [
      ['no_call', 'no_call_request'],
      ['extra_call', 'call_request'],
      ['availability_change', 'unavailable'],
      ['something_new', 'unavailable'],
    ]) {
      const { calls } = setup({ request: { ...REQUEST, request_type: reqType } });
      await PATCH(patchReq({ status: 'approved' }), { params });
      const [insert] = callsFor(calls, 'provider_availability', 'insert');
      expect(insert.args[0]).toMatchObject({ availability_type: availType });
    }
  });
});

describe('PATCH without approval', () => {
  it('touches availability only on approval', async () => {
    const { calls } = setup();
    const res = await PATCH(patchReq({ status: 'denied', decision_reason: 'no' }), { params });
    expect(res.status).toBe(200);
    expect(callsFor(calls, 'provider_availability', 'insert')).toHaveLength(0);
    const [update] = callsFor(calls, 'provider_requests', 'update');
    expect(update.args[0]).toMatchObject({ status: 'denied', decision_reason: 'no' });
  });

  it('edits pending fields without a status change', async () => {
    const { calls } = setup();
    await PATCH(patchReq({ notes: 'moved', start_date: '2026-11-01' }), { params });
    const [update] = callsFor(calls, 'provider_requests', 'update');
    expect(update.args[0]).toEqual({ notes: 'moved', start_date: '2026-11-01' });
  });
});
