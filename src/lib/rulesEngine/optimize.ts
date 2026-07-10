import { solve, seedSolveState } from './solve';
import { scoreSolution } from './metrics';
import { evaluateEligibility } from './eligibility';
import { CLASSIC_PATTERN } from './callPattern';
import type { CallPatternDoc } from './callPattern';
import type {
  GenerationContext, SolutionPlan, SolutionMetrics, SlotToFill,
} from './genTypes';

// Legacy fallback for call-ness of an UNFILLED slot (that shape carries no
// category) — used only when ctx.shiftTypes is absent (bare fixtures /
// degraded mode), mirroring solve()'s fallback idiom.
const LEGACY_CALL_CODES = ['C1', 'C2', 'C3'];
const MAX_ITERATIONS = 200; // bound on accepted moves (hill-climb is monotone)
// Worst-case re-solves per scan = unfilled × providers × movable × providers.
// On a real 12-week/85-provider block that can reach ~50 × 85 × 850 × 85 ≈ 307 M.
// The budget caps wall-clock to ≈ maxResolves × <ms per solve> (opt-out via orchestrator).
const DEFAULT_MAX_RESOLVES = 5000;
// Wall-clock ceiling per optimize() call. Generous enough that fixture-sized
// optimizations never hit it (they finish in single-digit ms); real blocks are
// additionally bounded by maxResolves. Overridable via OptimizeOptions
// (autoGenerate threads SCHEDULING_OPTIMIZE_WALL_MS).
const DEFAULT_WALL_CLOCK_MS = 2000;

export interface OptimizeOptions {
  maxIterations?: number;
  maxResolves?: number;
  wallClockMs?: number;
}

// Observability counters for a single optimize() run.
export interface OptimizeStats {
  resolves: number;   // full solve()+score trials evaluated
  gatedSkips: number; // trials skipped by the eligibility pre-gate
  wallMs: number;     // elapsed wall-clock of the optimize() call
}

export interface OptimizeResult {
  plan: SolutionPlan;
  stats: OptimizeStats;
}

// slot_id -> provider_id for every filled CALL slot in a plan. Call-ness is
// the shift type's category stamped on the assignment, not a code literal.
export function extractCallAssignment(plan: SolutionPlan): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of plan.assignments) {
    if (a.shift_type_category === 'call') m.set(a.slot_id, a.provider_id);
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

// A call slot is movable by the optimizer iff it was placed by the main loop
// AND its day type is in the pattern's optimizerMovableDayTypes (classic:
// weekday + friday). Block-chain / pre-PTO placements are structurally coupled
// and left to deterministic construction.
function movableCallSlotIds(plan: SolutionPlan, doc: CallPatternDoc): string[] {
  const movableDayTypes = doc.optimizerMovableDayTypes as readonly string[];
  return plan.assignments
    .filter(a => a.shift_type_category === 'call'
      && movableDayTypes.includes(a.derived_day_type)
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
// move improves the lexicographic objective, or a budget (accepted moves,
// re-solves, wall clock) is hit.
export function optimize(ctx: GenerationContext, opts: OptimizeOptions = {}): OptimizeResult {
  const t0 = Date.now();
  const maxIters = opts.maxIterations ?? MAX_ITERATIONS;
  const maxResolves = opts.maxResolves ?? DEFAULT_MAX_RESOLVES;
  const wallClockMs = opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  const doc = ctx.callPattern ?? CLASSIC_PATTERN;
  const providerIds = ctx.providers.map(p => p.id).sort();
  const providerById = ctx.providerById ?? new Map(ctx.providers.map(p => [p.id, p]));
  const slotById = new Map<string, SlotToFill>(ctx.slotsToFill.map(s => [s.slot_id, s]));
  // Call-ness of an unfilled slot: shift-type category when the map is loaded,
  // legacy code literals otherwise (same idiom as solve's fallbacks).
  const isCallCode = (code: string): boolean => (ctx.shiftTypes
    ? ctx.shiftTypes.get(code)?.category === 'call'
    : LEGACY_CALL_CODES.includes(code));

  let best = solve(ctx);
  let bestMetrics = scoreSolution(best, ctx);
  let bestAssign = extractCallAssignment(best);
  let resolvesUsed = 0;
  let gatedSkips = 0;
  const budgetExhausted = () =>
    resolvesUsed >= maxResolves || Date.now() - t0 >= wallClockMs;

  for (let iter = 0; iter < maxIters && !budgetExhausted(); iter++) {
    let improved = false;

    // ── Eligibility pre-gate (rebuilt once per scan) ──
    // Why gating cannot change the chosen plan (parity-critical): the gate
    // state holds ONLY the seeded assignments (+ ctx-derived facts like PTO,
    // cross-site, credentials, weekday availability inside evaluateEligibility)
    // — exactly the state every re-solve starts from, and solve() only ever
    // ADDS to it. Every gate condition is monotone in that state, so a gated
    // (slot, provider) pair would also fail overrideFor()'s identical 'call'
    // check inside the trial's solve(): the forced provider self-rejects, the
    // slot goes unfilled, `unfilled` grows, and compareMetrics rejects the
    // trial as no-improvement. Gating therefore only SKIPS resolves the
    // ungated optimizer would have rejected anyway.
    // NOTE: the snapshot must NOT include the current best's own (non-seed)
    // assignments — those are exactly what a trial perturbs (e.g. an eviction
    // vacates P's slot, freeing P's quota/day), and gating on them would skip
    // improving moves.
    const gateState = seedSolveState(ctx, doc);
    const gateMemo = new Map<string, boolean>();
    const gatePasses = (slotId: string, pid: string): boolean => {
      const key = `${slotId}|${pid}`;
      const memo = gateMemo.get(key);
      if (memo !== undefined) return memo;
      const slot = slotById.get(slotId);
      const p = providerById.get(pid);
      // Unknown slot/provider: don't gate — fall through to the full resolve.
      const pass = !slot || !p
        || evaluateEligibility(slot, p, gateState, ctx, 'call').eligible;
      gateMemo.set(key, pass);
      return pass;
    };

    const unfilledCallIds = best.unfilled
      .filter(u => isCallCode(u.shift_type_code))
      .map(u => u.slot_id).sort();
    const movable = movableCallSlotIds(best, doc);
    // pid -> movable slot ids they hold, built once per scan (movable is
    // sorted, so each per-pid list stays in deterministic sorted order).
    const movableByPid = new Map<string, string[]>();
    for (const sId of movable) {
      const pid = bestAssign.get(sId);
      if (pid === undefined) continue;
      const list = movableByPid.get(pid);
      if (list) list.push(sId); else movableByPid.set(pid, [sId]);
    }

    // ── Move set 1: 2-slot eviction to fill a skipped CALL slot ──
    // For each unfilled call slot U, try moving provider P onto U and
    // simultaneously forcing provider Q onto P's vacated slot S.
    // This engineers the augmenting path: P moves to the gap U, Q takes
    // P's old slot S. Without forcing S→Q, solve re-picks P for S and
    // P ends up blocked from U (eviction self-rejects).
    outer:
    for (const uId of unfilledCallIds) {
      for (const pid of providerIds) {
        // P must currently hold at least one movable slot.
        const pSlots = movableByPid.get(pid) ?? [];
        for (const sId of pSlots) {
          for (const qid of providerIds) {
            if (qid === pid) continue;
            if (budgetExhausted()) break outer; // budget guard
            if (!gatePasses(uId, pid) || !gatePasses(sId, qid)) {
              gatedSkips++;
              continue;
            }
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
        if (budgetExhausted()) break swap; // budget guard
        if (!gatePasses(sId, pid)) {
          gatedSkips++;
          continue;
        }
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

  return {
    plan: best,
    stats: { resolves: resolvesUsed, gatedSkips, wallMs: Date.now() - t0 },
  };
}
