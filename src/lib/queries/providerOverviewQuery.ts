/* ───────────────────────────────────────────────────────────────────────────
 * Loading one clinician's overview.
 *
 * Seven reads, feeding lib/providerOverview's pure builder. Three of them
 * matter more than the rest:
 *
 * 1. THE ASSIGNMENTS are read through `fetchCommittedAssignments`, so the
 *    published-only predicate stays single-homed (clinical invariant 3). A
 *    physician's own page must never count a draft as work they have done.
 *
 * 2. THE OWED SIDE comes from the block covering today at their home site,
 *    scaled by the house formula: (that category's slot weight ÷
 *    sites.call_par_level) × the provider's call-pool FTE. The block's slate
 *    and the provider's pool FTE both come from `computeCallObligationCensus`
 *    — the SAME census the schedule grid and the Call Counts modal use — so
 *    what a physician reads on their profile and what the grid tags OVER
 *    cannot disagree. The stated per-FTE BANDS this used to read were deleted
 *    from the pattern docs on 2026-09-22; `statedBucketsFor` consequently
 *    returned null for everyone, which is why every owed cell rendered "—".
 *
 * 3. THE EXTRAS are chosen by the shared over-par machinery
 *    (`selectOverParAssignmentIds` → `extraCallsByBucketCode`), run ONCE PER
 *    CATEGORY against that category's own obligation. That is the no-netting
 *    rule: being short on Sun C2 does not pay for an extra M–Th C1.
 *
 * ── WHICH BLOCK, AND WHOSE CALL (2026-09-22) ───────────────────────────────
 * Every site now publishes TWO overlapping master schedules — a physician one
 * and a CRNA one, both starting 2026-09-01 — so "the published schedule
 * covering today at this site" is ambiguous and the old ORDER BY date_start
 * LIMIT 1 could hand a physician the CRNA block. The schedule is therefore
 * matched on `schedules.provider_group` against `providers.provider_type`, and
 * the block's call slots are additionally filtered by
 * `shift_types.provider_group`. NOT by `schedule_slots.provider_group`, which
 * is 'both' on all 7,188 live rows and carries no information.
 *
 * ── AND NEVER A CONFIDENT ZERO ─────────────────────────────────────────────
 * Anything that could not be read is reported in `errors` and left null in the
 * payload. An owed column of dashes means "not derived"; an owed column of
 * zeros would mean "you owe nothing", and they are different sentences.
 * ─────────────────────────────────────────────────────────────────────────── */

import { readAllRows } from '@/lib/pagedRead';
import { embedArray } from '@/lib/embed';
import {
  fetchCommittedAssignments, filterPublishedVersions,
} from '@/lib/rulesEngine/committedAssignments';
import {
  computeCallObligationCensus, overParBucketKey, selectOverParAssignmentIds,
  type CensusSlot, type CensusProfile, type OverParCall,
} from '@/lib/fteTarget';
import {
  extraCallsByBucketCode, type CallCountSlotRow,
} from '@/lib/callCountColumns';
import { CallPatternDocSchema, type CallPatternDoc } from '@/lib/rulesEngine/callPattern';
import { owedUnitsFor } from '@/lib/rulesEngine/neuroWeekend';
import {
  buildProviderOverview, perCategoryOwed,
  type ProviderOverview, type OverviewAssignment, type OverviewProvider,
  type OverviewProfile, type OverviewSite, type OwedInputs,
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
  + ' start_time, end_time, counts_toward_hours, counts_toward_call_burden,'
  + ' provider_group))';

/** The schedule provider_group a person's work lives under. */
function groupForProviderType(providerType: string | null | undefined): 'crna' | 'physician' {
  return providerType === 'crna' ? 'crna' : 'physician';
}

export async function loadProviderOverview(
  sb: SchedulingClient,
  opts: { providerId: string; today: string },
): Promise<ProviderOverviewResult | null> {
  const { providerId, today } = opts;
  const errors: string[] = [];
  const yearStart = `${today.slice(0, 4)}-01-01`;

  const [providerRes, profileRes, sitesRes, credsRes, availRes, horizonRes] = await Promise.all([
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
    // The publication horizon: the first date any PUBLISHED version covers.
    // Published data only begins 2026-09-01, so a total labelled "YTD" without
    // this is a year's worth of claim over three weeks of data. Routed through
    // filterPublishedVersions so the committed predicate keeps one home.
    filterPublishedVersions(
      sb.from('schedules').select('date_start, schedule_versions!inner(version_status)')
        .is('deleted_at', null)
        .order('date_start', { ascending: true }).limit(1),
      'schedule_versions',
    ),
  ]);

  if (providerRes.error) throw new Error(`provider: ${providerRes.error.message}`);
  if (!providerRes.data) return null;
  // A missing employment profile is legitimate (several roster rows have none);
  // a FAILED read is not, and must not render as "no employment on file".
  if (profileRes.error) errors.push(`employment profile: ${profileRes.error.message}`);
  for (const r of [sitesRes, credsRes, availRes]) if (r.error) errors.push(r.error);
  if (horizonRes.error) errors.push(`published range: ${horizonRes.error.message}`);

  const profile: OverviewProfile | null = profileRes.data ?? null;
  const provider: OverviewProvider = providerRes.data;
  const providerGroup = groupForProviderType(provider.provider_type);
  const publishedFrom = (horizonRes.data?.[0]?.date_start as string | undefined) ?? null;

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
      countsTowardCallBurden: (st?.counts_toward_call_burden as boolean | null) ?? null,
      shiftProviderGroup: (st?.provider_group as string | null) ?? null,
    });
  }

  // ── The owed side, from the block covering today at the home site ───────
  let owed: OwedInputs | null = null;
  let extrasByCategory: Map<string, number> | null = null;
  let blockLabel: string | null = null;
  let blockRange: { start: string; end: string } | null = null;
  let neuroCode: string | null = null;
  let neuroOwedWeekends: number | null = null;

  const homeSiteId = profile?.home_site_id ?? null;
  if (homeSiteId) {
    const block = await loadCurrentBlock(sb, homeSiteId, today, providerGroup);
    if (block.error) errors.push(block.error);
    if (block.versionId) {
      blockLabel = block.label;
      blockRange = block.range;
      neuroCode = block.pattern?.neuroWeekend?.code ?? null;

      if (block.parLevel == null) {
        // Par-authoritative means there is no substitute for the stored value.
        // Defaulting to 12 here would print an obligation the site never set.
        errors.push('call par level: not set for this site — the owed column is not shown');
      } else {
        const census = computeCallObligationCensus({
          storedParLevel: block.parLevel,
          siteId: homeSiteId,
          includedProviderIds: block.includedProviderIds,
          profiles: block.profiles,
          slots: block.slots,
          callPattern: block.pattern,
        });
        if (!census.bucketSlotWeight) {
          // All-or-nothing, as everywhere else: a call slot with no day type
          // makes every bucket total suspect, and a short denominator would
          // understate what is owed rather than fail visibly.
          errors.push('block slots: a call slot carries no day type — the owed column is not shown');
        } else {
          const callFte = census.poolFteFor(providerId);
          owed = {
            parLevel: census.effectivePar,
            callFte,
            inCallPool: callFte > 0,
            bucketSlotWeight: census.bucketSlotWeight,
          };
          // The neuro tier's requirement bands survived the 2026-09-22 deletion
          // of the call obligation bands — Paoli still states one weekend per
          // call taker, and the solver still places by it — so the owed side
          // reads the SAME band the engine does. Outside the call pool nobody
          // owes a neuro weekend, whatever the lowest band's minFte says.
          const neuroCfg = block.pattern?.neuroWeekend ?? null;
          if (neuroCfg) neuroOwedWeekends = callFte > 0 ? owedUnitsFor(callFte, neuroCfg) : 0;
          const extras = computeExtrasByCategory(
            providerId, census.callRecords, block.slots, owed,
            // A stated weekend requirement is ONE CALL on each neuro day the
            // block stands, so the extras threshold is the same number the
            // panel prints — otherwise a doc could be told they owe one
            // weekend and be charged for a pickup on the day they worked it.
            neuroCfg && neuroOwedWeekends !== null
              ? { code: neuroCfg.code, owedPerDay: neuroOwedWeekends }
              : null,
          );
          extrasByCategory = extras.byCategory;
          if (extras.unbucketed > 0) {
            errors.push(`additional calls: ${extras.unbucketed} block call(s) carry no day type`
              + ' and are not in the picked-up tally');
          }
        }
      }
    }
  }

  return {
    provider,
    sites: sitesRes.rows,
    errors,
    overview: buildProviderOverview({
      today,
      provider,
      profile,
      assignments,
      availability: availRes.rows,
      credentials: credsRes.rows,
      sites: sitesRes.rows,
      owed,
      extrasByCategory,
      blockLabel,
      blockRange,
      neuroCode,
      neuroOwedWeekends,
      publishedFrom,
      readsComplete: errors.length === 0,
    }),
  };
}

/** Calls held PAST the obligation, per `bucket|code`.
 *
 * NO NETTING (Gabriel, 2026-08-03 and restated 2026-09-22): each category is
 * judged ON ITS OWN against its own obligation, so a provider can be over on
 * M–Th C1 while short on Sun C2 and both are true — the day types price
 * differently and must never cancel.
 *
 * WHAT IS "EXTRA" IS NOT REINTERPRETED HERE. The selection is the shared
 * `selectOverParAssignmentIds` (which rounds the obligation through
 * `roundedObligation`, so an owed of 2.6 is met by 3 and only the 4th call is
 * a pickup, and picks the minimal-weight set of whole assignments to flag),
 * and the day-type grouping is `extraCallsByBucketCode`, the same function
 * behind the Call Counts modal's Extra Calls columns.
 *
 * Exported because it is the one piece of arithmetic in this module: it takes
 * plain records and slots, so it is unit-testable without a database. */
export function computeExtrasByCategory(
  providerId: string,
  callRecords: ReadonlyArray<OverParCall>,
  slots: ReadonlyArray<CensusSlot>,
  owed: OwedInputs,
  /** The site's stated neuro requirement, as calls per neuro day the block
   *  stands (one weekend unit = one call on each of its days). Null ⇒ the
   *  neuro code is judged by the par formula like any other category. */
  neuro?: { code: string; owedPerDay: number } | null,
): { byCategory: Map<string, number>; unbucketed: number } {
  const owedByCategory = perCategoryOwed(owed.bucketSlotWeight, owed.parLevel, owed.callFte);
  if (neuro) {
    for (const key of owedByCategory.keys()) {
      if (key.slice(key.lastIndexOf('|') + 1) === neuro.code) {
        owedByCategory.set(key, neuro.owedPerDay);
      }
    }
  }
  const mine = callRecords.filter(r => r.provider_id === providerId);

  const byBucket = new Map<string, OverParCall[]>();
  let unbucketed = 0;
  for (const rec of mine) {
    if (!rec.bucket) { unbucketed++; continue; }
    const key = overParBucketKey(rec.bucket, rec.parent_code || rec.shift_type_code);
    const list = byBucket.get(key);
    if (list) list.push(rec); else byBucket.set(key, [rec]);
  }

  const overIds = new Set<string>();
  for (const [key, calls] of byBucket) {
    const target = owedByCategory.get(key) ?? 0;
    for (const id of selectOverParAssignmentIds(calls, () => target)) overIds.add(id);
  }

  const slotRows: CallCountSlotRow[] = slots.map(s => ({
    slot_date: s.slot_date,
    derived_day_type: s.derived_day_type ?? '',
    shift_types: s.shift_types,
    assignments: s.assignments ?? null,
  }));
  const tallied = extraCallsByBucketCode(slotRows, mine, overIds);

  const prefix = `${providerId}|`;
  const byCategory = new Map<string, number>();
  for (const [key, weight] of Object.entries(tallied)) {
    if (!key.startsWith(prefix)) continue;
    byCategory.set(key.slice(prefix.length), weight);
  }
  return { byCategory, unbucketed };
}

/** The published block covering `today` at a site FOR THIS DISCIPLINE, with
 *  everything the census needs. Returns an empty result — not an error — when
 *  no block covers today: between blocks is a normal state, and it simply
 *  means there is no obligation to show yet. */
async function loadCurrentBlock(
  sb: SchedulingClient, siteId: string, today: string, providerGroup: 'physician' | 'crna',
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

  // A site publishes a physician master AND a CRNA master over the same dates,
  // so the discipline is part of "which block covers today" — without it the
  // ordering picks one at random and a physician's obligation gets scaled off
  // CRNA slots.
  const { data: sched, error: schedError } = await sb.from('schedules')
    .select('id, schedule_name, date_start, date_end, included_provider_ids, provider_group,'
      + ' sites(call_par_level), schedule_versions(id, version_status)')
    .eq('site_id', siteId).eq('status', 'published')
    .is('deleted_at', null)                         // patch62 soft delete
    .in('provider_group', [providerGroup, 'both'])
    .lte('date_start', today).gte('date_end', today)
    .order('date_start', { ascending: false }).limit(1);
  if (schedError) return { ...empty, error: `current block: ${schedError.message}` };
  const row = (sched ?? [])[0] as Record<string, unknown> | undefined;
  if (!row) return empty;

  const version = embedArray(row.schedule_versions as never)
    .find((v: Record<string, unknown>) => v.version_status === 'published') as
      { id: string } | undefined;
  if (!version) return empty;

  const site = embedArray(row.sites as never)[0] as { call_par_level?: number | null } | undefined;

  const [slotRes, profileRes, patternRes] = await Promise.all([
    readAllRows<Record<string, unknown>>((f, t) => sb.from('schedule_slots')
      .select('slot_date, derived_day_type,'
        + ' shift_types(code, category, call_burden_weight, parent_call_code, provider_group),'
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

  // The block's own slate, narrowed to this discipline's shift types. A
  // physician block holds only physician + 'both' types today, so this changes
  // nothing live; it is here because the day the two are mixed into one
  // schedule, a CRNA beeper slot must not enlarge a physician's obligation.
  const slots = slotRes.rows.map(s => ({
    slot_date: String(s.slot_date),
    derived_day_type: (s.derived_day_type as string | null) ?? null,
    shift_types: embedArray(s.shift_types as never)[0] ?? null,
    assignments: embedArray(s.assignments as never),
  })) as Array<CensusSlot & { shift_types: { provider_group?: string | null } | null }>;

  return {
    versionId: version.id,
    label: String(row.schedule_name ?? `${row.date_start} – ${row.date_end}`),
    range: { start: String(row.date_start), end: String(row.date_end) },
    parLevel: typeof site?.call_par_level === 'number' ? site.call_par_level : null,
    includedProviderIds: (row.included_provider_ids as string[] | null) ?? undefined,
    slots: slots.filter(s => {
      const group = s.shift_types?.provider_group ?? null;
      return !group || group === 'both' || group === providerGroup;
    }) as CensusSlot[],
    profiles: profileRes.rows,
    pattern: parsed?.success ? parsed.data : null,
    error,
  };
}
