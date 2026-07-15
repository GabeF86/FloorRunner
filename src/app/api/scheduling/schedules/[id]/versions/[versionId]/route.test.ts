import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeFakeSupabase, callsFor, type Filter } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

// publishRevalidation (loadSiteValidationContext + batchValidateVersion) is the
// seam; mock it to isolate the route's own duties: published_version_number
// parity on the parent schedule, and a NON-BLOCKING revalidation payload.
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
      schedule_versions: { data: { id: 'ver-9', version_number: 4, version_status: 'published' }, error: null },
      schedules: { data: { site_id: 'site-1' }, error: null },
      ...over,
    },
  });
  holder.sb = sb;
  holder.revalidate = vi.fn(async () => ({ hardCount: 0, softCount: 3, errors: [] as string[] }));
  return { sb, calls };
}

async function patch(body: Record<string, unknown>) {
  const req = { json: async () => body } as unknown as NextRequest;
  const res = await PATCH(req, { params: Promise.resolve({ id: 'sched-1', versionId: 'ver-9' }) });
  return { res, json: await res.json() };
}

beforeEach(() => { setup(); });

describe('PATCH /api/scheduling/schedules/:id/versions/:versionId — publish flow', () => {
  it('sets published_version_number on the parent schedule (existing B1 parity)', async () => {
    const { calls } = setup();
    await patch({ version_status: 'published' });
    const schedUpdates = callsFor(calls, 'schedules', 'update');
    expect(schedUpdates.some(c => (c.args[0] as { published_version_number?: number })?.published_version_number === 4)).toBe(true);
  });

  it('invokes revalidation with the site + this version, returns the counts', async () => {
    const { res, json } = await patch({ version_status: 'published' });
    expect(res.status).toBe(200);
    expect(holder.revalidate).toHaveBeenCalledWith(holder.sb, 'site-1', 'ver-9');
    expect(json.publishValidation).toEqual({ hardCount: 0, softCount: 3, errors: [] });
  });

  it('a validation FAILURE does not fail the publish — payload marks it unavailable', async () => {
    setup();
    holder.revalidate!.mockResolvedValueOnce({ hardCount: 0, softCount: 0, errors: ['validation-unavailable — slot load failed'] });
    const { res, json } = await patch({ version_status: 'published' });
    expect(res.status).toBe(200);
    expect(json.publishValidation.errors.length).toBeGreaterThan(0);
  });

  it('a missing schedule site_id reports unavailable rather than fake-clean', async () => {
    setup({ schedules: { data: {}, error: null } });
    const { res, json } = await patch({ version_status: 'published' });
    expect(res.status).toBe(200);
    expect(holder.revalidate).not.toHaveBeenCalled();
    expect(json.publishValidation.errors[0]).toMatch(/site_id missing/);
  });

  it('a non-publish status change does not revalidate', async () => {
    const { json } = await patch({ version_status: 'review' });
    expect(holder.revalidate).not.toHaveBeenCalled();
    expect(json.publishValidation).toBeUndefined();
  });
});

// ── C1: superseded published siblings are demoted on publish ─────────────────
// Same behavior pin as the schedules-route test: the fake emulates the demote
// UPDATE's filters against a mini version table (only published siblings; never
// the target version; drafts untouched). The final publish flip and the
// version_number select fall through to the canned target row.

type VersionRow = { id: string; schedule_id: string; version_status: string };

function demoteAware(rows: VersionRow[]) {
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
    return { data: { id: 'ver-9', version_number: 4, version_status: 'published' }, error: null };
  };
  return { cfg, demoted };
}

describe('PATCH /api/scheduling/schedules/:id/versions/:versionId — superseded published siblings (C1)', () => {
  it('publishing archives the published sibling ONLY — drafts and the target untouched; revalidation still runs', async () => {
    const { cfg, demoted } = demoteAware([
      { id: 'ver-9', schedule_id: 'sched-1', version_status: 'draft' },     // the target
      { id: 'ver-8', schedule_id: 'sched-1', version_status: 'published' }, // superseded → archived
      { id: 'ver-7', schedule_id: 'sched-1', version_status: 'draft' },     // draft → untouched
    ]);
    setup({ schedule_versions: cfg });
    const { res } = await patch({ version_status: 'published' });
    expect(res.status).toBe(200);
    expect(demoted).toEqual(['ver-8']);
    expect(holder.revalidate).toHaveBeenCalledWith(holder.sb, 'site-1', 'ver-9');
  });

  it('re-publishing the same version archives NOTHING (.neq self-guard)', async () => {
    const { cfg, demoted } = demoteAware([
      { id: 'ver-9', schedule_id: 'sched-1', version_status: 'published' }, // the target, already published
      { id: 'ver-7', schedule_id: 'sched-1', version_status: 'draft' },
    ]);
    setup({ schedule_versions: cfg });
    const { res } = await patch({ version_status: 'published' });
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
        return { data: { id: 'ver-9', version_number: 4, version_status: 'published' }, error: null };
      },
    });
    const { res, json } = await patch({ version_status: 'published' });
    expect(res.status).toBe(500);
    expect(json.error).toBe('demote blocked');
    expect(holder.revalidate).not.toHaveBeenCalled();
  });
});
