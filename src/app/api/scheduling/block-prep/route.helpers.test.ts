// The route's data layer, exercised with an injected fake supabase client —
// the house convention for DB-coupled modules (no network, no DB).
import { describe, it, expect } from 'vitest';
import { loadBlockPrepData, PAGE_SIZE, MAX_PAGES } from './route.helpers';

const SITE = 'site-1';

interface TableResponse {
  data?: unknown;
  error?: { message: string };
  /** Set HIGHER than data.length to simulate a PostgREST 1000-row truncation.
   *  Pass `null` explicitly (not "omitted") to simulate the `{ count: 'exact' }`
   *  option being dropped from a select — see the `'count' in res` check
   *  below, which distinguishes "unset" (default to a clean count) from
   *  "explicitly null" (a real transport anomaly). */
  count?: number | null;
}

/**
 * Minimal PostgREST-shaped fake. Each table returns a canned { data, error };
 * every builder method returns `this` so any chain of .select/.eq/.in/.gte/.lte
 * /.order/.range resolves to the same envelope. `await`-ability comes from
 * `then`.
 *
 * PAGING: a table may instead configure `pages: TableResponse[]` — successive
 * `.from(table)` calls consume successive entries (clamped to the last one
 * once exhausted), so a route that genuinely loops `.range()` calls sees a
 * different response each time, exactly like real pagination. A table with a
 * bare `TableResponse` (no `pages`) returns that same response on every call,
 * as before — existing single-shot tests are unaffected.
 */
function fakeClient(tables: Record<string, TableResponse | { pages: TableResponse[] }>) {
  const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const callIndex: Record<string, number> = {};
  const client = {
    calls,
    from(table: string) {
      const record = { table, filters: [] as Array<[string, unknown]> };
      calls.push(record);
      const config = tables[table] ?? { data: [] };
      let res: TableResponse;
      if ('pages' in config) {
        const idx = callIndex[table] ?? 0;
        callIndex[table] = idx + 1;
        res = config.pages[Math.min(idx, config.pages.length - 1)];
      } else {
        res = config;
      }
      const builder: Record<string, unknown> = {
        then(resolve: (v: unknown) => unknown) {
          const hasCount = Object.prototype.hasOwnProperty.call(res, 'count');
          return Promise.resolve({
            data: res.data ?? null,
            error: res.error ?? null,
            // Default the count to the row count — i.e. NOT truncated — so
            // only a test that explicitly sets a count (including `null`)
            // exercises the guard. `'count' in res` rather than `??` so a
            // test can force a genuine null count through, distinct from
            // "the test didn't say".
            count: hasCount ? res.count : (Array.isArray(res.data) ? res.data.length : 0),
          }).then(resolve);
        },
      };
      for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'or', 'not', 'range']) {
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

/** A single published call-assignment slot row for `pid`, all on the same
 *  date — fine for volume/pagination tests, which only need each row to
 *  contribute one weighted call count, not clinically distinct dates. */
function callRow(pid: string) {
  return {
    slot_date: '2026-01-05',
    derived_day_type: 'weekday',
    shift_types: { code: 'C1', category: 'call', requires_post_call_rule: false },
    assignments: { provider_id: pid, assignment_status: 'assigned' },
  };
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
    expect(out.unrosteredProviderIds).toEqual([]);
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
    expect(out.unrosteredProviderIds).toBeNull();
    // AnnualTallyCard's blocks-banner dedup (2026-09-06 review) hinges on this
    // being BYTE-IDENTICAL, not merely both mentioning the same failure — a
    // future wrapping of the roster's copy (e.g. prefixing "Roster could not
    // be loaded: ") would pass every `toContain` check above while silently
    // bringing back two differently-worded banners about one root cause.
    expect(out.roster.error).toBe(out.blocks.error);
  });

  it('errors rather than under-counting when the slot read comes back short of its declared count (a stall)', async () => {
    // PostgREST caps un-ranged selects at 1000 rows with no error. A short
    // read against a larger exact count must surface as an error — never as
    // a confident, wrong call tally. This never reaches MAX_PAGES (it breaks
    // on the very first short/empty page), so it is a SHORTFALL, not a
    // page-budget exhaustion — reload-oriented wording, not "raise the budget".
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
    expect(out.roster.error).toMatch(/short/i);
    expect(out.roster.error).toMatch(/reload/i);
    expect(out.roster.error).not.toMatch(/page budget/i);
  });

  it('errors rather than showing full PTO balances when availability comes back short of its declared count (a stall)', async () => {
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
    expect(out.roster.error).toMatch(/short/i);
    expect(out.roster.error).toMatch(/reload/i);
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

  it('coerces string numeric fte_value/work_days_fte for both the roster row and the tally path, and keeps a null pto_weeks null', async () => {
    // fte_value and work_days_fte are Postgres `numeric` columns and arrive as
    // strings over PostgREST. pto_weeks is `integer` and does NOT — kept as a
    // plain number below; there is nothing to coerce for it.
    //
    // The route coerces fte_value/work_days_fte/pto_weeks TWICE: once building
    // TallyProfile for computeAnnualTally (the tally path), and again,
    // independently, building the RosterRow copy of the same fields (the
    // display path) — see route.helpers.ts. NOTE: annualTally's own helpers
    // (offDayBudgetFor, effectiveWorkDaysFte) also defensively re-coerce
    // fte_value/work_days_fte with their own Number() calls, so the
    // TallyProfile-side coercion here is belt-and-suspenders, not a live bug
    // if it were ever dropped — asserted anyway (via hussain.pto.allotmentDays
    // below) so this test's claim of tally-path coverage is honest, and so a
    // future edit that also removes annualTally's defensive coercion has a
    // second guard.
    const sb = fakeClient({
      provider_employment_profiles: {
        data: [
          {
            provider_id: 'p1', fte_value: '0.8', work_days_fte: '0.9', pto_weeks: null,
            call_taker: true, partial_call_taker: false, home_site_id: SITE,
            providers: { id: 'p1', last_name: 'Jones', short_display_name: 'A.Jones', status: 'active' },
          },
          {
            provider_id: 'p2', fte_value: '1', work_days_fte: null, pto_weeks: 3,
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
    // The TALLY path: a stated pto_weeks reaches ptoFiguresFor as a real
    // number and produces a real allotment (3 weeks x 5 = 15 days) — this is
    // the assertion that actually exercises computeAnnualTally's output,
    // rather than only the RosterRow echo of the same input fields.
    expect(hussain.pto.allotmentDays).toBe(15);
  });

  // ── Fix 1 (CRITICAL): paging past PostgREST's 1000-row cap ─────────────────

  it('assembles a 3-page slot read into one correct call total (genuine multi-page pagination, not a single stubbed call)', async () => {
    const page0 = Array.from({ length: PAGE_SIZE }, () => callRow('p1'));
    const page1 = Array.from({ length: PAGE_SIZE }, () => callRow('p1'));
    const page2 = Array.from({ length: 200 }, () => callRow('p1'));
    const TOTAL = page0.length + page1.length + page2.length; // 2200
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES },
      holiday_calendars: { data: [] },
      shift_types: { data: [{ code: 'C1', call_burden_weight: 1, parent_call_code: null }] },
      provider_availability: { data: [] },
      schedule_slots: { pages: [
        { data: page0, count: TOTAL },
        { data: page1, count: TOTAL },
        { data: page2, count: TOTAL },
      ] },
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    expect(out.roster.error).toBeNull();
    const jones = out.roster.data!.find(r => r.provider_id === 'p1')!;
    // Proves every page's rows reached the tally — a stub that only read
    // page 0 would total 1000, not 2200 (and would in fact have errored: 1000
    // rows against a declared count of 2200 IS a truncation).
    expect(jones.callTotal).toBe(TOTAL);

    const slotCalls = sb.calls.filter(c => c.table === 'schedule_slots');
    expect(slotCalls.length).toBe(3); // exactly 3 round trips — not 1, not 50
    const ranges = slotCalls.map(c => c.filters.find(([m]) => m === 'range')?.[1]);
    // Each call requested a genuinely different .range() window — proof the
    // loop is advancing, not resubmitting page 0.
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('errors rather than assembling a partial tally when a slot read exhausts the page budget', async () => {
    // Every page comes back FULL (never a short page) with a count that keeps
    // claiming there's more — simulating a read genuinely larger than
    // MAX_PAGES x PAGE_SIZE rows. `pages` has one entry, repeated (clamped)
    // for every subsequent call, so all 50 calls are exercised for real.
    const fullPage = Array.from({ length: PAGE_SIZE }, () => callRow('p1'));
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES },
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { data: [] },
      schedule_slots: { pages: [{ data: fullPage, count: MAX_PAGES * PAGE_SIZE + 1 }] },
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    expect(out.roster.data).toBeNull();
    // The EXHAUSTED-branch message: reloading would not help here (every
    // page was full — there's genuinely more data than the budget covers),
    // so it must say "page budget" / "report", never "reload".
    expect(out.roster.error).toMatch(/page budget/i);
    expect(out.roster.error).not.toMatch(/reload/i);
    const slotCalls = sb.calls.filter(c => c.table === 'schedule_slots');
    // Genuinely exhausted the page budget (MAX_PAGES round trips) rather than
    // bailing after the first mismatched count.
    expect(slotCalls.length).toBe(MAX_PAGES);
  });

  it('pages provider_availability past the 1000-row cap too (symmetry with slots)', async () => {
    const ptoRow = (pid: string) => ({
      provider_id: pid, availability_type: 'pto', start_date: '2026-01-05', end_date: '2026-01-05',
      approval_status: 'approved', reason_code: null,
    });
    const page0 = Array.from({ length: PAGE_SIZE }, () => ptoRow('p1'));
    const page1 = [ptoRow('p1')]; // one more row -> a short second page ends it
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES },
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { pages: [
        { data: page0, count: PAGE_SIZE + 1 },
        { data: page1, count: PAGE_SIZE + 1 },
      ] },
      schedule_slots: { data: [] },
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    expect(out.roster.error).toBeNull();
    const availCalls = sb.calls.filter(c => c.table === 'provider_availability');
    expect(availCalls.length).toBe(2); // genuinely paged, not a single call
  });

  it('validates the aggregate against the LAST reported count, not the first — a concurrent insert must not slip through as success', async () => {
    // page 0 looks complete on its own (1000 of 1000). Page 1 (the mandatory
    // follow-up check, since page 0 was exactly full) comes back EMPTY, but
    // the count has grown to 1005 — five rows became visible somewhere in the
    // table after page 0 ran, and this read never fetched them. Using the
    // FIRST count (1000) would read as "1000 of 1000 — done" and silently
    // return an incomplete set; only comparing against the LAST count (1005)
    // catches the shortfall.
    const fullPage = Array.from({ length: PAGE_SIZE }, () => callRow('p1'));
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES },
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { data: [] },
      schedule_slots: { pages: [
        { data: fullPage, count: PAGE_SIZE },     // page 0: 1000 of 1000, looks done
        { data: [], count: PAGE_SIZE + 5 },       // page 1: empty, but the true total grew
      ] },
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    expect(out.roster.data).toBeNull();
    // A concurrent write mid-read is a SHORTFALL, not a budget exhaustion —
    // only 2 calls were made, so "reload" is the right advice, not "raise
    // the page budget".
    expect(out.roster.error).toMatch(/reload/i);
    expect(out.roster.error).not.toMatch(/page budget/i);
    const slotCalls = sb.calls.filter(c => c.table === 'schedule_slots');
    expect(slotCalls.length).toBe(2);
  });

  // ── Nit 4: two correct boundaries the suite would otherwise miss ───────────

  it('a read whose count is an exact multiple of PAGE_SIZE succeeds via one harmless extra empty request', async () => {
    // .range() sets an offset/limit, not a Range header — an offset past the
    // end of the result set returns 200 with an empty array, never a 416. So
    // when the true total is EXACTLY 1000 (one full page), the loop cannot
    // tell it's done without asking once more; that second call comes back
    // empty and the read still succeeds, just with one extra harmless round
    // trip. A future "optimization" that tries to skip that check must not
    // start failing this exact-multiple case.
    const fullPage = Array.from({ length: PAGE_SIZE }, () => callRow('p1'));
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES },
      holiday_calendars: { data: [] },
      shift_types: { data: [{ code: 'C1', call_burden_weight: 1, parent_call_code: null }] },
      provider_availability: { data: [] },
      schedule_slots: { pages: [
        { data: fullPage, count: PAGE_SIZE },
        { data: [], count: PAGE_SIZE }, // the harmless confirmation call
      ] },
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    expect(out.roster.error).toBeNull();
    const jones = out.roster.data!.find(r => r.provider_id === 'p1')!;
    expect(jones.callTotal).toBe(PAGE_SIZE);
    const slotCalls = sb.calls.filter(c => c.table === 'schedule_slots');
    expect(slotCalls.length).toBe(2); // the one extra request, not an error
  });

  it('MAX_PAGES reached with the count exactly satisfied still succeeds (not a false budget failure)', async () => {
    // Every one of MAX_PAGES pages comes back exactly full, and the total
    // (MAX_PAGES x PAGE_SIZE) matches the reported count exactly — a
    // completely legitimate, if large, read. `exhausted` stays true (no page
    // was ever short), but `truncated()` is false (the aggregate matches the
    // count), so this must succeed. This is the boundary a per-page
    // `rows.length >= res.count` termination check (the fetchRollupRows
    // style) needs special-casing to avoid failing; validating the aggregate
    // once, after the loop, does not.
    const TOTAL = MAX_PAGES * PAGE_SIZE;
    const fullPage = Array.from({ length: PAGE_SIZE }, () => callRow('p1'));
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES },
      holiday_calendars: { data: [] },
      shift_types: { data: [{ code: 'C1', call_burden_weight: 1, parent_call_code: null }] },
      provider_availability: { data: [] },
      schedule_slots: { pages: [{ data: fullPage, count: TOTAL }] }, // repeated (clamped) for all 50 calls
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    expect(out.roster.error).toBeNull();
    const jones = out.roster.data!.find(r => r.provider_id === 'p1')!;
    expect(jones.callTotal).toBe(TOTAL);
    const slotCalls = sb.calls.filter(c => c.table === 'schedule_slots');
    expect(slotCalls.length).toBe(MAX_PAGES); // exactly the budget, no more, no error
  });

  // ── Fix 2 (Important): the exact count is what makes truncation detectable ─

  it('requests an exact count on both year-wide reads — dropping it would make truncation undetectable', async () => {
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES },
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { data: [] },
      schedule_slots: { data: [] },
      schedules: { data: [] },
    });
    await loadBlockPrepData(sb, SITE, 2026);
    const hasExactCount = (table: string) => {
      const call = sb.calls.find(c => c.table === table)!;
      const selectCall = call.filters.find(([m]) => m === 'select');
      return !!selectCall && JSON.stringify(selectCall[1]).includes('exact');
    };
    expect(hasExactCount('schedule_slots')).toBe(true);
    expect(hasExactCount('provider_availability')).toBe(true);
  });

  it('treats a missing exact count as unverifiable, never as an all-clear', async () => {
    // If a future edit silently drops `{ count: 'exact' }` from the select,
    // PostgREST returns `count: null` with NO error — this must still error,
    // never render a short read as a complete one.
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES },
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { data: [] },
      schedule_slots: { data: [callRow('p1')], count: null },
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    expect(out.roster.data).toBeNull();
    expect(out.roster.error).toMatch(/count/i);
  });

  // ── Fix 3 (Important): unrostered providers are footnoted, never dropped ───

  it('surfaces unrostered provider ids — a published call for someone the roster query excluded is not silently lost', async () => {
    // Live case (2026-09-06): Orji has a published 2026 call at Paoli but is
    // neither call_taker nor partial_call_taker, so the roster query's
    // .or('call_taker.eq.true,partial_call_taker.eq.true') excludes them
    // while annualCallCounts still counts their call. computeAnnualTally
    // exposes exactly this gap via unrosteredProviderIds; the route must pass
    // it through rather than dropping it on the floor.
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES }, // p1, p2 only — no 'orji'
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { data: [] },
      schedule_slots: { data: [callRow('orji')] },
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    expect(out.roster.error).toBeNull();
    expect(out.roster.data!.map(r => r.provider_id).sort()).toEqual(['p1', 'p2']);
    expect(out.unrosteredProviderIds).toEqual(['orji']);
  });

  it('unrosteredProviderIds is null (not []) when the roster itself failed to load', async () => {
    const sb = fakeClient({
      provider_employment_profiles: { error: { message: 'boom' } },
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { data: [] },
      schedule_slots: { data: [] },
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    expect(out.unrosteredProviderIds).toBeNull();
  });

  // ── Fix 4 (Important): the slots read must not be serialized behind the roster ─

  it('queries schedule_slots concurrently with the roster read, not serialized behind it', async () => {
    // The slots read is scoped only by site_id and date — it doesn't need the
    // roster's provider ids, unlike availability. A serialized implementation
    // would short-circuit on profiles.error before ever reaching it.
    const sb = fakeClient({
      provider_employment_profiles: { error: { message: 'boom' } },
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { data: [] },
      schedule_slots: { data: [] },
      schedules: { data: [] },
    });
    await loadBlockPrepData(sb, SITE, 2026);
    expect(sb.calls.some(c => c.table === 'schedule_slots')).toBe(true);
  });
});
