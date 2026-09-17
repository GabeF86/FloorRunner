/* ───────────────────────────────────────────────────────────────────────────
 * Operations board — data layer.
 *
 * Six paged reads, one envelope. Every read is either complete or an error:
 * `readAllRows` never hands back a partial array with a null error, and this
 * module never renders around a missing read. The reason is specific to this
 * page — a truncated slot read would not look broken, it would look like
 * COVERAGE. Rooms would silently vanish from the "needed" side and a short day
 * would render green.
 *
 * PUBLISHED ONLY (clinical invariant 3): what back office needs to see is what
 * is actually committed, so the slot read filters to published versions
 * through filterPublishedVersions — the single home of that predicate. A draft
 * is a hypothetical and must never show up as somebody's Tuesday.
 * ─────────────────────────────────────────────────────────────────────────── */

import { readAllRows } from '@/lib/pagedRead';
import { embedArray } from '@/lib/embed';
import { filterPublishedVersions } from '@/lib/rulesEngine/committedAssignments';
import { addDays } from '@/lib/rulesEngine/shared';
import {
  resolveDemand, parseWeekendCall, type DemandRow, type WeekendCall,
} from '@/lib/staffingDemand';
import {
  coverageWeek, perDiemBench, siteDayBoard, rosterSummary, weekDates, transferPicture,
  type CoverageRow, type BenchSummary, type SiteDayBoard, type RosterSummary,
  type TransferPicture,
  type OpsSlotRow, type OpsSiteRow, type OpsProviderRow,
  type OpsProfileRow, type OpsCredentialRow, type OpsAvailRow,
} from '@/lib/operationsBoard';

// Same loose client seam the other DB-coupled modules use — supabase-js's
// schema generic otherwise rejects both the injected client and the test fake.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchedulingClient = any;

export interface OperationsData {
  /** The day the bench and the floor cards are about. */
  date: string;
  /** Monday-first week containing `date`. */
  dates: string[];
  coverage: CoverageRow[];
  /** Who could move from a site with staff to spare to one that is short,
   *  for `date`. Staff sharing here is daily. */
  transfers: TransferPicture;
  bench: BenchSummary;
  boards: SiteDayBoard[];
  summary: RosterSummary;
  /** Per-read failures. A non-empty list means some panel is showing less than
   *  the truth, and the page says so rather than quietly rendering short. */
  errors: string[];
}

const SLOT_SELECT =
  'site_id, slot_date, required_count,'
  + ' schedule_versions!inner(version_status),'
  + ' shift_types(code, name, category, provider_group, call_rank,'
  + ' start_time, end_time, requires_post_call_rule),'
  + ' assignments(provider_id)';

/** PostgREST hands an embed back as an object or an array depending on whether
 *  the DB carries the UNIQUE(schedule_slot_id) constraint — normalise both. */
function normaliseSlot(row: Record<string, unknown>): OpsSlotRow {
  const shift = embedArray(row.shift_types as never)[0] ?? null;
  return {
    site_id: String(row.site_id),
    slot_date: String(row.slot_date),
    required_count: row.required_count as number | null,
    shift_types: shift,
    assignments: embedArray(row.assignments as never),
  };
}

export async function loadOperationsData(
  sb: SchedulingClient,
  opts: { date: string },
): Promise<OperationsData> {
  const date = opts.date;
  const dates = weekDates(date);
  // One day either side: the day BEFORE the week for the post-call check, the
  // day AFTER for "off today, back tomorrow".
  const from = addDays(dates[0], -1);
  const to = addDays(dates[6], 1);
  const errors: string[] = [];

  const [sitesRes, providersRes, profilesRes, credsRes, availRes, demandRes, slotRes] = await Promise.all([
    readAllRows<OpsSiteRow>((f, t) => sb.from('sites')
      .select('id, name, short_name, operational_days, weekend_staffing,'
        + ' display_order, is_active', { count: 'exact' })
      .eq('is_active', true)
      .order('display_order').order('name').range(f, t), 'sites'),

    readAllRows<OpsProviderRow>((f, t) => sb.from('providers')
      .select('id, provider_type, short_display_name, first_name, last_name', { count: 'exact' })
      .eq('status', 'active')
      .order('last_name').order('id').range(f, t), 'providers'),

    readAllRows<OpsProfileRow>((f, t) => sb.from('provider_employment_profiles')
      .select('provider_id, employment_status, home_site_id', { count: 'exact' })
      .order('provider_id').range(f, t), 'employment profiles'),

    readAllRows<OpsCredentialRow>((f, t) => sb.from('provider_site_credentials')
      .select('provider_id, site_id, is_active, credentialed,'
        + ' effective_start_date, effective_end_date', { count: 'exact' })
      .order('provider_id').order('site_id').range(f, t), 'site credentials'),

    // Any row OVERLAPPING the window, not just one starting inside it — a
    // three-week PTO block that began last month still covers Tuesday.
    readAllRows<OpsAvailRow>((f, t) => sb.from('provider_availability')
      .select('provider_id, availability_type, approval_status, start_date, end_date',
        { count: 'exact' })
      .lte('start_date', to).gte('end_date', from)
      .order('provider_id').order('start_date').range(f, t), 'availability'),

    readAllRows<DemandRow>((f, t) => sb.from('staffing_demand')
      .select('site_id, demand_date, md_needed, crna_needed, source, notes', { count: 'exact' })
      .gte('demand_date', dates[0]).lte('demand_date', dates[6])
      .order('demand_date').order('site_id').range(f, t), 'staffing demand'),

    readAllRows<Record<string, unknown>>((f, t) => filterPublishedVersions(
      sb.from('schedule_slots')
        .select(SLOT_SELECT, { count: 'exact' })
        .gte('slot_date', from).lte('slot_date', to)
        .order('slot_date').order('id').range(f, t),
      'schedule_versions',
    ), 'schedule slots'),
  ]);

  for (const r of [sitesRes, providersRes, profilesRes, credsRes, availRes, demandRes, slotRes]) {
    if (r.error) errors.push(r.error);
  }

  const sites = sitesRes.rows;
  const providers = providersRes.rows;

  // Weekend call is structural — the positions that must be covered every
  // Saturday and Sunday whatever the OR is doing — so it is configured once
  // per site rather than typed in week after week.
  const weekendCall = new Map<string, WeekendCall>();
  for (const s of sites as Array<OpsSiteRow & { weekend_staffing?: unknown }>) {
    const wc = parseWeekendCall(s.weekend_staffing);
    if (wc) weekendCall.set(s.id, wc);
  }
  const slots = slotRes.rows.map(normaliseSlot);

  const bench = perDiemBench({
    date, providers, sites,
    profiles: profilesRes.rows,
    credentials: credsRes.rows,
    availability: availRes.rows,
    slots,
  });

  const coverage = coverageWeek({
      sites, slots, providers, dates,
      // Manual beats calculated beats the standing weekend complement; an
      // absent entry is "not stated", never zero.
      demand: resolveDemand(demandRes.rows),
      weekendCall,
  });

  return {
    date,
    dates,
    coverage,
    transfers: transferPicture({
      date, coverage, slots, providers, credentials: credsRes.rows,
    }),
    bench,
    boards: siteDayBoard({ date, sites, slots, providers }),
    summary: {
      ...rosterSummary({
        date, providers,
        profiles: profilesRes.rows,
        availability: availRes.rows,
        slots,
        freeToday: bench.freeToday,
      }),
      sites: sites.length,
    },
    errors,
  };
}
