// Batch validation for a whole schedule version.
//
// Instead of N x (6 queries + 1 write) via serial evaluateAssignment, this
// loads everything once (~5 queries), constructs an EvaluationContext per
// assignment from the preloaded maps, evaluates in memory with the SAME pure
// evaluators, and persists validation_flags with one bulk upsert (chunked at
// 500 rows). Per-assignment results must be identical to the serial path —
// batchValidate.test.ts asserts parity on canned data.
//
// Clinical invariant 6: an assignment whose context can't be built (unknown
// shift type) or whose evaluation threw is returned with evaluated:false and
// EXCLUDED from the write — validation_flags are never overwritten with a
// value that would masquerade as clean.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
import { addDays } from './shared';
import { providerGroupFromType, parseEmbeddedFte } from './loadContext';
import type { SiteValidationContext } from './loadContext';
import { evaluateContext } from './evaluate';
import type { EvaluateResult } from './evaluate';
import type {
  EvaluationContext,
  SlotRow,
  AvailabilityRow,
  ProviderSiteCredentials,
  DayType,
} from './types';

// Mirror the serial loadContext windows exactly (parity requirement).
const NEIGHBOR_WINDOW_DAYS = 31;
const AVAIL_WINDOW_DAYS = 14;
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
interface RawNeighborRow {
  id: string;
  provider_id: string;
  slot_id: string;
  slot_date: string;
  shift_type_id: string;
  day_type: DayType | null;
  site_id: string;
  schedule_version_id: string | null;
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

  // ── 1. All slots + assignment rows for the version ─────────────────────────
  dbQueries++;
  const { data: slotData, error: slotErr } = await sb
    .from('schedule_slots')
    .select(
      'id, site_id, slot_date, shift_type_id, provider_group, derived_day_type, schedule_version_id, required_count, assignments(id, provider_id, assignment_status)',
    )
    .eq('schedule_version_id', scheduleVersionId);
  if (slotErr) {
    errors.push(`batch validation: slot load failed: ${slotErr.message}`);
    return { results: [], dbQueries, errors, written: 0 };
  }
  const slots = (slotData || []) as RawSlotRow[];
  if (slots.length === 0) return { results: [], dbQueries, errors, written: 0 };

  const targets: Array<{ assignmentId: string; slot: RawSlotRow; providerId: string | null }> = [];
  for (const s of slots) {
    for (const a of s.assignments || []) {
      targets.push({ assignmentId: a.id, slot: s, providerId: a.provider_id });
    }
  }

  const providerIds = [...new Set(targets.map(t => t.providerId).filter((p): p is string => !!p))];
  const dates = slots.map(s => s.slot_date).sort();
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  // A schedule version is single-site (see commitValidation invariant).
  const siteId = slots[0].site_id;

  // ── 2. Provider info: group + FTE ──────────────────────────────────────────
  const provInfo = new Map<string, { group: 'physician' | 'crna' | 'both'; fte: number | null }>();
  if (providerIds.length > 0) {
    dbQueries++;
    const { data } = await sb
      .from('providers')
      .select('id, provider_type, provider_employment_profiles(fte_value)')
      .in('id', providerIds);
    for (const row of (data || []) as Array<Record<string, unknown>>) {
      provInfo.set(row.id as string, {
        group: providerGroupFromType(row.provider_type as string),
        fte: parseEmbeddedFte(row.provider_employment_profiles),
      });
    }
  }

  // ── 3. Availability for all assigned providers over the version range ──────
  const availByPid = new Map<string, AvailabilityRow[]>();
  if (providerIds.length > 0) {
    dbQueries++;
    const { data } = await sb
      .from('provider_availability')
      .select('id, provider_id, availability_type, start_date, end_date, approval_status')
      .in('provider_id', providerIds)
      .lte('start_date', addDays(maxDate, AVAIL_WINDOW_DAYS))
      .gte('end_date', addDays(minDate, -AVAIL_WINDOW_DAYS));
    for (const row of (data || []) as AvailabilityRow[]) {
      const list = availByPid.get(row.provider_id) || [];
      list.push(row);
      availByPid.set(row.provider_id, list);
    }
  }

  // ── 4. All assigned rows for those providers, version range ±31d ───────────
  // Deliberately UNSCOPED by site/version: one query serves both the
  // neighbor window (scoped in memory to this version+site, matching the
  // serial loadContext filters) and cross-site double-booking detection
  // (which must see every site and every version).
  const rowsByPid = new Map<string, RawNeighborRow[]>();
  if (providerIds.length > 0) {
    dbQueries++;
    const { data } = await sb
      .from('assignments')
      .select(
        'id, provider_id, schedule_slot_id, schedule_slots!inner(id, slot_date, shift_type_id, derived_day_type, site_id, schedule_version_id)',
      )
      .in('provider_id', providerIds)
      .eq('assignment_status', 'assigned')
      .gte('schedule_slots.slot_date', addDays(minDate, -NEIGHBOR_WINDOW_DAYS))
      .lte('schedule_slots.slot_date', addDays(maxDate, NEIGHBOR_WINDOW_DAYS));
    for (const row of (data || []) as Array<Record<string, unknown>>) {
      const s = row.schedule_slots as Record<string, unknown> | null;
      if (!s) continue;
      const pid = row.provider_id as string;
      const list = rowsByPid.get(pid) || [];
      list.push({
        id: row.id as string,
        provider_id: pid,
        slot_id: s.id as string,
        slot_date: s.slot_date as string,
        shift_type_id: s.shift_type_id as string,
        day_type: (s.derived_day_type as DayType | null) ?? null,
        site_id: s.site_id as string,
        schedule_version_id: (s.schedule_version_id as string | null) ?? null,
      });
      rowsByPid.set(pid, list);
    }
  }

  // ── 5. Site credentials ─────────────────────────────────────────────────────
  const credByPid = new Map<string, ProviderSiteCredentials>();
  if (providerIds.length > 0) {
    dbQueries++;
    const { data } = await sb
      .from('provider_site_credentials')
      .select(
        'provider_id, site_id, is_active, credentialed, can_take_call, can_take_weekend_call, can_take_holiday_call, can_take_backup_call, allowed_shift_types, excluded_shift_types, skill_tags',
      )
      .in('provider_id', providerIds)
      .eq('site_id', siteId);
    for (const row of (data || []) as Array<Record<string, unknown>>) {
      credByPid.set(row.provider_id as string, {
        provider_id: row.provider_id as string,
        site_id: row.site_id as string,
        is_active: !!row.is_active,
        credentialed: !!row.credentialed,
        can_take_call: !!row.can_take_call,
        can_take_weekend_call: !!row.can_take_weekend_call,
        can_take_holiday_call: !!row.can_take_holiday_call,
        can_take_backup_call: !!row.can_take_backup_call,
        allowed_shift_types: Array.isArray(row.allowed_shift_types) ? (row.allowed_shift_types as string[]) : [],
        excluded_shift_types: Array.isArray(row.excluded_shift_types) ? (row.excluded_shift_types as string[]) : [],
        skill_tags: Array.isArray(row.skill_tags) ? (row.skill_tags as string[]) : [],
      });
    }
  }

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
  for (const t of targets) {
    const slot = t.slot;
    const shiftType = siteCtx.shiftTypesById.get(slot.shift_type_id);
    if (!shiftType) {
      // Serial loadContext would return null here → evaluated:false, no write.
      results.push({
        assignmentId: t.assignmentId, slotId: slot.id, providerId: t.providerId,
        violations: [], hardCount: 0, softCount: 0, evaluated: false,
      });
      continue;
    }

    const pid = t.providerId;
    const info = pid ? provInfo.get(pid) : undefined;
    const providerRows = pid ? rowsByPid.get(pid) || [] : [];

    const nStart = addDays(slot.slot_date, -NEIGHBOR_WINDOW_DAYS);
    const nEnd = addDays(slot.slot_date, NEIGHBOR_WINDOW_DAYS);
    const neighborAssignments: EvaluationContext['neighborAssignments'] = [];
    for (const r of providerRows) {
      if (r.slot_id === slot.id) continue; // not a neighbor of itself
      if (r.slot_date < nStart || r.slot_date > nEnd) continue;
      // In-memory equivalent of the serial query's version+site scoping.
      if (r.schedule_version_id !== scheduleVersionId || r.site_id !== slot.site_id) continue;
      const st = siteCtx.shiftTypesById.get(r.shift_type_id);
      if (!st) continue;
      neighborAssignments.push({
        assignment_id: r.id,
        slot_date: r.slot_date,
        shift_type_code: st.code,
        shift_type_category: st.category,
        day_type: r.day_type,
      });
    }

    // Cross-site rows: same date, ANY site/version, self included (serial parity).
    const crossSiteAssignments: EvaluationContext['crossSiteAssignments'] = providerRows
      .filter(r => r.slot_date === slot.slot_date)
      .map(r => ({
        assignment_id: r.id,
        site_id: r.site_id,
        slot_date: r.slot_date,
        shift_type_code: siteCtx.shiftTypesById.get(r.shift_type_id)?.code || 'unknown',
      }));

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
      neighborAssignments,
      availability,
      sameDayAssignments: sameDayFor(slot.slot_date),
      crossSiteAssignments, // already [] when pid is null (providerRows is [])
      scheduleVersionId,
      rules: siteCtx.rules,
      shiftTypesByCode: siteCtx.shiftTypesByCode,
      shiftTypesById: siteCtx.shiftTypesById,
    };

    const { violations, evaluated } = evaluateContext(ctx);
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

  let written = 0;
  for (const rows of chunk(payload, WRITE_CHUNK)) {
    dbQueries++;
    const { error } = await sb.from('assignments').upsert(rows, { onConflict: 'id' });
    if (error) errors.push(`batch validation: flag write failed: ${error.message}`);
    else written += rows.length;
  }

  return { results, dbQueries, errors, written };
}
