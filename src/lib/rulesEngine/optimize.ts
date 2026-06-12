import { solve } from './solve';
import { scoreSolution } from './metrics';
import type {
  GenerationContext, SolutionPlan, SolutionMetrics,
} from './genTypes';

const CALL_CODES = ['C1', 'C2', 'C3'];
const MAX_ITERATIONS = 200; // bound on accepted moves (hill-climb is monotone)

export interface OptimizeOptions {
  maxIterations?: number;
}

// slot_id -> provider_id for every filled CALL slot in a plan.
export function extractCallAssignment(plan: SolutionPlan): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of plan.assignments) {
    if (CALL_CODES.includes(a.shift_type_code)) m.set(a.slot_id, a.provider_id);
  }
  return m;
}

// Lexicographic objective: fewer skips, then lower fairness stdev, then lower
// burnout. Returns <0 if a is better than b, >0 if worse, 0 if equal.
const EPS = 1e-9;
export function compareMetrics(a: SolutionMetrics, b: SolutionMetrics): number {
  if (a.skipped !== b.skipped) return a.skipped - b.skipped;
  if (Math.abs(a.fairnessStdev - b.fairnessStdev) > EPS) return a.fairnessStdev - b.fairnessStdev;
  return a.burnout - b.burnout;
}

// A call slot is movable by the optimizer iff it's a weekday/Friday call slot
// placed by the main loop (NOT a weekend-chain or pre-PTO slot — those are
// structurally coupled and left to deterministic construction).
function movableCallSlotIds(plan: SolutionPlan): string[] {
  return plan.assignments
    .filter(a => CALL_CODES.includes(a.shift_type_code)
      && (a.derived_day_type === 'weekday' || a.derived_day_type === 'friday')
      && a.source === 'main-loop')
    .map(a => a.slot_id)
    .sort(); // deterministic order
}

// Re-solve from a (perturbed) call assignment and score it.
function evaluate(ctx: GenerationContext, callAssign: Map<string, string>):
  { plan: SolutionPlan; metrics: SolutionMetrics } {
  const plan = solve(ctx, { callOverrides: callAssign });
  return { plan, metrics: scoreSolution(plan, ctx) };
}

// Deterministic bounded hill-climb. Seeds with greedy solve(), then repeatedly
// applies the single strictly-improving move it can find (eviction to fill a
// skip, or a fairness swap), re-deriving via solve() each time. Stops when no
// move improves the lexicographic objective or the iteration budget is hit.
export function optimize(ctx: GenerationContext, opts: OptimizeOptions = {}): SolutionPlan {
  const maxIters = opts.maxIterations ?? MAX_ITERATIONS;
  const providerIds = ctx.providers.map(p => p.id).sort();

  let best = solve(ctx);
  let bestMetrics = scoreSolution(best, ctx);
  let bestAssign = extractCallAssignment(best);

  for (let iter = 0; iter < maxIters; iter++) {
    let improved = false;

    // ── Move set 1: eviction to fill a skipped CALL slot ──
    // For each unfilled call slot U, try moving a provider P off one of their
    // movable call slots S onto U (P->U), freeing S to be re-picked by solve.
    const unfilledCallIds = best.unfilled
      .filter(u => CALL_CODES.includes(u.shift_type_code))
      .map(u => u.slot_id).sort();
    const movable = movableCallSlotIds(best);

    outer:
    for (const uId of unfilledCallIds) {
      for (const pid of providerIds) {
        // P must currently hold at least one movable slot (so the move keeps
        // P's call count constant) — find their movable slots, sorted.
        const pSlots = movable.filter(sId => bestAssign.get(sId) === pid).sort();
        for (const sId of pSlots) {
          const trial = new Map(bestAssign);
          trial.set(uId, pid);   // force P onto the gap
          trial.delete(sId);     // vacate S (solve re-picks it)
          const { plan, metrics } = evaluate(ctx, trial);
          if (compareMetrics(metrics, bestMetrics) < 0) {
            best = plan; bestMetrics = metrics; bestAssign = extractCallAssignment(plan);
            improved = true;
            break outer; // re-start the scan from the new best (monotone)
          }
        }
      }
    }
    if (improved) continue;

    // ── Move set 2: fairness swap ──
    // Move a movable call slot from its current (over-allocated) provider to an
    // under-allocated eligible one. Try, deterministically, each movable slot
    // reassigned to each other provider; keep the first strictly-improving swap.
    swap:
    for (const sId of movable) {
      const current = bestAssign.get(sId);
      for (const pid of providerIds) {
        if (pid === current) continue;
        const trial = new Map(bestAssign);
        trial.set(sId, pid);
        const { plan, metrics } = evaluate(ctx, trial);
        if (compareMetrics(metrics, bestMetrics) < 0) {
          best = plan; bestMetrics = metrics; bestAssign = extractCallAssignment(plan);
          improved = true;
          break swap;
        }
      }
    }
    if (!improved) break; // local optimum reached
  }

  return best;
}
