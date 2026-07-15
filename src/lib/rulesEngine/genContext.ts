// Load phase for the call-schedule generation pipeline.
//
// `loadGenerationContext` runs all Supabase reads and returns an immutable
// `GenerationContext` that the solve phase can consume without touching I/O.
//
// `computeBucketTargets` is a pure helper (extracted so it can be unit-tested)
// that turns bucket totals + historical data into per-provider FTE targets.

import {
  addDays,
  dayTypeBucket,
  normalizeWeekdays,
  buildPrePtoByThursday,
  type SupabaseClient,
} from './shared';

import type {
  GenerationContext,
  SlotToFill,
  CandidateProvider,
  SiteCredentials,
  AvailabilityEntry,
  SeedAssignment,
  ShiftTypeInfo,
} from './genTypes';

import { CallPatternDocSchema, patternWarnings, callFillOrderWarnings, type CallPatternDoc } from './callPattern';
import { fetchCommittedAssignments } from './committedAssignments';
import { embedArray } from '@/lib/embed';

const DEFAULT_PAR_LEVEL = 12; // fallback when site.call_par_level isn't set
const NEIGHBOR_WINDOW_DAYS = 31;

// A Supabase/PostgREST error indicating the queried relation doesn't exist yet
// (pre-patch18 live DB). Distinct from a plain "no row" result (data:null,
// error:null). Missing-COLUMN errors (patch18 partly applied) are handled
// separately at the shift_types load.
function isMissingRelationError(error: unknown): boolean {
  const e = error as { message?: string; code?: string } | null;
  if (!e) return false;
  if (e.code === '42P01') return true; // undefined_table
  return /does not exist|could not find the table|schema cache/i.test(e.message || '');
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Compute per-provider FTE-weighted block targets, carrying forward any
 * historical deficit so under-allocated providers catch up across blocks.
 *
 *   base_i_B     = (block_total_B / par_level) * fte_i
 *   expected_i_B = (hist_total_B  / par_level) * fte_i
 *   deficit_i_B  = max(0, expected_i_B - actual_i_B)
 *   target_i_B   = base_i_B + deficit_i_B
 *
 * The max(0, …) ensures over-allocated providers don't get a reduced cap —
 * they just score worse so the greedy loop prefers under-allocated ones.
 */
export function computeBucketTargets(
  bucketTotals: Map<string, number>,
  historicalTotalByBucket: Map<string, number>,
  historicalAssignedByPid: Map<string, Map<string, number>>,
  providers: CandidateProvider[],
  parLevel: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of providers) {
    for (const [k, blockTotal] of bucketTotals) {
      const base = (blockTotal / parLevel) * p.fte_value;
      const histTotal = historicalTotalByBucket.get(k) || 0;
      const histExpected = (histTotal / parLevel) * p.fte_value;
      const histActual = historicalAssignedByPid.get(p.id)?.get(k) || 0;
      const deficit = Math.max(0, histExpected - histActual);
      out.set(`${p.id}|${k}`, base + deficit);
    }
  }
  return out;
}

// ── Load result ───────────────────────────────────────────────────────────────

export interface LoadResult {
  ctx: GenerationContext | null;
  error?: string;
  dbQueries: number;
  totalSlots: number;
}

// ── Main I/O function ─────────────────────────────────────────────────────────

/**
 * Run all Supabase reads for a schedule version and return a fully-populated,
 * immutable `GenerationContext`. No assignment logic here — only reads + shaping.
 */
export async function loadGenerationContext(
  sb: SupabaseClient,
  scheduleVersionId: string,
  options: { overrideProviderIds?: string[] } = {},
): Promise<LoadResult> {
  let dbQueries = 0;
  const countQ = () => { dbQueries++; };
  // Load-time warnings (missing patch18 objects, unknown pattern codes, quota
  // shortfalls, unsupported multi-fill slots). Always surfaced on ctx.warnings.
  const warnings: string[] = [];

  // ── 1. Preload schedule + site + slots ────────────────────────────────────
  countQ();
  const { data: rawSlots, error: slotsErr } = await sb
    .from('schedule_slots')
    .select('id, slot_date, shift_type_id, provider_group, required_count, locked, derived_day_type, site_id, shift_types(code, category), assignments(id, provider_id, assignment_status)')
    .eq('schedule_version_id', scheduleVersionId)
    .order('slot_date')
    .order('slot_index');

  if (slotsErr || !rawSlots || rawSlots.length === 0) {
    return {
      ctx: null,
      error: `Failed to load slots: ${slotsErr?.message || 'no slots in version'}`,
      dbQueries,
      totalSlots: 0,
    };
  }
  const siteId = (rawSlots[0] as { site_id: string }).site_id;

  // Load site to get call_par_level (gracefully fallback if column doesn't exist yet)
  let parLevel = DEFAULT_PAR_LEVEL;
  try {
    countQ();
    const { data: site } = await sb.from('sites').select('call_par_level').eq('id', siteId).single();
    if (site && typeof site.call_par_level === 'number' && site.call_par_level > 0) {
      parLevel = site.call_par_level;
    }
  } catch { /* column may not exist yet — use default */ }

  // ── 1b. Load full shift-type metadata for the site ────────────────────────
  // Drives generation behavior (call/relief rank, overlay, engine, post-call
  // flag, coverage type). On ANY load failure ctx.shiftTypes stays undefined so
  // solve's documented legacy fallbacks (LEGACY_RELIEF_CODES, call-rank
  // literals) engage uniformly — attaching a rank-less map here would make
  // reliefCodesFor() return [] and silently kill the relief pass.
  //   • Missing engine columns (pre-patch18 live DB): warn "apply patch18" and
  //     retry with code+category ONLY to feed the pattern cross-check below.
  //   • Any other error (timeout, RLS, transient): warn with the error message.
  let shiftTypes: Map<string, ShiftTypeInfo> | undefined;
  const knownShiftCodes = new Set<string>();
  {
    countQ();
    const wide = await sb
      .from('shift_types')
      .select('code, category, call_rank, relief_rank, is_overlay, generation_engine, requires_post_call_rule, call_coverage_type')
      .eq('site_id', siteId)
      .eq('is_active', true);

    if (wide.error) {
      const wideErrMsg = (wide.error as { message?: string }).message || '';
      if (/column/i.test(wideErrMsg)) {
        warnings.push('shift_types engine columns missing — apply patch18');
        countQ();
        const narrow = await sb
          .from('shift_types')
          .select('code, category')
          .eq('site_id', siteId)
          .eq('is_active', true);
        for (const r of ((narrow.data as Array<Record<string, unknown>> | null) || [])) {
          if (r.code) knownShiftCodes.add(r.code as string);
        }
      } else {
        warnings.push(`shift_types load failed — using legacy engine fallbacks: ${wideErrMsg || 'unknown error'}`);
      }
    } else {
      shiftTypes = new Map<string, ShiftTypeInfo>();
      for (const r of ((wide.data as Array<Record<string, unknown>> | null) || [])) {
        const code = r.code as string;
        const category = r.category as string;
        if (!code) continue;
        const engineDefault: ShiftTypeInfo['generation_engine'] = category === 'call' ? 'call' : 'day_pool';
        shiftTypes.set(code, {
          code,
          category,
          call_rank: (r.call_rank as number | null) ?? null,
          relief_rank: (r.relief_rank as number | null) ?? null,
          is_overlay: !!r.is_overlay,
          generation_engine: (r.generation_engine as ShiftTypeInfo['generation_engine']) || engineDefault,
          requires_post_call_rule: !!r.requires_post_call_rule,
          call_coverage_type: (r.call_coverage_type as string | null) ?? null,
        });
        knownShiftCodes.add(code);
      }
    }
  }

  // ── 1c. Load the site's active call pattern ───────────────────────────────
  // Success → ctx.callPattern (zod-parsed). Validation failure → undefined +
  // warning. Missing table → undefined + warning. No row → undefined, silent
  // (normal pre-seed state; solve falls back to CLASSIC_PATTERN).
  let callPattern: CallPatternDoc | undefined;
  {
    countQ();
    const { data: patRow, error: patErr } = await sb
      .from('call_patterns')
      .select('definition')
      .eq('site_id', siteId)
      .eq('status', 'active')
      .maybeSingle();

    if (patErr) {
      if (isMissingRelationError(patErr)) {
        warnings.push('call_patterns table missing — apply patch18');
      }
      // Other errors: leave undefined; engine falls back to CLASSIC silently.
    } else {
      const definition = (patRow as { definition?: unknown } | null)?.definition;
      if (definition != null) {
        const parsed = CallPatternDocSchema.safeParse(definition);
        if (parsed.success) {
          callPattern = parsed.data;
        } else {
          warnings.push(`Active call pattern failed validation: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
        }
      }
      // No row → definition undefined → callPattern stays undefined, no warning.
    }
  }

  // Cross-check: every code the pattern references should exist as a shift
  // type. knownShiftCodes is populated from the wide select or, in degraded
  // (columns-missing) mode, the narrow code+category retry.
  if (callPattern && knownShiftCodes.size > 0) {
    warnings.push(...patternWarnings(callPattern, knownShiftCodes));
  }
  // callFillOrder='call_rank' needs ranks on every call code — a null rank
  // silently falls back to solve's legacy code literals (skipped in degraded
  // mode: shiftTypes undefined means the legacy fallback is engaged anyway).
  if (callPattern && shiftTypes) {
    warnings.push(...callFillOrderWarnings(callPattern, shiftTypes.values()));
  }

  // ── 2. Build slot index ───────────────────────────────────────────────────
  // slotsToFill = call-category slots that need assignment (main loop)
  // slotIndex   = ALL open slots by date+code (used for weekend chaining and D-fill)
  const slotsToFill: SlotToFill[] = [];
  const slotIndex = new Map<string, Map<string, SlotToFill>>();
  // Sibling slots (Task 11) are the multi-coverage mechanism: schedule
  // creation materializes required_count as N slot rows of required_count 1.
  // A slot row with required_count > 1 is a LEGACY shape the engine fills at
  // most once. Count OPEN multi-count slots (fully-satisfied ones don't
  // affect generation) and aggregate to one warning per shift code so legacy
  // schedules don't flood the warning list.
  const multiFillOpenByCode = new Map<string, number>();

  for (const raw of rawSlots as Array<Record<string, unknown>>) {
    if (raw.locked) continue;
    const st = raw.shift_types as { code: string; category: string } | null;
    if (!st) continue;

    // UNIQUE(schedule_slot_id) → PostgREST returns this embed as a single
    // OBJECT (or null) against the live DB; dev fakes return arrays.
    const assignments = embedArray(raw.assignments) as Array<{ id: string; provider_id: string | null }>;
    const required = (raw.required_count as number) || 1;
    const assignedCount = assignments.filter(a => a.provider_id).length;
    if (assignedCount >= required) continue;
    if (required > 1) {
      multiFillOpenByCode.set(st.code, (multiFillOpenByCode.get(st.code) || 0) + 1);
    }

    const openRow = assignments.find(a => !a.provider_id);
    const slot: SlotToFill = {
      slot_id: raw.id as string,
      slot_date: raw.slot_date as string,
      shift_type_id: raw.shift_type_id as string,
      shift_type_code: st.code,
      shift_type_category: st.category,
      derived_day_type: (raw.derived_day_type as string) || 'weekday',
      provider_group: raw.provider_group as SlotToFill['provider_group'],
      required_count: required,
      existing_assignment_id: openRow?.id || null,
    };

    // Index every open slot for cross-shift lookups
    if (!slotIndex.has(slot.slot_date)) slotIndex.set(slot.slot_date, new Map());
    slotIndex.get(slot.slot_date)!.set(slot.shift_type_code, slot);

    // Only call slots go through the quota-based main loop.
    // D-slots are filled deterministically in the post-pass from the call schedule.
    if (st.category === 'call') slotsToFill.push(slot);
  }

  for (const [code, n] of multiFillOpenByCode) {
    warnings.push(`${n} open slot${n === 1 ? '' : 's'} with required_count > 1 for ${code} (legacy) — generation covers only one provider per slot; split into sibling slots (one row per required provider, required_count 1 each)`);
  }

  // Sorted date keys of ALL open slots (call + derived) — reused for the
  // cross-site window and ctx.scheduleDates.
  const allSlotDates = Array.from(slotIndex.keys()).sort();

  // Sort: weekends first (Sat then Sun), then friday, then weekday — by date.
  // Within a date, backup (C2, C3) before primary (C1) so pairing rules pass
  // (unless the active pattern sets callFillOrder='call_rank' — solve
  // re-sorts within each date).
  //
  // IMPORTANT: this sort reads `derived_day_type` DIRECTLY — not through
  // dayTypeBucket(). The bucket collapses saturday/sunday into 'weekend',
  // which isn't in dayOrder; both Sat and Sun would fall through to the
  // `?? 5` default and end up dead-last. That broke the whole weekend-first
  // contract — the weekend chain (Sat-C2 → Sun-C1 + Fri-D2, etc.) needs to
  // run before the Friday slots get filled by their own normal pass,
  // otherwise the chain double-books providers across Friday + Saturday.
  const dayOrder: Record<string, number> = {
    saturday: 0,
    sunday: 1,
    friday: 2,
    weekday: 3,
    federal_holiday: 4,
    major_holiday: 4,
    holiday: 4,
  };
  const codeOrder: Record<string, number> = { C2: 0, C3: 1, C1: 2 };
  slotsToFill.sort((a, b) => {
    const da = dayOrder[a.derived_day_type] ?? 5;
    const db = dayOrder[b.derived_day_type] ?? 5;
    if (da !== db) return da - db;
    if (a.slot_date !== b.slot_date) return a.slot_date.localeCompare(b.slot_date);
    const ca = codeOrder[a.shift_type_code] ?? 9;
    const cb = codeOrder[b.shift_type_code] ?? 9;
    return ca - cb;
  });

  console.log(`[genContext] ${slotsToFill.length} call slots to fill, par_level=${parLevel}`);
  if (slotsToFill.length === 0) {
    // Return a valid (empty) context — no slots, nothing to do.
    return {
      ctx: {
        scheduleVersionId,
        siteId,
        parLevel,
        slotsToFill: [],
        slotIndex,
        providers: [],
        credByPid: new Map(),
        availByPid: new Map(),
        crossSiteByDate: new Map(),
        historicalAssignedByPid: new Map(),
        historicalTotalByBucket: new Map(),
        bucketTotals: new Map(),
        bucketTarget: new Map(),
        seedAssignments: [],
        callPattern,
        shiftTypes,
        warnings,
        providerById: new Map(),
        prePtoByThursday: new Map(),
        scheduleDates: allSlotDates,
      },
      dbQueries,
      totalSlots: rawSlots.length,
    };
  }

  // ── 3. Preload pool providers ─────────────────────────────────────────────
  countQ();
  // Default pool = providers whose home site is this site AND who are flagged
  // as a call-taker or partial call-taker. `can_take_call` on the per-site
  // credential is only an "eligible for extras" flag and does NOT pull
  // someone into the auto-assignment pool.
  //
  // Override pool: when the caller passes overrideProviderIds, the pool is
  // exactly those UUIDs. The home_site/call_taker gates are skipped — the
  // scheduler (a human) has made a deliberate call about who to include.
  // Eligibility checks (credentials, availability, conflicts, FTE quotas)
  // still apply later in the pipeline.
  const override = options.overrideProviderIds && options.overrideProviderIds.length > 0
    ? options.overrideProviderIds
    : null;

  let profilesQuery = sb
    .from('provider_employment_profiles')
    .select('provider_id, fte_value, home_site_id, call_taker, partial_call_taker, available_weekdays');
  if (override) {
    profilesQuery = profilesQuery.in('provider_id', override);
  } else {
    profilesQuery = profilesQuery
      .eq('home_site_id', siteId)
      .or('call_taker.eq.true,partial_call_taker.eq.true')
      .order('provider_id');
  }
  const { data: profiles } = await profilesQuery;

  const profileByPid = new Map<string, { fte_value: number; home_site_id: string; available_weekdays: boolean[] }>();
  for (const p of (profiles || []) as Array<Record<string, unknown>>) {
    profileByPid.set(p.provider_id as string, {
      fte_value: (p.fte_value as number) || 1,
      home_site_id: p.home_site_id as string,
      available_weekdays: normalizeWeekdays(p.available_weekdays),
    });
  }
  const providerIds = Array.from(profileByPid.keys());
  if (providerIds.length === 0) {
    return {
      ctx: null,
      error: override
        ? `Override pool is empty or none of the selected providers have an employment profile.`
        : `No call-takers found at this site. ` +
          `Providers must have home_site_id set to this site AND "Call Taker" ` +
          `or "Partial Call Taker" checked on their Employment & Scheduling tab.`,
      dbQueries,
      totalSlots: rawSlots.length,
    };
  }

  countQ();
  const { data: providerRows } = await sb
    .from('providers')
    .select('id, provider_type, short_display_name')
    .in('id', providerIds)
    .eq('status', 'active')
    .order('id');

  const providers: CandidateProvider[] = (
    ((providerRows || []) as Array<Record<string, unknown>>).map(p => {
      const prof = profileByPid.get(p.id as string);
      if (!prof) return null;
      return {
        id: p.id as string,
        provider_type: p.provider_type as string,
        short_display_name: p.short_display_name as string,
        fte_value: prof.fte_value,
        home_site_id: prof.home_site_id,
        available_weekdays: prof.available_weekdays,
      } as CandidateProvider;
    }) as Array<CandidateProvider | null>
  ).filter((p): p is CandidateProvider => p !== null);

  // ── 4. Preload site credentials for all home-site providers ───────────────
  countQ();
  const { data: creds } = await sb
    .from('provider_site_credentials')
    .select('provider_id, is_active, credentialed, can_take_call, can_take_weekend_call, can_take_holiday_call, allowed_shift_types, excluded_shift_types, skill_tags')
    .eq('site_id', siteId)
    .in('provider_id', providerIds);

  const credByPid = new Map<string, SiteCredentials>();
  for (const c of (creds || []) as Array<Record<string, unknown>>) {
    credByPid.set(c.provider_id as string, {
      is_active: !!c.is_active,
      credentialed: !!c.credentialed,
      can_take_call: !!c.can_take_call,
      can_take_weekend_call: !!c.can_take_weekend_call,
      can_take_holiday_call: !!c.can_take_holiday_call,
      allowed_shift_types: Array.isArray(c.allowed_shift_types) ? (c.allowed_shift_types as string[]) : [],
      excluded_shift_types: Array.isArray(c.excluded_shift_types) ? (c.excluded_shift_types as string[]) : [],
      skill_tags: Array.isArray(c.skill_tags) ? (c.skill_tags as string[]) : [],
    });
  }

  // ── 5. Preload availability for the schedule date range ───────────────────
  const dates = Array.from(new Set(slotsToFill.map(s => s.slot_date))).sort();
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  const availRangeStart = addDays(minDate, -NEIGHBOR_WINDOW_DAYS);
  const availRangeEnd = addDays(maxDate, NEIGHBOR_WINDOW_DAYS);

  countQ();
  const { data: avail } = await sb
    .from('provider_availability')
    .select('provider_id, availability_type, start_date, end_date, approval_status')
    .in('provider_id', providerIds)
    .lte('start_date', availRangeEnd)
    .gte('end_date', availRangeStart);

  const availByPid = new Map<string, AvailabilityEntry[]>();
  for (const a of (avail || []) as Array<Record<string, unknown>>) {
    const list = availByPid.get(a.provider_id as string) || [];
    list.push({
      availability_type: a.availability_type as string,
      start_date: a.start_date as string,
      end_date: a.end_date as string,
      approval_status: a.approval_status as string,
    });
    availByPid.set(a.provider_id as string, list);
  }

  // ── 6. Preload conflicting assignments in OTHER schedules ─────────────────
  // Anything assigned to these providers on dates in the schedule range, in
  // any OTHER schedule — other sites AND other schedules at this same site
  // (invariant 3: no double-booking across any site, any schedule version).
  // Exclusion is by parent SCHEDULE, not by version: sibling versions of this
  // schedule are clones/alternatives (the versions route copies
  // slots+assignments), so counting them would make every
  // regenerate-into-a-new-version self-conflict. Mirrors dayShiftAutoGen.
  //
  // Window = the FULL slotIndex date range (call AND derived slots — derived
  // fills like D1/D2 can land a provider on a day with no open call slot),
  // widened ±1 day so post-call/adjacency guards see a neighbor booked
  // elsewhere. Deriving this from slotsToFill (call slots only) left a hole
  // on derived-only edge dates.
  countQ();
  const { data: verRow } = await sb
    .from('schedule_versions')
    .select('schedule_id')
    .eq('id', scheduleVersionId)
    .single();
  const parentScheduleId = (verRow as { schedule_id?: string } | null)?.schedule_id ?? null;
  if (!parentScheduleId) {
    warnings.push('schedule_versions lookup failed — conflict scan degraded to other-sites-only (same-site double-booking in other schedules is invisible)');
  }

  const crossWindowStart = addDays(allSlotDates[0], -1);
  const crossWindowEnd = addDays(allSlotDates[allSlotDates.length - 1], 1);
  countQ();
  // Draft isolation (invariant 3): a conflict is a booking in a PUBLISHED
  // version — an overlapping *unpublished* draft is invisible (resolved at
  // publish time). Exclude the parent schedule either way (its sibling versions
  // are clones — counting them self-conflicts every regenerate). Degraded
  // no-parent fallback keeps the legacy other-sites-only scope AND the
  // published-only filter — never version-only exclusion (would self-conflict
  // clones). No includeVersionId: the current version IS the parent schedule,
  // already excluded, and its own rows are seeded separately.
  const { data: crossSite } = await fetchCommittedAssignments(
    sb,
    'provider_id, schedule_slots!inner(slot_date, site_id, schedule_versions!inner(schedule_id, version_status))',
    {
      providerIds,
      start: crossWindowStart,
      end: crossWindowEnd,
      ...(parentScheduleId
        ? { excludeScheduleId: parentScheduleId }
        : { excludeSiteId: siteId }),
    },
  );

  // crossSiteByDate: pid -> Set<date> — provider is assigned elsewhere (another
  // site, or another schedule at this same site) on these dates. Field name
  // kept: it feeds the eligibility 'cross-site' rejection vocabulary.
  const crossSiteByDate = new Map<string, Set<string>>();
  for (const a of (crossSite || []) as Array<Record<string, unknown>>) {
    const s = a.schedule_slots as { slot_date: string };
    const pid = a.provider_id as string;
    if (!crossSiteByDate.has(pid)) crossSiteByDate.set(pid, new Set());
    crossSiteByDate.get(pid)!.add(s.slot_date);
  }

  // ── 6.5. Preload historical call assignments ─────────────────────────────
  //
  // Cross-block memory. Per provider, count how many call shifts they've
  // already taken in past schedules at this site, keyed by bucket + code.
  // This lets us (a) score providers by lifetime fairness (not just
  // within-block) and (b) widen a provider's block-level cap to let them
  // catch up if they've been under-allocated historically.
  //
  // "Past" = anything with slot_date strictly before this schedule starts.
  // So schedules that were cancelled / replaced mid-way won't get counted
  // twice, and we automatically ignore the schedule we're generating right
  // now.
  //
  // Primary path: the `historical_call_counts` RPC returns pre-aggregated
  // (provider, bucket, code, n) rows — no unbounded assignment scan into the
  // app. If the function isn't present yet (pre-patch18 live DB), fall back to
  // the legacy row scan so dev environments keep working, and warn.
  const historicalAssignedByPid = new Map<string, Map<string, number>>();
  const historicalTotalByBucket = new Map<string, number>();
  const addHistorical = (pid: string, key: string, n: number) => {
    const byProv = historicalAssignedByPid.get(pid) || new Map<string, number>();
    byProv.set(key, (byProv.get(key) || 0) + n);
    historicalAssignedByPid.set(pid, byProv);
    historicalTotalByBucket.set(key, (historicalTotalByBucket.get(key) || 0) + n);
  };
  countQ();
  const rpcRes = await sb.rpc('historical_call_counts', { p_site_id: siteId, p_before: minDate });
  if (rpcRes.error) {
    // "apply patch18" only fits a missing function (42883 undefined_function,
    // or PostgREST's schema-cache miss). Any other failure (timeout, RLS,
    // transient) gets its actual error surfaced instead.
    const rpcErr = rpcRes.error as { message?: string; code?: string };
    const fnMissing = rpcErr.code === '42883'
      || /function .*historical_call_counts.* does not exist|could not find the function|schema cache/i.test(rpcErr.message || '');
    warnings.push(fnMissing
      ? 'historical_call_counts RPC unavailable — using legacy scan (apply patch18)'
      : `historical_call_counts RPC failed — using legacy scan: ${rpcErr.message || 'unknown error'}`);
    countQ();
    const { data: hist } = await sb
      .from('assignments')
      .select('provider_id, schedule_slots!inner(slot_date, site_id, derived_day_type, shift_types!inner(code, category))')
      .in('provider_id', providerIds)
      .eq('assignment_status', 'assigned')
      .eq('schedule_slots.site_id', siteId)
      .eq('schedule_slots.shift_types.category', 'call')
      .lt('schedule_slots.slot_date', minDate);

    for (const row of (hist || []) as Array<Record<string, unknown>>) {
      const pid = row.provider_id as string | null;
      const ss = row.schedule_slots as {
        derived_day_type?: string;
        shift_types?: { code?: string };
      } | null;
      if (!pid || !ss) continue;
      const code = ss.shift_types?.code;
      if (!code) continue;
      addHistorical(pid, `${dayTypeBucket(ss.derived_day_type || 'weekday')}|${code}`, 1);
    }
  } else {
    for (const row of (rpcRes.data || []) as Array<Record<string, unknown>>) {
      const pid = row.provider_id as string | null;
      const bucket = row.bucket as string | null;
      const code = row.code as string | null;
      if (!pid || !bucket || !code) continue;
      addHistorical(pid, `${bucket}|${code}`, Number(row.n) || 0);
    }
  }

  // ── 7. Compute bucket totals & targets ────────────────────────────────────
  const bucketTotals = new Map<string, number>();
  for (const s of slotsToFill) {
    const key = `${dayTypeBucket(s.derived_day_type)}|${s.shift_type_code}`;
    bucketTotals.set(key, (bucketTotals.get(key) || 0) + s.required_count);
  }
  // Include already-assigned slots so targets reflect total schedule load
  for (const raw of rawSlots as Array<Record<string, unknown>>) {
    const st = raw.shift_types as { code: string; category: string } | null;
    if (!st || st.category !== 'call') continue;
    const assignments = embedArray(raw.assignments) as Array<{ provider_id: string | null }>;
    const n = assignments.filter(a => a.provider_id).length;
    if (n > 0) {
      const dt = (raw.derived_day_type as string) || 'weekday';
      const key = `${dayTypeBucket(dt)}|${st.code}`;
      bucketTotals.set(key, (bucketTotals.get(key) || 0) + n);
    }
  }

  // Per-provider block target = base share of THIS block + deficit carried
  // forward from past blocks at this site.
  //
  //   base_i_B     = (block_total_B / par_level) * fte_i
  //   expected_i_B = (hist_total_B / par_level) * fte_i   [what they *should* have]
  //   actual_i_B   = hist_assigned_i_B                    [what they got]
  //   deficit_i_B  = max(0, expected_i_B - actual_i_B)
  //
  //   target_i_B = base_i_B + deficit_i_B
  //
  // The `max(0, …)` means providers who've been OVER-allocated historically
  // don't get their block target shrunk — they just get scored worse so the
  // greedy loop hands slots to under-allocated providers first. A hard
  // shrink of their cap could leave slots unfilled for no good reason.
  const bucketTarget = computeBucketTargets(
    bucketTotals,
    historicalTotalByBucket,
    historicalAssignedByPid,
    providers,
    parLevel,
  );

  // Quota sanity: if the FTE-weighted targets across the whole pool can't sum
  // to the bucket's slot count, the block is structurally under-staffed for
  // that bucket (par_level too high, or pool FTE too low). Warn so the human
  // knows some slots will go unfilled for capacity — not eligibility — reasons.
  for (const [key, total] of bucketTotals) {
    let sum = 0;
    for (const p of providers) sum += bucketTarget.get(`${p.id}|${key}`) || 0;
    if (sum < total) {
      warnings.push(`Bucket ${key}: FTE-weighted quota (${sum.toFixed(2)}) cannot cover ${total} slots — check call_par_level vs pool FTE`);
    }
  }

  // ── 8. Collect seed assignments (pre-existing assignments on these slots) ──
  //
  // Walk rawSlots: for each slot that already has a provider_id on one of its
  // assignment rows, record it as a SeedAssignment so the solve phase can
  // pre-populate its runtime state (bucketAssigned, assignedOnDate, etc.)
  // without hitting the DB again.
  const seedAssignments: SeedAssignment[] = [];
  for (const raw of rawSlots as Array<Record<string, unknown>>) {
    const st = raw.shift_types as { code: string; category: string } | null;
    if (!st) continue;
    const assignments = embedArray(raw.assignments) as Array<{ id: string; provider_id: string | null; assignment_status?: string }>;
    for (const a of assignments) {
      if (a.provider_id) {
        seedAssignments.push({
          slot_date: raw.slot_date as string,
          provider_id: a.provider_id,
          shift_type_code: st.code,
          shift_type_category: st.category,
          derived_day_type: (raw.derived_day_type as string) || 'weekday',
        });
      }
    }
  }

  return {
    ctx: {
      scheduleVersionId,
      siteId,
      parLevel,
      slotsToFill,
      slotIndex,
      providers,
      credByPid,
      availByPid,
      crossSiteByDate,
      historicalAssignedByPid,
      historicalTotalByBucket,
      bucketTotals,
      bucketTarget,
      seedAssignments,
      // ── v2 pattern-interpreter inputs + precomputed invariants ──
      callPattern,
      shiftTypes,
      warnings,
      providerById: new Map(providers.map(p => [p.id, p])),
      prePtoByThursday: buildPrePtoByThursday(providers, availByPid, slotIndex),
      scheduleDates: allSlotDates,
    },
    dbQueries,
    totalSlots: rawSlots.length,
  };
}
