import { loadSiteValidationContext } from './loadContext';
import { batchValidateVersion, chunk, WRITE_CHUNK } from './batchValidate';
import type { SupabaseClient } from './shared';
import type { SolutionPlan, PlannedAssignment } from './genTypes';

// Pure: fold source + explanation detail into the jsonb stored on the row.
export function buildMetadataPayload(a: PlannedAssignment): Record<string, unknown> {
  return { source: a.source, ...(a.explanation ?? {}) };
}

// Cheap probe: does scheduling.assignments have the generation_metadata column?
// Mirrors the call_par_level graceful-fallback pattern. Returns false on any error.
//
// The POSITIVE result is cached for the process lifetime — once the column is
// confirmed present, every later generation skips the round-trip. A negative
// result is NOT cached, so applying the migration mid-process self-heals on the
// next generation rather than being stuck "absent" until a restart.
let metadataColumnConfirmed = false;
export async function hasGenerationMetadataColumn(sb: SupabaseClient): Promise<boolean> {
  if (metadataColumnConfirmed) return true;
  const { error } = await sb.from('assignments').select('generation_metadata').limit(1);
  if (!error) metadataColumnConfirmed = true;
  return !error;
}

// Test-only: reset the cached probe result so unit tests don't leak state.
export function __resetMetadataColumnCache(): void {
  metadataColumnConfirmed = false;
}

// .in() read chunks stay well under URL-length limits (500 UUIDs ≈ 19KB of
// query string); writes go in the request body so WRITE_CHUNK can be larger.
const READ_CHUNK = 100;

export interface BulkWriteOutcome {
  landedIdx: number[];                                  // row indices confirmed written
  rowErrors: Array<{ index: number; message: string }>; // per-row fallback failures
  dbQueries: number;
}

// The shared bulk-write idiom (commitMetadata / commitPlan / batchValidate /
// dayShiftAutoGen — previously four divergent copies): one bulk call for the
// whole batch; if THAT fails (e.g. one concurrently deleted id would make the
// upsert's insert arm resurrect a ghost row or trip UNIQUE(schedule_slot_id)
// and sink the chunk), fall back to per-row writes so one bad row can't lose
// the batch.
//
// opts.onConflict set   → bulk upsert; fallback = per-row UPDATE of the
//   non-key fields keyed by the conflict column, confirmed via .select() so
//   only rows the DB actually touched count as landed. A zero-row update (the
//   row vanished) is a harmless no-op: not landed, not an error.
// opts.onConflict unset → bulk insert; fallback = per-row inserts.
//
// Callers own error MESSAGE formatting (rowErrors carry the row index) and
// chunking (pass one WRITE_CHUNK-sized batch at a time). NOTE: batchValidate
// imports this — a deliberate function-level-only cycle with the
// batchValidateVersion/chunk imports above (nothing crosses at module top
// level, and function declarations are hoisted, so evaluation order is safe).
export async function bulkWriteWithRowFallback<T extends object>(
  sb: SupabaseClient,
  table: string,
  rows: T[],
  opts: { onConflict?: string; label: string },
): Promise<BulkWriteOutcome> {
  const out: BulkWriteOutcome = { landedIdx: [], rowErrors: [], dbQueries: 0 };
  if (rows.length === 0) return out;

  out.dbQueries++;
  const bulk = opts.onConflict
    ? await sb.from(table).upsert(rows, { onConflict: opts.onConflict })
    : await sb.from(table).insert(rows);
  if (!bulk.error) {
    out.landedIdx = rows.map((_, i) => i);
    return out;
  }

  console.error(`[rulesEngine] ${opts.label}: bulk write failed (${bulk.error.message}) — falling back to per-row writes`);
  for (let i = 0; i < rows.length; i++) {
    out.dbQueries++;
    if (opts.onConflict) {
      const { [opts.onConflict]: key, ...fields } = rows[i] as Record<string, unknown>;
      const { data, error } = await sb
        .from(table)
        .update(fields)
        .eq(opts.onConflict, key)
        .select(opts.onConflict);
      if (error) out.rowErrors.push({ index: i, message: error.message });
      else if (Array.isArray(data) && data.length > 0) out.landedIdx.push(i);
      // else: zero rows updated — the row vanished; silent no-op by design.
    } else {
      const { error } = await sb.from(table).insert(rows[i]);
      if (error) out.rowErrors.push({ index: i, message: error.message });
      else out.landedIdx.push(i);
    }
  }
  return out;
}

// Best-effort: write generation_metadata per assignment. Caller should only
// invoke this when hasGenerationMetadataColumn() is true. One preload of the
// existing assignment ids (matched by slot+provider), then one bulk upsert
// keyed by assignment id — instead of N serial (slot, provider) updates.
export async function commitMetadata(
  sb: SupabaseClient,
  assignments: PlannedAssignment[],
): Promise<{ dbQueries: number; errors: string[] }> {
  const errors: string[] = [];
  let dbQueries = 0;
  if (assignments.length === 0) return { dbQueries, errors };

  const bySlotProvider = new Map<string, PlannedAssignment>();
  for (const a of assignments) bySlotProvider.set(`${a.slot_id}|${a.provider_id}`, a);
  const slotIds = [...new Set(assignments.map(a => a.slot_id))];

  // Preload the existing row ids for the plan's slots.
  const payload: Array<{ id: string; schedule_slot_id: string; generation_metadata: Record<string, unknown> }> = [];
  for (const ids of chunk(slotIds, READ_CHUNK)) {
    dbQueries++;
    const { data, error } = await sb
      .from('assignments')
      .select('id, schedule_slot_id, provider_id')
      .in('schedule_slot_id', ids);
    if (error) {
      errors.push(`metadata id fetch failed: ${error.message}`);
      continue;
    }
    for (const row of (data || []) as Array<{ id: string; schedule_slot_id: string; provider_id: string | null }>) {
      const planned = bySlotProvider.get(`${row.schedule_slot_id}|${row.provider_id}`);
      if (!planned) continue; // row belongs to someone else / was reassigned
      payload.push({
        id: row.id,
        // schedule_slot_id satisfies NOT NULL on the (never taken) insert arm.
        schedule_slot_id: row.schedule_slot_id,
        generation_metadata: buildMetadataPayload(planned),
      });
    }
  }

  for (const rows of chunk(payload, WRITE_CHUNK)) {
    const w = await bulkWriteWithRowFallback(sb, 'assignments', rows, {
      onConflict: 'id', label: 'metadata',
    });
    dbQueries += w.dbQueries;
    for (const e of w.rowErrors) {
      errors.push(`metadata write failed for assignment ${rows[e.index].id}: ${e.message}`);
    }
  }
  return { dbQueries, errors };
}

export interface WriteUpdate {
  id: string;
  provider_id: string;
  assignment_status: 'assigned';
  source_type: 'auto_generated';
  assigned_at: string;
}
export interface WriteInsert {
  schedule_slot_id: string;
  provider_id: string;
  assignment_status: 'assigned';
  source_type: 'auto_generated';
  assigned_at: string;
}

// Pure: partition planned assignments into the upsert (existing open row) and
// insert (no row yet) batches. `assigned_at` is supplied by the caller so this
// stays deterministic/testable.
export function partitionForWrite(
  assignments: PlannedAssignment[],
  assignedAt = '1970-01-01T00:00:00.000Z',
): { updates: WriteUpdate[]; inserts: WriteInsert[] } {
  const updates: WriteUpdate[] = [];
  const inserts: WriteInsert[] = [];
  for (const a of assignments) {
    if (a.existing_assignment_id) {
      updates.push({
        id: a.existing_assignment_id, provider_id: a.provider_id,
        assignment_status: 'assigned', source_type: 'auto_generated',
        assigned_at: assignedAt,
      });
    } else {
      inserts.push({
        schedule_slot_id: a.slot_id, provider_id: a.provider_id,
        assignment_status: 'assigned', source_type: 'auto_generated',
        assigned_at: assignedAt,
      });
    }
  }
  return { updates, inserts };
}

export interface CommitResult {
  filled: number;
  errors: string[];
  dbQueries: number;
}

// Batched write of the whole plan. Two bulk calls instead of N serial writes;
// per-row fallback on bulk failure so one bad row no longer loses the batch.
export async function commitPlan(
  sb: SupabaseClient,
  plan: SolutionPlan,
): Promise<CommitResult> {
  const errors: string[] = [];
  let dbQueries = 0;
  const assignedAt = new Date().toISOString();
  const { updates, inserts } = partitionForWrite(plan.assignments, assignedAt);

  let filled = 0;
  if (updates.length > 0) {
    const w = await bulkWriteWithRowFallback(sb, 'assignments', updates, {
      onConflict: 'id', label: 'plan update batch',
    });
    dbQueries += w.dbQueries;
    filled += w.landedIdx.length;
    for (const e of w.rowErrors) {
      errors.push(`Batch update failed for assignment ${updates[e.index].id}: ${e.message}`);
    }
  }
  if (inserts.length > 0) {
    const w = await bulkWriteWithRowFallback(sb, 'assignments', inserts, {
      label: 'plan insert batch',
    });
    dbQueries += w.dbQueries;
    filled += w.landedIdx.length;
    for (const e of w.rowErrors) {
      errors.push(`Batch insert failed for slot ${inserts[e.index].schedule_slot_id}: ${e.message}`);
    }
  }

  return { filled, errors, dbQueries };
}

// INVARIANT: the schedule version must belong to `siteId` (a schedule version
// is single-site, so this always holds for the orchestrator's call site).
// Validation pass — loads the per-site rule/shift-type context ONCE, then
// delegates to batchValidateVersion, which validates EVERY assignment row in
// the version in ~5 queries and persists with one bulk upsert. Assignments
// that could not be evaluated are skipped, never written clean (invariant 6);
// they surface in `errors` as 'validation-unavailable'.
export async function commitValidation(
  sb: SupabaseClient,
  siteId: string,
  scheduleVersionId: string,
): Promise<{ dbQueries: number; errors: string[] }> {
  // NOTE: dbQueries is an approximate lower bound — loadSiteValidationContext
  // itself issues 2-3 queries but is counted once. Used for smoke-test signal,
  // not exact accounting.
  let dbQueries = 0;
  dbQueries++;
  const siteCtx = await loadSiteValidationContext(sb, siteId);

  const batch = await batchValidateVersion(sb, scheduleVersionId, siteCtx);
  return { dbQueries: dbQueries + batch.dbQueries, errors: batch.errors };
}
