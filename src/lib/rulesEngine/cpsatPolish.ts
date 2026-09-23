// Apply a CP-SAT solution to an incumbent plan — Stage 1 of the hybrid.
//
// Gabriel 2026-09-22. Measured on the real Paoli October block: the greedy
// reaches a per-FTE fairness spread of 1.75 in obligatory mode where the
// proved optimum is 0.34, and no commitment ordering closes that (slotOrder
// measurement, same day). The solver is the only measured path to it.
//
// ── WHAT THE SOLVER IS AND IS NOT ALLOWED TO DO ───────────────────────────
// A CP-SAT solution is a Map<slot_id, provider_id> and NOTHING MORE. It goes
// back in through solve()'s existing callOverrides seam — the same seam
// optimize() already uses for every trial — so the solver only ever answers
// "who holds this call". Everything else re-derives normally:
//
//   • post-call rest and the day-off block
//   • D-chains and weekend chains (constructed, not chosen)
//   • the relief and mop-up passes
//   • plan.skippedDerived (invariant 4)
//   • the per-slot per-candidate REJECTION REPORT a chief reads when a slot
//     will not fill — a thing CP-SAT cannot produce and does not replace,
//     because solve() still runs
//
// ── WHY THIS IS SAFE EVEN IF THE MODEL IS WRONG ───────────────────────────
// Three independent gates, in order:
//
//   1. STALENESS — every slot id and provider id in the solution must still
//      exist in this ctx. A draft edited since the model was exported fails
//      here rather than writing a solution built against slots that moved.
//      Unknown ids are REJECTED, never silently dropped (invariant 6's
//      discipline: never quietly report clean).
//   2. RE-DERIVATION — solve() owns structure. Where the solver's assignment
//      and the pattern's chain construction disagree, solve() wins.
//   3. STRICTLY BETTER — the re-derived plan must beat the incumbent on the
//      engine's own lexicographic objective (compareMetrics: skipped →
//      fairnessStdev → burnout). Anything else keeps the incumbent.
//
// Gate 3 is what makes gates 1 and 2 sufficient: a solution that is wrong in
// any way the engine can see loses the comparison and is discarded. The
// caller runs batchValidate before writing, so a solution wrong in a way only
// the DB can see is caught too.
import { solve } from './solve';
import { compareMetrics } from './optimize';
import { scoreSolution } from './metrics';
import type {
  FillMode, GenerationContext, SolutionMetrics, SolutionPlan,
} from './genTypes';

/** The shape scripts/cpsat/model.py writes. */
export interface CpsatSolution {
  status: string;
  fillProved?: boolean;
  fairnessProved?: boolean;
  filled?: number;
  stdev?: number;
  /** slot_id -> provider_id. Absent when the solver stopped before phase 2. */
  assignment?: Record<string, string>;
}

export type PolishRejection =
  | 'no-solution'
  | 'solver-status'
  | 'no-assignment'
  | 'stale-slots'
  | 'stale-providers'
  | 'not-better';

export interface PolishResult {
  accepted: boolean;
  /** The plan to use — the trial when accepted, the incumbent when not. */
  plan: SolutionPlan;
  reason: PolishRejection | 'improved';
  detail: string;
  incumbentMetrics: SolutionMetrics;
  /** Null when the solution never got as far as a re-solve. */
  trialMetrics: SolutionMetrics | null;
  /** Ids in the solution that this ctx does not know about. */
  unknownSlots: string[];
  unknownProviders: string[];
  /** Slots where solve() overrode the solver (chains win, gate 2). */
  overriddenByStructure: string[];
}

const ACCEPTABLE_STATUS = new Set(['OPTIMAL', 'FEASIBLE']);

export function applyCpsatSolution(
  ctx: GenerationContext,
  incumbent: SolutionPlan,
  solution: CpsatSolution | null | undefined,
  opts: { fillMode?: FillMode } = {},
): PolishResult {
  const incumbentMetrics = scoreSolution(incumbent, ctx);
  const reject = (
    reason: PolishRejection, detail: string,
    extra: Partial<PolishResult> = {},
  ): PolishResult => ({
    accepted: false, plan: incumbent, reason, detail, incumbentMetrics,
    trialMetrics: null, unknownSlots: [], unknownProviders: [],
    overriddenByStructure: [], ...extra,
  });

  if (!solution) return reject('no-solution', 'No solver output was supplied.');
  if (!ACCEPTABLE_STATUS.has(solution.status)) {
    return reject('solver-status',
      `Solver returned ${solution.status}; only OPTIMAL/FEASIBLE are applied.`);
  }
  const assignment = solution.assignment;
  if (!assignment || Object.keys(assignment).length === 0) {
    return reject('no-assignment',
      'Solver output carries no per-slot assignment (it stopped before the fairness phase).');
  }

  // ── Gate 1: staleness ───────────────────────────────────────────────────
  const openCallSlotIds = new Set(ctx.slotsToFill
    .filter(s => s.shift_type_category === 'call').map(s => s.slot_id));
  const providerIds = new Set(ctx.providers.map(p => p.id));
  const unknownSlots: string[] = [];
  const unknownProviders: string[] = [];
  for (const [slotId, pid] of Object.entries(assignment)) {
    if (!openCallSlotIds.has(slotId)) unknownSlots.push(slotId);
    if (!providerIds.has(pid)) unknownProviders.push(pid);
  }
  if (unknownSlots.length > 0) {
    return reject('stale-slots',
      `${unknownSlots.length} assigned slot(s) are not open call slots in this context — `
      + 'the draft changed since the model was exported. Re-export and re-solve.',
      { unknownSlots, unknownProviders });
  }
  if (unknownProviders.length > 0) {
    return reject('stale-providers',
      `${unknownProviders.length} assigned provider(s) are not in this context's pool.`,
      { unknownSlots, unknownProviders });
  }

  // ── Gate 2: re-derivation (solve owns structure) ────────────────────────
  const overrides = new Map(Object.entries(assignment));
  const trial = solve(ctx, { callOverrides: overrides, fillMode: opts.fillMode });
  const placed = new Map<string, string>();
  for (const a of trial.assignments) {
    if (a.provider_id) placed.set(a.slot_id, a.provider_id);
  }
  const overriddenByStructure = [...overrides.entries()]
    .filter(([slotId, pid]) => placed.has(slotId) && placed.get(slotId) !== pid)
    .map(([slotId]) => slotId);

  // ── Gate 3: strictly better on the engine's own objective ───────────────
  const trialMetrics = scoreSolution(trial, ctx);
  const cmp = compareMetrics(trialMetrics, incumbentMetrics);
  if (cmp >= 0) {
    return reject('not-better',
      `Solver plan does not beat the incumbent (skipped ${trialMetrics.skipped} vs `
      + `${incumbentMetrics.skipped}, spread ${trialMetrics.fairnessStdev.toFixed(3)} vs `
      + `${incumbentMetrics.fairnessStdev.toFixed(3)}).`,
      { trialMetrics, overriddenByStructure });
  }

  return {
    accepted: true,
    plan: trial,
    reason: 'improved',
    detail: `skipped ${incumbentMetrics.skipped} → ${trialMetrics.skipped}, `
      + `spread ${incumbentMetrics.fairnessStdev.toFixed(3)} → `
      + `${trialMetrics.fairnessStdev.toFixed(3)}`,
    incumbentMetrics,
    trialMetrics,
    unknownSlots: [],
    unknownProviders: [],
    overriddenByStructure,
  };
}
