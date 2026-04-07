// Public entry point for the rules engine.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
import { loadContext } from './loadContext';
import { evaluators } from './evaluators';
import type { RuleViolation } from './types';

export interface EvaluateResult {
  slotId: string;
  providerId: string | null;
  violations: RuleViolation[];
  hardCount: number;
  softCount: number;
}

/**
 * Evaluate a single (slot, provider) assignment against all active rules.
 * Returns the violation list — never throws on rule errors; an unloadable
 * context simply yields zero violations.
 */
export async function evaluateAssignment(
  sb: SupabaseClient,
  slotId: string,
  providerId: string | null,
): Promise<EvaluateResult> {
  const ctx = await loadContext(sb, slotId, providerId);
  if (!ctx) {
    return { slotId, providerId, violations: [], hardCount: 0, softCount: 0 };
  }

  const violations: RuleViolation[] = [];
  for (const evaluator of evaluators) {
    try {
      violations.push(...evaluator(ctx));
    } catch (err) {
      // Don't let one broken rule kill the whole evaluation
      console.error('[rulesEngine] evaluator threw:', err);
    }
  }

  return {
    slotId,
    providerId,
    violations,
    hardCount: violations.filter(v => v.severity === 'hard').length,
    softCount: violations.filter(v => v.severity === 'soft').length,
  };
}

export type { RuleViolation } from './types';
