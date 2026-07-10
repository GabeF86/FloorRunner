// Public entry point for the rules engine.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
import { loadContext } from './loadContext';
import type { SiteValidationContext } from './loadContext';
import { evaluators } from './evaluators';
import type { EvaluationContext, RuleViolation } from './types';

export interface EvaluateResult {
  slotId: string;
  providerId: string | null;
  violations: RuleViolation[];
  hardCount: number;
  softCount: number;
  // Clinical invariant 6: validation must never silently report clean on
  // failure. true ONLY when the context loaded and no evaluator threw.
  // When false, callers must NOT persist validation_flags (the stored flags
  // would masquerade as a clean/partial evaluation).
  evaluated: boolean;
}

/**
 * Run every evaluator against an in-memory context. Pure (no I/O) — shared by
 * the serial path (evaluateAssignment) and the batch path (batchValidateVersion).
 * An evaluator throw is caught so one broken rule can't kill the whole pass,
 * but it flips `evaluated` to false so the result is visibly incomplete.
 *
 * `loggedEvaluatorErrors` (optional): batch callers pass one Set per run so a
 * broken evaluator logs ONCE per run instead of once per assignment. Serial
 * callers omit it — a single evaluation logs normally.
 */
export function evaluateContext(
  ctx: EvaluationContext,
  loggedEvaluatorErrors?: Set<string>,
): { violations: RuleViolation[]; evaluated: boolean } {
  const violations: RuleViolation[] = [];
  let evaluated = true;
  for (const evaluator of evaluators) {
    try {
      violations.push(...evaluator(ctx));
    } catch (err) {
      evaluated = false;
      const name = evaluator.name || 'unknown';
      if (!loggedEvaluatorErrors?.has(name)) {
        loggedEvaluatorErrors?.add(name);
        console.error(`[rulesEngine] evaluator '${name}' threw:`, err);
      }
    }
  }
  return { violations, evaluated };
}

// The stored validation_flags for a write that must not silently look clean:
// the real violations when evaluation completed, otherwise a single sentinel
// warning flag. Used by write-sites that MUST write something (e.g. the POST
// upsert, where omitting the column on a reassignment would leave the previous
// provider's stale violations on the new provider's row).
export const VALIDATION_UNAVAILABLE_FLAG: RuleViolation = {
  rule_id: null,
  rule_name: 'Validation unavailable',
  category: 'system',
  severity: 'warning',
  message: 'validation unavailable — needs re-validation',
};

export function validationFlagsFor(
  result: Pick<EvaluateResult, 'evaluated' | 'violations'>,
): RuleViolation[] {
  return result.evaluated ? result.violations : [VALIDATION_UNAVAILABLE_FLAG];
}

/**
 * Evaluate a single (slot, provider) assignment against all active rules.
 * Never throws on rule errors; an unloadable context yields zero violations
 * with `evaluated: false` so callers can distinguish "clean" from "unknown".
 *
 * When `siteCtx` is provided, the shift-type and rule-definition queries
 * inside loadContext are skipped (N+1 fix for batched serial callers).
 */
export async function evaluateAssignment(
  sb: SupabaseClient,
  slotId: string,
  providerId: string | null,
  siteCtx?: SiteValidationContext,
): Promise<EvaluateResult> {
  const ctx = await loadContext(sb, slotId, providerId, siteCtx);
  if (!ctx) {
    return { slotId, providerId, violations: [], hardCount: 0, softCount: 0, evaluated: false };
  }

  const { violations, evaluated } = evaluateContext(ctx);
  return {
    slotId,
    providerId,
    violations,
    hardCount: violations.filter(v => v.severity === 'hard').length,
    softCount: violations.filter(v => v.severity === 'soft').length,
    evaluated,
  };
}

export type { RuleViolation } from './types';
