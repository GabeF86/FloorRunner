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
  existingCallDates?: string[];
} = {}) {
  const window = opts.window === undefined ? WINDOW : opts.window;
  const provider = opts.provider === undefined ? { id: 'prov-1', status: 'active' } : opts.provider;
  const profile = opts.profile === undefined ? { home_site_id: 'site-1' } : opts.profile;
  const existing = (opts.existingNoCallDates ?? []).map(d => ({ start_date: d }));
  const existingCall = (opts.existingCallDates ?? []).map(d => ({ start_date: d }));

  const tables: Record<string, TableCfg> = {
    request_windows: { data: window, error: null },
    providers: { data: provider, error: null },
    provider_employment_profiles: { data: profile, error: null },
    // The existing-rows SELECT runs per request type — dispatch on the
    // availability_type filter so each cap counts only its own rows.
    provider_availability: (filters: Filter[]) => {
      if (filters.some(f => f.method === 'insert')) return { data: null, error: null };
      const typeEq = filters.find(f => f.method === 'eq' && f.args[0] === 'availability_type');
      return { data: typeEq?.args[1] === 'call_request' ? existingCall : existing, error: null };
    },
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
    expect(body.created).toEqual({ pto: 1, days_off: 1, no_call: 2, call: 0 });

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

  it('rejects call dates when the window does not enable call requests', async () => {
    // WINDOW carries no max_call_requests (pre-patch36 shape / admin left it
    // Off) — call_dates must be refused with a clear message, no writes.
    const { calls } = setup();
    const res = await POST(fakeReq({ provider_id: 'prov-1', call_dates: ['2026-09-10'] }), params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/call/i);
    expect(writeCount(calls)).toBe(0);
  });

  it('rejects a call date submitted together with the same no-call date (contradictory)', async () => {
    const { calls } = setup({ window: { ...WINDOW, max_call_requests: 3 } });
    const res = await POST(fakeReq({
      provider_id: 'prov-1',
      no_call_dates: ['2026-09-10'],
      call_dates: ['2026-09-10'],
    }), params);
    expect(res.status).toBe(400);
    expect(writeCount(calls)).toBe(0);
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

// ── call-shift requests (2026-07-22) — mirror of the no-call category ───────
// Enabled by the admin per window (max_call_requests ≥ 1; NULL = category
// off). One request = one requested DATE; the per-provider cap counts the
// provider's existing window-sourced call_request rows exactly like no-call.
describe('POST /api/requests/submit/[token] — call-shift requests', () => {
  const CALL_WINDOW = { ...WINDOW, max_call_requests: 3 };

  it('400s when a call date falls outside the block', async () => {
    const { calls } = setup({ window: CALL_WINDOW });
    const res = await POST(fakeReq({ provider_id: 'prov-1', call_dates: ['2026-12-01'] }), params);
    expect(res.status).toBe(400);
    expect(writeCount(calls)).toBe(0);
  });

  it('enforces the per-window call cap against existing window-sourced rows', async () => {
    const { calls } = setup({
      window: CALL_WINDOW,
      existingCallDates: ['2026-09-10', '2026-09-17'],
    });
    const res = await POST(
      fakeReq({ provider_id: 'prov-1', call_dates: ['2026-10-01', '2026-10-08'] }),
      params,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/3/); // mentions the cap
    expect(writeCount(calls)).toBe(0);
  });

  it('accepts a submission that lands exactly AT the cap', async () => {
    const { calls } = setup({
      window: CALL_WINDOW,
      existingCallDates: ['2026-09-10', '2026-09-17'],
    });
    const res = await POST(fakeReq({ provider_id: 'prov-1', call_dates: ['2026-10-01'] }), params);
    expect(res.status).toBe(200);
    expect(callsFor(calls, 'provider_availability', 'insert')).toHaveLength(1);
  });

  it('scopes the cap to THIS window (queries rows by the window notes tag)', async () => {
    const { calls } = setup({ window: CALL_WINDOW });
    await POST(fakeReq({ provider_id: 'prov-1', call_dates: ['2026-10-01'] }), params);
    const eqs = callsFor(calls, 'provider_availability', 'eq').map(c => c.args);
    expect(eqs).toContainEqual(['availability_type', 'call_request']);
    expect(eqs).toContainEqual(['notes', 'request_window:win-1']);
    expect(eqs).toContainEqual(['source', 'request_window']);
  });

  it('the no-call cap and the call cap count independently', async () => {
    // 3 no-call rows already used; a call date must still be accepted.
    const { calls } = setup({
      window: CALL_WINDOW,
      existingNoCallDates: ['2026-09-10', '2026-09-17', '2026-09-24'],
    });
    const res = await POST(fakeReq({ provider_id: 'prov-1', call_dates: ['2026-10-01'] }), params);
    expect(res.status).toBe(200);
    expect(callsFor(calls, 'provider_availability', 'insert')).toHaveLength(1);
  });

  it('skips already-submitted call dates instead of double-counting them', async () => {
    const { calls } = setup({ window: CALL_WINDOW, existingCallDates: ['2026-09-10'] });
    const res = await POST(
      fakeReq({ provider_id: 'prov-1', call_dates: ['2026-09-10', '2026-10-01'] }),
      params,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created.call).toBe(2);       // what the provider asked for
    expect(body.skipped_call).toBe(1);       // the resubmitted date
    const inserts = callsFor(calls, 'provider_availability', 'insert');
    expect(inserts).toHaveLength(1);
    const rows = inserts[0].args[0] as Array<Record<string, unknown>>;
    expect(rows.map(r => r.start_date)).toEqual(['2026-10-01']);
  });

  it('writes call_request rows in the exact no-call row shape', async () => {
    const { calls } = setup({ window: CALL_WINDOW });
    const res = await POST(fakeReq({
      provider_id: 'prov-1',
      call_dates: ['2026-09-10', '2026-09-24'],
    }), params);
    expect(res.status).toBe(200);
    const inserts = callsFor(calls, 'provider_availability', 'insert');
    expect(inserts).toHaveLength(1);
    const rows = inserts[0].args[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.availability_type).toBe('call_request');
      expect(row.approval_status).toBe('approved');
      expect(row.source).toBe('request_window');
      expect(row.notes).toBe('request_window:win-1');
      expect(row.site_id).toBe('site-1');
      expect(row.start_date).toBe(row.end_date); // single dates
      expect(row.all_day).toBe(true);
    }
  });

  it('no-call and call rows can be submitted together (different dates)', async () => {
    const { calls } = setup({ window: CALL_WINDOW });
    const res = await POST(fakeReq({
      provider_id: 'prov-1',
      no_call_dates: ['2026-09-10'],
      call_dates: ['2026-09-24'],
    }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created.no_call).toBe(1);
    expect(body.created.call).toBe(1);
    const inserts = callsFor(calls, 'provider_availability', 'insert');
    const allRows = inserts.flatMap(i => i.args[0] as Array<Record<string, unknown>>);
    expect(allRows.map(r => r.availability_type).sort()).toEqual(['call_request', 'no_call_request']);
  });
});

// ── Weekend no-call unit counting (Gabriel 2026-07-22) ──────────────────────
// "A no weekend call (no Friday, no Saturday and no Sunday call) is considered
// one request not three." The no-call cap is enforced in UNITS
// (countNoCallRequestUnits): weekday = 1 each, Fri/Sat/Sun of one weekend = 1
// total. Counted over the UNION of existing window rows and the new dates so
// resubmits / weekend completion never double-count. CALL requests stay
// per-date. Inside the test block: 9/11 Fri · 9/12 Sat · 9/13 Sun ·
// 9/18–20 the next weekend · 9/10 + 10/01 + 10/08 Thursdays.
describe('POST /api/requests/submit/[token] — weekend no-call units', () => {
  it('a full Fri+Sat+Sun weekend plus 2 weekdays fits a cap of 3 (3 units, 5 rows)', async () => {
    const { calls } = setup(); // max_no_call_requests: 3
    const res = await POST(fakeReq({
      provider_id: 'prov-1',
      no_call_dates: ['2026-09-11', '2026-09-12', '2026-09-13', '2026-09-10', '2026-10-01'],
    }), params);
    expect(res.status).toBe(200);
    const inserts = callsFor(calls, 'provider_availability', 'insert');
    expect(inserts).toHaveLength(1);
    const rows = inserts[0].args[0] as Array<Record<string, unknown>>;
    expect(rows.map(r => r.start_date).sort()).toEqual(
      ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-10-01'],
    );
  });

  it('two different weekends + 2 weekdays exceed a cap of 3 (4 units) → 400 speaking in requests + weekend rule', async () => {
    const { calls } = setup();
    const res = await POST(fakeReq({
      provider_id: 'prov-1',
      no_call_dates: ['2026-09-11', '2026-09-12', '2026-09-20', '2026-09-10', '2026-10-01'],
    }), params);
    expect(res.status).toBe(400);
    const msg = (await res.json()).error as string;
    expect(msg).toMatch(/3 requests/);
    expect(msg).toMatch(/full weekend/i); // explains Fri+Sat+Sun = one request
    expect(writeCount(calls)).toBe(0);
  });

  it('a weekday-only overflow keeps a plain per-request message (no weekend clause)', async () => {
    const { calls } = setup({ window: { ...WINDOW, max_no_call_requests: 1 } });
    const res = await POST(fakeReq({
      provider_id: 'prov-1',
      no_call_dates: ['2026-09-10', '2026-10-01'],
    }), params);
    expect(res.status).toBe(400);
    const msg = (await res.json()).error as string;
    expect(msg).toMatch(/1 request/);
    expect(msg).not.toMatch(/weekend/i);
    expect(writeCount(calls)).toBe(0);
  });

  it('completing an already-submitted weekend at the cap adds 0 units → accepted', async () => {
    // Cap 1, Saturday already recorded: adding the Fri + Sun of the SAME
    // weekend is still the same single request.
    const { calls } = setup({
      window: { ...WINDOW, max_no_call_requests: 1 },
      existingNoCallDates: ['2026-09-12'],
    });
    const res = await POST(fakeReq({
      provider_id: 'prov-1',
      no_call_dates: ['2026-09-11', '2026-09-13'],
    }), params);
    expect(res.status).toBe(200);
    const inserts = callsFor(calls, 'provider_availability', 'insert');
    expect(inserts).toHaveLength(1);
    const rows = inserts[0].args[0] as Array<Record<string, unknown>>;
    expect(rows.map(r => r.start_date)).toEqual(['2026-09-11', '2026-09-13']);
  });

  it('resubmitting the same weekend does not double-count (union semantics)', async () => {
    const { calls } = setup({
      window: { ...WINDOW, max_no_call_requests: 2 },
      existingNoCallDates: ['2026-09-11', '2026-09-12', '2026-09-13'], // 1 unit used
    });
    const res = await POST(fakeReq({
      provider_id: 'prov-1',
      no_call_dates: ['2026-09-12', '2026-09-13', '2026-10-01'], // same weekend + 1 weekday = 2 units total
    }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped_no_call).toBe(2); // the two resubmitted dates
    const inserts = callsFor(calls, 'provider_availability', 'insert');
    expect(inserts).toHaveLength(1);
    const rows = inserts[0].args[0] as Array<Record<string, unknown>>;
    expect(rows.map(r => r.start_date)).toEqual(['2026-10-01']);
  });

  it('a second, different weekend against remaining budget is rejected', async () => {
    const { calls } = setup({
      window: { ...WINDOW, max_no_call_requests: 1 },
      existingNoCallDates: ['2026-09-12'], // 1 unit used of 1
    });
    const res = await POST(fakeReq({ provider_id: 'prov-1', no_call_dates: ['2026-09-19'] }), params);
    expect(res.status).toBe(400);
    const msg = (await res.json()).error as string;
    expect(msg).toMatch(/1 request/);
    expect(msg).toMatch(/1 already used/);
    expect(writeCount(calls)).toBe(0);
  });

  it('CALL requests stay per-date: a full weekend of call dates is 3 requests, not 1', async () => {
    const { calls } = setup({ window: { ...WINDOW, max_call_requests: 2 } });
    const res = await POST(fakeReq({
      provider_id: 'prov-1',
      call_dates: ['2026-09-11', '2026-09-12', '2026-09-13'],
    }), params);
    expect(res.status).toBe(400); // 3 dates > cap 2 — no weekend collapsing here
    expect(writeCount(calls)).toBe(0);
  });
});
