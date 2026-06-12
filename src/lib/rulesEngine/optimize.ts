import { solve } from './solve';
import { scoreSolution } from './metrics';
import type {
  GenerationContext, SolutionPlan, SolutionMetrics,
} from './genTypes';

const CALL_CODES = ['C1', 'C2', 'C3'];
const MAX_ITERATIONS = 200; // bound on accepted moves (hill-climb is monotone)
// Worst-case re-solves per scan = unfilled × providers × movable × providers.
// On a real 12-week/85-provider block that can reach ~50 × 85 × 850 × 85 ≈ 307 M.
// The budget caps wall-clock to ≈ maxResolves × <ms per solve> (opt-out via orchestrator).
const DEFAULT_MAX_RESOLVES = 5000;

export interface OptimizeOptions {
  maxIterations?: number;
  maxResolves?: number;
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
  const maxResolves = opts.maxResolves ?? DEFAULT_MAX_RESOLVES;
  const providerIds = ctx.providers.map(p => p.id).sort();

  let best = solve(ctx);
  let bestMetrics = scoreSolution(best, ctx);
  let bestAssign = extractCallAssignment(best);
  let resolvesUsed = 0;

  for (let iter = 0; iter < maxIters; iter++) {
    let improved = false;

    // ── Move set 1: 2-slot eviction to fill a skipped CALL slot ──
    // For each unfilled call slot U, try moving provider P onto U and
    // simultaneously forcing provider Q onto P's vacated slot S.
    // This engineers the augmenting path: P moves to the gap U, Q takes
    // P's old slot S. Without forcing S→Q, solve re-picks P for S and
    // P ends up blocked from U (eviction self-rejects).
    const unfilledCallIds = best.unfilled
      .filter(u => CALL_CODES.includes(u.shift_type_code))
      .map(u => u.slot_id).sort();
    const movable = movableCallSlotIds(best);

    outer:
    for (const uId of unfilledCallIds) {
      for (const pid of providerIds) {
        // P must currently hold at least one movable slot.
        const pSlots = movable.filter(sId => bestAssign.get(sId) === pid).sort();
        for (const sId of pSlots) {
          for (const qid of providerIds) {
            if (qid === pid) continue;
            if (resolvesUsed >= maxResolves) break outer; // budget guard
            const trial = new Map(bestAssign);
            trial.set(uId, pid);   // P fills the gap
            trial.set(sId, qid);   // Q takes P's vacated slot
            resolvesUsed++;
            const { plan, metrics } = evaluate(ctx, trial);
            if (compareMetrics(metrics, bestMetrics) < 0) {
              best = plan; bestMetrics = metrics; bestAssign = extractCallAssignment(plan);
              improved = true;
              break outer; // re-start scan from new best (monotone)
            }
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
        if (resolvesUsed >= maxResolves) break swap; // budget guard
        const trial = new Map(bestAssign);
        trial.set(sId, pid);
        resolvesUsed++;
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
