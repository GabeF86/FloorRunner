// Whole-number, TOTAL-level call obligations (2026-07-17).
//
// A provider's obligatory call count for a block is the ROUNDED total of their
// FTE share of every call slot in the block:
//
//   totalExpected_i = Σ_buckets (bucketTotal / effectivePar) × fte_i
//                   = totalCallSlots / effectivePar × fte_i        (linearity)
//   obligation_i    = roundedObligation(totalExpected_i)           (half-up)
//
// effectivePar = min(stored call_par_level, Σ pool FTE) — the same clamp the
// quota math uses (genContext.effectiveParLevel), so obligations line up with
// what the engine can actually distribute.
//
// This math defines obligation/extra ACCOUNTING and the obligatory fill-mode
// cap ONLY. Category-level fairness/rotation (fractional bucketTarget map,
// deficit carry-forward, scoreCall ordering) is deliberately untouched: the
// rounding never changes WHO fills a slot in fill-all mode, only how many call
// assignments count as obligatory vs extra. The rounding helper itself is
// single-homed in src/lib/fteTarget.ts, shared with the schedule grid and the
// Call Counts modal so engine and UI can't drift.
import { fteWeightedTarget, roundedObligation } from '@/lib/fteTarget';
import { effectiveParLevel } from './genContext';
import type { GenerationContext } from './genTypes';

// pid -> fractional total expected calls for THIS block (no deficit — pure
// base share). Total call slots = open call slots (slotsToFill required
// counts) + already-assigned call seeds — the same census production
// genContext folds into bucketTotals, but derived from category-tagged
// sources so bare fixtures (whose buildCtx bucketTotals include regular
// slots) count call slots only.
export function totalExpectedCalls(ctx: GenerationContext): Map<string, number> {
  const par = effectiveParLevel(ctx.parLevel, ctx.providers);
  let totalCallSlots = 0;
  for (const s of ctx.slotsToFill) totalCallSlots += s.required_count;
  for (const seed of ctx.seedAssignments) {
    if (seed.shift_type_category === 'call') totalCallSlots++;
  }
  const out = new Map<string, number>();
  for (const p of ctx.providers) {
    out.set(p.id, fteWeightedTarget(totalCallSlots, par, p.fte_value));
  }
  return out;
}

// pid -> whole-number obligatory call count (round-half-up of the total
// expected). Drives the obligatory fill-mode cap and the extra-call accounting.
export function computeObligations(ctx: GenerationContext): Map<string, number> {
  const out = new Map<string, number>();
  for (const [pid, expected] of totalExpectedCalls(ctx)) {
    out.set(pid, roundedObligation(expected));
  }
  return out;
}
