import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeFakeSupabase, callsFor, type Filter } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

// ── Mocks ────────────────────────────────────────────────────────────────────
// The route's post-publish revalidation seam is publishRevalidation (which runs
// loadSiteValidationContext + batchValidateVersion). Mock it so the route test
// isolates the route's own responsibilities: B1 published_version_number parity,
// invoking revalidation with the right (site, version), and threading the
// counts / validation-unavailable payload NON-BLOCKINGLY.
const holder = vi.hoisted(() => ({
  sb: null as unknown,
  revalidate: null as ReturnType<typeof vi.fn> | null,
}));
vi.mock('@/lib/supabaseScheduling', () => ({ sbSchedulingServer: () => holder.sb }));
vi.mock('@/lib/rulesEngine/commit', () => ({
  publishRevalidation: (...args: unknown[]) => holder.revalidate!(...args),
}));

import { PATCH } from './route';

function setup(over: Record<string, unknown> = {}) {
  const { sb, calls } = makeFakeSupabase({
    tables: {
      schedules: { data: { id: 'sched-1', site_id: 'site-1', status: 'published' }, error: null },
      schedule_versions: { data: { id: 'ver-9', version_number: 4 }, error: null },
      ...over,
    },
  });
  holder.sb = sb;
  holder.revalidate = vi.fn(async () => ({ hardCount: 2, softCount: 1, errors: [] as string[] }));
  return { sb, calls };
}

async function patch(body: Record<string, unknown>) {
  const req = { json: async () => body } as unknown as NextRequest;
  const res = await PATCH(req, { params: Promise.resolve({ id: 'sched-1' }) });
  return { res, json: await res.json() };
}

beforeEach(() => { setup(); });

describe('PATCH /api/scheduling/schedules/:id — publish flow', () => {
  it('sets published_version_number to the latest version number (B1 parity)', async () => {
    const { calls } = setup();
    await patch({ status: 'published' });
    const schedUpdates = callsFor(calls, 'schedules', 'update');
    // First update is the body itself; the B1 update carries published_version_number.
    expect(schedUpdates.some(c => (c.args[0] as { published_version_number?: number })?.published_version_number === 4)).toBe(true);
  });

  it('invokes revalidation with the site + newly published version, returns the counts', async () => {
    const { res, json } = await patch({ status: 'published' });
    expect(res.status).toBe(200);
    expect(holder.revalidate).toHaveBeenCalledWith(holder.sb, 'site-1', 'ver-9');
    expect(json.publishValidation).toEqual({ hardCount: 2, softCount: 1, errors: [] });
  });

  it('a validation FAILURE does not fail the publish — payload marks it unavailable', async () => {
    setup();
    holder.revalidate!.mockResolvedValueOnce({ hardCount: 0, softCount: 0, errors: ['validation-unavailable — site context load failed'] });
    const { res, json } = await patch({ status: 'published' });
    expect(res.status).toBe(200); // publish succeeded
    expect(json.publishValidation.errors.length).toBeGreaterThan(0);
  });

  it('a THROWN revalidation still succeeds and reports unavailable (never fake-clean)', async () => {
    setup();
    holder.revalidate!.mockRejectedValueOnce(new Error('boom'));
    const { res, json } = await patch({ status: 'published' });
    expect(res.status).toBe(200);
    expect(json.publishValidation.errors[0]).toMatch(/validation-unavailable/);
  });

  it('a non-publish PATCH does not revalidate and returns the plain row', async () => {
    const { json } = await patch({ notes: 'edit' });
    expect(holder.revalidate).not.toHaveBeenCalled();
    expect(json.publishValidation).toBeUndefined();
  });
});

// ── C1: superseded published siblings are demoted on publish ─────────────────
// "Committed = published" makes published-ness load-bearing: a schedule with
// TWO published versions counts phantom bookings in every other schedule's
// conflict scans and double-counts call history. The fake emulates the demote
// UPDATE's filters against a mini version table so the semantics are pinned as
// behavior (only published siblings; never the target; drafts untouched), not
// just query shape.

type VersionRow = { id: string; schedule_id: string; version_status: string };

function demoteAware(rows: VersionRow[], latest: { id: string; version_number: number }) {
  const demoted: string[] = [];
  const cfg = (filters: Filter[]) => {
    const upd = filters.find(f => f.method === 'update');
    if (upd && (upd.args[0] as { version_status?: string }).version_status === 'archived') {
      demoted.push(...rows.filter(r => filters.every(f => {
        const [col, val] = f.args as [string, unknown];
        if (f.method === 'eq') return (r as Record<string, unknown>)[col] === val;
        if (f.method === 'neq') return (r as Record<string, unknown>)[col] !== val;
        return true;
      })).map(r => r.id));
      return { data: null, error: null };
    }
    if (upd) return { data: null, error: null }; // the publish flip
    return { data: latest, error: null };        // the latest-version select
  };
  return { cfg, demoted };
}

// ── provider_limits hardening (2026-07-22, patch34) ──────────────────────────
// The PATCH is otherwise a passthrough update; the provider_limits key gets
// route-hardened parsing (shape-validate; integers >= 0 only; strip unknown
// keys; reject NaN) via the shared parseProviderLimits. Malformed shapes are
// rejected 400 BEFORE any DB write; valid ones are written NORMALIZED.
describe('PATCH /api/scheduling/schedules/:id — provider_limits hardening', () => {
  const updateArgs = (calls: ReturnType<typeof setup>['calls']) =>
    callsFor(calls, 'schedules', 'update').map(c => c.args[0] as Record<string, unknown>);

  it('rejects a non-object provider_limits with 400 and writes nothing', async () => {
    const { calls } = setup();
    const { res, json } = await patch({ provider_limits: 'bad' });
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/provider_limits/);
    expect(updateArgs(calls)).toHaveLength(0);
  });

  it('rejects NaN / negative / fractional counts', async () => {
    for (const bad of [
      { p1: { calls: { C1: NaN } } },
      { p1: { calls: { C1: -1 } } },
      { p1: { workingDays: 2.5 } },
    ]) {
      setup();
      const { res } = await patch({ provider_limits: bad });
      expect(res.status).toBe(400);
    }
  });

  it('rejects workingDays together with daysOff (mutually exclusive)', async () => {
    setup();
    const { res, json } = await patch({ provider_limits: { p1: { workingDays: 10, daysOff: 2 } } });
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/mutually exclusive/);
  });

  it('writes a valid shape NORMALIZED (unknown keys stripped, empty entries dropped)', async () => {
    const { calls } = setup();
    const { res } = await patch({
      provider_limits: { p1: { calls: { C1: 2 }, sneaky: true }, p2: {} },
      notes: 'other fields pass through',
    });
    expect(res.status).toBe(200);
    const written = updateArgs(calls);
    expect(written).toHaveLength(1);
    expect(written[0].provider_limits).toEqual({ p1: { calls: { C1: 2 } } });
    expect(written[0].notes).toBe('other fields pass through');
  });

  it('null clears the limits (and an all-blank map normalizes to null)', async () => {
    const { calls } = setup();
    await patch({ provider_limits: null });
    expect(updateArgs(calls)[0].provider_limits).toBeNull();

    const { calls: calls2 } = setup();
    await patch({ provider_limits: { p1: {} } });
    expect(updateArgs(calls2)[0].provider_limits).toBeNull();
  });

  it('a PATCH without the key is untouched (no provider_limits in the update)', async () => {
    const { calls } = setup();
    await patch({ notes: 'edit' });
    expect('provider_limits' in updateArgs(calls)[0]).toBe(false);
  });
});

// ── schedule_name rename (Gabriel 2026-07-22) ────────────────────────────────
// Inline rename from the schedule detail header PATCHes schedule_name through
// this route. Same route-hardening style as provider_limits: the key is
// validated BEFORE any write (trimmed, non-empty, ≤ 120 chars); everywhere
// schedule_name is read (dashboard, pickers, banners) sees the new value
// because they read the column.
describe('PATCH /api/scheduling/schedules/:id — schedule_name rename', () => {
  const updateArgs = (calls: ReturnType<typeof setup>['calls']) =>
    callsFor(calls, 'schedules', 'update').map(c => c.args[0] as Record<string, unknown>);

  it('accepts a rename and writes it TRIMMED', async () => {
    const { calls } = setup();
    const { res } = await patch({ schedule_name: '  September Draft — final  ' });
    expect(res.status).toBe(200);
    const written = updateArgs(calls);
    expect(written).toHaveLength(1);
    expect(written[0].schedule_name).toBe('September Draft — final');
  });

  it('rejects empty and whitespace-only names with 400 and writes nothing', async () => {
    for (const bad of ['', '   ', null]) {
      const { calls } = setup();
      const { res, json } = await patch({ schedule_name: bad });
      expect(res.status).toBe(400);
      expect(json.error).toMatch(/schedule_name/);
      expect(updateArgs(calls)).toHaveLength(0);
    }
  });

  it('rejects over-long and non-string names with 400', async () => {
    for (const bad of ['x'.repeat(121), 42]) {
      setup();
      const { res } = await patch({ schedule_name: bad });
      expect(res.status).toBe(400);
    }
  });

  it('other fields ride along with a valid rename', async () => {
    const { calls } = setup();
    const { res } = await patch({ schedule_name: 'New Name', notes: 'kept' });
    expect(res.status).toBe(200);
    const written = updateArgs(calls)[0];
    expect(written.schedule_name).toBe('New Name');
    expect(written.notes).toBe('kept');
  });
});

describe('PATCH /api/scheduling/schedules/:id — superseded published siblings (C1)', () => {
  it('publishing archives the published sibling ONLY — drafts and the target untouched; revalidation still runs', async () => {
    const { cfg, demoted } = demoteAware([
      { id: 'ver-9', schedule_id: 'sched-1', version_status: 'draft' },     // the target (latest)
      { id: 'ver-8', schedule_id: 'sched-1', version_status: 'published' }, // superseded → archived
      { id: 'ver-7', schedule_id: 'sched-1', version_status: 'draft' },     // draft → untouched
    ], { id: 'ver-9', version_number: 4 });
    setup({ schedule_versions: cfg });
    const { res } = await patch({ status: 'published' });
    expect(res.status).toBe(200);
    expect(demoted).toEqual(['ver-8']);
    expect(holder.revalidate).toHaveBeenCalledWith(holder.sb, 'site-1', 'ver-9');
  });

  it('re-publishing the already-published latest version archives NOTHING (.neq self-guard)', async () => {
    const { cfg, demoted } = demoteAware([
      { id: 'ver-9', schedule_id: 'sched-1', version_status: 'published' }, // the target, already published
      { id: 'ver-7', schedule_id: 'sched-1', version_status: 'draft' },
    ], { id: 'ver-9', version_number: 4 });
    setup({ schedule_versions: cfg });
    const { res } = await patch({ status: 'published' });
    expect(res.status).toBe(200);
    expect(demoted).toEqual([]);
    expect(holder.revalidate).toHaveBeenCalled();
  });

  it('a failed demotion fails the publish loudly — phantom committed bookings must not persist silently', async () => {
    setup({
      schedule_versions: (filters: Filter[]) => {
        const upd = filters.find(f => f.method === 'update');
        if (upd && (upd.args[0] as { version_status?: string }).version_status === 'archived') {
          return { data: null, error: { message: 'demote blocked' } };
        }
        return { data: { id: 'ver-9', version_number: 4 }, error: null };
      },
    });
    const { res, json } = await patch({ status: 'published' });
    expect(res.status).toBe(500);
    expect(json.error).toBe('demote blocked');
  });
});
