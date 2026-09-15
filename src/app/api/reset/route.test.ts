// POST /api/reset — the reset is HOSPITAL-scoped.
// The delete used to be filtered by date alone, so resetting one hospital's
// board cleared every hospital's assignments for that day. These tests pin the
// scope (and the refusal when there is no scope to reset within).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeFakeSupabase, callsFor, type RecordedCall, type Filter } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

const holder = vi.hoisted(() => ({ sb: null as unknown }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => holder.sb,
}));

import { POST } from './route';

const HOSPITAL = 'Paoli Hospital';

const BODY = {
  hospital: HOSPITAL,
  date: '2026-09-15',
  siteIdsToDelete: ['site-a', 'site-b'],
  baseline: [{ name: 'Main OR', color: '#111', icon: '◈', rooms: ['OR 1', 'OR 2'] }],
};

function fakeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function has(filters: Filter[], method: string) {
  return filters.some(f => f.method === method);
}

interface SetupOpts {
  sitesReadError?: { message: string };
  siteInsertError?: { message: string };
  roomsReadRows?: { id: string }[];
}

function setup(opts: SetupOpts = {}) {
  const roomRows = opts.roomsReadRows ?? [{ id: 'room-1' }, { id: 'room-2' }];
  const { sb, calls } = makeFakeSupabase({
    tables: {
      sites: (filters) => {
        if (has(filters, 'insert')) {
          return opts.siteInsertError
            ? { data: null, error: opts.siteInsertError }
            : { data: { id: 'new-site', name: 'Main OR', hospital: HOSPITAL }, error: null };
        }
        if (has(filters, 'delete')) return { data: null, error: null };
        if (opts.sitesReadError) return { data: null, error: opts.sitesReadError, count: null };
        return { data: [{ id: 'site-a' }, { id: 'site-b' }], error: null };
      },
      rooms: (filters) => has(filters, 'insert')
        ? { data: [{ id: 'new-room' }], error: null }
        : { data: roomRows, error: null },
      assignments: { data: null, error: null },
    },
  });
  holder.sb = sb;
  return { calls };
}

function forTable(calls: RecordedCall[], table: string) {
  return calls.filter(c => c.table === table);
}

beforeEach(() => { holder.sb = null; });

describe('POST /api/reset', () => {
  it('clears assignments scoped to this hospital\'s rooms, not the whole date', async () => {
    const { calls } = setup();
    const res = await POST(fakeReq(BODY));
    expect(res.status).toBe(200);

    const assignmentCalls = forTable(calls, 'assignments');
    expect(assignmentCalls.some(c => c.method === 'delete')).toBe(true);

    const dateFilter = assignmentCalls.find(c => c.method === 'eq');
    expect(dateFilter?.args).toEqual(['board_date', '2026-09-15']);

    const roomFilter = assignmentCalls.find(c => c.method === 'in');
    expect(roomFilter?.args).toEqual(['room_id', ['room-1', 'room-2']]);
  });

  it('scopes the room lookup to the sites of the requested hospital', async () => {
    const { calls } = setup();
    await POST(fakeReq(BODY));

    const siteReadEq = forTable(calls, 'sites').find(c => c.method === 'eq');
    expect(siteReadEq?.args).toEqual(['hospital', HOSPITAL]);

    const roomReadIn = forTable(calls, 'rooms').find(c => c.method === 'in');
    expect(roomReadIn?.args).toEqual(['site_id', ['site-a', 'site-b']]);
  });

  it('guards the site delete with the hospital as well as the id list', async () => {
    const { calls } = setup();
    await POST(fakeReq(BODY));

    const siteCalls = forTable(calls, 'sites');
    const deleteIdx = siteCalls.findIndex(c => c.method === 'delete');
    expect(deleteIdx).toBeGreaterThan(-1);
    const afterDelete = siteCalls.slice(deleteIdx);
    expect(afterDelete.find(c => c.method === 'in')?.args).toEqual(['id', ['site-a', 'site-b']]);
    expect(afterDelete.find(c => c.method === 'eq')?.args).toEqual(['hospital', HOSPITAL]);
  });

  it('refuses a request with no hospital and touches nothing', async () => {
    const { calls } = setup();
    const res = await POST(fakeReq({ ...BODY, hospital: '' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('hospital');
    expect(calls).toHaveLength(0);
  });

  it('refuses a request with no date and touches nothing', async () => {
    const { calls } = setup();
    const res = await POST(fakeReq({ ...BODY, date: undefined }));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed body', async () => {
    const { calls } = setup();
    const res = await POST({ json: async () => { throw new Error('bad'); } } as unknown as NextRequest);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('fails loudly when the scope read fails — never deletes on a failed read', async () => {
    const { calls } = setup({ sitesReadError: { message: 'connection lost' } });
    const res = await POST(fakeReq(BODY));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('connection lost');
    expect(callsFor(calls, 'assignments', 'delete')).toHaveLength(0);
    expect(callsFor(calls, 'sites', 'delete')).toHaveLength(0);
  });

  it('reports a failed baseline site insert instead of returning a short list', async () => {
    setup({ siteInsertError: { message: 'duplicate key' } });
    const res = await POST(fakeReq(BODY));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain('Main OR');
    expect(json.error).toContain('duplicate key');
  });

  it('recreates the baseline and returns the created sites', async () => {
    const { calls } = setup();
    const res = await POST(fakeReq(BODY));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sites).toHaveLength(1);
    expect(json.sites[0].rooms).toEqual([{ id: 'new-room' }]);

    const insert = callsFor(calls, 'sites', 'insert')[0];
    expect((insert.args[0] as { hospital: string }).hospital).toBe(HOSPITAL);
  });

  it('skips the assignment delete when the hospital has no rooms', async () => {
    const { calls } = setup({ roomsReadRows: [] });
    const res = await POST(fakeReq(BODY));
    expect(res.status).toBe(200);
    expect(callsFor(calls, 'assignments', 'delete')).toHaveLength(0);
  });
});
