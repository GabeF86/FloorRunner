import { evaluateAssignment } from './evaluate';
import { loadSiteValidationContext } from './loadContext';
import type { SupabaseClient } from './shared';
import type { SolutionPlan, PlannedAssignment } from './genTypes';

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

// INVARIANT: every assignment must belong to `siteId`. loadSiteValidationContext
// keys off this value (a schedule version is single-site, so this always holds
// for the orchestrator's call site).
// Validation pass — loads the per-site rule/shift-type context ONCE (M3 fix)
// and threads it into each evaluateAssignment, then writes validation_flags
// in parallel batches.
export async function commitValidation(
  sb: SupabaseClient,
  siteId: string,
  assignments: PlannedAssignment[],
): Promise<{ dbQueries: number }> {
  // NOTE: dbQueries is an approximate lower bound — loadSiteValidationContext
  // itself issues 2-3 queries but is counted once. Used for smoke-test signal,
  // not exact accounting.
  let dbQueries = 0;
  dbQueries++;
  const siteCtx = await loadSiteValidationContext(sb, siteId);

  const CONCURRENCY = 10;
  for (let i = 0; i < assignments.length; i += CONCURRENCY) {
    const batch = assignments.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async a => {
      dbQueries++;
      const ev = await evaluateAssignment(sb, a.slot_id, a.provider_id, siteCtx);
      dbQueries++;
      await sb.from('assignments')
        .update({ validation_flags: ev.violations })
        .eq('schedule_slot_id', a.slot_id)
        .eq('provider_id', a.provider_id);
    }));
  }
  return { dbQueries };
}
