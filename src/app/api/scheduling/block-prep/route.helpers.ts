// Block Prep board data layer. All DB reads for /block-prep happen here, in one
// function that takes an injected client so it is testable without a database
// (the convention shared by dashboard/queries.ts and the assistant modules).
//
// FAIL-SOFT, NEVER FAKE ZEROS. Each panel carries { data, error }; a failed
// query surfaces its message on that panel and the page renders a Banner. A
// failed availability read fails the WHOLE roster panel, not just its PTO
// columns — coarser than the design spec's finer-grained wording ("a failed
// availability read shows an error in the PTO columns"), which is deliberately
// NOT implemented here: this route's fail-soft grain is per DATA SOURCE
// (roster / blocks), not per COLUMN. Splitting the roster panel into
// column-level sub-panels would be a real feature, not a one-line fix, and the
// spec text is being reconciled separately — don't take it as the contract.
//
// PUBLISHED ONLY (clinical invariant 3). Slot reads go through
// filterPublishedVersions, the single home of that predicate — never re-inline
// the version_status comparison here.
//
// A NOTE ON ARCHIVED SCHEDULES: `DELETE ?archive=true` sets `schedules.status
// = 'archived'` WITHOUT demoting its published version. Such a schedule is
// still `version_status = 'published'`, so it deliberately DOES appear in
// `blocks` and DOES extend `coveredSpan` here — CLAUDE.md's authoritative
// predicate is the published version, regardless of `schedules.status`, and
// this keeps the blocks panel internally consistent with the slot read (both
// go through the identical filterPublishedVersions predicate). Every OTHER
// display surface in the app excludes archived schedules by a separate
// `status` filter, so this panel can show a block the rest of the UI hides —
// a deliberate choice given the invariant, not an oversight.

import { filterPublishedVersions } from '@/lib/rulesEngine/committedAssignments';
import {
  computeAnnualTally, type AnnualTally, type TallyProfile, type TallyShiftType,
} from '@/lib/annualTally';
import type { RosterRow } from '@/lib/blockPrepView';
import type { PlannerAvailabilityRow, PlannerHoliday, PlannerSlotRow } from '@/lib/plannerMath';

// Same loose client type the other DB-coupled modules use at this seam —
// supabase-js's schema generic otherwise rejects the injected client and the
// test fake alike.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchedulingClient = any;

export interface Panel<T> {
  data: T | null;
  error: string | null;
}

export interface PublishedBlock {
  schedule_id: string;
  schedule_name: string;
  date_start: string;
  date_end: string;
}

export interface BlockPrepData {
  site_id: string;
  year: number;
  roster: Panel<RosterRow[]>;
  blocks: Panel<PublishedBlock[]>;
  /** See annualTally.AnnualTally.coveredSpan — carries `segments` so a gapped
   *  coverage range can never be rendered as continuous. */
  coveredSpan: AnnualTally['coveredSpan'];
  /**
   * Provider ids with published call assignments in the year that the roster
   * query excluded — annualTally.AnnualTally.unrosteredProviderIds passed
   * through verbatim, never dropped. Their calls are counted in NEITHER
   * `roster` NOR anywhere else unless surfaced here (the roster's
   * `.or('call_taker.eq.true,partial_call_taker.eq.true')` filter, a mid-year
   * status change, or cross-site coverage can all produce this). Live example
   * (2026-09-06): Orji has a published 2026 call at Paoli but is neither
   * call_taker nor partial_call_taker, so the roster excludes them while
   * annualCallCounts still counts their call. Null exactly when `roster` is
   * null (nothing to footnote against). Empty array, never null, when the
   * roster loaded fine and nobody was left out.
   */
  unrosteredProviderIds: ReadonlyArray<string> | null;
}

const PROFILE_COLUMNS =
  'provider_id, fte_value, work_days_fte, pto_weeks, call_taker, partial_call_taker, home_site_id, '
  + 'providers!inner(id, last_name, short_display_name, status)';

const SLOT_COLUMNS =
  'slot_date, derived_day_type, shift_types!inner(code, category, requires_post_call_rule), '
  + 'assignments(provider_id, assignment_status), schedule_versions!inner(version_status, schedule_id)';

const AVAILABILITY_COLUMNS =
  'provider_id, availability_type, start_date, end_date, approval_status, reason_code';

function msg(e: unknown, what: string): string {
  const m = (e as { message?: string })?.message;
  return `${what} could not be loaded${m ? `: ${m}` : '.'}`;
}

// PostgREST's silent per-request row cap, and the .range() page size for
// paging past it. Live repro (2026-09-06): Paoli has 717 published 2026 slot
// rows for a SINGLE published block (9.3 rows/day) — a second published block
// crosses 1000 and, pre-paging, silently truncated the tally. Same constants
// as dashboard/queries.ts's fetchRollupRows, the house pattern this mirrors.
export const PAGE_SIZE = 1000;
export const MAX_PAGES = 50;

const TRUNCATED_MSG = (what: string) =>
  `${what} could not be loaded in full — the read was truncated even after paging through `
  + `up to ${MAX_PAGES} pages of ${PAGE_SIZE} rows each, so the numbers below would be wrong. `
  + 'This is an engineering issue (the page budget needs raising, or something is producing far '
  + 'more rows than expected) — please report it rather than retrying from this screen.';

const COUNT_UNAVAILABLE_MSG = (what: string) =>
  `${what} could not be verified complete — the read did not report a row count, so it is `
  + 'treated as truncated rather than trusted. This is an engineering issue (an exact count '
  + "option was dropped somewhere), not something fixable by retrying.";

// A truncated OR UNVERIFIABLE read is unsafe — treated identically. PostgREST
// silently caps an un-ranged/short-ranged select at 1000 rows with NO error;
// `count` is what lets a caller tell. A NULL count (e.g. a future edit drops
// `{ count: 'exact' }` from a select) is therefore ALSO "truncated" here, not
// "no evidence of truncation" — same posture as dashboard/queries.ts's
// countPanel, which turns a null head-count into an error rather than a
// good-looking zero. Kept as a plain data/count comparison (rather than
// folded into fetchAllPages) so it stays independently testable.
function truncated(res: { data: unknown; count?: number | null }): boolean {
  const len = Array.isArray(res.data) ? res.data.length : 0;
  return res.count == null || len < res.count;
}

/**
 * Pages a single query via `.range()` until either every row (per the exact
 * count) has been collected or MAX_PAGES is exhausted. Mirrors
 * dashboard/queries.ts's `fetchRollupRows` — the house pattern for a
 * year-wide read past PostgREST's 1000-row cap.
 *
 * `buildPage` must apply a STABLE `.order()` (otherwise `.range()` pages are
 * not guaranteed disjoint/complete — same requirement fetchRollupRows
 * documents) and pass `{ count: 'exact' }` on its `.select()`.
 *
 * Never returns a partial result: a short page is trusted as "the last page"
 * only provisionally — the aggregate is re-checked against the reported exact
 * count once the loop ends (via `truncated()`), so a query that stalls (an
 * empty/short page before the count is satisfied) fails exactly like one that
 * exhausts the whole page budget. A null count is failed closed rather than
 * treated as "nothing to prove" — see `truncated()`.
 */
async function fetchAllPages<T>(
  buildPage: (fromRow: number, toRow: number) => PromiseLike<{
    data: unknown;
    error: { message?: string } | null;
    count?: number | null;
  }>,
  what: string,
): Promise<{ data: T[] | null; error: string | null }> {
  const rows: T[] = [];
  let lastCount: number | null | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const fromRow = page * PAGE_SIZE;
    // eslint-disable-next-line no-await-in-loop -- pages are inherently sequential (.range() offsets)
    const res = await buildPage(fromRow, fromRow + PAGE_SIZE - 1);
    if (res.error) return { data: null, error: msg(res.error, what) };
    lastCount = res.count;
    const batch = (res.data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break; // short page — provisionally the last one
  }
  if (lastCount == null) return { data: null, error: COUNT_UNAVAILABLE_MSG(what) };
  if (truncated({ data: rows, count: lastCount })) return { data: null, error: TRUNCATED_MSG(what) };
  return { data: rows, error: null };
}

export async function loadBlockPrepData(
  sb: SchedulingClient, siteId: string, year: number,
): Promise<BlockPrepData> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const fail = (error: string, blocks: Panel<PublishedBlock[]>): BlockPrepData => ({
    site_id: siteId, year, roster: { data: null, error }, blocks, coveredSpan: null,
    unrosteredProviderIds: null,
  });

  // The slots read is scoped only by `site_id` and the date range — unlike
  // availability, it does NOT depend on the roster's provider ids, so it goes
  // in this first wave too rather than being serialized behind the profile
  // read for no reason. It is the single slowest query in the route
  // (year-wide, three embeds, hundreds to thousands of rows), so serializing
  // it would add a full extra round trip to every load.
  const [profilesRes, holidaysRes, shiftTypesRes, blocksRes, slotsRes] = await Promise.all([
    sb.from('provider_employment_profiles')
      .select(PROFILE_COLUMNS)
      .eq('home_site_id', siteId)
      .eq('providers.status', 'active')
      .or('call_taker.eq.true,partial_call_taker.eq.true'),
    sb.from('holiday_calendars')
      .select('holiday_date, is_major_holiday')
      .gte('holiday_date', from)
      .lte('holiday_date', to),
    sb.from('shift_types')
      .select('code, call_burden_weight, parent_call_code')
      .eq('site_id', siteId),
    // Published predicate goes through the single home, NOT an inline
    // version_status comparison — CLAUDE.md already tolerates two legacy
    // display-layer inlines and this must not become a third.
    filterPublishedVersions(
      sb.from('schedules')
        .select('id, schedule_name, date_start, date_end, schedule_versions!inner(version_status)')
        .eq('site_id', siteId)
        .lte('date_start', to)
        .gte('date_end', from),
      'schedule_versions',
    ),
    fetchAllPages<PlannerSlotRow>(
      (fromRow, toRow) => filterPublishedVersions(
        sb.from('schedule_slots')
          .select(SLOT_COLUMNS, { count: 'exact' })
          .eq('site_id', siteId)
          .gte('slot_date', from)
          .lte('slot_date', to)
          .order('id')
          .range(fromRow, toRow),
        'schedule_versions',
      ),
      'Published assignments',
    ),
  ]);

  const blocks: Panel<PublishedBlock[]> = blocksRes.error
    ? { data: null, error: msg(blocksRes.error, 'Published blocks') }
    : {
      data: (blocksRes.data ?? []).map((s: Record<string, unknown>) => ({
        schedule_id: s.id as string,
        schedule_name: s.schedule_name as string,
        date_start: s.date_start as string,
        date_end: s.date_end as string,
      })),
      error: null,
    };

  // A FAILED BLOCKS READ MUST FAIL THE ROSTER TOO. `coveredSpans` feeds
  // offDaysUsed, and an empty list is indistinguishable from "nothing is
  // published this year" — so passing `blocks.data ?? []` through on error
  // would make the board assert, in Task 5's covered-span label, that no
  // blocks exist, a claim the code never established, while the blocks panel
  // beside it simultaneously shows an error. Same no-silent-clean rule as
  // holidays and shift types below (invariant 6, display-layer form).
  if (blocks.error) return fail(blocks.error, blocks);
  if (profilesRes.error) return fail(msg(profilesRes.error, 'Roster'), blocks);
  if (holidaysRes.error) return fail(msg(holidaysRes.error, 'Holiday calendar'), blocks);
  if (shiftTypesRes.error) return fail(msg(shiftTypesRes.error, 'Shift types'), blocks);
  // slotsRes is already a friendly { data, error: string } shape from
  // fetchAllPages — it owns both the raw-error and the truncation messaging.
  if (slotsRes.error) return fail(slotsRes.error, blocks);

  const rows = (profilesRes.data ?? []) as Array<Record<string, unknown>>;
  const providerIds = rows.map(r => r.provider_id as string);

  // Availability DOES depend on the roster ids (`.in('provider_id', ...)`),
  // so it runs in this second wave, after the roster read.
  //
  // CARRIES AN EXACT COUNT AND PAGES PAST THE 1000-ROW CAP, same reasoning as
  // slots above even though it is far from the cap today — the symmetry is
  // worth more than the saved lines, and a roster this size crossing 1000
  // availability rows in a year is not implausible.
  const availRes = providerIds.length === 0
    ? { data: [] as PlannerAvailabilityRow[], error: null as string | null }
    : await fetchAllPages<PlannerAvailabilityRow>(
      (fromRow, toRow) => sb.from('provider_availability')
        .select(AVAILABILITY_COLUMNS, { count: 'exact' })
        .in('provider_id', providerIds)
        .lte('start_date', to)
        .gte('end_date', from)
        .order('id')
        .range(fromRow, toRow),
      'Availability',
    );

  if (availRes.error) return fail(availRes.error, blocks);

  const profiles: TallyProfile[] = rows.map(r => ({
    provider_id: r.provider_id as string,
    fte_value: r.fte_value == null ? null : Number(r.fte_value),
    work_days_fte: r.work_days_fte == null ? null : Number(r.work_days_fte),
    pto_weeks: r.pto_weeks == null ? null : Number(r.pto_weeks),
  }));

  const shiftTypes = new Map<string, TallyShiftType>(
    ((shiftTypesRes.data ?? []) as Array<Record<string, unknown>>).map(st => [
      st.code as string,
      {
        call_burden_weight: st.call_burden_weight == null ? null : Number(st.call_burden_weight),
        parent_call_code: (st.parent_call_code as string | null) ?? null,
      },
    ]),
  );

  const tally = computeAnnualTally({
    year,
    profiles,
    availability: (availRes.data ?? []) as PlannerAvailabilityRow[],
    slots: (slotsRes.data ?? []) as PlannerSlotRow[],
    holidays: (holidaysRes.data ?? []) as PlannerHoliday[],
    shiftTypes,
    coveredSpans: (blocks.data ?? []).map(b => ({ date_start: b.date_start, date_end: b.date_end })),
  });

  const roster: RosterRow[] = rows.map(r => {
    const pid = r.provider_id as string;
    const p = (r.providers ?? {}) as Record<string, unknown>;
    const figures = tally.providers.get(pid)!;
    return {
      provider_id: pid,
      display_name: (p.short_display_name as string) || (p.last_name as string) || pid,
      last_name: (p.last_name as string) || '',
      fte_value: r.fte_value == null ? null : Number(r.fte_value),
      work_days_fte: r.work_days_fte == null ? null : Number(r.work_days_fte),
      pto_weeks: r.pto_weeks == null ? null : Number(r.pto_weeks),
      call_taker: !!r.call_taker,
      partial_call_taker: !!r.partial_call_taker,
      pto: figures.pto,
      offDayBudget: figures.offDayBudget,
      offDaysUsed: figures.offDaysUsed,
      callCounts: figures.callCounts,
      callTotal: figures.callTotal,
    };
  });

  return {
    site_id: siteId,
    year,
    roster: { data: roster, error: null },
    blocks,
    coveredSpan: tally.coveredSpan,
    unrosteredProviderIds: tally.unrosteredProviderIds,
  };
}
