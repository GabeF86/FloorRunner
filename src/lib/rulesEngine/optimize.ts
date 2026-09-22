import { solve, seedSolveState } from './solve';
import { scoreSolution } from './metrics';
import { evaluateEligibility } from './eligibility';
import { mergedCallCapsForCtx, planWithinCallCaps } from './providerCaps';
import { computeObligations, planWithinObligations } from './obligation';
import { CLASSIC_PATTERN } from './callPattern';
import type { CallPatternDoc } from './callPattern';
import type { CandidateTierStrategy } from './candidateTier';
import type {
  GenerationContext, SolutionPlan, SolutionMetrics, SlotToFill, UnfilledSlot,
  FillMode,
} from './genTypes';

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
  /** Calls-only: threaded into the seed solve AND every trial re-solve, so the
   *  optimizer never compares a relief-filled trial against a calls-only seed. */
  callsOnly?: boolean;
  /** Day scope — rides into the seed solve and every trial re-solve. */
  dayScope?: 'weekday' | 'weekend';
  maxIterations?: number;
  maxResolves?: number;
  wallClockMs?: number;
  // EXPERIMENTAL candidate ordering; absent/'none' is inert (candidateTier.ts).
  candidateTier?: CandidateTierStrategy;
  // Neuro scope rides into every trial re-solve for the same reason callsOnly
  // does: a trial solved over a different slot set than the seed would be
  // scored against an unlike plan.
  neuroScope?: 'only' | 'exclude';
  // RUIN-AND-RECREATE (2026-09-22). Off by default: absent, optimize() is
  // byte-identical to before and every golden pin holds.
  //
  // The two existing moves are a 2-slot eviction and a single swap, so the
  // search cannot cross a valley — any rearrangement needing three or more
  // simultaneous changes is unreachable, however long it runs. Measured: at a
  // 30-second budget the optimizer made the SAME 528 re-solves it makes at 2
  // seconds and found nothing, because it had already converged.
  //
  // This tears a chunk out of the incumbent and lets solve() rebuild it from
  // scratch, which changes many slots at once by construction.
  ruinRecreate?: boolean;
  /** Rounds of ruin-and-recreate to attempt. Each round tries every strategy
   *  at every size before giving up. */
  ruinRounds?: number;
  /** Which categories fill-monotonicity judges. 'all' (default) is the strict
   *  original; 'call' scopes it to what callOverrides actually controls. */
  fillMonotonicityScope?: 'all' | 'call';
  // Fill mode threaded into the seed solve AND every trial re-solve
  // (2026-07-24). autoGenerate never optimizes non-'all' plans (its gate is
  // pinned in autoGenerateFillMode.test.ts) — this exists so a DIRECT caller
  // can never use optimize() to place past an obligation: in 'obligatory'
  // every trial solves under the cap gates and acceptance additionally
  // requires planWithinObligations (mirror of the planWithinCallCaps gate).
  fillMode?: FillMode;
  // Multi-start tie-break rotation (2026-07-26): threaded into the seed solve
  // AND every trial re-solve so one optimize() run explores exactly one
  // tie-break ordering — deterministic per seed. 0/absent = identity order,
  // byte-identical to the pre-seed optimizer.
  tieBreakSeed?: number;
}

// Observability counters for a single optimize() run.
export interface OptimizeStats {
  resolves: number;   // full solve()+score trials evaluated
  gatedSkips: number; // pre-gate rejections (a hoisted rejection skips many trials at once)
  wallMs: number;     // elapsed wall-clock of the optimize() call
  /** Ruin-and-recreate rounds that produced a strict improvement. 0 when the
   *  phase is off (the default), which is also how you tell "did not run"
   *  from "ran and found nothing" — the latter still burns resolves. */
  ruinAccepted?: number;
  /** Why ruin trials were refused — the diagnostic that tells "no better plan"
   *  apart from "the gate would not let one through". */
  ruinReject?: { fill: number; caps: number; oblig: number; same: number; worse: number };
  /** Same breakdown for the eviction and fairness-swap moves. */
  moveReject?: { fill: number; caps: number; oblig: number; same: number; worse: number };
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

// A call slot is movable by the optimizer iff it was placed by the main loop's
// scoring path — 'main-loop' or 'quota-relaxed' (2026-07-16: a quota-relaxed
// fill is an ordinary scored placement whose bucket happened to be exhausted;
// excluding it froze exactly the slots fairness moves want to touch) — AND its
// day type is in the pattern's optimizerMovableDayTypes (classic: weekday +
// friday) — AND it is not a CHAIN ANCHOR (plan.chainAnchorSlotIds, stamped by
// solve's applyBlockChains: e.g. weekend-v2's Friday C1 whose +2 Sunday C2
// partner is pinned separately; moving the anchor severed the designed
// same-provider pairing — 2026-07-16 PROOF defect 2). Block-chain / pre-PTO
// placements are structurally coupled and left to deterministic construction.
export function movableCallSlotIds(plan: SolutionPlan, doc: CallPatternDoc): string[] {
  const movableDayTypes = doc.optimizerMovableDayTypes as readonly string[];
  const anchors = new Set(plan.chainAnchorSlotIds ?? []);
  return plan.assignments
    .filter(a => a.shift_type_category === 'call'
      && movableDayTypes.includes(a.derived_day_type)
      && (a.source === 'main-loop' || a.source === 'quota-relaxed')
      && !anchors.has(a.slot_id))
    .map(a => a.slot_id)
    .sort(); // deterministic order
}

// Every filled slot id in a plan — ALL categories, not just call (derived and
// relief fills count: trading any of them for a hole is still a hole).
export function filledSlotIds(plan: SolutionPlan): Set<string> {
  const ids = new Set<string>();
  for (const a of plan.assignments) if (a.provider_id) ids.add(a.slot_id);
  return ids;
}

// Re-solve from a (perturbed) call assignment and score it. The caller's
// fillMode rides along so an obligatory trial re-solves under the same
// obligation-cap gates as its seed (undefined = 'all', the pre-change byte);
// tieBreakSeed likewise so every trial shares the run's tie-break ordering.
function evaluate(
  ctx: GenerationContext, callAssign: Map<string, string>,
  fillMode?: FillMode, tieBreakSeed?: number, callsOnly?: boolean,
  dayScope?: 'weekday' | 'weekend',
  candidateTier?: CandidateTierStrategy,
  neuroScope?: 'only' | 'exclude',
): { plan: SolutionPlan; metrics: SolutionMetrics } {
  // The tier rides into every trial re-solve. A trial solved under a
  // DIFFERENT candidate order than the seed would be scored against an unlike
  // plan — the same argument callsOnly already makes above.
  const plan = solve(ctx, {
    callOverrides: callAssign, fillMode, tieBreakSeed, callsOnly, dayScope,
    candidateTier, neuroScope,
  });
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
  const fillMode = opts.fillMode; // undefined = 'all', the pre-change engine byte for byte
  const tieBreakSeed = opts.tieBreakSeed; // undefined/0 = identity tie-break order
  // Rides into EVERY trial re-solve: a trial that filled relief slots the seed
  // plan does not have would be scored against an unlike plan.
  const callsOnly = opts.callsOnly;
  const dayScope = opts.dayScope;
  const candidateTier = opts.candidateTier;
  const neuroScope = opts.neuroScope;
  let ruinAccepted = 0;
  const ruinReject = { fill: 0, caps: 0, oblig: 0, same: 0, worse: 0 };
  // The same tally for the eviction and swap moves. "0 accepted" says nothing
  // about WHY, and the why turned out to be the whole story.
  const moveReject = { fill: 0, caps: 0, oblig: 0, same: 0, worse: 0 };
  const tally = (
    t: { fill: number; caps: number; oblig: number; same: number; worse: number },
    plan: SolutionPlan, metrics: SolutionMetrics, incumbent: SolutionMetrics,
  ) => {
    if (!keepsEveryIncumbentFill(plan)) t.fill++;
    else if (!withinCallCaps(plan)) t.caps++;
    else if (!withinObligations(plan)) t.oblig++;
    else {
      const c = compareMetrics(metrics, incumbent);
      if (c === 0) t.same++; else if (c > 0) t.worse++;
    }
  };
  const doc = ctx.callPattern ?? CLASSIC_PATTERN;
  const providerIds = ctx.providers.map(p => p.id).sort();
  const providerById = ctx.providerById ?? new Map(ctx.providers.map(p => [p.id, p]));
  const slotById = new Map<string, SlotToFill>(ctx.slotsToFill.map(s => [s.slot_id, s]));
  // Call-ness of an unfilled slot: the v2 solve() stamps shift_type_category
  // on every unfilled entry; the shift-type map covers older plan shapes.
  // Unknown category -> conservatively not a call (no eviction attempted).
  const isCallUnfilled = (u: UnfilledSlot): boolean =>
    (u.shift_type_category ?? ctx.shiftTypes?.get(u.shift_type_code)?.category) === 'call';

  let best = solve(ctx, { fillMode, tieBreakSeed, callsOnly, dayScope });
  let bestMetrics = scoreSolution(best, ctx);
  let bestAssign = extractCallAssignment(best);
  let bestFilled = filledSlotIds(best);
  let bestCallFilled = new Set(best.assignments
    .filter(a => a.provider_id && a.shift_type_category === 'call').map(a => a.slot_id));
  let resolvesUsed = 0;
  let gatedSkips = 0;
  const budgetExhausted = () =>
    resolvesUsed >= maxResolves || Date.now() - t0 >= wallClockMs;

  // ── Per-slot fill monotonicity (2026-07-16 PROOF defect 1) ──
  // A trial is acceptable ONLY if every slot filled in the incumbent stays
  // filled (fill-set superset-or-equal). The aggregate `skipped` metric alone
  // let accepted trials TRADE a filled slot for a hole at equal-or-better skip
  // counts — a pinned provider made ineligible by cascaded shifts dropped its
  // slot ('Forced provider ineligible') without re-opening it to the pool.
  // With this gate, optimizer-introduced holes are structurally impossible;
  // the lexicographic objective still ranks the surviving trials.
  // MEASUREMENT SEAM (2026-09-22). The gate judges EVERY category, but the
  // trial mechanism only pins CALL assignments — derived day slots are
  // re-derived from scratch on every trial. Measured on a live block: an
  // IDENTITY re-solve (pin the whole incumbent, change nothing) loses one
  // `regular` fill, so this gate cannot pass there however good the move is.
  // The optimizer rejected 528 of 528 trials in fill-all and 1,698 of 1,698
  // in obligatory, every single one on this test and none on caps,
  // obligations or the objective.
  //
  // 'call' scopes the gate to what the mechanism controls. Default stays
  // 'all' — the strict behaviour PROOF defect 1 asked for — so nothing
  // changes unless a caller asks.
  const fillScope = opts.fillMonotonicityScope ?? 'all';
  const keepsEveryIncumbentFill = (trial: SolutionPlan): boolean => {
    if (fillScope === 'call') {
      const trialCalls = new Set(trial.assignments
        .filter(a => a.provider_id && a.shift_type_category === 'call').map(a => a.slot_id));
      for (const id of bestCallFilled) if (!trialCalls.has(id)) return false;
      return true;
    }
    const trialFilled = filledSlotIds(trial);
    for (const id of bestFilled) if (!trialFilled.has(id)) return false;
    return true;
  };

  // ── Provider call caps (2026-07-22, patch34 provider_limits) ──
  // Caps are hard ceilings for ALL of auto-generation, the optimizer
  // included. Inside a trial re-solve the pinned assignments re-validate with
  // 'call-no-quota' — which rightly bypasses caps for incumbents — so a move
  // ONTO a capped provider slips through the trial. The acceptance gate
  // rejects any trial plan exceeding a stated cap (seeds counted): the greedy
  // seed plan is cap-clean by construction, so acceptance stays monotone
  // cap-clean. null caps ⇒ the check is inert (blank-fallback pin). Since
  // 2026-07-26 the caps are the MERGED set (provider_limits + scenario
  // per-(bucket,code)/NEURO/either-or ceilings) and the tally is
  // scenario-aware, so no accepted trial can move a call past a scenario
  // target ceiling either.
  const callCaps = mergedCallCapsForCtx(ctx);
  const withinCallCaps = (trial: SolutionPlan): boolean =>
    !callCaps || planWithinCallCaps(callCaps, trial, ctx.seedAssignments, ctx.shiftTypes, ctx.scenario);

  // ── Obligation cap (2026-07-24, obligatory fill mode only) ──
  // The TOTAL-level mirror of the per-code call-caps gate above: no accepted
  // trial may hold any provider past their rounded obligation (seeds
  // counted). Every in-solve placement path is capRoom-gated — pins included
  // — so trials are cap-clean by construction; this acceptance gate is the
  // planWithinCallCaps-style backstop that keeps it that way structurally.
  // The obligation cap is a Gabriel-stated ceiling like provider_limits, NOT
  // the fairness quota — the optimizer must never "improve" a deliberately
  // open 'obligation-cap' slot (the paid-pickup layer) into a fill. Inert
  // (null) outside obligatory mode.
  const obligations = fillMode === 'obligatory' ? computeObligations(ctx) : null;
  const withinObligations = (trial: SolutionPlan): boolean =>
    !obligations || planWithinObligations(obligations, trial, ctx.seedAssignments, ctx.shiftTypes);

  // ── Eligibility pre-gate (built once — its inputs never change) ──
  // The gate state holds ONLY the seeded assignments (+ ctx-derived facts like
  // PTO, cross-site, credentials, weekday availability inside
  // evaluateEligibility) — exactly the state every re-solve starts from, and
  // solve() only ever ADDS to it. Every gate condition is monotone in that
  // state, so a gated (slot, provider) pair is GUARANTEED to self-reject at
  // overrideFor()'s identical 'call' check inside the trial's solve(), leaving
  // the forced slot unfilled. Such a trial can improve the objective only
  // through second-order cascades (the freed provider filling a DIFFERENT
  // unfilled slot in the main loop). Gating is therefore an accepted narrowing
  // of the move set: it never admits an invalid plan, stays deterministic, and
  // skips only trials whose forced placement is guaranteed to self-reject.
  // NOTE: the snapshot must NOT include the current best's own (non-seed)
  // assignments — those are exactly what a trial perturbs (e.g. an eviction
  // vacates P's slot, freeing P's quota/day), and gating on them would skip
  // first-order improving moves.
  const gateState = seedSolveState(ctx, doc);
  const gateMemo = new Map<string, boolean>();
  const gatePasses = (slotId: string, pid: string): boolean => {
    const key = `${slotId}|${pid}`;
    const memo = gateMemo.get(key);
    if (memo !== undefined) return memo;
    const slot = slotById.get(slotId);
    const p = providerById.get(pid);
    // Unknown slot/provider: don't gate — fall through to the full resolve.
    // Gate 'call-no-quota' (2026-07-16): the trial's overrideFor re-validates
    // pins with the same quota-free gate, so gate-monotonicity holds
    // identically — a pair gated here is STILL guaranteed to self-reject
    // inside the trial. Gating with the quota-inclusive gate killed every
    // eviction move INTO a quota-starved slot dead on arrival (exactly the
    // slots the 2026-07-16 relaxation work needs the optimizer to reach).
    const pass = !slot || !p
      || evaluateEligibility(slot, p, gateState, ctx, 'call-no-quota').eligible;
    gateMemo.set(key, pass);
    return pass;
  };

  for (let iter = 0; iter < maxIters && !budgetExhausted(); iter++) {
    let improved = false;

    const unfilledCallIds = best.unfilled
      .filter(isCallUnfilled)
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
        if (pSlots.length === 0) continue;
        // Hoisted gate: if P can't take U in any trial, every (slot, evictee)
        // combination for this P is dead — counted as ONE gated skip.
        if (!gatePasses(uId, pid)) { gatedSkips++; continue; }
        for (const sId of pSlots) {
          for (const qid of providerIds) {
            if (qid === pid) continue;
            if (budgetExhausted()) break outer; // budget guard
            if (!gatePasses(sId, qid)) { gatedSkips++; continue; }
            const trial = new Map(bestAssign);
            trial.set(uId, pid);   // P fills the gap
            trial.set(sId, qid);   // Q takes P's vacated slot
            resolvesUsed++;
            const { plan, metrics } = evaluate(ctx, trial, fillMode, tieBreakSeed, callsOnly, dayScope, candidateTier, neuroScope);
            tally(moveReject, plan, metrics, bestMetrics);
            if (keepsEveryIncumbentFill(plan) && withinCallCaps(plan)
              && withinObligations(plan)
              && compareMetrics(metrics, bestMetrics) < 0) {
              best = plan; bestMetrics = metrics; bestAssign = extractCallAssignment(plan);
              bestFilled = filledSlotIds(plan);
              bestCallFilled = new Set(plan.assignments
                .filter(a => a.provider_id && a.shift_type_category === 'call').map(a => a.slot_id));
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
        const { plan, metrics } = evaluate(ctx, trial, fillMode, tieBreakSeed, callsOnly, dayScope, candidateTier, neuroScope);
        tally(moveReject, plan, metrics, bestMetrics);
        if (keepsEveryIncumbentFill(plan) && withinCallCaps(plan)
          && withinObligations(plan)
          && compareMetrics(metrics, bestMetrics) < 0) {
          best = plan; bestMetrics = metrics; bestAssign = extractCallAssignment(plan);
          bestFilled = filledSlotIds(plan);
          bestCallFilled = new Set(plan.assignments
            .filter(a => a.provider_id && a.shift_type_category === 'call').map(a => a.slot_id));
          improved = true;
          break swap;
        }
      }
    }
    if (!improved) break; // local optimum reached
  }

  // ── Move set 3: RUIN AND RECREATE ──────────────────────────────────────
  // Opt-in. The two moves above are converged by the time we get here — the
  // loop only exits when neither finds an improvement — so this starts from a
  // genuine local optimum and tries to cross out of it.
  //
  // Ruin: drop every movable call in a contiguous window, or every movable
  // call one provider holds. Recreate: hand the REST back to solve() as
  // overrides and let the greedy loop refill the hole from scratch. Because
  // solve() re-derives the whole plan, one round can change many slots at
  // once — which is exactly what the eviction/swap pair cannot do.
  //
  // WHY IT CANNOT BREAK ANYTHING THE OTHER MOVES CANNOT. It only ever removes
  // ids from the override map, and only ids that movableCallSlotIds already
  // vouched for — so chain anchors, chain links, pre-PTO placements and seeds
  // are never touched. Acceptance runs the identical four gates: every
  // incumbent fill kept, caps respected, obligations respected, and a strict
  // improvement on the lexicographic objective.
  if (opts.ruinRecreate) {
    const rounds = opts.ruinRounds ?? 40;
    // ITS OWN BUDGET. The first implementation shared the global one and, in
    // obligatory mode, never executed a single trial — the eviction and swap
    // phases had already spent it. A phase that silently does not run is
    // indistinguishable from a phase that runs and finds nothing, and the
    // first measurement could not tell those apart.
    const ruinDeadline = Date.now() + Math.max(1_000, wallClockMs);
    const ruinExhausted = () => Date.now() >= ruinDeadline;
    const movableNow = () => movableCallSlotIds(best, doc);
    // Deterministic pseudo-randomness. Math.random would make a plan
    // irreproducible from the same DB state, which this engine does not do
    // anywhere — the tie-break seed machinery exists for the same reason.
    let rng = 0x9e3779b9;
    const nextInt = (n: number): number => {
      rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0;
      return n <= 0 ? 0 : rng % n;
    };

    for (let round = 0; round < rounds && !ruinExhausted(); round++) {
      const movableIds = movableNow();
      if (movableIds.length === 0) break;
      const dated = movableIds
        .map(id => ({ id, date: slotById.get(id)?.slot_date ?? '' }))
        .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

      // Two ruin shapes, tried in turn. A WINDOW breaks up a run of dates that
      // settled badly together; a PROVIDER frees the whole burden of someone
      // the greedy over- or under-loaded, which is the shape of the fairness
      // failures actually observed.
      // RUIN BY DATE WINDOW, not by slot count. Pulling N slots out of a
      // date-sorted list can leave half a day pinned and half free, and the
      // recreate then has no room to move anyone — every trial dies on
      // fill-monotonicity. Taking whole DATES gives the greedy a genuinely
      // empty stretch to rebuild.
      const allDates = [...new Set(dated.map(d => d.date))].sort();
      const ruins: string[][] = [];
      for (const span of [4, 8, 16, 28]) {
        if (allDates.length <= span) continue;
        const start = nextInt(Math.max(1, allDates.length - span));
        const window = new Set(allDates.slice(start, start + span));
        ruins.push(dated.filter(d => window.has(d.date)).map(d => d.id));
      }
      // A whole provider's burden, PLUS every movable slot on the dates they
      // held — otherwise their slots come free while the only people who
      // could take them stay pinned, and nothing can refill.
      for (const pid of providerIds) {
        const theirs = movableIds.filter(id => bestAssign.get(id) === pid);
        if (theirs.length === 0) continue;
        const theirDates = new Set(theirs.map(id => slotById.get(id)?.slot_date ?? ''));
        ruins.push(dated.filter(d => theirDates.has(d.date)).map(d => d.id));
      }

      let improvedHere = false;
      for (const ruin of ruins) {
        if (ruinExhausted()) break;
        const trial = new Map(bestAssign);
        for (const id of ruin) trial.delete(id);
        resolvesUsed++;
        const { plan, metrics } = evaluate(
          ctx, trial, fillMode, tieBreakSeed, callsOnly, dayScope, candidateTier, neuroScope);
        // Diagnostic tally: which gate actually stops a ruin trial. Without
        // it "0 accepted" cannot distinguish "no better plan exists" from
        // "the acceptance test refuses to look at one".
        if (!keepsEveryIncumbentFill(plan)) ruinReject.fill++;
        else if (!withinCallCaps(plan)) ruinReject.caps++;
        else if (!withinObligations(plan)) ruinReject.oblig++;
        else if (compareMetrics(metrics, bestMetrics) === 0) ruinReject.same++;
        else if (compareMetrics(metrics, bestMetrics) > 0) ruinReject.worse++;
        if (keepsEveryIncumbentFill(plan) && withinCallCaps(plan)
          && withinObligations(plan)
          && compareMetrics(metrics, bestMetrics) < 0) {
          best = plan; bestMetrics = metrics; bestAssign = extractCallAssignment(plan);
          bestFilled = filledSlotIds(plan);
          bestCallFilled = new Set(plan.assignments
            .filter(a => a.provider_id && a.shift_type_category === 'call').map(a => a.slot_id));
          ruinAccepted++;
          improvedHere = true;
          break; // restart the round from the new incumbent (monotone)
        }
      }
      // Nothing in a full sweep of shapes helped; further rounds only re-roll
      // the window offsets, so give the budget back rather than spinning.
      if (!improvedHere && round > 4) break;
    }
  }

  return {
    plan: best,
    stats: {
      resolves: resolvesUsed, gatedSkips, wallMs: Date.now() - t0,
      ruinAccepted, ruinReject, moveReject,
    },
  };
}
