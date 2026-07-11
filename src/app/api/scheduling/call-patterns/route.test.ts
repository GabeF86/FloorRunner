// GET/PUT /api/scheduling/call-patterns (Task 13).
// PUT replaces the site's active pattern: archive current active → insert new
// active. The call_patterns_one_active partial unique index can race a
// concurrent writer, so a 23505 on insert re-archives and retries exactly once.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeFakeSupabase, callsFor, type Filter } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';
import { CLASSIC_PATTERN } from '@/lib/rulesEngine/callPattern';

const holder = vi.hoisted(() => ({ sb: null as unknown }));
vi.mock('@/lib/supabaseScheduling', () => ({
  sbSchedulingServer: () => holder.sb,
}));

import { GET, PUT } from './route';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function fakeReq(body: unknown, url = 'http://test/api/scheduling/call-patterns'): NextRequest {
  return { url, json: async () => body } as unknown as NextRequest;
}

function getReq(query = ''): NextRequest {
  return {
    url: `http://test/api/scheduling/call-patterns${query}`,
    json: async () => ({}),
  } as unknown as NextRequest;
}

const ACTIVE_ROW = {
  id: 'cp-1', site_id: 'site-1', name: 'Classic', status: 'active',
  source: 'seed', definition: CLASSIC_PATTERN,
};
const INSERTED_ROW = {
  id: 'cp-2', site_id: 'site-1', name: 'Custom pattern', status: 'active',
  source: 'manual', definition: CLASSIC_PATTERN,
};

function hasEq(filters: Filter[], col: string, val: unknown): boolean {
  return filters.some(f => f.method === 'eq' && f.args[0] === col && f.args[1] === val);
}

beforeEach(() => { holder.sb = null; });

// ── PUT ──────────────────────────────────────────────────────────────────────

describe('PUT /api/scheduling/call-patterns', () => {
  it('rejects an invalid CallPatternDoc with 400 and a zod issue path', async () => {
    const { sb } = makeFakeSupabase();
    holder.sb = sb;
    const bad = { ...CLASSIC_PATTERN, version: 2 };
    const res = await PUT(fakeReq({ site_id: 'site-1', definition: bad }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(typeof json.error).toBe('string');
    expect(json.issues.map((i: { path: string }) => i.path)).toContain('definition.version');
  });

  it('rejects unknown top-level keys with 400', async () => {
    const { sb } = makeFakeSupabase();
    holder.sb = sb;
    const res = await PUT(fakeReq({ site_id: 'site-1', definition: CLASSIC_PATTERN, hax: 1 }));
    expect(res.status).toBe(400);
  });

  it('rejects a missing site_id with 400', async () => {
    const { sb } = makeFakeSupabase();
    holder.sb = sb;
    const res = await PUT(fakeReq({ definition: CLASSIC_PATTERN }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.issues.map((i: { path: string }) => i.path)).toContain('site_id');
  });

  it('rejects malformed JSON with 400', async () => {
    const { sb } = makeFakeSupabase();
    holder.sb = sb;
    const req = {
      url: 'http://test/api/scheduling/call-patterns',
      json: async () => { throw new SyntaxError('bad json'); },
    } as unknown as NextRequest;
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it('archives the prior active, inserts the new active, and returns it', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        call_patterns: (filters) => {
          if (filters.some(f => f.method === 'insert')) return { data: INSERTED_ROW, error: null };
          return { data: null, error: null }; // archive update
        },
      },
    });
    holder.sb = sb;

    const res = await PUT(fakeReq({
      site_id: 'site-1', definition: CLASSIC_PATTERN, name: 'Custom pattern', source: 'manual',
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe('cp-2');
    expect(json.status).toBe('active');

    // Archive step: update {status:'archived'} scoped to site + currently active.
    const updates = callsFor(calls, 'call_patterns', 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].args[0]).toEqual({ status: 'archived' });
    const eqs = calls.filter(c => c.table === 'call_patterns' && c.method === 'eq');
    expect(hasEq(eqs as unknown as Filter[], 'site_id', 'site-1')).toBe(true);
    expect(hasEq(eqs as unknown as Filter[], 'status', 'active')).toBe(true);

    // Insert step: new active row with the validated doc.
    const inserts = callsFor(calls, 'call_patterns', 'insert');
    expect(inserts).toHaveLength(1);
    const row = inserts[0].args[0] as Record<string, unknown>;
    expect(row.site_id).toBe('site-1');
    expect(row.status).toBe('active');
    expect(row.source).toBe('manual');
    expect(row.name).toBe('Custom pattern');
    expect(row.definition).toEqual(CLASSIC_PATTERN);
  });

  it('defaults name and source when omitted', async () => {
    const { sb, calls } = makeFakeSupabase({
      tables: {
        call_patterns: (filters) => {
          if (filters.some(f => f.method === 'insert')) return { data: INSERTED_ROW, error: null };
          return { data: null, error: null };
        },
      },
    });
    holder.sb = sb;

    const res = await PUT(fakeReq({ site_id: 'site-1', definition: CLASSIC_PATTERN }));
    expect(res.status).toBe(200);
    const row = callsFor(calls, 'call_patterns', 'insert')[0].args[0] as Record<string, unknown>;
    expect(row.source).toBe('manual');
    expect(typeof row.name).toBe('string');
    expect((row.name as string).length).toBeGreaterThan(0);
  });

  it('retries once after a unique violation (23505) by re-archiving and re-inserting', async () => {
    let insertAttempts = 0;
    const { sb, calls } = makeFakeSupabase({
      tables: {
        call_patterns: (filters) => {
          if (filters.some(f => f.method === 'insert')) {
            insertAttempts++;
            if (insertAttempts === 1) {
              return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "call_patterns_one_active"' } };
            }
            return { data: INSERTED_ROW, error: null };
          }
          return { data: null, error: null };
        },
      },
    });
    holder.sb = sb;

    const res = await PUT(fakeReq({ site_id: 'site-1', definition: CLASSIC_PATTERN }));
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('cp-2');
    expect(callsFor(calls, 'call_patterns', 'insert')).toHaveLength(2);
    expect(callsFor(calls, 'call_patterns', 'update')).toHaveLength(2); // archive ran again before retry
  });

  it('returns 500 when the retry also hits a unique violation', async () => {
    const { sb } = makeFakeSupabase({
      tables: {
        call_patterns: (filters) => {
          if (filters.some(f => f.method === 'insert')) {
            return { data: null, error: { code: '23505', message: 'duplicate key' } };
          }
          return { data: null, error: null };
        },
      },
    });
    holder.sb = sb;

    const res = await PUT(fakeReq({ site_id: 'site-1', definition: CLASSIC_PATTERN }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBeTruthy();
  });
});

// ── GET ──────────────────────────────────────────────────────────────────────

describe('GET /api/scheduling/call-patterns', () => {
  it('requires site_id', async () => {
    const { sb } = makeFakeSupabase();
    holder.sb = sb;
    const res = await GET(getReq());
    expect(res.status).toBe(400);
  });

  it('returns {active, history} for the site', async () => {
    const archived = [
      { ...ACTIVE_ROW, id: 'cp-0', status: 'archived' },
    ];
    const { sb, calls } = makeFakeSupabase({
      tables: {
        call_patterns: (filters) => {
          if (hasEq(filters, 'status', 'active')) return { data: ACTIVE_ROW, error: null };
          return { data: archived, error: null };
        },
      },
    });
    holder.sb = sb;

    const res = await GET(getReq('?site_id=site-1'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.active.id).toBe('cp-1');
    expect(json.history).toHaveLength(1);
    expect(json.history[0].id).toBe('cp-0');

    // History query is archived-only, newest first, bounded.
    const eqs = calls.filter(c => c.table === 'call_patterns' && c.method === 'eq');
    expect(hasEq(eqs as unknown as Filter[], 'status', 'archived')).toBe(true);
    const limits = calls.filter(c => c.table === 'call_patterns' && c.method === 'limit');
    expect(limits).toHaveLength(1);
    expect(limits[0].args[0]).toBe(10);
  });

  it('returns active: null when the site has no active pattern', async () => {
    const { sb } = makeFakeSupabase({
      tables: {
        call_patterns: (filters) => {
          if (hasEq(filters, 'status', 'active')) return { data: null, error: null };
          return { data: [], error: null };
        },
      },
    });
    holder.sb = sb;

    const res = await GET(getReq('?site_id=site-1'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.active).toBeNull();
    expect(json.history).toEqual([]);
  });
});
