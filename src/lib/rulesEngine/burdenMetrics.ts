// Call burden per provider — the ONE place the benchmark metrics live.
//
// NAMED burdenMetrics, not callBurden: src/lib/callBurden.ts already exists and
// means something else entirely (fractional call-split WEIGHTS, imported by the
// schedule UI). Two files called callBurden.ts, one per directory, is a
// wrong-import waiting to happen.
//
// ── WHY THIS IS A MODULE AND NOT A HELPER IN EACH SCRIPT ──────────────────
// It was a helper in each script, and they diverged. scripts/compareCpsat and
// scripts/measureOptimizerScope counted only the calls placed IN THE PLAN,
// while model.py folds in priorCalls — the calls a provider already holds
// elsewhere in the block (16 of them on the Paoli October block). Comparing
// those two numbers made the engine look 5x worse than the proved optimum
// when the like-for-like figure was 1.25x, and made "obligations met" read
// 3-of-10 when it was 8-of-10.
//
// A provider's burden is ALL the call they hold in the block. A metric that
// silently measures a subset is the "failures rendering as zeros" hazard in
// another costume: it does not error, it just quietly answers a different
// question. One home, one definition.
import { totalExpectedCalls } from './obligation';
import type { GenerationContext, SolutionPlan } from './genTypes';

/**
 * Calls per provider. `includePrior` folds in call-category seeds that have
 * no OPEN slot of their own — work already committed elsewhere in the block,
 * which consumes obligation and counts toward burden just the same.
 *
 * Providers with fte_value 0 are excluded: they carry no obligation and would
 * divide by zero in the ratio.
 */
export function callCounts(
  plan: SolutionPlan,
  ctx: GenerationContext,
  includePrior: boolean,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of ctx.providers) if (p.fte_value > 0) counts.set(p.id, 0);
  const bump = (pid: string) => {
    const cur = counts.get(pid);
    if (cur !== undefined) counts.set(pid, cur + 1);
  };

  for (const a of plan.assignments) {
    if (a.provider_id && a.shift_type_category === 'call') bump(a.provider_id);
  }
  if (includePrior) {
    const openCallIds = new Set(ctx.slotsToFill
      .filter(s => s.shift_type_category === 'call').map(s => s.slot_id));
    for (const seed of ctx.seedAssignments) {
      if (seed.shift_type_category !== 'call' || !seed.provider_id) continue;
      // A seed WITH an open slot is already in the plan — counting it here
      // too would double it.
      if (seed.slot_id && openCallIds.has(seed.slot_id)) continue;
      bump(seed.provider_id);
    }
  }
  return counts;
}

/**
 * Population standard deviation of calls-per-FTE — the same quantity
 * scripts/cpsat/model.py reports, so both sides of a comparison are one
 * number computed one way.
 *
 * NOT the same as SolutionMetrics.fairnessStdev, which is the engine's own
 * internal objective term on a different scale. Never print one as the
 * counterpart of the other.
 */
export function callsPerFteStdev(
  plan: SolutionPlan,
  ctx: GenerationContext,
  includePrior = true,
): number {
  const counts = callCounts(plan, ctx, includePrior);
  const ratios: number[] = [];
  for (const p of ctx.providers) {
    if (p.fte_value > 0) ratios.push(counts.get(p.id)! / p.fte_value);
  }
  if (ratios.length === 0) return 0;
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return Math.sqrt(ratios.reduce((a, r) => a + (r - mean) ** 2, 0) / ratios.length);
}

export interface ObligationCoverage {
  met: number;
  short: number;
  total: number;
  /** Provider id -> how many calls they are still owed (only those short). */
  shortfallByPid: Map<string, number>;
}

/**
 * How many providers reached their stated block obligation.
 *
 * Gabriel 2026-09: "the only true and important thing is call quota being met
 * every block". Measured against TOTAL block call, priors included — an
 * obligation is a whole-block figure, so checking it against a subset of the
 * provider's calls understates coverage.
 */
export function obligationCoverage(
  plan: SolutionPlan,
  ctx: GenerationContext,
): ObligationCoverage {
  const counts = callCounts(plan, ctx, true);
  const owed = totalExpectedCalls(ctx);
  const shortfallByPid = new Map<string, number>();
  let met = 0;
  for (const [pid, n] of counts) {
    const target = Math.round(owed.get(pid) ?? 0);
    if (n >= target) met++;
    else shortfallByPid.set(pid, target - n);
  }
  return { met, short: counts.size - met, total: counts.size, shortfallByPid };
}

/** Calls actually placed by this plan — excludes priors, so it is comparable
 *  to a solver's `filled`. */
export function callsPlaced(plan: SolutionPlan): number {
  return plan.assignments
    .filter(a => a.provider_id && a.shift_type_category === 'call').length;
}
