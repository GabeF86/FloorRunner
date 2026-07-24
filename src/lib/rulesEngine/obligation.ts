// Whole-number, TOTAL-level call obligations (2026-07-17).
//
// A provider's obligatory call count for a block is the ROUNDED total of their
// FTE share of every call slot in the block:
//
//   totalExpected_i = Σ_buckets (bucketTotal / par) × fte_i
//                   = totalCallSlots / par × fte_i                 (linearity)
//   obligation_i    = roundedObligation(totalExpected_i)           (half-up)
//
// par = ctx.parLevel (stored sites.call_par_level), AUTHORITATIVE — Gabriel
// 2026-07-24, superseding the 2026-07-16 pool-ΣFTE clamp: when the pool's
// summed FTE is below the par, Σ obligations deliberately UNDER-COVER the
// block; the obligatory fill mode leaves the remainder OPEN and those slots
// are the paid-pickup layer, taken after the schedule is made. Fill-all mode
// still fills everything it can (quota never blocks fills).
//
// This math defines obligation/extra ACCOUNTING and the obligatory fill-mode
// cap ONLY. Category-level fairness/rotation (fractional bucketTarget map,
// deficit carry-forward, scoreCall ordering) is deliberately untouched: the
// rounding never changes WHO fills a slot in fill-all mode, only how many call
// assignments count as obligatory vs extra. The rounding helper itself is
// single-homed in src/lib/fteTarget.ts, shared with the schedule grid and the
// Call Counts modal so engine and UI can't drift.
import { fteWeightedTarget, roundedObligation } from '@/lib/fteTarget';
import { callBurdenWeight } from '@/lib/callBurden';
import type { GenerationContext } from './genTypes';

// pid -> fractional total expected calls for THIS block (no deficit — pure
// base share). Total call slots = open call slots (slotsToFill required
// counts) + open manual-only segment slots (ctx.manualCallSlots) + already-
// assigned call seeds — the same census production genContext folds into
// bucketTotals, but derived from category-tagged sources so bare fixtures
// (whose buildCtx bucketTotals include regular slots) count call slots only.
// WEIGHTED (2026-07-22, call splits): every slot/seed counts its shift type's
// call_burden_weight (1 when absent — unsplit inputs unchanged), so a split
// call totals exactly ONE call of obligation.
export function totalExpectedCalls(ctx: GenerationContext): Map<string, number> {
  const par = ctx.parLevel; // authoritative — never clamped to the pool (2026-07-24)
  const weightOf = (code: string) => callBurdenWeight(ctx.shiftTypes?.get(code));
  let totalCallSlots = 0;
  for (const s of ctx.slotsToFill) totalCallSlots += s.required_count * weightOf(s.shift_type_code);
  for (const s of ctx.manualCallSlots ?? []) totalCallSlots += s.required_count * weightOf(s.shift_type_code);
  for (const seed of ctx.seedAssignments) {
    if (seed.shift_type_category === 'call') totalCallSlots += weightOf(seed.shift_type_code);
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
