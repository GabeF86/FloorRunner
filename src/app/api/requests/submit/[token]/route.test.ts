// Public intake route (patch29). The token is the only gate — everything
// else is validated server-side against the window row: roster membership,
// block bounds for no-call dates, the per-provider no-call cap, and the
// row shapes for all three categories. site_id ALWAYS derives from the
// window, never from the body.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeFakeSupabase, callsFor, type Filter, type TableCfg } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

const holder = vi.hoisted(() => ({ sb: null as unknown }));
vi.mock('@/lib/supabaseScheduling', () => ({
  sbSchedulingServer: () => holder.sb,
}));

import { POST } from './route';

const WINDOW = {
  id: 'win-1',
  site_id: 'site-1',
  block_start: '2026-09-07',
  block_end: '2026-11-22',
  max_no_call_requests: 3,
  status: 'open',
};

function fakeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const params = { params: Promise.resolve({ token: 'tok-1' }) };

function setup(opts: {
  window?: Record<string, unknown> | null;
  provider?: Record<string, unknown> | null;
  profile?: Record<string, unknown> | null;
  existingNoCallDates?: string[];
} = {}) {
  const window = opts.window === undefined ? WINDOW : opts.window;
  const provider = opts.provider === undefined ? { id: 'prov-1', status: 'active' } : opts.provider;
  const profile = opts.profile === undefined ? { home_site_id: 'site-1' } : opts.profile;
  const existing = (opts.existingNoCallDates ?? []).map(d => ({ start_date: d }));

  const tables: Record<string, TableCfg> = {
    request_windows: { data: window, error: null },
    providers: { data: provider, error: null },
    provider_employment_profiles: { data: profile, error: null },
    provider_availability: (filters: Filter[]) =>
      filters.some(f => f.method === 'insert')
        ? { data: null, error: null }
        : { data: existing, error: null },
    provider_requests: { data: null, error: null },
  };
  const { sb, calls } = makeFakeSupabase({ tables });
  holder.sb = sb;
  return { calls };
}

function writeCount(calls: ReturnType<typeof setup>['calls']) {
  return callsFor(calls, 'provider_requests', 'insert').length +
    callsFor(calls, 'provider_availability', 'insert').length;
}

beforeEach(() => { holder.sb = null; });

describe('POST /api/requests/submit/[token]', () => {
  it('404s on an unknown token with no writes', async () => {
    const { calls } = setup({ window: null });
    const res = await POST(fakeReq({ provider_id: 'prov-1', no_call_dates: ['2026-09-10'] }), params);
    expect(res.status).toBe(404);
    expect(writeCount(calls)).toBe(0);
  });

  it('410s on a closed window with no writes', async () => {
    const { calls } = setup({ window: { ...WINDOW, status: 'closed' } });
    const res = await POST(fakeReq({ provider_id: 'prov-1', no_call_dates: ['2026-09-10'] }), params);
    expect(res.status).toBe(410);
    expect(writeCount(calls)).toBe(0);
  });

  it('403s when the provider is not on the window site roster', async () => {
    const { calls } = setup({ profile: { home_site_id: 'other-site' } });
    const res = await POST(fakeReq({ provider_id: 'prov-1', no_call_dates: ['2026-09-10'] }), params);
    expect(res.status).toBe(403);
    expect(writeCount(calls)).toBe(0);
  });

  it('403s when the provider is inactive', async () => {
    const { calls } = setup({ provider: { id: 'prov-1', status: 'inactive' } });
    const res = await POST(fakeReq({ provider_id: 'prov-1', no_call_dates: ['2026-09-10'] }), params);
    expect(res.status).toBe(403);
    expect(writeCount(calls)).toBe(0);
  });

  it('400s on an empty submission', async () => {
    setup();
    const res = await POST(fakeReq({ provider_id: 'prov-1' }), params);
    expect(res.status).toBe(400);
  });

  it('400s when a no-call date falls outside the block', async () => {
    const { calls } = setup();
    const res = await POST(fakeReq({ provider_id: 'prov-1', no_call_dates: ['2026-12-01'] }), params);
    expect(res.status).toBe(400);
    expect(writeCount(calls)).toBe(0);
  });

  it('enforces the per-window no-call cap against existing window-sourced rows', async () => {
    const { calls } = setup({ existingNoCallDates: ['2026-09-10', '2026-09-17'] });
    const res = await POST(
      fakeReq({ provider_id: 'prov-1', no_call_dates: ['2026-10-01', '2026-10-08'] }),
      params,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/3/); // mentions the cap
    expect(writeCount(calls)).toBe(0);
  });

  it('skips already-submitted no-call dates instead of double-counting them', async () => {
    const { calls } = setup({ existingNoCallDates: ['2026-09-10'] });
    const res = await POST(
      fakeReq({ provider_id: 'prov-1', no_call_dates: ['2026-09-10', '2026-10-01'] }),
      params,
    );
    expect(res.status).toBe(200);
    const inserts = callsFor(calls, 'provider_availability', 'insert');
    expect(inserts).toHaveLength(1);
    const rows = inserts[0].args[0] as Array<Record<string, unknown>>;
    expect(rows.map(r => r.start_date)).toEqual(['2026-10-01']);
  });

  it('writes correct row shapes for all three categories', async () => {
    const { calls } = setup();
    const res = await POST(fakeReq({
      provider_id: 'prov-1',
      site_id: 'attacker-site', // must be ignored
      pto: [{ start_date: '2026-09-14', end_date: '2026-09-18' }],
      days_off: [{ start_date: '2026-10-05', end_date: '2026-10-05' }],
      no_call_dates: ['2026-09-10', '2026-09-24'],
    }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toEqual({ pto: 1, days_off: 1, no_call: 2 });

    // PTO + Days Off → pending provider_requests feeding the approval queue.
    const reqInserts = callsFor(calls, 'provider_requests', 'insert');
    expect(reqInserts).toHaveLength(1);
    const reqRows = reqInserts[0].args[0] as Array<Record<string, unknown>>;
    expect(reqRows).toHaveLength(2);
    const ptoRow = reqRows.find(r => r.request_type === 'pto')!;
    expect(ptoRow.provider_id).toBe('prov-1');
    expect(ptoRow.site_id).toBe('site-1'); // from the window, not the body
    expect(ptoRow.start_date).toBe('2026-09-14');
    expect(ptoRow.end_date).toBe('2026-09-18');
    expect(ptoRow.status).toBe('pending');
    const dayOffRow = reqRows.find(r => r.request_type === 'availability_change')!;
    expect(dayOffRow.start_date).toBe('2026-10-05');
    expect(dayOffRow.status).toBe('pending');

    // No-call → provider_availability rows DIRECTLY (algorithm-arbitrated).
    const availInserts = callsFor(calls, 'provider_availability', 'insert');
    expect(availInserts).toHaveLength(1);
    const availRows = availInserts[0].args[0] as Array<Record<string, unknown>>;
    expect(availRows).toHaveLength(2);
    for (const row of availRows) {
      expect(row.availability_type).toBe('no_call_request');
      expect(row.approval_status).toBe('approved');
      expect(row.source).toBe('request_window');
      expect(row.notes).toBe('request_window:win-1');
      expect(row.site_id).toBe('site-1');
      expect(row.start_date).toBe(row.end_date); // single dates
      expect(row.all_day).toBe(true);
    }
  });

  it('does not write no-call rows when only PTO is submitted', async () => {
    const { calls } = setup();
    const res = await POST(fakeReq({
      provider_id: 'prov-1',
      pto: [{ start_date: '2026-09-14', end_date: '2026-09-18' }],
    }), params);
    expect(res.status).toBe(200);
    expect(callsFor(calls, 'provider_availability', 'insert')).toHaveLength(0);
    expect(callsFor(calls, 'provider_requests', 'insert')).toHaveLength(1);
  });
});
