/* ───────────────────────────────────────────────────────────────────────────
 * Loading one clinician's overview.
 *
 * Six reads, feeding lib/providerOverview's pure builder. Two of them matter
 * more than the rest:
 *
 * 1. THE ASSIGNMENTS are read through `fetchCommittedAssignments`, so the
 *    published-only predicate stays single-homed (clinical invariant 3). A
 *    physician's own page must never count a draft as work they have done.
 *
 * 2. THE OWED SIDE comes from `computeCallObligationCensus` run over the block
 *    that covers today at their home site — the SAME census the schedule grid
 *    and the Call Counts modal use. It is not recomputed here, so what a
 *    physician reads on their profile and what the grid tags OVER cannot
 *    disagree.
 * ─────────────────────────────────────────────────────────────────────────── */

import { readAllRows } from '@/lib/pagedRead';
import { embedArray } from '@/lib/embed';
import { fetchCommittedAssignments } from '@/lib/rulesEngine/committedAssignments';
import { computeCallObligationCensus, type CensusSlot, type CensusProfile } from '@/lib/fteTarget';
import { CallPatternDocSchema, type CallPatternDoc } from '@/lib/rulesEngine/callPattern';
import {
  buildProviderOverview,
  type ProviderOverview, type OverviewAssignment, type OverviewProvider,
  type OverviewProfile, type OverviewSite,
} from '@/lib/providerOverview';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchedulingClient = any;

export interface ProviderOverviewResult {
  provider: OverviewProvider;
  sites: OverviewSite[];
  overview: ProviderOverview;
  /** Non-fatal read failures. A non-empty list means a panel is showing less
   *  than the truth, and the page says so instead of rendering short. */
  errors: string[];
}

const ASSIGNMENT_SELECT =
  'id, schedule_slots!inner(slot_date, site_id, derived_day_type,'
  + ' schedule_versions!inner(version_status),'
  + ' shift_types(code, category, call_rank, parent_call_code, call_burden_weight,'
  + ' start_time, end_time, counts_toward_hours))';

export async function loadProviderOverview(
  sb: SchedulingClient,
  opts: { providerId: string; today: string },
): Promise<ProviderOverviewResult | null> {
  const { providerId, today } = opts;
  const errors: string[] = [];
  const yearStart = `${today.slice(0, 4)}-01-01`;

  const [providerRes, profileRes, sitesRes, credsRes, availRes] = await Promise.all([
    sb.from('providers')
      .select('id, first_name, last_name, short_display_name, provider_type, status')
      .eq('id', providerId).maybeSingle(),
    sb.from('provider_employment_profiles')
      .select('employment_status, fte_value, work_days_fte, pto_weeks, is_shareholder,'
        + ' is_partner_track, home_site_id, call_taker, partial_call_taker')
      .eq('provider_id', providerId).maybeSingle(),
    readAllRows<OverviewSite>((f, t) => sb.from('sites')
      .select('id, name, short_name', { count: 'exact' })
      .eq('is_active', true).order('display_order').order('name').range(f, t), 'sites'),
    readAllRows<{ site_id: string; is_active: boolean | null; credentialed: boolean | null;
      effective_start_date: string | null; effective_end_date: string | null }>(
      (f, t) => sb.from('provider_site_credentials')
        .select('site_id, is_active, credentialed, effective_start_date, effective_end_date',
          { count: 'exact' })
        .eq('provider_id', providerId).order('site_id').range(f, t), 'credentials'),
    readAllRows<{ availability_type: string; approval_status: string;
      start_date: string; end_date: string }>(
      (f, t) => sb.from('provider_availability')
        .select('availability_type, approval_status, start_date, end_date', { count: 'exact' })
        .eq('provider_id', providerId).order('start_date').range(f, t), 'availability'),
  ]);

  if (providerRes.error) throw new Error(`provider: ${providerRes.error.message}`);
  if (!providerRes.data) return null;
  // A missing employment profile is legitimate (several roster rows have none);
  // a FAILED read is not, and must not render as "no employment on file".
  if (profileRes.error) errors.push(`employment profile: ${profileRes.error.message}`);
  for (const r of [sitesRes, credsRes, availRes]) if (r.error) errors.push(r.error);

  const profile: OverviewProfile | null = profileRes.data ?? null;

  // ── Assignments, published only, this calendar year ─────────────────────
  const { data: rawAssignments, error: assignError } = await fetchCommittedAssignments(
    sb, ASSIGNMENT_SELECT, { providerId, start: yearStart, end: today });
  if (assignError) errors.push(`assignments: ${assignError.message}`);

  const assignments: OverviewAssignment[] = [];
  for (const row of rawAssignments ?? []) {
    const slot = embedArray(row.schedule_slots as never)[0] as Record<string, unknown> | undefined;
    if (!slot) continue;
    const st = embedArray(slot.shift_types as never)[0] as Record<string, unknown> | undefined;
    assignments.push({
      date: String(slot.slot_date),
      siteId: String(slot.site_id),
      code: String(st?.code ?? ''),
      category: String(st?.category ?? ''),
      callRank: (st?.call_rank as number | null) ?? null,
      parentCode: (st?.parent_call_code as string | null) ?? null,
      callBurdenWeight: (st?.call_burden_weight as number | null) ?? null,
      startTime: (st?.start_time as string | null) ?? null,
      endTime: (st?.end_time as string | null) ?? null,
      dayType: (slot.derived_day_type as string | null) ?? null,
      countsTowardHours: (st?.counts_toward_hours as boolean | null) ?? true,
    });
  }

  // ── The owed side, from the block covering today at the home site ───────
  let owedByCategory: ReadonlyMap<string, number> | null = null;
  let blockLabel: string | null = null;
  let blockRange: { start: string; end: string } | null = null;
  let neuroCode: string | null = null;

  const homeSiteId = profile?.home_site_id ?? null;
  if (homeSiteId) {
    const block = await loadCurrentBlock(sb, homeSiteId, today);
    if (block.error) errors.push(block.error);
    if (block.versionId) {
      const census = computeCallObligationCensus({
        storedParLevel: block.parLevel ?? 12,
        siteId: homeSiteId,
        includedProviderIds: block.includedProviderIds,
        profiles: block.profiles,
        slots: block.slots,
        callPattern: block.pattern,
      });
      owedByCategory = census.statedBucketsFor(providerId);
      blockLabel = block.label;
      blockRange = block.range;
      neuroCode = block.pattern?.neuroWeekend?.code ?? null;
    }
  }

  return {
    provider: providerRes.data,
    sites: sitesRes.rows,
    errors,
    overview: buildProviderOverview({
      today,
      provider: providerRes.data,
      profile,
      assignments,
      availability: availRes.rows,
      credentials: credsRes.rows,
      sites: sitesRes.rows,
      owedByCategory,
      blockLabel,
      blockRange,
      neuroCode,
    }),
  };
}

/** The published block covering `today` at a site, with everything the census
 *  needs. Returns an empty result — not an error — when no block covers today:
 *  between blocks is a normal state, and it simply means there is no stated
 *  obligation to show yet. */
async function loadCurrentBlock(
  sb: SchedulingClient, siteId: string, today: string,
): Promise<{
  versionId: string | null; label: string | null;
  range: { start: string; end: string } | null; parLevel: number | null;
  includedProviderIds: string[] | undefined; slots: CensusSlot[];
  profiles: CensusProfile[]; pattern: CallPatternDoc | null; error: string | null;
}> {
  const empty = {
    versionId: null, label: null, range: null, parLevel: null, includedProviderIds: undefined,
    slots: [] as CensusSlot[], profiles: [] as CensusProfile[], pattern: null, error: null,
  };

  const { data: sched, error: schedError } = await sb.from('schedules')
    .select('id, schedule_name, date_start, date_end, included_provider_ids,'
      + ' sites(call_par_level), schedule_versions(id, version_status)')
    .eq('site_id', siteId).eq('status', 'published')
    .lte('date_start', today).gte('date_end', today)
    .order('date_start', { ascending: false }).limit(1);
  if (schedError) return { ...empty, error: `current block: ${schedError.message}` };
  const row = (sched ?? [])[0] as Record<string, unknown> | undefined;
  if (!row) return empty;

  const version = embedArray(row.schedule_versions as never)
    .find((v: Record<string, unknown>) => v.version_status === 'published') as
      { id: string } | undefined;
  if (!version) return empty;

  const site = embedArray(row.sites as never)[0] as { call_par_level?: number } | undefined;

  const [slotRes, profileRes, patternRes] = await Promise.all([
    readAllRows<Record<string, unknown>>((f, t) => sb.from('schedule_slots')
      .select('slot_date, derived_day_type,'
        + ' shift_types(code, category, call_burden_weight, parent_call_code),'
        + ' assignments(id, provider_id)', { count: 'exact' })
      .eq('schedule_version_id', version.id).order('slot_date').order('id').range(f, t),
      'block slots'),
    readAllRows<CensusProfile>((f, t) => sb.from('provider_employment_profiles')
      .select('provider_id, home_site_id, call_taker, partial_call_taker, fte_value',
        { count: 'exact' })
      .order('provider_id').range(f, t), 'block profiles'),
    sb.from('call_patterns').select('definition')
      .eq('site_id', siteId).eq('status', 'active').maybeSingle(),
  ]);

  const error = slotRes.error ?? profileRes.error
    ?? (patternRes.error ? `call pattern: ${patternRes.error.message}` : null);

  // A doc that fails the schema is null, matching the engine, which silently
  // falls back to CLASSIC_PATTERN rather than erroring.
  const parsed = patternRes.data?.definition
    ? CallPatternDocSchema.safeParse(patternRes.data.definition)
    : null;

  return {
    versionId: version.id,
    label: String(row.schedule_name ?? `${row.date_start} – ${row.date_end}`),
    range: { start: String(row.date_start), end: String(row.date_end) },
    parLevel: site?.call_par_level ?? null,
    includedProviderIds: (row.included_provider_ids as string[] | null) ?? undefined,
    slots: slotRes.rows.map(s => ({
      slot_date: String(s.slot_date),
      derived_day_type: (s.derived_day_type as string | null) ?? null,
      shift_types: embedArray(s.shift_types as never)[0] ?? null,
      assignments: embedArray(s.assignments as never),
    })) as CensusSlot[],
    profiles: profileRes.rows,
    pattern: parsed?.success ? parsed.data : null,
    error,
  };
}
