// The route's data layer, exercised with an injected fake supabase client —
// the house convention for DB-coupled modules (no network, no DB).
import { describe, it, expect } from 'vitest';
import { loadBlockPrepData } from './route.helpers';

const SITE = 'site-1';

/**
 * Minimal PostgREST-shaped fake. Each table returns a canned { data, error };
 * every builder method returns `this` so any chain of .select/.eq/.in/.gte/.lte
 * /.order resolves to the same envelope. `await`-ability comes from `then`.
 */
function fakeClient(tables: Record<string, {
  data?: unknown;
  error?: { message: string };
  /** Set HIGHER than data.length to simulate a PostgREST 1000-row truncation. */
  count?: number;
}>) {
  const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const client = {
    calls,
    from(table: string) {
      const record = { table, filters: [] as Array<[string, unknown]> };
      calls.push(record);
      const res = tables[table] ?? { data: [] };
      const builder: Record<string, unknown> = {
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve({
            data: res.data ?? null,
            error: res.error ?? null,
            // Default the count to the row count — i.e. NOT truncated — so only
            // a test that explicitly sets a higher count exercises the guard.
            count: res.count ?? (Array.isArray(res.data) ? res.data.length : 0),
          }).then(resolve);
        },
      };
      for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'or', 'not']) {
        builder[m] = (...args: unknown[]) => {
          record.filters.push([m, args]);
          return builder;
        };
      }
      return builder;
    },
  };
  return client;
}

const PROFILES = [
  {
    provider_id: 'p1', fte_value: 1, work_days_fte: null, pto_weeks: 4,
    call_taker: true, partial_call_taker: false, home_site_id: SITE,
    providers: { id: 'p1', last_name: 'Jones', short_display_name: 'A.Jones', status: 'active' },
  },
  {
    provider_id: 'p2', fte_value: 0.7, work_days_fte: 1, pto_weeks: null,
    call_taker: true, partial_call_taker: false, home_site_id: SITE,
    providers: { id: 'p2', last_name: 'Hussain', short_display_name: 'O.Hussain', status: 'active' },
  },
];

describe('loadBlockPrepData', () => {
  it('returns a roster row per call taker with tally figures attached', async () => {
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES },
      holiday_calendars: { data: [] },
      shift_types: { data: [{ code: 'C1', call_burden_weight: 1, parent_call_code: null }] },
      provider_availability: { data: [] },
      schedule_slots: { data: [] },
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    expect(out.roster.error).toBeNull();
    expect(out.roster.data!.map(r => r.provider_id).sort()).toEqual(['p1', 'p2']);
    const hussain = out.roster.data!.find(r => r.provider_id === 'p2')!;
    // work_days_fte 1.00 despite call FTE 0.70 -> zero off days.
    // work_days_fte 1.00 despite call FTE 0.70 -> owes every working day.
    expect(hussain.offDayBudget).toEqual({ kind: 'none' });
    expect(hussain.pto.remainingDays).toBeNull();
  });

  it('surfaces a roster query error instead of an empty roster', async () => {
    const sb = fakeClient({
      provider_employment_profiles: { error: { message: 'boom' } },
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { data: [] },
      schedule_slots: { data: [] },
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    expect(out.roster.data).toBeNull();
    expect(out.roster.error).toContain('boom');
  });

  it('surfaces an availability error rather than showing full PTO balances', async () => {
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES },
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { error: { message: 'avail down' } },
      schedule_slots: { data: [] },
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    expect(out.roster.data).toBeNull();
    expect(out.roster.error).toContain('avail down');
  });

  it('fails the roster when the blocks read fails, rather than claiming nothing is published', async () => {
    // coveredSpans feeds offDaysUsed, and an empty list is indistinguishable
    // from "no blocks this year" — so a failed blocks read must not degrade
    // into a confident "nothing published" label.
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES },
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { data: [] },
      schedule_slots: { data: [] },
      schedules: { error: { message: 'blocks down' } },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    expect(out.blocks.error).toContain('blocks down');
    expect(out.roster.data).toBeNull();
    expect(out.roster.error).toContain('blocks down');
    expect(out.coveredSpan).toBeNull();
  });

  it('errors rather than under-counting when the slot read is truncated', async () => {
    // PostgREST caps un-ranged selects at 1000 rows with no error. A short read
    // against a larger exact count must surface as an error — never as a
    // confident, wrong call tally.
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES },
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { data: [] },
      schedule_slots: { data: [], count: 1200 },
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    expect(out.roster.data).toBeNull();
    expect(out.roster.error).toMatch(/truncated/i);
  });

  it('errors rather than showing full PTO balances when availability is truncated', async () => {
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES },
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { data: [], count: 1200 },
      schedule_slots: { data: [] },
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    expect(out.roster.data).toBeNull();
    expect(out.roster.error).toMatch(/truncated/i);
  });

  it('filters slots to published versions', async () => {
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES },
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { data: [] },
      schedule_slots: { data: [] },
      schedules: { data: [] },
    });
    await loadBlockPrepData(sb, SITE, 2026);
    const slotCall = sb.calls.find(c => c.table === 'schedule_slots')!;
    const published = slotCall.filters.some(
      ([m, args]) => m === 'eq' && JSON.stringify(args).includes('published'));
    expect(published).toBe(true);
  });

  // ── Beyond the plan's suite ────────────────────────────────────────────────

  it('a site with no call takers returns an empty roster with error: null (not an error)', async () => {
    const sb = fakeClient({
      provider_employment_profiles: { data: [] },
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { data: [] },
      schedule_slots: { data: [] },
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    expect(out.roster.error).toBeNull();
    expect(out.roster.data).toEqual([]);
  });

  it('feeds computeAnnualTally slots and coveredSpans from the SAME published-version set', async () => {
    // AnnualTallyInput's doc comment: slots and coveredSpans must be drawn
    // from the same published-version set in both directions. Verify: (a)
    // BOTH the blocks query (schedules) and the slots query (schedule_slots)
    // carry the published-only filter, and (b) the coveredSpan the route
    // returns is derived from the very same blocks data the blocks panel
    // exposes to the caller — not a second, independently-scoped read.
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES },
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { data: [] },
      schedule_slots: { data: [] },
      schedules: {
        data: [{
          id: 'sch1', schedule_name: 'Block 1',
          date_start: '2026-01-05', date_end: '2026-01-11',
          schedule_versions: { version_status: 'published' },
        }],
      },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);

    const hasPublishedFilter = (table: string) => {
      const call = sb.calls.find(c => c.table === table)!;
      return call.filters.some(
        ([m, args]) => m === 'eq' && JSON.stringify(args).includes('published'));
    };
    expect(hasPublishedFilter('schedules')).toBe(true);
    expect(hasPublishedFilter('schedule_slots')).toBe(true);

    // The blocks panel and the tally's coveredSpan agree on the block dates —
    // both trace back to the one published-only `schedules` read.
    expect(out.blocks.data).toEqual([{
      schedule_id: 'sch1', schedule_name: 'Block 1',
      date_start: '2026-01-05', date_end: '2026-01-11',
    }]);
    expect(out.coveredSpan).not.toBeNull();
    expect(out.coveredSpan!.start).toBe('2026-01-05');
    expect(out.coveredSpan!.end).toBe('2026-01-11');
  });

  it('coerces a string call_burden_weight (Postgres numeric) rather than rejecting it to the weight-1 default', async () => {
    // callBurden.callBurdenWeight rejects a non-number weight outright and
    // falls back to 1 (callBurden.test.ts pins this). Postgres numeric columns
    // really do arrive over the wire as strings, so the route MUST coerce with
    // Number() before the value ever reaches callBurdenWeight — otherwise
    // every split call on a live DB would silently price at a whole call.
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES },
      holiday_calendars: { data: [] },
      shift_types: { data: [{ code: 'C1', call_burden_weight: '0.5', parent_call_code: null }] },
      provider_availability: { data: [] },
      schedule_slots: {
        data: [{
          slot_date: '2026-01-05', // a Monday
          derived_day_type: 'weekday',
          shift_types: { code: 'C1', category: 'call', requires_post_call_rule: false },
          assignments: { provider_id: 'p1', assignment_status: 'assigned' },
        }],
      },
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    const jones = out.roster.data!.find(r => r.provider_id === 'p1')!;
    expect(jones.callTotal).toBe(0.5);
  });

  it('coerces string numeric fte_value/work_days_fte/pto_weeks, and keeps a null pto_weeks null', async () => {
    // provider_employment_profiles' fte_value, work_days_fte and pto_weeks are
    // all Postgres `numeric`/int columns and can arrive as strings.
    const sb = fakeClient({
      provider_employment_profiles: {
        data: [
          {
            provider_id: 'p1', fte_value: '0.8', work_days_fte: '0.9', pto_weeks: null,
            call_taker: true, partial_call_taker: false, home_site_id: SITE,
            providers: { id: 'p1', last_name: 'Jones', short_display_name: 'A.Jones', status: 'active' },
          },
          {
            provider_id: 'p2', fte_value: '1', work_days_fte: null, pto_weeks: '3',
            call_taker: true, partial_call_taker: false, home_site_id: SITE,
            providers: { id: 'p2', last_name: 'Hussain', short_display_name: 'O.Hussain', status: 'active' },
          },
        ],
      },
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { data: [] },
      schedule_slots: { data: [] },
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    const jones = out.roster.data!.find(r => r.provider_id === 'p1')!;
    const hussain = out.roster.data!.find(r => r.provider_id === 'p2')!;

    expect(jones.fte_value).toBe(0.8);
    expect(jones.work_days_fte).toBe(0.9);
    expect(jones.pto_weeks).toBeNull();
    // BLANK IS NOT ZERO — a null pto_weeks stays null, never coerced to 0.
    expect(jones.pto.allotmentDays).toBeNull();
    expect(jones.pto.remainingDays).toBeNull();

    expect(hussain.fte_value).toBe(1);
    expect(hussain.pto_weeks).toBe(3);
    expect(typeof hussain.pto_weeks).toBe('number');
  });
});
