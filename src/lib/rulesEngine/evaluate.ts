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
 */
export function evaluateContext(
  ctx: EvaluationContext,
): { violations: RuleViolation[]; evaluated: boolean } {
  const violations: RuleViolation[] = [];
  let evaluated = true;
  for (const evaluator of evaluators) {
    try {
      violations.push(...evaluator(ctx));
    } catch (err) {
      evaluated = false;
      console.error('[rulesEngine] evaluator threw:', err);
    }
  }
  return { violations, evaluated };
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
