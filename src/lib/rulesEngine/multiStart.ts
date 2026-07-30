// Multi-start search (Paoli phase 2, 2026-07-26): run the greedy(+optimizer)
// K times with a seeded rotation of scoreCall's FINAL id tiebreak (tieHash —
// clinical/fairness keys untouched, no Math.random anywhere) and keep the
// lexicographically best spacing score (spacingScore.ts). Deterministic:
// the same ctx and K always choose the same seed and plan; start 0 is the
// identity tie-break order — byte-identical to today's single run, so
// K=1 IS the pre-multi-start engine (pinned in multiStart.test.ts).
import { solve } from './solve';
import { optimize } from './optimize';
import { scoreSolution } from './metrics';
import { spacingScore, compareSpacingScores } from './spacingScore';
import type { OptimizeStats } from './optimize';
import type { GenerationContext, SolutionPlan, SolutionMetrics, FillMode } from './genTypes';

export const DEFAULT_MULTI_START_K = 8;

export interface MultiStartOptions {
  /** Calls only — rides into every start's solve and optimize. */
  callsOnly?: boolean;
  k?: number;                // number of starts (seeds 0..k-1); default 8
  fillMode?: FillMode;
  // Run the bounded hill-climb per start (fill-all only — the same rule as
  // autoGenerate's single-run gate). Default true.
  optimizeEnabled?: boolean;
  wallClockMs?: number;      // PER-START optimizer budget
  maxResolves?: number;
}

export interface StartScore {
  seed: number;
  score: number[];           // spacingScore tuple (SPACING_SCORE_KEYS order)
  filled: number;
  unfilled: number;
}

export interface MultiStartResult {
  plan: SolutionPlan;
  chosenSeed: number;
  startScores: StartScore[];
  // The chosen start's GREEDY metrics (before its optimizer pass) — the
  // seedMetrics analogue of the single-run path.
  seedMetrics: SolutionMetrics;
  // The chosen start's optimizer stats, when the optimizer ran.
  optimizeStats?: OptimizeStats;
}

export function solveMultiStart(
  ctx: GenerationContext, opts: MultiStartOptions = {},
): MultiStartResult {
  const k = Math.max(1, opts.k ?? DEFAULT_MULTI_START_K);
  const fillMode = opts.fillMode;
  const optimizeEnabled = (opts.optimizeEnabled ?? true) && (fillMode === undefined || fillMode === 'all');

  let best: {
    plan: SolutionPlan; seed: number; score: number[];
    seedMetrics: SolutionMetrics; optimizeStats?: OptimizeStats;
  } | null = null;
  const startScores: StartScore[] = [];

  for (let seed = 0; seed < k; seed++) {
    const greedy = solve(ctx, { fillMode, tieBreakSeed: seed, callsOnly: opts.callsOnly });
    const seedMetrics = scoreSolution(greedy, ctx);
    let plan = greedy;
    let optimizeStats: OptimizeStats | undefined;
    if (optimizeEnabled) {
      const optimized = optimize(ctx, {
        fillMode, tieBreakSeed: seed, callsOnly: opts.callsOnly,
        wallClockMs: opts.wallClockMs, maxResolves: opts.maxResolves,
      });
      plan = optimized.plan;
      optimizeStats = optimized.stats;
    }
    const score = spacingScore(ctx, plan);
    startScores.push({
      seed, score,
      filled: plan.assignments.length,
      unfilled: plan.unfilled.length,
    });
    // Strictly-better keeps the EARLIEST seed on ties (deterministic; seed 0
    // — today's ordering — wins any tie by construction).
    if (!best || compareSpacingScores(score, best.score) < 0) {
      best = { plan, seed, score, seedMetrics, optimizeStats };
    }
  }

  return {
    plan: best!.plan,
    chosenSeed: best!.seed,
    startScores,
    seedMetrics: best!.seedMetrics,
    optimizeStats: best!.optimizeStats,
  };
}
