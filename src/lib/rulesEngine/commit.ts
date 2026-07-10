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
    dbQueries++;
    const { error } = await sb.from('assignments').upsert(rows, { onConflict: 'id' });
    if (!error) continue;
    // Bulk upsert failed (e.g. a row was concurrently deleted — the insert
    // arm would resurrect a ghost row or trip UNIQUE(schedule_slot_id) and
    // fail the whole chunk). Fall back to per-row updates: an update on a
    // deleted id is a harmless no-op; surviving rows still get metadata.
    console.error(`[rulesEngine] metadata bulk write failed (${error.message}) — falling back to per-row updates`);
    for (const row of rows) {
      dbQueries++;
      const { error: rowErr } = await sb
        .from('assignments')
        .update({ generation_metadata: row.generation_metadata })
        .eq('id', row.id);
      if (rowErr) errors.push(`metadata write failed for assignment ${row.id}: ${rowErr.message}`);
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

// Batched write of the whole plan. Two bulk calls instead of N serial writes.
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
    dbQueries++;
    const { error } = await sb.from('assignments').upsert(updates, { onConflict: 'id' });
    if (error) errors.push(`Batch update failed: ${error.message}`);
    else filled += updates.length;
  }
  if (inserts.length > 0) {
    dbQueries++;
    const { error } = await sb.from('assignments').insert(inserts);
    if (error) errors.push(`Batch insert failed: ${error.message}`);
    else filled += inserts.length;
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
