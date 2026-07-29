// GET /api/scheduling/planner — payload shape, param validation, and the
// actuals query plumbing, against the recording fake supabase client.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeFakeSupabase, callsFor, fromCount, type TableCfg } from '@/lib/rulesEngine/__fixtures__/fakeSupabase';

const holder = vi.hoisted(() => ({ sb: null as unknown }));
vi.mock('@/lib/supabaseScheduling', () => ({
  sbSchedulingServer: () => holder.sb,
}));

import { GET } from './route';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const QS = 'site_id=site-1&date_start=2026-01-01&date_end=2026-01-31';

function fakeReq(qs: string = QS): NextRequest {
  return { url: `http://test.local/api/scheduling/planner?${qs}` } as unknown as NextRequest;
}

const SITE = { id: 'site-1', name: 'Paoli', organization_id: 'org-1', call_par_level: null as number | null };

const HOLIDAYS = [
  { holiday_date: '2026-01-01', is_major_holiday: true },
  { holiday_date: '2026-01-19', is_major_holiday: false },
];

const TEMPLATES = [
  { day_type: 'weekday', shift_type_id: 'st-C1', required_count: 1, shift_types: { code: 'C1', category: 'call' } },
  { day_type: 'friday', shift_type_id: 'st-C1', required_count: 0, shift_types: { code: 'C1', category: 'call' } },
  { day_type: 'weekday', shift_type_id: 'st-D1', required_count: null, shift_types: { code: 'D1', category: 'regular' } },
];

const PROFILES = [
  { provider_id: 'p1', fte_value: 0.8, home_site_id: 'site-1', call_taker: true, partial_call_taker: false, is_day_doc: false, is_icu_doc: true },
  { provider_id: 'p2', fte_value: 1, home_site_id: 'site-1', call_taker: false, partial_call_taker: false, is_day_doc: true, is_icu_doc: false },
];

const PROVIDERS = [
  { id: 'p1', first_name: 'Ada', last_name: 'Lovelace', short_display_name: 'Lovelace A', initials: 'AL', provider_type: 'physician' },
  { id: 'p2', first_name: 'Mary', last_name: 'Shelley', short_display_name: 'Shelley M', initials: 'MS', provider_type: 'physician' },
];

const AVAILABILITY = [
  { provider_id: 'p1', availability_type: 'pto', start_date: '2026-01-05', end_date: '2026-01-09', approval_status: 'approved', reason_code: null },
  { provider_id: 'p1', availability_type: 'pto', start_date: '2026-01-14', end_date: '2026-01-14', approval_status: 'denied', reason_code: null },
];

const SCHEDULE = {
  id: 'sched-1', schedule_name: 'Paoli - Schedule - January 2026', status: 'draft',
  date_start: '2026-01-01', date_end: '2026-01-31', current_version_number: 2,
};

const SLOTS = [
  {
    slot_date: '2026-01-05', derived_day_type: 'weekday',
    shift_types: { code: 'C1', category: 'call', requires_post_call_rule: true },
    assignments: [{ provider_id: 'p1', assignment_status: 'assigned' }],
  },
  {
    slot_date: '2026-01-09', derived_day_type: 'friday',
    shift_types: { code: 'C2', category: 'call', requires_post_call_rule: false },
    // One-to-one embed shape (UNIQUE-constraint DBs): single object.
    assignments: { provider_id: 'p1', assignment_status: 'assigned' },
  },
  {
    slot_date: '2026-01-06', derived_day_type: 'weekday',
    shift_types: { code: 'C1', category: 'call', requires_post_call_rule: true },
    assignments: [{ provider_id: null, assignment_status: 'open' }],
  },
];

function setup(overrides: Record<string, TableCfg> = {}) {
  const { sb, calls } = makeFakeSupabase({
    tables: {
      sites: { data: SITE, error: null },
      holiday_calendars: { data: HOLIDAYS, error: null },
      shift_templates: { data: TEMPLATES, error: null },
      provider_employment_profiles: { data: PROFILES, error: null },
      schedules: { data: [SCHEDULE], error: null },
      providers: { data: PROVIDERS, error: null },
      provider_availability: { data: AVAILABILITY, error: null, count: AVAILABILITY.length },
      schedule_versions: { data: { id: 'ver-2' }, error: null },
      schedule_slots: { data: SLOTS, error: null, count: SLOTS.length },
      ...overrides,
    },
  });
  holder.sb = sb;
  return { calls };
}

beforeEach(() => { holder.sb = null; });

// ── Param validation (400s) ──────────────────────────────────────────────────

describe('GET /api/scheduling/planner — param validation', () => {
  it.each([
    ['date_start=2026-01-01&date_end=2026-01-31', 'site_id is required'],
    ['site_id=site-1&date_end=2026-01-31', 'date_start must be YYYY-MM-DD'],
    ['site_id=site-1&date_start=2026-13-01&date_end=2026-01-31', 'date_start must be YYYY-MM-DD'],
    ['site_id=site-1&date_start=2026-01-01&date_end=2026-02-30', 'date_end must be YYYY-MM-DD'],
    ['site_id=site-1&date_start=2026-02-01&date_end=2026-01-01', 'date_end must be on or after date_start'],
    ['site_id=site-1&date_start=2026-01-01&date_end=2027-06-01', 'date range must be at most 400 days'],
  ])('?%s → 400', async (qs, message) => {
    setup();
    const res = await GET(fakeReq(qs));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(message);
  });

  it('unknown site → 404', async () => {
    setup({ sites: { data: null, error: null } });
    const res = await GET(fakeReq());
    expect(res.status).toBe(404);
  });
});

// ── Payload shape ────────────────────────────────────────────────────────────

describe('GET /api/scheduling/planner — payload', () => {
  it('assembles site (par fallback), holidays, aggregated templates, roster, live availability, actuals', async () => {
    setup();
    const res = await GET(fakeReq());
    expect(res.status).toBe(200);
    const json = await res.json();

    // Par level: stored null resolves through the engine default (12).
    expect(json.site).toEqual({ id: 'site-1', name: 'Paoli', call_par_level: 12, call_par_level_stored: null });
    expect(json.range).toEqual({ date_start: '2026-01-01', date_end: '2026-01-31' });
    expect(json.holidays).toEqual(HOLIDAYS);

    // Templates aggregated per (day_type, shift_type); count-0 friday row KEPT.
    expect(json.templates).toEqual([
      { day_type: 'friday', shift_type_id: 'st-C1', code: 'C1', category: 'call', count: 0 },
      { day_type: 'weekday', shift_type_id: 'st-C1', code: 'C1', category: 'call', count: 1 },
      { day_type: 'weekday', shift_type_id: 'st-D1', code: 'D1', category: 'regular', count: 1 },
    ]);

    // Roster = active providers merged with their employment profile.
    expect(json.roster).toEqual([
      {
        provider_id: 'p1', first_name: 'Ada', last_name: 'Lovelace', short_display_name: 'Lovelace A',
        initials: 'AL', provider_type: 'physician', fte_value: 0.8, work_days_fte: null,
        home_site_id: 'site-1',
        call_taker: true, partial_call_taker: false, is_day_doc: false, is_icu_doc: true,
      },
      {
        provider_id: 'p2', first_name: 'Mary', last_name: 'Shelley', short_display_name: 'Shelley M',
        initials: 'MS', provider_type: 'physician', fte_value: 1, work_days_fte: null,
        home_site_id: 'site-1',
        call_taker: false, partial_call_taker: false, is_day_doc: true, is_icu_doc: false,
      },
    ]);

    // Dismissed availability rows never reach the payload.
    expect(json.availability).toEqual([AVAILABILITY[0]]);

    // Actuals from the overlapping draft schedule's current version.
    expect(json.actuals.schedule).toEqual({
      id: 'sched-1', schedule_name: 'Paoli - Schedule - January 2026', status: 'draft',
      date_start: '2026-01-01', date_end: '2026-01-31', version_number: 2,
    });
    expect(json.actuals.byProvider).toEqual({
      p1: {
        callCounts: [
          { bucket: 'friday', code: 'C2', count: 1 },
          { bucket: 'weekday', code: 'C1', count: 1 },
        ],
        assignedWorkdays: ['2026-01-05', '2026-01-09'],
        postCallRestWorkdays: ['2026-01-06'],
        icuWorkdays: [],
      },
    });
  });

  it('stored positive par is used as-is; 0/negative falls back to the engine default', async () => {
    setup({ sites: { data: { ...SITE, call_par_level: 8 }, error: null } });
    let json = await (await GET(fakeReq())).json();
    expect(json.site.call_par_level).toBe(8);
    expect(json.site.call_par_level_stored).toBe(8);

    setup({ sites: { data: { ...SITE, call_par_level: 0 }, error: null } });
    json = await (await GET(fakeReq())).json();
    expect(json.site.call_par_level).toBe(12);
    expect(json.site.call_par_level_stored).toBe(0);
  });

  it('no overlapping schedule → actuals: null (pre-generation state, not an error)', async () => {
    const { calls } = setup({ schedules: { data: [], error: null } });
    const res = await GET(fakeReq());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.actuals).toBeNull();
    expect(fromCount(calls, 'schedule_versions')).toBe(0);
    expect(fromCount(calls, 'schedule_slots')).toBe(0);
  });

  it('empty roster (no home-site profiles) short-circuits provider reads', async () => {
    const { calls } = setup({ provider_employment_profiles: { data: [], error: null } });
    const res = await GET(fakeReq());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.roster).toEqual([]);
    expect(json.availability).toEqual([]);
    expect(fromCount(calls, 'providers')).toBe(0);
    expect(fromCount(calls, 'provider_availability')).toBe(0);
  });

  // patch43 — work_days_fte (the WORKING-DAYS FTE) rides the profiles read.
  // This route HARD-FAILS on a profiles error, so without the narrow retry a
  // DB predating the column would 500 the whole planner card.
  it('carries work_days_fte onto the roster', async () => {
    setup({ provider_employment_profiles: { data: [
      { ...PROFILES[0], work_days_fte: 1 },
      { ...PROFILES[1], work_days_fte: null },
    ], error: null } });
    const json = await (await GET(fakeReq())).json();
    expect(json.roster.map((r: { work_days_fte: number | null }) => r.work_days_fte))
      .toEqual([1, null]);
  });

  it('a missing work_days_fte column retries narrow instead of 500ing the card', async () => {
    const { calls } = setup({
      provider_employment_profiles: (filters: { method: string; args: unknown[] }[]) => {
        const sel = (filters.find(f => f.method === 'select')?.args[0] as string) ?? '';
        if (sel.includes('work_days_fte')) {
          return { data: null, error: { message: 'column work_days_fte does not exist', code: '42703' } };
        }
        return { data: PROFILES, error: null };
      },
    });
    const res = await GET(fakeReq());
    const json = await res.json();
    expect(res.status).toBe(200);
    // Roster survives, with every provider back on the fte_value contract.
    expect(json.roster.map((r: { provider_id: string }) => r.provider_id)).toEqual(['p1', 'p2']);
    expect(json.roster.every((r: { work_days_fte: number | null }) => r.work_days_fte === null)).toBe(true);
    const selects = callsFor(calls, 'provider_employment_profiles', 'select').map(c => c.args[0] as string);
    expect(selects).toHaveLength(2);
    expect(selects[0]).toContain('work_days_fte');
    expect(selects[1]).not.toContain('work_days_fte');
  });

  it('a NON-column profiles failure still 500s (no pointless retry, no silent partial payload)', async () => {
    const { calls } = setup({
      provider_employment_profiles: { data: null, error: { message: 'connection reset', code: '08006' } },
    });
    expect((await GET(fakeReq())).status).toBe(500);
    expect(callsFor(calls, 'provider_employment_profiles', 'select')).toHaveLength(1);
  });

  it('providers absent from the active-providers read (inactive) drop out of the roster', async () => {
    setup({ providers: { data: [PROVIDERS[0]], error: null } });
    const json = await (await GET(fakeReq())).json();
    expect(json.roster.map((r: { provider_id: string }) => r.provider_id)).toEqual(['p1']);
  });
});

// ── Query plumbing (recorded calls) ──────────────────────────────────────────

describe('GET /api/scheduling/planner — recorded queries', () => {
  it('templates are scoped active-only (retired D8/D9 can never appear) and site-scoped', async () => {
    const { calls } = setup();
    await GET(fakeReq());
    const eqs = callsFor(calls, 'shift_templates', 'eq').map(c => c.args);
    expect(eqs).toContainEqual(['site_id', 'site-1']);
    expect(eqs).toContainEqual(['is_active', true]);
  });

  it('schedule lookup: site-scoped, non-archived, range-overlap, latest-first', async () => {
    const { calls } = setup();
    await GET(fakeReq());
    expect(callsFor(calls, 'schedules', 'eq').map(c => c.args)).toContainEqual(['site_id', 'site-1']);
    expect(callsFor(calls, 'schedules', 'neq').map(c => c.args)).toContainEqual(['status', 'archived']);
    expect(callsFor(calls, 'schedules', 'lte').map(c => c.args)).toContainEqual(['date_start', '2026-01-31']);
    expect(callsFor(calls, 'schedules', 'gte').map(c => c.args)).toContainEqual(['date_end', '2026-01-01']);
    expect(callsFor(calls, 'schedules', 'limit').map(c => c.args)).toContainEqual([1]);
  });

  it('actuals resolve the CURRENT version and clip slots to the requested range', async () => {
    const { calls } = setup();
    await GET(fakeReq());
    const verEqs = callsFor(calls, 'schedule_versions', 'eq').map(c => c.args);
    expect(verEqs).toContainEqual(['schedule_id', 'sched-1']);
    expect(verEqs).toContainEqual(['version_number', 2]);
    expect(callsFor(calls, 'schedule_slots', 'eq').map(c => c.args)).toContainEqual(['schedule_version_id', 'ver-2']);
    expect(callsFor(calls, 'schedule_slots', 'gte').map(c => c.args)).toContainEqual(['slot_date', '2026-01-01']);
    expect(callsFor(calls, 'schedule_slots', 'lte').map(c => c.args)).toContainEqual(['slot_date', '2026-01-31']);
  });

  it('availability is roster-scoped and range-overlap filtered', async () => {
    const { calls } = setup();
    await GET(fakeReq());
    expect(callsFor(calls, 'provider_availability', 'in').map(c => c.args))
      .toContainEqual(['provider_id', ['p1', 'p2']]);
    expect(callsFor(calls, 'provider_availability', 'lte').map(c => c.args)).toContainEqual(['start_date', '2026-01-31']);
    expect(callsFor(calls, 'provider_availability', 'gte').map(c => c.args)).toContainEqual(['end_date', '2026-01-01']);
  });
});

// ── Failure posture ──────────────────────────────────────────────────────────

describe('GET /api/scheduling/planner — failure posture', () => {
  it('a failed read is a 500, never a partial payload', async () => {
    setup({ holiday_calendars: { data: null, error: { message: 'boom' } } });
    const res = await GET(fakeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('boom');
  });

  it('truncated availability (count > rows) is a 500, never an undercount', async () => {
    setup({ provider_availability: { data: [AVAILABILITY[0]], error: null, count: 5 } });
    const res = await GET(fakeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/truncated/);
  });

  it('truncated slot reads are a 500, never wrong actuals', async () => {
    setup({ schedule_slots: { data: SLOTS, error: null, count: SLOTS.length + 100 } });
    const res = await GET(fakeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/truncated/);
  });

  it('a schedule pointing at a missing current version is a 500 (dangling pointer, not "no actuals")', async () => {
    setup({ schedule_versions: { data: null, error: null } });
    const res = await GET(fakeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/no version/);
  });
});
