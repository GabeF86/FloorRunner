// Request-window CRUD (patch29). POST generates the crypto-random token
// server-side and enforces one OPEN window per site; PATCH only closes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeFakeSupabase, callsFor, type Filter } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

const holder = vi.hoisted(() => ({ sb: null as unknown }));
vi.mock('@/lib/supabaseScheduling', () => ({
  sbSchedulingServer: () => holder.sb,
}));

import { GET, POST } from './route';
import { PATCH } from './[id]/route';

const VALID_BODY = {
  site_id: 'site-1',
  block_start: '2026-09-07',
  block_end: '2026-11-22',
  max_no_call_requests: 3,
};

function fakeReq(body: unknown, url = 'http://x/api/scheduling/request-windows'): NextRequest {
  return { json: async () => body, url } as unknown as NextRequest;
}

// One table serves both the existing-open lookup and the insert: the insert
// chain is distinguished by the recorded 'insert' filter.
function setup(opts: { existingOpen?: boolean } = {}) {
  const inserted = { id: 'win-1', ...VALID_BODY, token: 'tok', status: 'open' };
  const { sb, calls } = makeFakeSupabase({
    tables: {
      request_windows: (filters: Filter[]) => {
        if (filters.some(f => f.method === 'insert' || f.method === 'update')) {
          return { data: inserted, error: null };
        }
        return { data: opts.existingOpen ? { id: 'win-0' } : null, error: null };
      },
    },
  });
  holder.sb = sb;
  return { calls };
}

beforeEach(() => { holder.sb = null; });

describe('POST /api/scheduling/request-windows', () => {
  it('creates a window with a server-generated token and status open', async () => {
    const { calls } = setup();
    const res = await POST(fakeReq(VALID_BODY));
    expect(res.status).toBe(200);
    const inserts = callsFor(calls, 'request_windows', 'insert');
    expect(inserts).toHaveLength(1);
    const row = inserts[0].args[0] as Record<string, unknown>;
    expect(row.site_id).toBe('site-1');
    expect(row.block_start).toBe('2026-09-07');
    expect(row.block_end).toBe('2026-11-22');
    expect(row.max_no_call_requests).toBe(3);
    expect(row.status).toBe('open');
    // Crypto-random token, generated server-side — never from the body.
    expect(typeof row.token).toBe('string');
    expect((row.token as string).length).toBeGreaterThanOrEqual(20);
  });

  it('ignores a client-supplied token', async () => {
    const { calls } = setup();
    await POST(fakeReq({ ...VALID_BODY, token: 'attacker-chosen' }));
    const row = callsFor(calls, 'request_windows', 'insert')[0].args[0] as Record<string, unknown>;
    expect(row.token).not.toBe('attacker-chosen');
  });

  it('defaults max_no_call_requests to 3', async () => {
    const { calls } = setup();
    const { max_no_call_requests: _omit, ...body } = VALID_BODY;
    await POST(fakeReq(body));
    const row = callsFor(calls, 'request_windows', 'insert')[0].args[0] as Record<string, unknown>;
    expect(row.max_no_call_requests).toBe(3);
  });

  // ── admin-set call-request cap (2026-07-22) ───────────────────────────────
  it('passes max_call_requests through when the admin enables call requests', async () => {
    const { calls } = setup();
    await POST(fakeReq({ ...VALID_BODY, max_call_requests: 2 }));
    const row = callsFor(calls, 'request_windows', 'insert')[0].args[0] as Record<string, unknown>;
    expect(row.max_call_requests).toBe(2);
  });

  it('defaults max_call_requests to null (call requests OFF)', async () => {
    const { calls } = setup();
    await POST(fakeReq(VALID_BODY));
    const row = callsFor(calls, 'request_windows', 'insert')[0].args[0] as Record<string, unknown>;
    expect(row.max_call_requests).toBeNull();
  });

  it('400s on max_call_requests below 1 (0 is not a valid cap — omit to disable)', async () => {
    const { calls } = setup();
    const res = await POST(fakeReq({ ...VALID_BODY, max_call_requests: 0 }));
    expect(res.status).toBe(400);
    expect(callsFor(calls, 'request_windows', 'insert')).toHaveLength(0);
  });

  it('pre-patch36 DB: retries the insert without max_call_requests when it was not set', async () => {
    // Missing-column error on the first insert; the retry (without the
    // column) succeeds — an unset cap loses nothing on a pre-patch36 DB.
    const inserted = { id: 'win-1', ...VALID_BODY, token: 'tok', status: 'open' };
    const { sb, calls } = makeFakeSupabase({
      tables: {
        request_windows: (filters: Filter[]) => {
          const ins = filters.find(f => f.method === 'insert');
          if (!ins) return { data: null, error: null }; // no existing open window
          const row = ins.args[0] as Record<string, unknown>;
          if ('max_call_requests' in row) {
            return { data: null, error: { code: '42703', message: 'column request_windows.max_call_requests does not exist' } };
          }
          return { data: inserted, error: null };
        },
      },
    });
    holder.sb = sb;
    const res = await POST(fakeReq(VALID_BODY));
    expect(res.status).toBe(200);
    expect(callsFor(calls, 'request_windows', 'insert')).toHaveLength(2);
  });

  it('pre-patch36 DB: surfaces the error when the admin actually SET a call cap', async () => {
    // Never silently drop a cap the admin chose — apply patch36 first.
    const { sb } = makeFakeSupabase({
      tables: {
        request_windows: (filters: Filter[]) =>
          filters.some(f => f.method === 'insert')
            ? { data: null, error: { code: '42703', message: 'column request_windows.max_call_requests does not exist' } }
            : { data: null, error: null },
      },
    });
    holder.sb = sb;
    const res = await POST(fakeReq({ ...VALID_BODY, max_call_requests: 2 }));
    expect(res.status).toBe(500);
  });

  it('409s when the site already has an open window (no insert)', async () => {
    const { calls } = setup({ existingOpen: true });
    const res = await POST(fakeReq(VALID_BODY));
    expect(res.status).toBe(409);
    expect(callsFor(calls, 'request_windows', 'insert')).toHaveLength(0);
  });

  it('400s on an invalid date and does not touch the DB', async () => {
    const { calls } = setup();
    const res = await POST(fakeReq({ ...VALID_BODY, block_start: 'not-a-date' }));
    expect(res.status).toBe(400);
    expect(callsFor(calls, 'request_windows', 'insert')).toHaveLength(0);
  });

  it('400s when block_end precedes block_start', async () => {
    setup();
    const res = await POST(fakeReq({ ...VALID_BODY, block_start: '2026-11-22', block_end: '2026-09-07' }));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/scheduling/request-windows', () => {
  it('filters by site_id and status', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: { request_windows: { data: [], error: null } },
    });
    holder.sb = sb;
    const res = await GET(fakeReq(null, 'http://x/api/scheduling/request-windows?site_id=site-1&status=open'));
    expect(res.status).toBe(200);
    const eqs = callsFor(calls, 'request_windows', 'eq').map(c => c.args);
    expect(eqs).toContainEqual(['site_id', 'site-1']);
    expect(eqs).toContainEqual(['status', 'open']);
  });
});

describe('PATCH /api/scheduling/request-windows/[id]', () => {
  const params = { params: Promise.resolve({ id: 'win-1' }) };

  it('closes a window (status + closed_at)', async () => {
    const { calls } = setup();
    const res = await PATCH(fakeReq({ status: 'closed' }), params);
    expect(res.status).toBe(200);
    const updates = callsFor(calls, 'request_windows', 'update');
    expect(updates).toHaveLength(1);
    const payload = updates[0].args[0] as Record<string, unknown>;
    expect(payload.status).toBe('closed');
    expect(typeof payload.closed_at).toBe('string');
  });

  it('rejects any status other than closed', async () => {
    const { calls } = setup();
    const res = await PATCH(fakeReq({ status: 'open' }), params);
    expect(res.status).toBe(400);
    expect(callsFor(calls, 'request_windows', 'update')).toHaveLength(0);
  });
});
