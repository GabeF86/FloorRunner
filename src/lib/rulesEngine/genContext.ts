// Load phase for the call-schedule generation pipeline.
//
// `loadGenerationContext` runs all Supabase reads and returns an immutable
// `GenerationContext` that the solve phase can consume without touching I/O.
//
// `computeBucketTargets` is a pure helper (extracted so it can be unit-tested)
// that turns bucket totals + historical data into per-provider FTE targets.

import {
  NEIGHBOR_WINDOW_DAYS,
  addDays,
  dayTypeBucket,
  dayTypeBucketOn,
  isMissingRelationError,
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
  WorkDayBudget,
  ProviderWorkDayBudget,
} from './genTypes';

import { CallPatternDocSchema, patternWarnings, callFillOrderWarnings, dayTypeFillOrderWarnings, neuroWeekendWarnings, type CallPatternDoc } from './callPattern';
import { projectScenario, applyScenarioBucketTargets, type ScenarioDoc } from './scenario';
import { fetchCommittedAssignments, filterPublishedVersions } from './committedAssignments';
import { embedArray } from '@/lib/embed';
import { callBurdenWeight, parentCallCodeOf } from '@/lib/callBurden';
import { isWorkingDay, ptoWeekdaysCovered, requiredWorkDaysWithLimit, entitledOffDays, loadMajorHolidayDates } from './workDays';
import { parseProviderLimits, type ProviderLimits } from '@/lib/providerLimits';

// Fallback when site.call_par_level isn't set (or is 0/negative). Exported
// (2026-07-20) so the planner API resolves the same default the engine does —
// the schedule page's `?? 12` is this same convention.
export const DEFAULT_PAR_LEVEL = 12;

// Missing-relation detection (pre-patch18 live DB) is the shared
// isMissingRelationError; missing-COLUMN errors (patch18 partly applied) are
// handled separately at the shift_types load.

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

/**
 * At-least-one-per-bucket floor (2026-07-16). patch24's saturday/sunday split
 * shrank weekend buckets to a handful of slots, driving per-provider targets
 * below 1 — and the strict `assigned + 1 > target` check then gave EVERY
 * provider zero capacity in those buckets (the merged weekend bucket's whole
 * reason to exist, per the old ALGORITHM.md §4 rationale). Floor each
 * positive-FTE provider's target to ≥ 1 so quota math can never zero out an
 * entire bucket; fairness ORDERING is unaffected — scoreCall's lifetime-ratio
 * sort still decides who actually gets the slot. Zero-FTE providers keep their
 * raw target (no capacity means no quota grant).
 *
 * This lives at target-computation time, NOT in the eligibility gate: parity
 * fixtures hand-build their target maps, and the only consumer of
 * ctx.bucketTarget is the eligibility quota check, so flooring here is
 * production-identical and keeps the frozen-legacy parity net meaningful.
 */
export function floorBucketTargets(
  targets: Map<string, number>,
  providers: CandidateProvider[],
): Map<string, number> {
  const fteById = new Map(providers.map(p => [p.id, p.fte_value]));
  const out = new Map<string, number>();
  for (const [k, v] of targets) {
    const pid = k.slice(0, k.indexOf('|'));
    out.set(k, (fteById.get(pid) ?? 0) > 0 ? Math.max(1, v) : v);
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
  options: {
    overrideProviderIds?: string[];
    // The version's parent schedule id, when the caller already holds it (the
    // generate route's path param). Skips the redundant schedule_versions
    // round trip in step 6; absent → the lookup (and its degraded-mode
    // warning) runs exactly as before.
    parentScheduleId?: string;
  } = {},
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
    .select('id, slot_date, shift_type_id, provider_group, required_count, locked, derived_day_type, site_id, shift_types(code, category), assignments(id, provider_id, assignment_status, source_type)')
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

  // ── 1a-1c. Site metadata wave (parallelized 2026-07-20, C2.4) ─────────────
  // sites + shift_types (with its conditional narrow retry CHAINED inside its
  // member) + call_patterns depend only on siteId, so their round trips
  // overlap in one Promise.all wave. Each member keeps its bespoke
  // degraded-mode handling verbatim and RETURNS its warnings; they are pushed
  // after the wave resolves in the original fixed order (shift_types →
  // call_patterns) so the warnings array is identical to the serial load's.

  // 1a. Site row: call_par_level (graceful fallback if the column doesn't
  // exist yet) + organization_id (scopes the holiday_calendars query for the
  // working-days budget below — holiday rows are org-wide, site_id NULL).
  const loadSiteRow = async (): Promise<{ parLevel: number; organizationId: string | null }> => {
    let parLevel = DEFAULT_PAR_LEVEL;
    let organizationId: string | null = null;
    try {
      countQ();
      const { data: site } = await sb.from('sites').select('call_par_level, organization_id').eq('id', siteId).single();
      if (site) {
        if (typeof site.call_par_level === 'number' && site.call_par_level > 0) {
          parLevel = site.call_par_level;
        }
        organizationId = (site.organization_id as string | null) ?? null;
      }
    } catch { /* column may not exist yet — use default */ }
    return { parLevel, organizationId };
  };

  // 1b. Full shift-type metadata for the site. Drives generation behavior
  // (call/relief rank, overlay, engine, post-call flag, coverage type, and —
  // patch35 — the call-split columns manual_only/call_burden_weight/
  // parent_call_code). On ANY load failure shiftTypes stays undefined so
  // solve's documented legacy fallbacks (LEGACY_RELIEF_CODES, call-rank
  // literals) engage uniformly — attaching a rank-less map here would make
  // reliefCodesFor() return [] and silently kill the relief pass.
  //   • Missing patch35 columns (pre-patch35 live DB): retry with the patch18
  //     select SILENTLY — an absent column can hold no segments, so weight 1 /
  //     parent null is exact (the providerLimits degradation posture).
  //     manual_only is base-schema and rides in both wide selects.
  //   • Missing engine columns (pre-patch18 live DB): warn "apply patch18" and
  //     retry with code+category ONLY to feed the pattern cross-check below.
  //   • Any other error (timeout, RLS, transient): warn with the error message.
  const loadShiftTypes = async (): Promise<{
    shiftTypes: Map<string, ShiftTypeInfo> | undefined;
    knownShiftCodes: Set<string>;
    warnings: string[];
  }> => {
    let shiftTypes: Map<string, ShiftTypeInfo> | undefined;
    const knownShiftCodes = new Set<string>();
    const memberWarnings: string[] = [];
    const stSelect = (cols: string) => {
      countQ();
      return sb.from('shift_types').select(cols).eq('site_id', siteId).eq('is_active', true);
    };
    const isColumnErr = (e: unknown) => /column/i.test((e as { message?: string })?.message || '');

    let wide = await stSelect('code, category, call_rank, relief_rank, is_overlay, generation_engine, requires_post_call_rule, call_coverage_type, manual_only, call_burden_weight, parent_call_code');
    if (wide.error && isColumnErr(wide.error)) {
      // Pre-patch35 narrow retry (silent — see above).
      wide = await stSelect('code, category, call_rank, relief_rank, is_overlay, generation_engine, requires_post_call_rule, call_coverage_type, manual_only');
    }

    if (wide.error) {
      const wideErrMsg = (wide.error as { message?: string }).message || '';
      if (isColumnErr(wide.error)) {
        memberWarnings.push('shift_types engine columns missing — apply patch18');
        const narrow = await stSelect('code, category');
        for (const r of ((narrow.data as Array<Record<string, unknown>> | null) || [])) {
          if (r.code) knownShiftCodes.add(r.code as string);
        }
      } else {
        memberWarnings.push(`shift_types load failed — using legacy engine fallbacks: ${wideErrMsg || 'unknown error'}`);
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
          manual_only: !!r.manual_only,
          call_burden_weight: callBurdenWeight(r as { call_burden_weight?: number | null }),
          parent_call_code: typeof r.parent_call_code === 'string' && r.parent_call_code ? r.parent_call_code : null,
        });
        knownShiftCodes.add(code);
      }
    }
    return { shiftTypes, knownShiftCodes, warnings: memberWarnings };
  };

  // 1c. The site's active call pattern. Success → callPattern (zod-parsed).
  // Validation failure → undefined + warning. Missing table → undefined +
  // warning. No row → undefined, silent (normal pre-seed state; solve falls
  // back to CLASSIC_PATTERN).
  const loadCallPattern = async (): Promise<{
    callPattern: CallPatternDoc | undefined;
    warnings: string[];
  }> => {
    let callPattern: CallPatternDoc | undefined;
    const memberWarnings: string[] = [];
    countQ();
    const { data: patRow, error: patErr } = await sb
      .from('call_patterns')
      .select('definition')
      .eq('site_id', siteId)
      .eq('status', 'active')
      .maybeSingle();

    if (patErr) {
      if (isMissingRelationError(patErr)) {
        memberWarnings.push('call_patterns table missing — apply patch18');
      }
      // Other errors: leave undefined; engine falls back to CLASSIC silently.
    } else {
      const definition = (patRow as { definition?: unknown } | null)?.definition;
      if (definition != null) {
        const parsed = CallPatternDocSchema.safeParse(definition);
        if (parsed.success) {
          callPattern = parsed.data;
        } else {
          memberWarnings.push(`Active call pattern failed validation: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
        }
      }
      // No row → definition undefined → callPattern stays undefined, no warning.
    }
    return { callPattern, warnings: memberWarnings };
  };

  const [siteRowRes, shiftTypesRes, callPatternRes] = await Promise.all([
    loadSiteRow(), loadShiftTypes(), loadCallPattern(),
  ]);
  const { parLevel, organizationId } = siteRowRes;
  const { shiftTypes, knownShiftCodes } = shiftTypesRes;
  const { callPattern } = callPatternRes;
  warnings.push(...shiftTypesRes.warnings);
  warnings.push(...callPatternRes.warnings);

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
  // dayTypeFillOrder names must be known derived_day_type values — an unknown
  // name never matches a slot (its position silently does nothing).
  if (callPattern) {
    warnings.push(...dayTypeFillOrderWarnings(callPattern));
  }
  // A neuroWeekend link floor that sits BETWEEN requirement bands silently
  // credits a whole pair against a different band's obligation and mints no
  // remainder (callPattern.ts states the case).
  if (callPattern) {
    warnings.push(...neuroWeekendWarnings(callPattern));
  }

  // ── 2. Build slot index ───────────────────────────────────────────────────
  // slotsToFill = call-category slots that need assignment (main loop)
  // slotIndex   = ALL open slots by date+code (used for weekend chaining and D-fill)
  // manualCallSlots = OPEN call slots whose shift type is manual_only (call-
  // split segments) — the engine NEVER places them (pinned in
  // callSplitWeighting.test.ts), but the obligation census counts their weight.
  const slotsToFill: SlotToFill[] = [];
  const manualCallSlots: SlotToFill[] = [];
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
    // manual_only call slots (split segments) NEVER enter the main loop —
    // they stay scheduler-filled; recorded separately for the weighted census.
    if (st.category === 'call') {
      if (shiftTypes?.get(st.code)?.manual_only) manualCallSlots.push(slot);
      else slotsToFill.push(slot);
    }
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
  // The active pattern may override the ACROSS-DATE order with
  // dayTypeFillOrder (spec 2026-07-15 friday-first Doc A): listed day types
  // get their list index; unlisted ones fall to the tail — exactly the
  // default map's `?? 5` semantics. Absent field = the default order below,
  // byte-identical behavior (classic docs untouched; golden parity holds).
  //
  // IMPORTANT: this sort reads `derived_day_type` DIRECTLY, and `dayOrder`
  // (default or pattern-supplied) enumerates the RAW day types (saturday,
  // sunday, friday, weekday, the two holiday types) — dayTypeFillOrder is
  // keyed on derived_day_type values, NOT dayTypeBucket buckets. The
  // anchor-before-link contract lives here: a block chain anchored on day
  // type X can only claim its link slots if X sorts before the link slots'
  // day types (classic weekend chain: Sat before Fri; friday-first Doc A:
  // Fri before Sun). dayTypeBucket() now splits saturday/sunday into their
  // own fairness buckets (they used to collapse to 'weekend', which wasn't
  // in dayOrder and sank both to the `?? 5` default), so routing the sort
  // through it would order weekends correctly too — but it still merges the
  // two holiday types, and there's no reason to bucket a raw value the sort
  // already has. Keep the sort on derived_day_type.
  const customDayOrder = callPattern?.dayTypeFillOrder;
  const dayOrder: Record<string, number> = customDayOrder
    ? Object.fromEntries(customDayOrder.map((dt, i) => [dt, i]))
    : {
        saturday: 0,
        sunday: 1,
        friday: 2,
        weekday: 3,
        federal_holiday: 4,
        major_holiday: 4,
        holiday: 4,
      };
  const dayOrderTail = customDayOrder ? customDayOrder.length : 5;
  const codeOrder: Record<string, number> = { C2: 0, C3: 1, C1: 2 };
  slotsToFill.sort((a, b) => {
    const da = dayOrder[a.derived_day_type] ?? dayOrderTail;
    const db = dayOrder[b.derived_day_type] ?? dayOrderTail;
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
        manualCallSlots,
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
  // Override pool = NARROWING (Gabriel 2026-07-21, both engines): when the
  // caller passes overrideProviderIds, the list INTERSECTS the base pool
  // criteria — it skips only the home_site gate (a hand-picked cross-site
  // call taker stays eligible; the cross-schedule conflict scan still guards
  // invariant 3), never the call_taker/partial_call_taker role criterion. A
  // day doc in a custom pool must not become call-eligible; the pre-fix code
  // took the list verbatim (the same defect class that day-shifted call
  // takers on live data). Non-call-takers in the list are dropped with a
  // loud warning, never silently. Eligibility checks (credentials,
  // availability, conflicts, FTE quotas) still apply later in the pipeline.
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
  const overrideNonCallTakers: string[] = [];
  for (const p of (profiles || []) as Array<Record<string, unknown>>) {
    // Role criterion, enforced in code for BOTH paths (the default path's SQL
    // `.or` already narrows against the live DB — this is the single-homed
    // predicate the override path must intersect too).
    if (!p.call_taker && !p.partial_call_taker) {
      if (override) overrideNonCallTakers.push(p.provider_id as string);
      continue;
    }
    profileByPid.set(p.provider_id as string, {
      fte_value: (p.fte_value as number) || 1,
      home_site_id: p.home_site_id as string,
      available_weekdays: normalizeWeekdays(p.available_weekdays),
    });
  }
  if (overrideNonCallTakers.length > 0) {
    warnings.push(
      `Override pool: ${overrideNonCallTakers.length} provider(s) excluded — not call takers ` +
      `(override narrows the call-taker pool, never widens it; Gabriel 2026-07-21): ${overrideNonCallTakers.join(', ')}`,
    );
  }
  const providerIds = Array.from(profileByPid.keys());
  if (providerIds.length === 0) {
    return {
      ctx: null,
      error: override
        ? `Override pool has no call takers: the custom pool intersects the call-taker criterion ` +
          `(a provider needs "Call Taker" or "Partial Call Taker" checked and an employment profile on file).`
        : `No call-takers found at this site. ` +
          `Providers must have home_site_id set to this site AND "Call Taker" ` +
          `or "Partial Call Taker" checked on their Employment & Scheduling tab.`,
      dbQueries,
      totalSlots: rawSlots.length,
    };
  }

  // ── 3b-5 + lookups: provider-scoped wave (parallelized 2026-07-20, C2.4) ──
  // providers, credentials, availability, the parent-schedule lookup (only
  // when the option is absent — C2.3) and the §9 holiday load are mutually
  // independent once providerIds + organizationId are known, so their round
  // trips overlap in one Promise.all wave. Query chains are constructed in
  // the original order (builders execute lazily on await for both the real
  // client and the recording fakes); results — and the parent-lookup's
  // degraded-mode warning — are processed after the wave in the original
  // fixed order. The two 'assignments' reads (§6 conflict scan, §6.5 legacy
  // fallback) deliberately stay sequential AFTER this wave: the conflict scan
  // needs parentScheduleId, and keeping them ordered preserves the serial
  // load's per-table query sequence exactly.

  // Pure date windows, hoisted ahead of the wave (§5's availability window +
  // §9's block span).
  const waveDates = Array.from(new Set(slotsToFill.map(s => s.slot_date))).sort();
  const waveAvailStart = addDays(waveDates[0], -NEIGHBOR_WINDOW_DAYS);
  const waveAvailEnd = addDays(waveDates[waveDates.length - 1], NEIGHBOR_WINDOW_DAYS);
  const blockMin = (rawSlots[0] as { slot_date: string }).slot_date;
  const blockMax = (rawSlots[rawSlots.length - 1] as { slot_date: string }).slot_date;

  countQ();
  const providersQ = sb
    .from('providers')
    .select('id, provider_type, short_display_name')
    .in('id', providerIds)
    .eq('status', 'active')
    .order('id');
  countQ();
  const credsQ = sb
    .from('provider_site_credentials')
    .select('provider_id, is_active, credentialed, can_take_call, can_take_weekend_call, can_take_holiday_call, allowed_shift_types, excluded_shift_types, skill_tags')
    .eq('site_id', siteId)
    .in('provider_id', providerIds);
  countQ();
  const availQ = sb
    .from('provider_availability')
    .select('provider_id, availability_type, start_date, end_date, approval_status, reason_code')
    .in('provider_id', providerIds)
    .lte('start_date', waveAvailEnd)
    .gte('end_date', waveAvailStart);
  // Parent-schedule lookup (skipped when the caller passed it — C2.3).
  const parentLookupQ = options.parentScheduleId
    ? null
    : (countQ(), sb
        .from('schedule_versions')
        .select('schedule_id')
        .eq('id', scheduleVersionId)
        .single());
  // §9's major-holiday load (swallow-errors-to-no-majors inside the helper).
  const holidaysQ = organizationId
    ? (countQ(), loadMajorHolidayDates(sb, organizationId, blockMin, blockMax))
    : null;

  const [providersRes, credsRes, availRes, verRes, majorHolidayDates] = await Promise.all([
    providersQ, credsQ, availQ,
    parentLookupQ ?? Promise.resolve(null),
    holidaysQ ?? Promise.resolve(new Set<string>()),
  ]);
  const providerRows = (providersRes as { data: unknown }).data;

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

  // ── 4. Site credentials for all home-site providers (loaded in the wave) ──
  const creds = (credsRes as { data: unknown }).data;

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

  // ── 5. Availability for the schedule date range (loaded in the wave) ──────
  // ALL availability types ride along un-filtered — pto_sellback rows included
  // (2026-07-20): the per-date consumers downstream (eligibility's
  // isDateBlocked gate, the §9 netting via ptoWeekdaysCovered) need them to
  // apply the date-level override. Never type-filter this load.
  const minDate = waveDates[0];
  const avail = (availRes as { data: unknown }).data;

  const availByPid = new Map<string, AvailabilityEntry[]>();
  for (const a of (avail || []) as Array<Record<string, unknown>>) {
    const list = availByPid.get(a.provider_id as string) || [];
    list.push({
      availability_type: a.availability_type as string,
      start_date: a.start_date as string,
      end_date: a.end_date as string,
      approval_status: a.approval_status as string,
      // ICU rotation rows carry reason_code 'icu_week' / 'icu_post_call' — the
      // working-days model credits them as worked (creditsAsWorkedAvailability).
      reason_code: (a.reason_code as string | null) ?? null,
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
  // Parent schedule id: taken from the options bag when the caller already
  // holds it (saves a round trip); otherwise from the wave's lookup, with the
  // degraded-mode warning preserved verbatim.
  let parentScheduleId: string | null = options.parentScheduleId ?? null;
  if (!parentScheduleId) {
    const verRow = (verRes as { data: unknown } | null)?.data;
    parentScheduleId = (verRow as { schedule_id?: string } | null)?.schedule_id ?? null;
    if (!parentScheduleId) {
      warnings.push('schedule_versions lookup failed — conflict scan degraded to other-sites-only (same-site double-booking in other schedules is invisible)');
    }
  }

  // ── 6b. Per-provider block limits (2026-07-22, patch34) ───────────────────
  // schedules.provider_limits for the parent schedule, parsed with the shared
  // hardened parser. Degradation posture (review runs pre-patch34):
  //   • missing column / no parent / no row / null → undefined, SILENT — an
  //     absent column can hold no limits, so "no limits" is exact, and a
  //     pre-patch warning on every generation would be noise;
  //   • any OTHER load error → undefined + a LOUD warning (a transient
  //     failure could be hiding real stated caps — never fail silent);
  //   • malformed jsonb → undefined + warning (all-or-nothing: never enforce
  //     a partially-parsed cap set).
  let providerLimits: ProviderLimits | undefined;
  let rawScenarioManifest: unknown = null;
  if (parentScheduleId) {
    countQ();
    // patch37 widens this select with scenario_manifest; a pre-patch37 DB
    // errors on the column and retries with the patch34 shape SILENTLY — an
    // absent column can hold no manifest, so "no scenario" is exact (the
    // patch35 narrow-retry posture). A pre-patch34 DB then errors again and
    // keeps the original provider_limits degradation semantics verbatim.
    let limitsRes = await sb
      .from('schedules')
      .select('provider_limits, scenario_manifest')
      .eq('id', parentScheduleId)
      .maybeSingle();
    if (limitsRes.error && /column|scenario_manifest/i.test((limitsRes.error as { message?: string }).message || '')) {
      countQ();
      limitsRes = await sb
        .from('schedules')
        .select('provider_limits')
        .eq('id', parentScheduleId)
        .maybeSingle();
    }
    if (limitsRes.error) {
      const limitsErrMsg = (limitsRes.error as { message?: string }).message || '';
      if (!/column|provider_limits/i.test(limitsErrMsg)) {
        warnings.push(`schedules.provider_limits load failed — generating WITHOUT provider limits: ${limitsErrMsg || 'unknown error'}`);
      }
    } else {
      const row = limitsRes.data as { provider_limits?: unknown; scenario_manifest?: unknown } | null;
      const rawLimits = row?.provider_limits;
      if (rawLimits != null) {
        const parsedLimits = parseProviderLimits(rawLimits);
        if (parsedLimits.ok) providerLimits = parsedLimits.value ?? undefined;
        else warnings.push(`schedules.provider_limits is malformed — limits IGNORED: ${parsedLimits.error}`);
      }
      rawScenarioManifest = row?.scenario_manifest ?? null;
    }
  }

  // ── 6c. Scenario manifest projection (2026-07-26, patch37) ────────────────
  // schedules.scenario_manifest holds the FULL phase-1 import manifest
  // (patch37 storage decision — see scenario.ts); the engine-facing
  // projection is computed here. Invalid manifests degrade LOUDLY to
  // scenario-free generation (never a crash, never silent). The scenario FTE
  // override applies to THIS generation's provider projection only — the
  // master employment profile is NEVER written (this loader has no write
  // path by construction); every mismatch is recorded for the audit.
  let scenario: ScenarioDoc | undefined;
  if (rawScenarioManifest != null) {
    const projected = projectScenario(rawScenarioManifest, {
      knownProviderIds: new Set(providers.map(p => p.id)),
      knownShiftCodes,
    });
    warnings.push(...projected.warnings);
    if (projected.scenario && projected.scenario.providers.size > 0) {
      scenario = projected.scenario;
      for (const p of providers) {
        const spv = scenario.providers.get(p.id);
        if (!spv) continue;
        if (Math.abs(spv.scenarioFte - p.fte_value) > 1e-9) {
          warnings.push(
            `Scenario FTE override: ${p.short_display_name} ${p.fte_value} (master) → ${spv.scenarioFte} (scenario) — master record NOT modified`);
        }
        p.fte_value = spv.scenarioFte;
      }
    }
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
  // Historical rows arrive keyed by their OWN code (the RPC aggregates raw
  // assignment rows); segment codes fold under the parent at weight here —
  // a past C1N12 row is 0.5 of C1 history. Codes without a live shift-type
  // row (renamed/other-era codes) keep weight 1 / their own key, as before.
  const addHistorical = (pid: string, bucket: string, code: string, n: number) => {
    const key = `${bucket}|${parentCallCodeOf(code, shiftTypes?.get(code))}`;
    const weighted = n * callBurdenWeight(shiftTypes?.get(code));
    const byProv = historicalAssignedByPid.get(pid) || new Map<string, number>();
    byProv.set(key, (byProv.get(key) || 0) + weighted);
    historicalAssignedByPid.set(pid, byProv);
    historicalTotalByBucket.set(key, (historicalTotalByBucket.get(key) || 0) + weighted);
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
    // Draft isolation (invariant 3): historical fairness counts only COMMITTED
    // past call — a booking in a PUBLISHED version. A past DRAFT schedule (or a
    // superseded sibling draft) must not skew the burden. The published RPC path
    // (patch21) does this in SQL; this legacy fallback applies the same predicate
    // in code via the one shared home. Shape (per-site `.eq` + unbounded `.lt`,
    // no cross-version include) doesn't fit fetchCommittedAssignments' option
    // bag, so we layer the predicate on directly.
    const { data: hist } = await filterPublishedVersions(
      sb
        .from('assignments')
        .select('provider_id, schedule_slots!inner(slot_date, site_id, derived_day_type, schedule_versions!inner(version_status), shift_types!inner(code, category))')
        .in('provider_id', providerIds)
        .eq('assignment_status', 'assigned')
        .eq('schedule_slots.site_id', siteId)
        .eq('schedule_slots.shift_types.category', 'call')
        .lt('schedule_slots.slot_date', minDate),
    );

    for (const row of (hist || []) as Array<Record<string, unknown>>) {
      const pid = row.provider_id as string | null;
      const ss = row.schedule_slots as {
        slot_date?: string;
        derived_day_type?: string;
        shift_types?: { code?: string };
      } | null;
      if (!pid || !ss) continue;
      const code = ss.shift_types?.code;
      if (!code) continue;
      // Same date-aware bucketing the RPC path must emit (a holiday counts as
      // its day of the week — Gabriel 2026-07-27), so the legacy scan and the
      // SQL aggregate cannot key history differently. slot_date is in the
      // select above; a row without one keeps the day type's own bucket.
      addHistorical(
        pid,
        ss.slot_date
          ? dayTypeBucketOn(ss.derived_day_type || 'weekday', ss.slot_date)
          : dayTypeBucket(ss.derived_day_type || 'weekday'),
        code, 1);
    }
  } else {
    for (const row of (rpcRes.data || []) as Array<Record<string, unknown>>) {
      const pid = row.provider_id as string | null;
      const bucket = row.bucket as string | null;
      const code = row.code as string | null;
      if (!pid || !bucket || !code) continue;
      addHistorical(pid, bucket, code, Number(row.n) || 0);
    }
  }

  // ── 7. Compute bucket totals & targets ────────────────────────────────────
  // Weighted + parent-mapped (2026-07-22, call splits): every call slot
  // contributes its call_burden_weight under its PARENT code's bucket key, so
  // a split call (open or filled, in any combination) totals exactly ONE call
  // of load. Whole calls are weight 1 / parent = own code — unsplit schedules
  // produce the identical integer totals (fill-mode golden pins).
  // Date-aware (dayTypeBucketOn, Gabriel 2026-07-27): a holiday-dated call slot
  // is counted in the bucket of the day of the week it falls on. This is the
  // DENOMINATOR side of the quota — the live 11-week Paoli block holds 44 Mon–Thu
  // C1 slots of which two are Monday holidays, and folding them out left the
  // weekday bucket at 42, targeting a 1.0 FTE at 3.818 instead of 4.
  const bucketKeyFor = (dt: string, date: string, code: string) =>
    `${dayTypeBucketOn(dt, date)}|${parentCallCodeOf(code, shiftTypes?.get(code))}`;
  const weightFor = (code: string) => callBurdenWeight(shiftTypes?.get(code));
  const bucketTotals = new Map<string, number>();
  for (const s of [...slotsToFill, ...manualCallSlots]) {
    const key = bucketKeyFor(s.derived_day_type, s.slot_date, s.shift_type_code);
    bucketTotals.set(key, (bucketTotals.get(key) || 0) + s.required_count * weightFor(s.shift_type_code));
  }
  // Include already-assigned slots so targets reflect total schedule load
  for (const raw of rawSlots as Array<Record<string, unknown>>) {
    const st = raw.shift_types as { code: string; category: string } | null;
    if (!st || st.category !== 'call') continue;
    const assignments = embedArray(raw.assignments) as Array<{ provider_id: string | null }>;
    const n = assignments.filter(a => a.provider_id).length;
    if (n > 0) {
      const dt = (raw.derived_day_type as string) || 'weekday';
      const key = bucketKeyFor(dt, raw.slot_date as string, st.code);
      bucketTotals.set(key, (bucketTotals.get(key) || 0) + n * weightFor(st.code));
    }
  }

  // Per-provider block target = base share of THIS block + deficit carried
  // forward from past blocks at this site (formula + max(0, …) rationale:
  // computeBucketTargets' docstring above).
  //
  // Par-authoritative (Gabriel 2026-07-24, supersedes the 2026-07-16 pool
  // clamp): the denominator is the STORED sites.call_par_level, in both
  // directions. A par above the pool's ΣFTE deliberately under-targets the
  // block — the fill-all relaxation/mop-up passes still fill every slot they
  // can ("quota never blocks fills"), and the obligatory mode leaves the
  // remainder open as the paid-pickup layer. Targets are still floored at
  // ≥ 1 per positive-FTE provider (floorBucketTargets) so quota math can
  // never structurally zero out a bucket.
  const rawTargets = computeBucketTargets(
    bucketTotals,
    historicalTotalByBucket,
    historicalAssignedByPid,
    providers,
    parLevel,
  );
  // Scenario steering override (2026-07-26): manifest providers' quota
  // targets are the STATED numbers — exact, unfloored, deficit-free (the
  // manifest IS the block's fair share). Non-manifest keys keep the
  // FTE-derived floored targets. Applied AFTER the floor so a stated 0 or
  // 0.5 survives.
  const flooredTargets = floorBucketTargets(rawTargets, providers);
  const bucketTarget = scenario
    ? applyScenarioBucketTargets(flooredTargets, scenario)
    : flooredTargets;

  // Coverage advisory: when the stored-par FTE-weighted targets across the
  // whole pool can't sum to a bucket's slot count (par above pool ΣFTE), the
  // gap is the paid-pickup layer — expected under Gabriel's 2026-07-24 model,
  // so say what it means instead of calling the par stale.
  for (const [key, total] of bucketTotals) {
    let sum = 0;
    for (const p of providers) sum += rawTargets.get(`${p.id}|${key}`) || 0;
    if (sum < total) {
      warnings.push(
        `Bucket ${key}: FTE-weighted quota (${sum.toFixed(2)} at call_par_level ${parLevel}) cannot cover ${total} slots — ` +
        `obligations under-cover by design (par-authoritative); fill-all still fills via relaxation/mop-up, and obligatory mode leaves the remainder open as paid pickups`,
      );
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
    const assignments = embedArray(raw.assignments) as Array<{ id: string; provider_id: string | null; assignment_status?: string; source_type?: string }>;
    for (const a of assignments) {
      if (a.provider_id) {
        seedAssignments.push({
          slot_date: raw.slot_date as string,
          provider_id: a.provider_id,
          shift_type_code: st.code,
          shift_type_category: st.category,
          derived_day_type: (raw.derived_day_type as string) || 'weekday',
          // Eviction provenance (2026-07-21): what the seed-eviction gates and
          // commitPlan's revert need. rawSlots are all THIS version by query,
          // so the version stamp is structural; source_type may be absent on
          // a fake/degraded read — the gates then refuse (never evict what
          // you can't attribute).
          slot_id: raw.id as string,
          assignment_id: a.id,
          source_type: a.source_type,
          schedule_version_id: scheduleVersionId,
        });
      }
    }
  }

  // ── 9. FTE working-days budget (2026-07-17) ───────────────────────────────
  // Load the block's MAJOR federal holidays and compute a per-provider
  // working-days budget: required = round(fte × workingDays) − nettingPtoWeekdays
  // (floored at 0), entitledOff = workingDays − round(fte × workingDays). The
  // budget's presence on ctx OPTS the whole run into the workdays cap (bare /
  // parity fixtures never set it → byte-identical no-cap behavior). Enumerated
  // over the true block span [blockMin, blockMax] from rawSlots (ordered by
  // slot_date), not just open dates, so a partial regenerate still sees the full
  // span. A missing/failed holiday query degrades to "no majors" (all weekdays
  // count) rather than aborting the whole load.
  // majorHolidayDates was loaded in the provider-scoped wave above (empty set
  // when organizationId is null — same degradation as before).
  const workingDaySet = new Set<string>();
  for (let d = blockMin; d <= blockMax; d = addDays(d, 1)) {
    if (isWorkingDay(d, majorHolidayDates)) workingDaySet.add(d);
  }
  const workingDays = workingDaySet.size;
  const byProvider = new Map<string, ProviderWorkDayBudget>();
  for (const p of providers) {
    // ptoWeekdaysCovered subtracts sell-back-covered weekdays (2026-07-20):
    // a sold-back day is owed again, so `required` rises back accordingly.
    const pto = ptoWeekdaysCovered(availByPid.get(p.id) ?? [], workingDaySet).size;
    byProvider.set(p.id, {
      fte: p.fte_value,
      workingDays,
      ptoWeekdays: pto,
      // Provider-limit override (patch34): a stated workingDays IS required;
      // a stated daysOff re-derives (WD − pto − daysOff) so future PTO edits
      // keep shifting it. BLANK → the pre-limits round(FTE × WD) − PTO
      // machinery, untouched (Gabriel's verbatim rule).
      required: requiredWorkDaysWithLimit(p.fte_value, workingDays, pto, providerLimits?.[p.id]),
      entitledOff: entitledOffDays(p.fte_value, workingDays),
    });
  }
  const workDayBudget: WorkDayBudget = { workingDays, workingDaySet, majorHolidayDates, byProvider };

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
      manualCallSlots,
      // ── v2 pattern-interpreter inputs + precomputed invariants ──
      callPattern,
      shiftTypes,
      warnings,
      providerById: new Map(providers.map(p => [p.id, p])),
      prePtoByThursday: buildPrePtoByThursday(providers, availByPid, slotIndex),
      scheduleDates: allSlotDates,
      workDayBudget,
      providerLimits,
      scenario,
    },
    dbQueries,
    totalSlots: rawSlots.length,
  };
}
