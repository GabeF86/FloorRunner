// Shared mutation cores for the schedule assistant AND the HTTP routes.
// replaceActivePattern moved here from
// src/app/api/scheduling/call-patterns/route.helpers.ts (Task 13 built it
// HTTP-free for exactly this move; the route imports it from here now).
// Assignment writes mirror the manual schedule-assignments route's code path
// (evaluate → upsert with real-or-sentinel flags → sequence auto-fill) by
// reusing the SAME engine modules, so assistant edits and manual UI edits
// can never diverge on the clinical invariants.
import { evaluateAssignment, validationFlagsFor } from '@/lib/rulesEngine/evaluate';
import { applySequenceAutoFill, cleanupSequenceAutoFill } from '@/lib/rulesEngine/sequenceAutoFill';
import { revalidateNeighbors } from '@/lib/rulesEngine/neighborRevalidation';
import type { CallPatternDoc } from '@/lib/rulesEngine/callPattern';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchedulingClient = any;
type PatternRow = Record<string, unknown>;
type SbError = { message: string; code?: string };

// 'seed' is migration-only provenance — runtime writers are the manual UI
// and the assistant, so the enum is narrowed to exactly those two.
export type PatternSource = 'manual' | 'assistant';

// Invalid model-supplied tool input → fed back to the model as an is_error
// tool_result so it self-corrects. Lives here (not tools.ts) so the mutation
// cores can throw it without an import cycle; tools.ts re-exports it.
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

// Assistant edits are scoped to ONE schedule version — the one the snapshot
// captured. A stale or hallucinated-but-real slot id from another version
// would mutate data the snapshot can't restore, so it is refused as invalid
// input (the model recovers by calling get_grid for current ids).
async function assertSlotInVersion(
  sb: SchedulingClient,
  slotId: string,
  expectedVersionId: string,
): Promise<void> {
  const { data: slot, error } = await sb
    .from('schedule_slots')
    .select('id, schedule_version_id')
    .eq('id', slotId)
    .maybeSingle();
  if (error) throw new Error(`slot lookup failed: ${error.message}`);
  if (!slot) {
    throw new ToolInputError(`slot ${slotId} not found — call get_grid for this schedule's current slot ids`);
  }
  if (slot.schedule_version_id !== expectedVersionId) {
    throw new ToolInputError(
      `slot ${slotId} belongs to a different schedule version — only slots in the current version can be edited; call get_grid for current slot ids`,
    );
  }
}

// Replaces the site's active call pattern. "Transaction" is approximated:
// archive the current active row, insert the new one as active. The partial
// unique index call_patterns_one_active makes a concurrent writer surface as
// a 23505 on insert, in which case we re-archive and retry exactly once.
// If the insert STILL fails, the just-archived row is re-activated so the
// site is never left with no active pattern (the engine would silently fall
// back to the classic constant otherwise).
export async function replaceActivePattern(
  sb: SchedulingClient,
  siteId: string,
  definition: CallPatternDoc,
  opts: { name?: string; source?: PatternSource } = {},
): Promise<{ data: PatternRow | null; error: SbError | null }> {
  const name = opts.name ?? 'Custom pattern';
  const source = opts.source ?? 'manual';

  // Capture the current active row id BEFORE archiving so a terminal insert
  // failure can restore it precisely (not just "whatever is archived").
  const { data: prevActive } = await sb
    .from('call_patterns')
    .select('id')
    .eq('site_id', siteId)
    .eq('status', 'active')
    .maybeSingle();

  const archiveActive = () => sb.from('call_patterns')
    .update({ status: 'archived' })
    .eq('site_id', siteId)
    .eq('status', 'active');
  const insertActive = () => sb.from('call_patterns')
    .insert({ site_id: siteId, name, status: 'active', source, definition })
    .select()
    .single();

  const { error: archiveErr } = await archiveActive();
  if (archiveErr) return { data: null, error: archiveErr as SbError };

  let { data, error } = await insertActive();
  if (error && (error as SbError).code === '23505') {
    const { error: rearchiveErr } = await archiveActive();
    if (rearchiveErr) return { data: null, error: rearchiveErr as SbError };
    ({ data, error } = await insertActive());
  }
  if (error) {
    // Terminal insert failure: re-activate the row we archived so the site
    // keeps a live pattern. Best effort — the original error is what matters.
    if (prevActive?.id) {
      const { error: restoreErr } = await sb
        .from('call_patterns')
        .update({ status: 'active' })
        .eq('id', prevActive.id);
      if (restoreErr) {
        console.error(`[scheduleAssistant] replaceActivePattern: failed to re-activate previous pattern ${prevActive.id}: ${restoreErr.message}`);
      }
    }
    return { data: null, error: error as SbError };
  }
  return { data: data as PatternRow, error: null };
}

// ── Assignment edits (assistant path, mirrors the manual route) ─────────────

export interface AssignOutcome {
  assignment: Record<string, unknown>;
  validation: { evaluated: boolean; hardCount: number; softCount: number; violations: unknown[] };
  filledSlotIds: string[];
  evictedSlotIds: string[];
  skips: unknown[];
  patternWarnings: string[];
}

// Same sequence as POST /api/scheduling/schedule-assignments: evaluate first
// (sentinel flag when validation is unavailable — invariant 6), atomic upsert
// on UNIQUE(schedule_slot_id), then pattern-driven sequence auto-fill.
export async function assignProviderToSlot(
  sb: SchedulingClient,
  slotId: string,
  providerId: string,
  expectedVersionId: string,
): Promise<AssignOutcome> {
  await assertSlotInVersion(sb, slotId, expectedVersionId);
  const evalResult = await evaluateAssignment(sb, slotId, providerId);
  if (!evalResult.evaluated) {
    console.error(`[scheduleAssistant] validation unavailable for slot ${slotId} — writing needs-re-validation sentinel`);
  }

  const { data, error } = await sb
    .from('assignments')
    .upsert(
      {
        schedule_slot_id: slotId,
        provider_id: providerId,
        assignment_status: 'assigned',
        // scheduling.source_type is an enum without an 'assistant' value —
        // assistant edits are manual edits made on the scheduler's behalf;
        // provenance is tracked via assistant_actions.
        source_type: 'manual',
        assigned_at: new Date().toISOString(),
        validation_flags: validationFlagsFor(evalResult),
      },
      { onConflict: 'schedule_slot_id' },
    )
    .select()
    .single();
  if (error) throw new Error(`assignment write failed: ${error.message}`);

  const fill = await applySequenceAutoFill(sb, slotId, providerId);
  // Same post-write step as the manual route: refresh the provider's ±7-day
  // neighbors' stored validation_flags (best-effort, never throws).
  await revalidateNeighbors(sb, slotId, providerId);
  return {
    assignment: data as Record<string, unknown>,
    validation: {
      evaluated: evalResult.evaluated,
      hardCount: evalResult.hardCount,
      softCount: evalResult.softCount,
      violations: evalResult.violations,
    },
    filledSlotIds: fill.filledSlotIds,
    evictedSlotIds: fill.evictedSlotIds,
    skips: fill.skips,
    patternWarnings: fill.patternWarnings,
  };
}

export interface ClearOutcome {
  cleared: boolean;
  clearedSlotIds: string[];
  patternWarnings: string[];
}

// Same sequence as DELETE /api/scheduling/schedule-assignments: clean up the
// pattern-linked auto-fills BEFORE deleting the trigger row, delete, then
// recreate the slot's row as 'open' (one-row-per-slot model).
export async function clearSlotAssignment(
  sb: SchedulingClient,
  slotId: string,
  expectedVersionId: string,
): Promise<ClearOutcome> {
  await assertSlotInVersion(sb, slotId, expectedVersionId);
  const { data: existing, error: selErr } = await sb
    .from('assignments')
    .select('id, provider_id, assignment_status')
    .eq('schedule_slot_id', slotId)
    .maybeSingle();
  if (selErr) throw new Error(`assignment lookup failed: ${selErr.message}`);
  if (!existing || !existing.provider_id) {
    return { cleared: false, clearedSlotIds: [], patternWarnings: [] };
  }

  const { clearedSlotIds, patternWarnings } = await cleanupSequenceAutoFill(
    sb, slotId, existing.provider_id as string,
  );

  const { error: delErr } = await sb.from('assignments').delete().eq('id', existing.id);
  if (delErr) throw new Error(`assignment delete failed: ${delErr.message}`);

  const { error: insErr } = await sb
    .from('assignments')
    .insert({ schedule_slot_id: slotId, assignment_status: 'open', source_type: 'manual' });
  if (insErr) throw new Error(`open-row recreate failed: ${insErr.message}`);

  await revalidateNeighbors(sb, slotId, existing.provider_id as string);
  return { cleared: true, clearedSlotIds, patternWarnings };
}
