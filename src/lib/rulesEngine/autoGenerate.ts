// Orchestrator for physician call-schedule generation.
// Pipeline: load (genContext) -> solve (pure) -> commit (batched) -> validate.
// See ALGORITHM.md and docs/superpowers/specs/2026-06-11-scheduling-engine-optimization-design.md
import { loadGenerationContext } from './genContext';
import { solve } from './solve';
import { commitPlan, commitValidation } from './commit';
import type { SupabaseClient } from './shared';

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
  }>;
  unfilled: Array<{
    slot_id: string; slot_date: string; shift_type_code: string; reason: string;
  }>;
  // Distinguishes a hard failure (no slots / empty pool / DB error) from a
  // legitimate partial fill. The route maps this to an HTTP status.
  ok: boolean;
  perf?: {
    par_level: number; total_slots: number; call_slots: number;
    providers: number; elapsed_ms: number; db_queries: number;
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

  const plan = solve(ctx);

  const commit = await commitPlan(sb, plan);
  result.errors.push(...commit.errors);
  if (commit.errors.length > 0) {
    return result; // commit failure -> ok false -> route 5xx
  }

  const validation = await commitValidation(sb, ctx.siteId, plan.assignments);

  // Map plan -> the legacy result shape the UI expects.
  result.filled = commit.filled;
  result.skipped = plan.unfilled.length;
  result.assignments = plan.assignments.map(a => ({
    slot_id: a.slot_id, slot_date: a.slot_date, shift_type_code: a.shift_type_code,
    provider_id: a.provider_id, provider_name: a.provider_name,
  }));
  result.unfilled = plan.unfilled;
  result.ok = true;
  result.perf = {
    par_level: ctx.parLevel,
    total_slots: ctx.slotsToFill.length + plan.assignments.length,
    call_slots: ctx.slotsToFill.length,
    providers: ctx.providers.length,
    elapsed_ms: Date.now() - t0,
    db_queries: load.dbQueries + commit.dbQueries + validation.dbQueries,
  };
  return result;
}
