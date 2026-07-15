import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeFakeSupabase, callsFor } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

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
