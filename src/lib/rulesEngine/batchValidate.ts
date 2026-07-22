// Batch validation for a whole schedule version.
//
// Instead of N x (6 queries + 1 write) via serial evaluateAssignment, this
// loads everything once (~5 queries), constructs an EvaluationContext per
// assignment from the preloaded maps, evaluates in memory with the SAME pure
// evaluators, and persists validation_flags with one bulk upsert (chunked at
// 500 rows). Per-assignment results must be identical to the serial path —
// batchValidate.test.ts asserts parity on canned data.
//
// Clinical invariant 6 (never silently report clean):
//   - a failed PRELOAD query aborts the whole pass: every target comes back
//     evaluated:false and nothing is written (a missing availability/neighbor/
//     credential map would otherwise validate clean against empty data);
//   - an assignment whose context can't be built (unknown shift type, off-site
//     slot) or whose evaluation threw is evaluated:false and EXCLUDED from the
//     write;
//   - a siteCtx that failed to load (loadError) declines the whole pass.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
import { addDays, NEIGHBOR_WINDOW_DAYS, AVAIL_WINDOW_DAYS } from './shared';
import { embedArray } from '@/lib/embed';
// Function-level-only cycle (commit.ts imports batchValidateVersion/chunk from
// here); nothing crosses at module top level, so evaluation order is safe.
import { bulkWriteWithRowFallback } from './commit';
import { fetchCommittedAssignments } from './committedAssignments';
import {
  providerGroupFromType,
  parseEmbeddedFte,
  parseEmbeddedPoolFlags,
  mapCredentialsRow,
  mapNeighborRow,
  mapCrossSiteRow,
  loadProviderLimitsValidationCtx,
} from './loadContext';
import type { SiteValidationContext, JoinedAssignmentRow } from './loadContext';
import { evaluateContext } from './evaluate';
import type { EvaluateResult } from './evaluate';
import type {
  EvaluationContext,
  SlotRow,
  AvailabilityRow,
  ProviderSiteCredentials,
} from './types';

export const WRITE_CHUNK = 500;

export function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

interface RawAssignmentRow {
  id: string;
  provider_id: string | null;
  assignment_status: string;
}
interface RawSlotRow extends SlotRow {
  schedule_version_id: string;
  required_count: number | null;
  assignments: RawAssignmentRow[];
}
// A joined assignment row from the provider-window query, with provider_id.
interface ProviderJoinedRow extends JoinedAssignmentRow {
  provider_id: string;
}

export interface BatchValidateResult {
  // One entry per assignment row in the version, serial-parity shaped.
  results: Array<EvaluateResult & { assignmentId: string }>;
  dbQueries: number;
  errors: string[];
  written: number;
}

export async function batchValidateVersion(
  sb: SupabaseClient,
  scheduleVersionId: string,
  siteCtx: SiteValidationContext,
): Promise<BatchValidateResult> {
  const errors: string[] = [];
  let dbQueries = 0;

  // A site context that failed to load is unusable — evaluating against empty
  // shift-type maps / rules:[] would produce fake-clean flags.
  if (siteCtx.loadError) {
    const msg = `batch validation: validation-unavailable — site context load failed: ${siteCtx.loadError}`;
    errors.push(msg);
    console.error(`[rulesEngine] ${msg}`);
    return { results: [], dbQueries, errors, written: 0 };
  }

  // ── 1. All slots + assignment rows for the version ─────────────────────────
  dbQueries++;
  const { data: slotData, error: slotErr } = await sb
    .from('schedule_slots')
    .select(
      'id, site_id, slot_date, shift_type_id, provider_group, derived_day_type, schedule_version_id, required_count, assignments(id, provider_id, assignment_status)',
    )
    .eq('schedule_version_id', scheduleVersionId);
  if (slotErr) {
    errors.push(`batch validation: validation-unavailable — slot load failed: ${slotErr.message}`);
    return { results: [], dbQueries, errors, written: 0 };
  }
  // UNIQUE(schedule_slot_id) → PostgREST returns each slot's assignments
  // embed as a single OBJECT (or null) against the live DB; dev fakes return
  // arrays. Normalize once here — targets and sameDayFor both walk it.
  const slots = ((slotData || []) as RawSlotRow[]).map(s => ({
    ...s,
    assignments: embedArray(s.assignments),
  }));
  if (slots.length === 0) return { results: [], dbQueries, errors, written: 0 };

  const targets: Array<{ assignmentId: string; slot: RawSlotRow; providerId: string | null }> = [];
  for (const s of slots) {
    for (const a of s.assignments || []) {
      targets.push({ assignmentId: a.id, slot: s, providerId: a.provider_id });
    }
  }

  // A failed preload must fail the WHOLE pass — evaluating against a silently
  // empty map would report clean where PTO/cross-site/credential violations
  // exist (invariants 2/3/6).
  const bail = (what: string, message: string): BatchValidateResult => {
    const msg = `batch validation: validation-unavailable — ${what} load failed: ${message}`;
    errors.push(msg);
    console.error(`[rulesEngine] ${msg}`);
    return {
      results: targets.map(t => ({
        assignmentId: t.assignmentId, slotId: t.slot.id, providerId: t.providerId,
        violations: [], hardCount: 0, softCount: 0, evaluated: false,
      })),
      dbQueries, errors, written: 0,
    };
  };

  const providerIds = [...new Set(targets.map(t => t.providerId).filter((p): p is string => !!p))];
  const dates = slots.map(s => s.slot_date).sort();
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  // A schedule version is single-site (see commitValidation invariant); the
  // guard below flags any slot that breaks it instead of validating it
  // against the wrong site's credentials/rules.
  const siteId = slots[0].site_id;

  // ── 2-5. Provider-scoped preloads (parallelized 2026-07-20, C2.4) ──────────
  // The four preloads are mutually independent once providerIds + the date
  // window are known, so their round trips overlap in one Promise.all wave.
  // Each keeps its exact query shape; failures are checked AFTER the wave in
  // the original order (providers → availability → assignments window →
  // credentials) so the bail message matches the serial load's first-failure
  // semantics. fetchCommittedAssignments' two sub-queries stay sequential
  // inside its member — it is the only pre-write reader of `assignments`.
  const provInfo = new Map<string, {
    group: 'physician' | 'crna' | 'both';
    fte: number | null;
    poolFlags: EvaluationContext['poolFlags'];
  }>();
  const availByPid = new Map<string, AvailabilityRow[]>();
  // ── 4's committed scope (draft isolation, invariant 3): every PUBLISHED
  // version plus THIS version under validation. One helper call serves both
  // the neighbor window (scoped in memory to this version+site, matching the
  // serial loadContext filters) and cross-site double-booking detection
  // (which must see every committed schedule + this version — but NOT other
  // drafts).
  const rowsByPid = new Map<string, ProviderJoinedRow[]>();
  const credByPid = new Map<string, ProviderSiteCredentials>();
  if (providerIds.length > 0) {
    dbQueries++;
    const provQ = sb
      .from('providers')
      .select('id, provider_type, provider_employment_profiles(fte_value, call_taker, partial_call_taker, is_day_doc)')
      .in('id', providerIds);
    dbQueries++;
    const availQ = sb
      .from('provider_availability')
      .select('id, provider_id, availability_type, start_date, end_date, approval_status')
      .in('provider_id', providerIds)
      .lte('start_date', addDays(maxDate, AVAIL_WINDOW_DAYS))
      .gte('end_date', addDays(minDate, -AVAIL_WINDOW_DAYS));
    dbQueries++;
    const rowsQ = fetchCommittedAssignments(
      sb,
      'id, provider_id, schedule_slot_id, schedule_slots!inner(id, slot_date, shift_type_id, derived_day_type, site_id, schedule_version_id, schedule_versions!inner(version_status))',
      {
        providerIds,
        start: addDays(minDate, -NEIGHBOR_WINDOW_DAYS),
        end: addDays(maxDate, NEIGHBOR_WINDOW_DAYS),
        includeVersionId: scheduleVersionId,
      },
    );
    dbQueries++;
    const credQ = sb
      .from('provider_site_credentials')
      .select(
        'provider_id, site_id, is_active, credentialed, can_take_call, can_take_weekend_call, can_take_holiday_call, can_take_backup_call, allowed_shift_types, excluded_shift_types, skill_tags',
      )
      .in('provider_id', providerIds)
      .eq('site_id', siteId);

    const [provRes, availRes, rowsRes, credRes] = await Promise.all([provQ, availQ, rowsQ, credQ]);

    // ── 2. Provider info: group + FTE + pool flags ──
    if (provRes.error) return bail('providers', provRes.error.message);
    for (const row of (provRes.data || []) as Array<Record<string, unknown>>) {
      provInfo.set(row.id as string, {
        group: providerGroupFromType(row.provider_type as string),
        fte: parseEmbeddedFte(row.provider_employment_profiles),
        poolFlags: parseEmbeddedPoolFlags(row.provider_employment_profiles),
      });
    }

    // ── 3. Availability for all assigned providers over the version range ──
    // ALL types un-filtered — pto_sellback rows must ride along so the timeOff
    // evaluator can apply the date-level override (isSellbackOverridden).
    if (availRes.error) return bail('provider_availability', availRes.error.message);
    for (const row of (availRes.data || []) as AvailabilityRow[]) {
      const list = availByPid.get(row.provider_id) || [];
      list.push(row);
      availByPid.set(row.provider_id, list);
    }

    // ── 4. All assigned rows for those providers, version range ±31d ──
    if (rowsRes.error) return bail('assignments window', rowsRes.error.message ?? 'unknown error');
    for (const row of (rowsRes.data || []) as Array<Record<string, unknown>>) {
      if (!row.schedule_slots) continue;
      const pid = row.provider_id as string;
      const list = rowsByPid.get(pid) || [];
      list.push({
        id: row.id as string,
        provider_id: pid,
        schedule_slots: row.schedule_slots as Record<string, unknown>,
      });
      rowsByPid.set(pid, list);
    }

    // ── 5. Site credentials ──
    if (credRes.error) return bail('provider_site_credentials', credRes.error.message);
    for (const row of (credRes.data || []) as Array<Record<string, unknown>>) {
      credByPid.set(row.provider_id as string, mapCredentialsRow(row));
    }
  }

  // ── Provider-limits soft-flag context (2026-07-22, patch34) ────────────────
  // Same shared loader the serial path uses (parity home) — loaded ONCE per
  // pass and threaded onto every context. Degrades to null (feature off);
  // never bails the pass (it feeds SOFT flags only).
  const limitsLoad = await loadProviderLimitsValidationCtx(sb, scheduleVersionId);
  dbQueries += limitsLoad.dbQueries;
  const providerLimitsCtx = limitsLoad.ctx;

  // ── sameDay index (from the step-1 rows, mirrors serial query 5) ───────────
  const slotsByDate = new Map<string, RawSlotRow[]>();
  for (const s of slots) {
    const list = slotsByDate.get(s.slot_date) || [];
    list.push(s);
    slotsByDate.set(s.slot_date, list);
  }
  const sameDayCache = new Map<string, EvaluationContext['sameDayAssignments']>();
  const sameDayFor = (date: string): EvaluationContext['sameDayAssignments'] => {
    const cached = sameDayCache.get(date);
    if (cached) return cached;
    const out: EvaluationContext['sameDayAssignments'] = [];
    for (const s of slotsByDate.get(date) || []) {
      const st = siteCtx.shiftTypesById.get(s.shift_type_id);
      if (!st) continue; // serial drops unknown shift types the same way
      for (const a of s.assignments || []) {
        out.push({
          slot_id: s.id,
          slot_date: s.slot_date,
          shift_type_code: st.code,
          shift_type_category: st.category,
          provider_id: a.provider_id,
          required_count: s.required_count || 1,
        });
      }
    }
    sameDayCache.set(date, out);
    return out;
  };

  // ── Evaluate every assignment in memory ────────────────────────────────────
  const results: BatchValidateResult['results'] = [];
  const loggedEvaluatorErrors = new Set<string>(); // one log per broken evaluator per run
  let offSite = 0;
  for (const t of targets) {
    const slot = t.slot;
    const unevaluated = () => {
      results.push({
        assignmentId: t.assignmentId, slotId: slot.id, providerId: t.providerId,
        violations: [], hardCount: 0, softCount: 0, evaluated: false,
      });
    };

    // Single-site guard: preloads (credentials, siteCtx rules/shift types) are
    // keyed to this version's site — an off-site slot cannot be evaluated here.
    if (slot.site_id !== siteId) {
      offSite++;
      unevaluated();
      continue;
    }

    const shiftType = siteCtx.shiftTypesById.get(slot.shift_type_id);
    if (!shiftType) {
      // Serial loadContext would return null here → evaluated:false, no write.
      unevaluated();
      continue;
    }

    const pid = t.providerId;
    const info = pid ? provInfo.get(pid) : undefined;
    const providerRows = pid ? rowsByPid.get(pid) || [] : [];

    const nStart = addDays(slot.slot_date, -NEIGHBOR_WINDOW_DAYS);
    const nEnd = addDays(slot.slot_date, NEIGHBOR_WINDOW_DAYS);
    const neighborAssignments: EvaluationContext['neighborAssignments'] = [];
    for (const r of providerRows) {
      const rs = r.schedule_slots!;
      const rDate = rs.slot_date as string;
      if (rDate < nStart || rDate > nEnd) continue;
      // In-memory equivalent of the serial query's version+site scoping.
      if (rs.schedule_version_id !== scheduleVersionId || rs.site_id !== slot.site_id) continue;
      const mapped = mapNeighborRow(r, siteCtx.shiftTypesById, slot.id);
      if (mapped) neighborAssignments.push(mapped);
    }

    // Cross-site rows: same date, any COMMITTED (published) site/version plus
    // this version, self included (serial parity — rowsByPid is already scoped
    // to committed + current-version by the helper above).
    const crossSiteAssignments: EvaluationContext['crossSiteAssignments'] = [];
    for (const r of providerRows) {
      if ((r.schedule_slots!.slot_date as string) !== slot.slot_date) continue;
      const mapped = mapCrossSiteRow(r, siteCtx.shiftTypesById);
      if (mapped) crossSiteAssignments.push(mapped);
    }

    const aStart = addDays(slot.slot_date, -AVAIL_WINDOW_DAYS);
    const aEnd = addDays(slot.slot_date, AVAIL_WINDOW_DAYS);
    const availability = pid
      ? (availByPid.get(pid) || []).filter(a => a.start_date <= aEnd && a.end_date >= aStart)
      : [];

    const ctx: EvaluationContext = {
      slot,
      shiftType,
      providerId: pid,
      providerGroup: info?.group ?? null,
      credentials: (pid && credByPid.get(pid)) || null,
      fte_value: info?.fte ?? null,
      poolFlags: info?.poolFlags ?? null,
      neighborAssignments,
      availability,
      sameDayAssignments: sameDayFor(slot.slot_date),
      crossSiteAssignments,
      scheduleVersionId,
      providerLimitsCtx,
      rules: siteCtx.rules,
      shiftTypesByCode: siteCtx.shiftTypesByCode,
      shiftTypesById: siteCtx.shiftTypesById,
    };

    const { violations, evaluated } = evaluateContext(ctx, loggedEvaluatorErrors);
    results.push({
      assignmentId: t.assignmentId,
      slotId: slot.id,
      providerId: pid,
      violations,
      hardCount: violations.filter(v => v.severity === 'hard').length,
      softCount: violations.filter(v => v.severity === 'soft').length,
      evaluated,
    });
  }

  if (offSite > 0) {
    const msg = `batch validation: ${offSite} slot(s) outside site ${siteId} in version ${scheduleVersionId} — single-site invariant broken; those assignments left unvalidated`;
    errors.push(msg);
    console.error(`[rulesEngine] ${msg}`);
  }

  // ── One bulk write; unevaluated rows are skipped, never written clean ──────
  const slotIdByAssignment = new Map(targets.map(t => [t.assignmentId, t.slot.id]));
  const payload = results
    .filter(r => r.evaluated)
    .map(r => ({
      id: r.assignmentId,
      // schedule_slot_id satisfies the NOT NULL constraint on the (never
      // taken) insert arm of the upsert; the value is unchanged.
      schedule_slot_id: slotIdByAssignment.get(r.assignmentId)!,
      validation_flags: r.violations,
    }));

  const skipped = results.length - payload.length;
  if (skipped > 0) {
    const msg = `validation-unavailable for ${skipped} assignment(s) — validation_flags left untouched`;
    errors.push(`batch validation: ${msg}`);
    console.error(`[rulesEngine] batch validation: ${msg}`);
  }

  // Shared bulk-write idiom: one upsert per chunk, per-row fallback on bulk
  // failure (one concurrently deleted id would otherwise resurrect a ghost row
  // or trip UNIQUE(schedule_slot_id) and fail the whole chunk). Only rows the
  // DB confirms count as written.
  let written = 0;
  for (const rows of chunk(payload, WRITE_CHUNK)) {
    const w = await bulkWriteWithRowFallback(sb, 'assignments', rows, {
      onConflict: 'id', label: 'batch validation flag write',
    });
    dbQueries += w.dbQueries;
    written += w.landedIdx.length;
    for (const e of w.rowErrors) {
      errors.push(`batch validation: flag write failed for assignment ${rows[e.index].id}: ${e.message}`);
    }
  }

  return { results, dbQueries, errors, written };
}
