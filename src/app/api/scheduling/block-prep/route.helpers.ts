// Block Prep board data layer. All DB reads for /block-prep happen here, in one
// function that takes an injected client so it is testable without a database
// (the convention shared by dashboard/queries.ts and the assistant modules).
//
// FAIL-SOFT, NEVER FAKE ZEROS. Each panel carries { data, error }; a failed
// query surfaces its message on that panel and the page renders a Banner. A
// failed availability read must NOT quietly render everyone at full PTO
// remaining — the same no-silent-clean ethos as EvaluateResult.evaluated.
//
// PUBLISHED ONLY (clinical invariant 3). Slot reads go through
// filterPublishedVersions, the single home of that predicate — never re-inline
// the version_status comparison here.

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
}

const PROFILE_COLUMNS =
  'provider_id, fte_value, work_days_fte, pto_weeks, call_taker, partial_call_taker, home_site_id, '
  + 'providers!inner(id, last_name, short_display_name, status)';

const SLOT_COLUMNS =
  'slot_date, derived_day_type, shift_types!inner(code, category, requires_post_call_rule), '
  + 'assignments(provider_id, assignment_status), schedule_versions!inner(version_status, schedule_id)';

function msg(e: unknown, what: string): string {
  const m = (e as { message?: string })?.message;
  return `${what} could not be loaded${m ? `: ${m}` : '.'}`;
}

const TRUNCATED_MSG = (what: string) =>
  `${what} could not be loaded in full — the read was truncated, so the numbers `
  + 'below would be wrong. This usually means the year has more rows than a single '
  + 'request returns; narrow the year or page the read.';

// PostgREST silently caps un-ranged selects at 1000 rows and reports NO error.
// Same predicate as planner/route.ts:92-97 — a short read against an exact
// count is a truncation, and a truncation must never be rendered as data.
function truncated(res: { data: unknown; count?: number | null }): boolean {
  const len = Array.isArray(res.data) ? res.data.length : 0;
  return res.count != null && len < res.count;
}

export async function loadBlockPrepData(
  sb: SchedulingClient, siteId: string, year: number,
): Promise<BlockPrepData> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const [profilesRes, holidaysRes, shiftTypesRes, blocksRes] = await Promise.all([
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
  if (blocks.error) {
    return { site_id: siteId, year, roster: { data: null, error: blocks.error }, blocks, coveredSpan: null };
  }
  if (profilesRes.error) {
    return { site_id: siteId, year, roster: { data: null, error: msg(profilesRes.error, 'Roster') }, blocks, coveredSpan: null };
  }
  if (holidaysRes.error) {
    return { site_id: siteId, year, roster: { data: null, error: msg(holidaysRes.error, 'Holiday calendar') }, blocks, coveredSpan: null };
  }
  if (shiftTypesRes.error) {
    return { site_id: siteId, year, roster: { data: null, error: msg(shiftTypesRes.error, 'Shift types') }, blocks, coveredSpan: null };
  }

  const rows = (profilesRes.data ?? []) as Array<Record<string, unknown>>;
  const providerIds = rows.map(r => r.provider_id as string);

  // Both of these depend on the roster ids, so they run after it.
  //
  // BOTH CARRY AN EXACT COUNT. PostgREST silently caps an un-ranged select at
  // 1000 rows with NO error, and both of these are year-wide: measured against
  // the live DB on 2026-09-06 there are 717 published 2026 slot rows for Paoli
  // across a single published block (9.3 rows/day), so a SECOND published block
  // crosses the cap and the tally starts silently under-counting calls. The
  // planner route already hardened against exactly this — see `truncated()` in
  // `src/app/api/scheduling/planner/route.ts:92-97` and its test
  // "truncated slot reads are a 500, never wrong actuals".
  const [availRes, slotsRes] = await Promise.all([
    providerIds.length === 0
      ? Promise.resolve({ data: [], error: null, count: 0 })
      : sb.from('provider_availability')
        .select('provider_id, availability_type, start_date, end_date, approval_status, reason_code',
          { count: 'exact' })
        .in('provider_id', providerIds)
        .lte('start_date', to)
        .gte('end_date', from),
    filterPublishedVersions(
      sb.from('schedule_slots')
        .select(SLOT_COLUMNS, { count: 'exact' })
        .eq('site_id', siteId)
        .gte('slot_date', from)
        .lte('slot_date', to),
      'schedule_versions',
    ),
  ]);

  if (availRes.error) {
    return { site_id: siteId, year, roster: { data: null, error: msg(availRes.error, 'Availability') }, blocks, coveredSpan: null };
  }
  if (slotsRes.error) {
    return { site_id: siteId, year, roster: { data: null, error: msg(slotsRes.error, 'Published assignments') }, blocks, coveredSpan: null };
  }
  // A truncated read becomes an ERROR, never an undercount rendered as fact.
  // This is the display-layer form of invariant 6: the board must not report a
  // confident number it could not actually compute.
  if (truncated(availRes)) {
    return { site_id: siteId, year, roster: { data: null, error: TRUNCATED_MSG('Availability') }, blocks, coveredSpan: null };
  }
  if (truncated(slotsRes)) {
    return { site_id: siteId, year, roster: { data: null, error: TRUNCATED_MSG('Published assignments') }, blocks, coveredSpan: null };
  }

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
  };
}
