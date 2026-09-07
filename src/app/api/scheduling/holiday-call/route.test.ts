// GET/POST /api/scheduling/holiday-call — the Holiday Call card's backend
// (patch44). Holiday call rows live in provider_availability; see
// src/lib/holidayCall.ts for why, and for the day-expansion rule this route
// serves to the card.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeFakeSupabase, callsFor, type Filter, type TableCfg } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

const holder = vi.hoisted(() => ({ sb: null as unknown }));
vi.mock('@/lib/supabaseScheduling', () => ({
  sbSchedulingServer: () => holder.sb,
}));

import { GET, POST } from './route';

// Christmas 2026 is a Friday, so its block is 12-25 → 12-27.
const CHRISTMAS = {
  id: 'hol-1',
  holiday_name: 'Christmas Day',
  holiday_date: '2026-12-25',
  holiday_type: 'federal',
  is_major_holiday: true,
};

const SITE = '2ddd2427-22fb-4290-9c4c-03a957e5af4e';

function getReq(qs: string): NextRequest {
  return { url: `http://localhost/api/scheduling/holiday-call?${qs}` } as unknown as NextRequest;
}
function postReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function has(filters: Filter[], method: string, arg?: string): boolean {
  return filters.some(f => f.method === method && (arg === undefined || f.args[0] === arg));
}

function setup(opts: {
  holidays?: Record<string, unknown>[];
  entries?: Record<string, unknown>[];
  leave?: Record<string, unknown>[];
  /** Rows the duplicate-code guard sees on POST. */
  existingForProvider?: Record<string, unknown>[];
  availabilityError?: unknown;
} = {}) {
  const availability: TableCfg = (filters) => {
    if (opts.availabilityError) return { data: null, error: opts.availabilityError };
    if (has(filters, 'insert')) return { data: { id: 'new-row' }, error: null };
    if (has(filters, 'delete')) return { data: null, error: null };
    // The conflict sweep is the only read keyed by provider_id list.
    if (has(filters, 'in', 'provider_id')) return { data: opts.leave ?? [], error: null };
    // POST's duplicate-code guard filters by a single provider_id.
    if (has(filters, 'eq', 'provider_id')) return { data: opts.existingForProvider ?? [], error: null };
    return { data: opts.entries ?? [], error: null };
  };
  const { sb, calls } = makeFakeSupabase({
    tables: {
      holiday_calendars: { data: opts.holidays ?? [CHRISTMAS], error: null },
      provider_availability: availability,
    },
  });
  holder.sb = sb;
  return { calls };
}

beforeEach(() => { holder.sb = null; });

describe('GET /api/scheduling/holiday-call', () => {
  it('expands each holiday into every day it covers', async () => {
    setup();
    const res = await GET(getReq('org_id=org-1&year=2026'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.year).toBe(2026);
    expect(json.holidays).toHaveLength(1);
    expect(json.holidays[0].dates).toEqual(['2026-12-25', '2026-12-26', '2026-12-27']);
  });

  it('maps recorded decisions to date + code with a display name', async () => {
    setup({
      entries: [{
        id: 'av-1', provider_id: 'prov-1', site_id: SITE,
        start_date: '2026-12-25', reason_code: 'C1', notes: 'Christmas Day',
        approval_status: 'approved', source: 'holiday_call_card',
        providers: { first_name: 'Ada', last_name: 'Lovelace', short_display_name: 'A.Lovelace' },
      }],
    });
    const json = await (await GET(getReq(`org_id=org-1&site_id=${SITE}&year=2026`))).json();
    expect(json.entries).toEqual([{
      id: 'av-1', provider_id: 'prov-1', provider_name: 'A.Lovelace',
      date: '2026-12-25', code: 'C1', holiday_name: 'Christmas Day', site_id: SITE,
    }]);
  });

  it('drops rows whose date falls outside every holiday block', async () => {
    setup({
      entries: [
        { id: 'av-1', provider_id: 'p1', start_date: '2026-12-25', reason_code: 'C1', providers: null },
        // Inside the queried span (12-25 … 12-27) but not a holiday day.
        { id: 'av-2', provider_id: 'p1', start_date: '2026-12-30', reason_code: 'C1', providers: null },
      ],
    });
    const json = await (await GET(getReq('org_id=org-1&year=2026'))).json();
    expect(json.entries.map((e: { id: string }) => e.id)).toEqual(['av-1']);
  });

  it('flags a provider who is on live PTO for a day they hold call', async () => {
    setup({
      entries: [{ id: 'av-1', provider_id: 'p1', start_date: '2026-12-25', reason_code: 'C1', providers: null }],
      leave: [{ provider_id: 'p1', availability_type: 'pto', start_date: '2026-12-20', end_date: '2026-12-28', approval_status: 'approved' }],
    });
    const json = await (await GET(getReq('org_id=org-1&year=2026'))).json();
    expect(json.conflicts).toEqual([
      { provider_id: 'p1', date: '2026-12-25', availability_type: 'pto', label: 'PTO' },
    ]);
  });

  it('counts PENDING leave as a conflict but ignores denied/canceled', async () => {
    setup({
      entries: [{ id: 'av-1', provider_id: 'p1', start_date: '2026-12-25', reason_code: 'C1', providers: null }],
      leave: [
        { provider_id: 'p1', availability_type: 'pto', start_date: '2026-12-25', end_date: '2026-12-25', approval_status: 'pending' },
        { provider_id: 'p1', availability_type: 'sick', start_date: '2026-12-25', end_date: '2026-12-25', approval_status: 'denied' },
      ],
    });
    const json = await (await GET(getReq('org_id=org-1&year=2026'))).json();
    expect(json.conflicts.map((c: { availability_type: string }) => c.availability_type)).toEqual(['pto']);
  });

  it('does not flag non-blocking availability as a conflict', async () => {
    setup({
      entries: [{ id: 'av-1', provider_id: 'p1', start_date: '2026-12-25', reason_code: 'C1', providers: null }],
      // call_request and holiday_call itself are not blocking types.
      leave: [
        { provider_id: 'p1', availability_type: 'call_request', start_date: '2026-12-25', end_date: '2026-12-25', approval_status: 'approved' },
        { provider_id: 'p1', availability_type: 'holiday_call', start_date: '2026-12-25', end_date: '2026-12-25', approval_status: 'approved' },
      ],
    });
    const json = await (await GET(getReq('org_id=org-1&year=2026'))).json();
    expect(json.conflicts).toEqual([]);
  });

  it('returns an empty payload when the year has no holidays', async () => {
    setup({ holidays: [] });
    const json = await (await GET(getReq('org_id=org-1&year=2026'))).json();
    expect(json).toEqual({ year: 2026, holidays: [], entries: [], conflicts: [] });
  });

  it('rejects a missing org_id and a nonsense year', async () => {
    setup();
    expect((await GET(getReq('year=2026'))).status).toBe(400);
    expect((await GET(getReq('org_id=org-1&year=99'))).status).toBe(400);
    expect((await GET(getReq('org_id=org-1&year=abc'))).status).toBe(400);
  });

  // site_id is interpolated into a PostgREST .or() filter string, so anything
  // that is not exactly a UUID is refused rather than escaped.
  it('refuses a site_id that is not a UUID', async () => {
    setup();
    expect((await GET(getReq('org_id=org-1&site_id=site-1'))).status).toBe(400);
    expect((await GET(getReq('org_id=org-1&site_id=x,y)'))).status).toBe(400);
    const res = await POST(postReq({ site_id: 'site-1', provider_id: 'p1', date: '2026-12-25', code: 'C1' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/scheduling/holiday-call', () => {
  it('clears the cell before writing so a code is single-valued', async () => {
    const { calls } = setup();
    const res = await POST(postReq({
      site_id: SITE, provider_id: 'prov-1', date: '2026-12-25', code: 'C1', holiday_name: 'Christmas Day',
    }));
    expect(res.status).toBe(200);

    expect(callsFor(calls, 'provider_availability', 'delete')).toHaveLength(1);
    const [insert] = callsFor(calls, 'provider_availability', 'insert');
    expect(insert.args[0]).toMatchObject({
      provider_id: 'prov-1',
      site_id: SITE,
      availability_type: 'holiday_call',
      start_date: '2026-12-25',
      end_date: '2026-12-25',
      reason_code: 'C1',
      notes: 'Christmas Day',
      source: 'holiday_call_card',
      approval_status: 'approved',
    });
  });

  it('clears without inserting when no provider is chosen', async () => {
    const { calls } = setup();
    const res = await POST(postReq({ site_id: SITE, provider_id: null, date: '2026-12-25', code: 'C1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: true });
    expect(callsFor(calls, 'provider_availability', 'delete')).toHaveLength(1);
    expect(callsFor(calls, 'provider_availability', 'insert')).toHaveLength(0);
  });

  it('refuses a second call code for the same provider on the same day', async () => {
    const { calls } = setup({ existingForProvider: [{ id: 'av-1', reason_code: 'C1' }] });
    const res = await POST(postReq({ site_id: SITE, provider_id: 'prov-1', date: '2026-12-25', code: 'C2' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Already holds C1/);
    expect(callsFor(calls, 'provider_availability', 'insert')).toHaveLength(0);
  });

  it('rejects a bad code, a bad date and a junk body', async () => {
    setup();
    expect((await POST(postReq({ provider_id: 'p1', date: '2026-12-25', code: 'D1' }))).status).toBe(400);
    expect((await POST(postReq({ provider_id: 'p1', date: '25/12/2026', code: 'C1' }))).status).toBe(400);
    expect((await POST(postReq(null))).status).toBe(400);
  });

  it('surfaces a write failure instead of reporting success', async () => {
    setup({ availabilityError: { message: 'enum value does not exist' } });
    const res = await POST(postReq({ provider_id: 'p1', date: '2026-12-25', code: 'C1' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('enum value does not exist');
  });
});
