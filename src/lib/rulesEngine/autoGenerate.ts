// Orchestrator for physician call-schedule generation.
// Pipeline: load (genContext) -> solve (pure) -> commit (batched) -> validate.
// See ALGORITHM.md and docs/superpowers/specs/2026-06-11-scheduling-engine-optimization-design.md
import { loadGenerationContext } from './genContext';
import { solve } from './solve';
import { commitPlan, commitValidation, commitMetadata, hasGenerationMetadataColumn } from './commit';
import { scoreSolution } from './metrics';
import type { SupabaseClient } from './shared';
import type { UnfilledSlot, PlannedAssignment, AssignmentExplanation, SolutionMetrics, PlacementSource } from './genTypes';

export interface AutoGenerateOptions {
  overrideProviderIds?: string[];
}

export interface GenerationResult {
  filled: number;
  skipped: number;
  errors: string[];
  assignments: Array<{
    slot_id: string; slot_date: string; shift_type_code: string;
    provider_id: string; provider_name: string;
    source?: PlacementSource;
    explanation?: AssignmentExplanation;
  }>;
  unfilled: UnfilledSlot[];
  // Distinguishes a hard failure (no slots / empty pool / DB error) from a
  // legitimate partial fill. The route maps this to an HTTP status.
  ok: boolean;
  metrics?: SolutionMetrics;
  perf?: {
    par_level: number; total_slots: number; call_slots: number;
    providers: number; elapsed_ms: number; db_queries: number;
  };
}

// Pure: planned assignment -> the API/UI assignment shape (now includes the
// placement source + explanation for the schedule UI's "why" view).
export function toResultAssignment(a: PlannedAssignment) {
  return {
    slot_id: a.slot_id, slot_date: a.slot_date, shift_type_code: a.shift_type_code,
    provider_id: a.provider_id, provider_name: a.provider_name,
    source: a.source, explanation: a.explanation,
  };
}

export async function autoGenerate(
  sb: SupabaseClient,
  scheduleVersionId: string,
  options: AutoGenerateOptions = {},
): Promise<GenerationResult> {
  const t0 = Date.now();
  const result: GenerationResult = {
    filled: 0, skipped: 0, errors: [], assignments: [], unfilled: [], ok: false,
  };

  const load = await loadGenerationContext(sb, scheduleVersionId, options);
  if (!load.ctx) {
    result.errors.push(load.error || 'Failed to load generation context');
    return result; // ok stays false -> route returns 4xx/5xx
  }
  const ctx = load.ctx;

  let plan;
  let commit;
  try {
    plan = solve(ctx);
    commit = await commitPlan(sb, plan);
  } catch (e: unknown) {
    result.errors.push(
      `Unexpected error during generation: ${e instanceof Error ? e.message : String(e)}`,
    );
    return result; // ok stays false
  }

  result.errors.push(...commit.errors);
  if (commit.errors.length > 0) {
    return result; // commit failure -> ok false (assignments not reliably written)
  }

  // Validation is best-effort: the assignments are ALREADY committed at this
  // point, so a validation-pass failure must NOT flip the run to ok=false — it
  // only means validation_flags couldn't be written. Surface a soft note.
  let validationQueries = 0;
  try {
    const validation = await commitValidation(sb, ctx.siteId, plan.assignments);
    validationQueries = validation.dbQueries;
  } catch (e: unknown) {
    result.errors.push(
      `Validation pass failed (assignments were still saved): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Persist per-assignment explanations, best-effort + graceful if the column
  // is absent (mirrors the call_par_level fallback). Never flips ok to false.
  let metadataQueries = 0;
  try {
    if (await hasGenerationMetadataColumn(sb)) {
      const meta = await commitMetadata(sb, plan.assignments);
      metadataQueries = meta.dbQueries;
      if (meta.errors.length > 0) {
        result.errors.push(`Some explanation metadata was not saved (${meta.errors.length} rows).`);
      }
    }
  } catch (e: unknown) {
    result.errors.push(
      `Explanation metadata pass failed (assignments were still saved): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Map plan -> the result shape (now with source + explanation per assignment).
  result.filled = commit.filled;
  result.skipped = plan.unfilled.length;
  result.assignments = plan.assignments.map(toResultAssignment);
  result.unfilled = plan.unfilled;
  result.metrics = scoreSolution(plan, ctx);
  result.ok = true;
  result.perf = {
    par_level: ctx.parLevel,
    total_slots: load.totalSlots,
    call_slots: ctx.slotsToFill.length, // open (unfilled) call slots at generation time
    providers: ctx.providers.length,
    elapsed_ms: Date.now() - t0,
    db_queries: load.dbQueries + commit.dbQueries + validationQueries + metadataQueries,
  };
  return result;
}
