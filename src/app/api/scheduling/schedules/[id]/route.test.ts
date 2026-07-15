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
