import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { Assignment } from '@/types';

// BoardClient imports the shared browser supabase client, which constructs
// itself at module load. Give it credentials BEFORE the dynamic import below;
// nothing here talks to a network.
process.env.NEXT_PUBLIC_SUPABASE_URL      ??= 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';

type Mod = typeof import('./BoardClient');
let mod: Mod;

beforeAll(async () => { mod = await import('./BoardClient'); });

afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(impl: () => unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => impl() as Response));
}

describe('readDailyList', () => {
  it('returns the rows on a normal array response', async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => [{ staff_id: 'a' }] }));
    const r = await mod.readDailyList<{ staff_id: string }>('/api/breaks?date=2026-09-15', 'breaks');
    expect(r.error).toBeNull();
    expect(r.rows).toEqual([{ staff_id: 'a' }]);
  });

  it('never reports an empty list when the request fails — rows stay null', async () => {
    stubFetch(() => ({ ok: false, status: 500, text: async () => 'boom' }));
    const r = await mod.readDailyList('/api/assignments?date=2026-09-15', 'assignments');
    expect(r.rows).toBeNull();
    expect(r.error).toContain('assignments');
    expect(r.error).toContain('500');
  });

  it('treats an {error} body as a failure rather than data', async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ error: 'permission denied' }) }));
    const r = await mod.readDailyList('/api/relief?date=2026-09-15', 'relief log');
    expect(r.rows).toBeNull();
    expect(r.error).toContain('permission denied');
  });

  it('resolves (never rejects) when the network throws, so sibling reads still land', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const r = await mod.readDailyList('/api/designations?date=2026-09-15', 'designations');
    expect(r.rows).toBeNull();
    expect(r.error).toContain('offline');
  });

  it('one failing read does not abort the others in a Promise.all', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error('offline');
      return { ok: true, status: 200, json: async () => [{ staff_id: 's' + n }] } as unknown as Response;
    }));
    const [a, b] = await Promise.all([
      mod.readDailyList('/api/a', 'a'),
      mod.readDailyList('/api/b', 'b'),
    ]);
    expect(a.rows).toBeNull();
    expect(b.rows).toEqual([{ staff_id: 's2' }]);
  });
});

describe('withServerAssignment', () => {
  const row = (id: string, room: string, staff: string): Assignment =>
    ({ id, room_id: room, staff_id: staff, board_date: '2026-09-15' });

  it('replaces the optimistic row with the server row, real id and all', () => {
    const prev = [row('real-1', 'r1', 'p1'), row('opt-9-1', 'r2', 'p2')];
    const next = mod.withServerAssignment(prev, 'opt-9-1', row('db-7', 'r2', 'p2'));
    expect(next.map((a) => a.id)).toEqual(['real-1', 'db-7']);
    expect(next.some((a) => a.id.startsWith('opt-'))).toBe(false);
  });

  it('leaves other optimistic rows alone', () => {
    const prev = [row('opt-9-1', 'r1', 'p1'), row('opt-9-2', 'r2', 'p2')];
    const next = mod.withServerAssignment(prev, 'opt-9-2', row('db-7', 'r2', 'p2'));
    expect(next.map((a) => a.id)).toEqual(['opt-9-1', 'db-7']);
  });

  it('collapses a duplicate row for the same room+person (upsert re-confirm)', () => {
    const prev = [row('db-7', 'r2', 'p2')];
    const next = mod.withServerAssignment(prev, 'opt-never-added', row('db-7', 'r2', 'p2'));
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('db-7');
  });
});

describe('optimisticId', () => {
  it('keeps the opt- prefix useBoardRealtime keys off', () => {
    expect(mod.optimisticId().startsWith('opt-')).toBe(true);
  });

  it('is unique within the same millisecond', () => {
    const ids = new Set(Array.from({ length: 50 }, () => mod.optimisticId()));
    expect(ids.size).toBe(50);
  });
});
