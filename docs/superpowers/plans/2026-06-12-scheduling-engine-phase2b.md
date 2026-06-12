# Scheduling Engine — Phase 2b (Local-Search Optimization) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a deterministic, bounded hill-climb local-search pass on top of the greedy construction that reduces skipped call slots and tightens fairness — accepting only strictly-improving moves, so it can never produce a worse schedule than today's engine.

**Architecture:** The greedy `solve()` is kept as the *seed*. We add an optional `callOverrides` map to `solve()` (when empty, behavior is byte-for-byte unchanged) that forces specific providers onto specific call slots — letting a new `optimize()` re-solve from a *perturbed* call assignment and reuse every existing derivation rule (D-chains, weekend block, relief) with zero new structural code. `optimize()` extracts the seed's call assignment, proposes single-slot eviction moves (to fill skips) and fairness swaps, evaluates each by re-solving + `scoreSolution`, and keeps a move only if it strictly improves a lexicographic objective `(skipped, fairnessStdev, burnout)`. The orchestrator runs `optimize()` behind a default-on flag and reports seed-vs-final metrics.

**Tech Stack:** TypeScript (strict), Vitest. Pure functions only — no new I/O, no new dependencies, no schema change.

**Scope note:** Phase 2b of the approved optimization design (`docs/superpowers/specs/2026-06-11-...`, §5). Builds on Phase 2a's `scoreSolution` (the objective) and explanation plumbing. Moves are restricted to **non-weekend-chain weekday/Friday call slots** (the bulk, and where skips occur); weekend-chain and pre-PTO slots are left to deterministic construction. Min-cost-flow / ILP and multi-restart remain out of scope (the user chose bounded hill-climb).

**Known carry-in (from 2a review):** the burnout metric excludes the Fri–Sun weekend block; that's already handled in `metrics.ts`.

---

## File Structure

**New files:**
- `src/lib/rulesEngine/optimize.ts` — `optimize(ctx, opts?)`: seed → improve → best plan; plus pure helpers `extractCallAssignment`, `isMovableCallSlot`, `compareMetrics`.
- `src/lib/rulesEngine/optimize.test.ts` — eviction-fills-a-skip, fairness-swap-lowers-stdev, never-worse, determinism.

**Modified files:**
- `src/lib/rulesEngine/genTypes.ts` — add `SolveOptions` (callOverrides).
- `src/lib/rulesEngine/solve.ts` — accept `SolveOptions`; honor `callOverrides` at every call-placement decision (pre-PTO, main loop, weekend block); empty map = unchanged.
- `src/lib/rulesEngine/solve.test.ts` — equivalence tests (empty override == plain; full-seed override reproduces seed providers).
- `src/lib/rulesEngine/autoGenerate.ts` — call `optimize()` instead of `solve()` (flagged); add seed-vs-final metrics to the result.

---

## Task 1: Add `callOverrides` to `solve()` (the re-solve mechanism)

The optimizer re-solves from a forced call assignment. `solve()` gains an optional override map: at each point where a CALL provider is chosen (pre-PTO, main loop, weekend chain), if the slot is in `callOverrides`, use that provider **iff it passes the canonical `'call'` gate** (else leave the slot unfilled — this makes infeasible moves self-reject). Everything after the choice (record, chainDFills, weekend block, relief) is unchanged. When `callOverrides` is empty/absent, every code path is identical to today.

**Files:**
- Modify: `src/lib/rulesEngine/genTypes.ts`, `src/lib/rulesEngine/solve.ts`
- Test: `src/lib/rulesEngine/solve.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/rulesEngine/solve.test.ts` (reuses existing `prov`/`callSlot`/`dSlot`/`buildCtx` helpers):

```ts
import { extractCallAssignment } from './optimize';

describe('solve — callOverrides (re-solve mechanism)', () => {
  function bigCtx() {
    // A small but non-trivial block: two weekday C1 slots, two providers.
    const slots = [
      callSlot('s1', '2026-01-06', 'C1'), // Tue
      callSlot('s2', '2026-01-13', 'C1'), // Tue next week
    ];
    return buildCtx(slots, [prov('pA'), prov('pB')]);
  }

  it('empty override is identical to no options', () => {
    const a = solve(bigCtx());
    const b = solve(bigCtx(), {});
    const c = solve(bigCtx(), { callOverrides: new Map() });
    const ids = (p: typeof a) => p.assignments.map(x => `${x.slot_id}:${x.provider_id}`).sort();
    expect(ids(b)).toEqual(ids(a));
    expect(ids(c)).toEqual(ids(a));
  });

  it('forces the given provider onto a call slot when eligible', () => {
    const ctx = bigCtx();
    const seed = solve(ctx);
    // Flip s1 to whichever provider did NOT get it in the seed.
    const got = seed.assignments.find(a => a.slot_id === 's1')!.provider_id;
    const other = got === 'pA' ? 'pB' : 'pA';
    const forced = solve(bigCtx(), { callOverrides: new Map([['s1', other]]) });
    expect(forced.assignments.find(a => a.slot_id === 's1')?.provider_id).toBe(other);
  });

  it('leaves a slot unfilled when the forced provider is ineligible (self-rejecting)', () => {
    const ctx = bigCtx();
    // Force a CRNA-typed provider id that cannot take the physician slot.
    const ctx2 = buildCtx(
      [callSlot('s1', '2026-01-06', 'C1')],
      [{ ...prov('pA'), provider_type: 'crna' }],
    );
    const forced = solve(ctx2, { callOverrides: new Map([['s1', 'pA']]) });
    expect(forced.assignments.some(a => a.slot_id === 's1')).toBe(false);
    expect(forced.unfilled.some(u => u.slot_id === 's1')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- solve`
Expected: FAIL — `extractCallAssignment` (from `./optimize`, created in Task 2) not found, and `solve` doesn't accept options. (For THIS task, temporarily remove the `import { extractCallAssignment }` line — it's only needed by later tests; add it back in Task 2. Re-run; now the `callOverrides` describe block fails on the missing options param.)

- [ ] **Step 3: Implement the override in genTypes + solve**

In `src/lib/rulesEngine/genTypes.ts`, add:

```ts
// Options for solve(). callOverrides forces a provider onto a CALL slot (by
// slot_id -> provider_id) when that provider passes the canonical 'call' gate;
// used by the local-search optimizer to re-solve a perturbed call assignment.
export interface SolveOptions {
  callOverrides?: Map<string, string>;
}
```

In `src/lib/rulesEngine/solve.ts`:

(a) Import the type and change the signature:

```ts
import type {
  GenerationContext, SlotToFill, CandidateProvider, SolveState,
  SolutionPlan, PlacementSource, AssignmentExplanation, CandidateRejection,
  SolveOptions,
} from './genTypes';

export function solve(ctx: GenerationContext, opts: SolveOptions = {}): SolutionPlan {
```

(b) Right after `const providerById = new Map(...)`, add a helper that resolves an override for a slot (returns the override provider if present AND eligible, else null):

```ts
  const overrides = opts.callOverrides;
  // If this call slot is overridden, return the forced provider WHEN eligible,
  // else null. A null return means "fall through to normal scoring"; an
  // overridden-but-ineligible slot is handled by the caller (left unfilled).
  const overrideFor = (slot: SlotToFill): CandidateProvider | null | undefined => {
    if (!overrides || !overrides.has(slot.slot_id)) return undefined; // not overridden
    const p = providerById.get(overrides.get(slot.slot_id)!);
    if (!p) return null;
    return evaluateEligibility(slot, p, state, ctx, 'call').eligible ? p : null;
  };
```

(c) In the **main loop**, before the `candidates` computation, handle overrides:

```ts
  for (const slot of ctx.slotsToFill) {
    if (state.handledSlotIds.has(slot.slot_id)) continue;
    if (slot.shift_type_category !== 'call') continue;

    const forced = overrideFor(slot);
    if (forced === null) {
      // Overridden to an ineligible provider -> leave unfilled (self-rejecting move).
      plan.unfilled.push({
        slot_id: slot.slot_id, slot_date: slot.slot_date,
        shift_type_code: slot.shift_type_code, reason: 'Forced provider ineligible',
      });
      continue;
    }
    if (forced) {
      record(slot, forced, 'main-loop');
      chainDFills(slot, forced);
      // weekend block off a forced Saturday pick (same logic as the scored path)
      maybeWeekendBlock(slot, forced);
      continue;
    }

    // ... existing scoring path unchanged ...
```

Extract the weekend-block code currently inline after `record(slot, scored[0].p, 'main-loop'); chainDFills(...)` into a local `const maybeWeekendBlock = (slot: SlotToFill, chosen: CandidateProvider) => { ... }` (the existing `if (slot.derived_day_type === 'saturday') { ... }` block, with `chosen` as the parameter), defined alongside `chainDFills`. Call `maybeWeekendBlock(slot, winner.p)` in the scored path where the inline weekend block currently sits. This keeps ONE copy of the weekend logic used by both the forced and scored paths.

(d) In the **pre-PTO pass**, make `tryPlacePrePto` defer to an override: at the top of `tryPlacePrePto`, if the slot is overridden, skip (return false) so the main loop's override is authoritative:

```ts
  const tryPlacePrePto = (slot: SlotToFill | undefined, p: CandidateProvider): boolean => {
    if (!slot) return false;
    if (overrides?.has(slot.slot_id)) return false; // override is authoritative; main loop handles it
    if (state.handledSlotIds.has(slot.slot_id)) return false;
    if (!evaluateEligibility(slot, p, state, ctx, 'call').eligible) return false;
    record(slot, p, 'pre-pto-thursday');
    chainDFills(slot, p);
    return true;
  };
```

(e) The weekend block's `chainAssign` places Sun/Fri CALL slots off a Saturday anchor. When those Sun/Fri slots are overridden, the override should win. Add an override check at the top of `chainAssign`: if `overrides?.has(target.slot_id)`, use `overrideFor(target)` (place the forced provider if eligible, else skip) instead of the chain's `chosen`. Concretely, inside `chainAssign`, before the eligibility check:

```ts
      const target = slotMap?.get(code);
      if (!target) return;
      if (state.handledSlotIds.has(target.slot_id)) return;
      if (overrides?.has(target.slot_id)) {
        const f = overrideFor(target);
        if (f) { record(target, f, 'weekend-chain'); chainDFills(target, f); }
        return; // overridden slot handled (placed if eligible, else left for main loop/unfilled)
      }
      const gate = target.shift_type_category === 'call' ? 'call' : 'derived';
      if (!evaluateEligibility(target, chosen, state, ctx, gate).eligible) return;
      record(target, chosen, 'weekend-chain');
      chainDFills(target, chosen);
```

> The full-seed-override equivalence (Task 4's golden-master) verifies these paths reproduce the seed exactly. If a test there fails, the override path diverged from the scored path — fix the divergence, do not weaken the test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- solve`
Expected: PASS — including the 3 new `callOverrides` tests and ALL pre-existing solve tests (the empty-override path must be identical). Re-add the `import { extractCallAssignment } from './optimize';` line only after Task 2 exists; for now keep it removed so the file compiles.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/genTypes.ts src/lib/rulesEngine/solve.ts src/lib/rulesEngine/solve.test.ts
git commit -m "Add callOverrides re-solve mechanism to solve (empty = unchanged)"
```

---

## Task 2: `optimize.ts` — extraction + eviction move + hill-climb

The optimizer. Pure. Seeds with `solve(ctx)`, extracts the call assignment, and runs a deterministic bounded hill-climb: for each unfilled call slot, try moving an eligible provider off one of their movable call slots onto the gap (re-picking the vacated slot), re-solve, and keep the move only if the lexicographic objective strictly improves.

**Files:**
- Create: `src/lib/rulesEngine/optimize.ts`
- Test: `src/lib/rulesEngine/optimize.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/rulesEngine/optimize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { optimize, extractCallAssignment, compareMetrics } from './optimize';
import { solve } from './solve';
import { scoreSolution } from './metrics';
import type { GenerationContext, SlotToFill, CandidateProvider } from './genTypes';

function prov(id: string, fte = 1, over: Partial<CandidateProvider> = {}): CandidateProvider {
  return {
    id, provider_type: 'physician', short_display_name: id, fte_value: fte,
    home_site_id: 'site1', available_weekdays: [true, true, true, true, true, true, true],
    ...over,
  };
}
function callSlot(id: string, date: string, code: string, dt = 'weekday'): SlotToFill {
  return {
    slot_id: id, slot_date: date, shift_type_id: 'st-' + code,
    shift_type_code: code, shift_type_category: 'call',
    derived_day_type: dt, provider_group: 'physician',
    required_count: 1, existing_assignment_id: null,
  };
}
function buildCtx(slots: SlotToFill[], providers: CandidateProvider[],
                  over: Partial<GenerationContext> = {}): GenerationContext {
  const slotIndex = new Map<string, Map<string, SlotToFill>>();
  for (const s of slots) {
    if (!slotIndex.has(s.slot_date)) slotIndex.set(s.slot_date, new Map());
    slotIndex.get(s.slot_date)!.set(s.shift_type_code, s);
  }
  const bucketTarget = new Map<string, number>();
  for (const s of slots) for (const p of providers) {
    bucketTarget.set(`${p.id}|weekday|${s.shift_type_code}`, 99);
  }
  return {
    scheduleVersionId: 'v1', siteId: 'site1', parLevel: 12,
    slotsToFill: slots, slotIndex, providers,
    credByPid: new Map(), availByPid: new Map(), crossSiteByDate: new Map(),
    historicalAssignedByPid: new Map(), historicalTotalByBucket: new Map(),
    bucketTotals: new Map(), bucketTarget, seedAssignments: [],
    ...over,
  };
}

describe('extractCallAssignment', () => {
  it('maps each filled call slot to its provider', () => {
    const slots = [callSlot('s1', '2026-01-06', 'C1')];
    const plan = solve(buildCtx(slots, [prov('pA')]));
    const ca = extractCallAssignment(plan);
    expect(ca.get('s1')).toBe('pA');
  });
});

describe('compareMetrics (lexicographic: skipped, fairnessStdev, burnout)', () => {
  it('fewer skips wins regardless of fairness', () => {
    expect(compareMetrics(
      { filled: 5, skipped: 0, fairnessStdev: 9, burnout: 9, providersUsed: 1 },
      { filled: 4, skipped: 1, fairnessStdev: 0, burnout: 0, providersUsed: 1 },
    )).toBeLessThan(0); // first is better
  });
  it('on equal skips, lower fairnessStdev wins', () => {
    expect(compareMetrics(
      { filled: 5, skipped: 0, fairnessStdev: 0.1, burnout: 5, providersUsed: 2 },
      { filled: 5, skipped: 0, fairnessStdev: 0.2, burnout: 0, providersUsed: 2 },
    )).toBeLessThan(0);
  });
});

describe('optimize — eviction fills a skip greedy left behind', () => {
  it('fills a slot that greedy stranded via a single eviction', () => {
    // Construct a corner: provider pX is the ONLY one eligible for slot s2
    // (others are weekday-unavailable that day), but greedy uses pX on s1
    // first, leaving s2 unfillable. pY can cover s1. Eviction: pX->s2, pY->s1.
    // s1 Tue 2026-01-06, s2 Wed 2026-01-07.
    const pX = prov('pX');
    // pY only available Tue (not Wed) -> pY can't take s2, only s1.
    const pY = prov('pY', 1, { available_weekdays: [true, true, true, false, true, true, true] }); // Wed(3) off
    const slots = [callSlot('s1', '2026-01-06', 'C1'), callSlot('s2', '2026-01-07', 'C1')];
    const ctx = buildCtx(slots, [pX, pY]);

    const seed = solve(ctx);
    const seedScore = scoreSolution(seed, ctx);

    const optimized = optimize(ctx);
    const optScore = scoreSolution(optimized, ctx);

    // Optimizer must do at least as well on skips, and ideally fill both.
    expect(optScore.skipped).toBeLessThanOrEqual(seedScore.skipped);
    expect(optimized.assignments.filter(a => ['s1', 's2'].includes(a.slot_id)).length)
      .toBeGreaterThanOrEqual(seed.assignments.filter(a => ['s1', 's2'].includes(a.slot_id)).length);
    // Both slots filled in the optimized result.
    expect(optimized.assignments.some(a => a.slot_id === 's1')).toBe(true);
    expect(optimized.assignments.some(a => a.slot_id === 's2')).toBe(true);
  });

  it('never produces more skips than the seed (never-worse guarantee)', () => {
    const slots = [
      callSlot('s1', '2026-01-06', 'C1'), callSlot('s2', '2026-01-13', 'C1'),
      callSlot('s3', '2026-01-20', 'C1'),
    ];
    const ctx = buildCtx(slots, [prov('pA'), prov('pB'), prov('pC')]);
    const seed = solve(ctx);
    const optimized = optimize(ctx);
    expect(scoreSolution(optimized, ctx).skipped)
      .toBeLessThanOrEqual(scoreSolution(seed, ctx).skipped);
  });

  it('is deterministic: two runs give identical assignments', () => {
    const mk = () => buildCtx(
      [callSlot('s1', '2026-01-06', 'C1'), callSlot('s2', '2026-01-13', 'C1')],
      [prov('pB'), prov('pA')],
    );
    const a = optimize(mk());
    const b = optimize(mk());
    expect(a.assignments.map(x => `${x.slot_id}:${x.provider_id}`).sort())
      .toEqual(b.assignments.map(x => `${x.slot_id}:${x.provider_id}`).sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- optimize`
Expected: FAIL — cannot find module `./optimize`.

- [ ] **Step 3: Implement `optimize.ts`**

Create `src/lib/rulesEngine/optimize.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- optimize`
Expected: PASS (extraction, compareMetrics, eviction-fills-skip, never-worse, determinism).
Also: re-add `import { extractCallAssignment } from './optimize';` to the top of `solve.test.ts` (Task 1 Step 2 removed it) and run `npm test -- solve` — still green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/optimize.ts src/lib/rulesEngine/optimize.test.ts src/lib/rulesEngine/solve.test.ts
git commit -m "Add optimize(): bounded hill-climb eviction + fairness local search"
```

---

## Task 3: Wire `optimize()` into the orchestrator (flagged) + seed-vs-final metrics

The orchestrator runs `optimize()` instead of plain `solve()`, behind a default-on option so it can be disabled for comparison. It reports both the seed (greedy) metrics and the final (optimized) metrics so the improvement is visible.

**Files:**
- Modify: `src/lib/rulesEngine/autoGenerate.ts`
- Test: `src/lib/rulesEngine/autoGenerate.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/rulesEngine/autoGenerate.test.ts`:

```ts
import { resolveOptimizeEnabled } from './autoGenerate';

describe('resolveOptimizeEnabled', () => {
  it('defaults to true when unset', () => {
    expect(resolveOptimizeEnabled(undefined)).toBe(true);
  });
  it('honors an explicit false (disable optimization)', () => {
    expect(resolveOptimizeEnabled(false)).toBe(false);
  });
  it('honors an explicit true', () => {
    expect(resolveOptimizeEnabled(true)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- autoGenerate`
Expected: FAIL — `resolveOptimizeEnabled` not exported.

- [ ] **Step 3: Implement**

In `src/lib/rulesEngine/autoGenerate.ts`:

(a) Add imports:

```ts
import { solve } from './solve';
import { optimize } from './optimize';
```
(keep `solve` imported — still used as the seed baseline for the metrics comparison).

(b) Extend `AutoGenerateOptions` and add the resolver + a `seedMetrics` field on the result:

```ts
export interface AutoGenerateOptions {
  overrideProviderIds?: string[];
  optimize?: boolean; // default true; set false to use raw greedy construction
}

// Pure: optimization is on by default; an explicit boolean overrides.
export function resolveOptimizeEnabled(flag: boolean | undefined): boolean {
  return flag !== false;
}
```

Add to the `GenerationResult` interface (additive):

```ts
  metrics?: SolutionMetrics;
  seedMetrics?: SolutionMetrics; // greedy baseline, for before/after comparison
```

(c) In the success path, replace the `plan = solve(ctx)` line inside the try block with seed + optional optimize, and compute both metrics. Find:

```ts
  let plan;
  let commit;
  try {
    plan = solve(ctx);
    commit = await commitPlan(sb, plan);
  } catch (e: unknown) {
```

Replace with:

```ts
  let plan;
  let commit;
  let seedMetrics;
  try {
    const seedPlan = solve(ctx);
    seedMetrics = scoreSolution(seedPlan, ctx);
    plan = resolveOptimizeEnabled(options.optimize) ? optimize(ctx) : seedPlan;
    commit = await commitPlan(sb, plan);
  } catch (e: unknown) {
```

(d) Where `result.metrics = scoreSolution(plan, ctx);` is set in the success mapping, add the seed metrics right after it:

```ts
  result.metrics = scoreSolution(plan, ctx);
  result.seedMetrics = seedMetrics;
```

(Ensure `scoreSolution` and `SolutionMetrics` are imported — `scoreSolution` was added in Phase 2a; add `SolutionMetrics` to the genTypes type import if not already there.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- autoGenerate`
Expected: PASS.
Run: `npm test`
Expected: full suite green.
Run: `npx tsc --noEmit && npm run build`
Expected: clean; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/autoGenerate.ts src/lib/rulesEngine/autoGenerate.test.ts
git commit -m "Run optimize() in orchestrator (default-on flag); report seed-vs-final metrics"
```

---

## Task 4: Golden-master — optimize-off equals Phase 2a; optimize-on never worse

A property test on a richer synthetic block proving (a) disabling optimization reproduces the greedy output exactly, and (b) the full-seed-override re-solve reproduces the seed (the equivalence the optimizer relies on), and (c) optimization never increases skips or fairness stdev.

**Files:**
- Test: `src/lib/rulesEngine/optimize.test.ts` (extend)

- [ ] **Step 1: Write the test**

Append to `src/lib/rulesEngine/optimize.test.ts`:

```ts
describe('golden-master / equivalence', () => {
  // A richer block: 4 weeks of weekday C1 + C2, 5 providers of mixed FTE.
  function richCtx() {
    const slots: SlotToFill[] = [];
    const dates = ['2026-01-06', '2026-01-13', '2026-01-20', '2026-01-27']; // Tuesdays
    for (const d of dates) {
      slots.push(callSlot(`c1-${d}`, d, 'C1'));
      slots.push(callSlot(`c2-${d}`, d, 'C2'));
    }
    const providers = [
      prov('pA', 1), prov('pB', 1), prov('pC', 0.5), prov('pD', 0.5), prov('pE', 1),
    ];
    return buildCtx(slots, providers);
  }

  it('full-seed override re-solve reproduces the seed exactly (equivalence)', () => {
    const ctx = richCtx();
    const seed = solve(ctx);
    const seedAssign = extractCallAssignment(seed);
    const replay = solve(ctx, { callOverrides: seedAssign });
    const key = (p: typeof seed) => p.assignments
      .map(a => `${a.slot_id}:${a.provider_id}`).sort();
    expect(key(replay)).toEqual(key(seed));
  });

  it('optimize never increases skips or fairness stdev vs the greedy seed', () => {
    const ctx = richCtx();
    const seed = solve(ctx);
    const seedM = scoreSolution(seed, ctx);
    const opt = optimize(ctx);
    const optM = scoreSolution(opt, ctx);
    expect(optM.skipped).toBeLessThanOrEqual(seedM.skipped);
    // On equal skips, fairness must not get worse.
    if (optM.skipped === seedM.skipped) {
      expect(optM.fairnessStdev).toBeLessThanOrEqual(seedM.fairnessStdev + 1e-9);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test -- optimize`
Expected: PASS. **If the equivalence test fails**, the override path in `solve()` (Task 1) diverges from the scored path — debug `solve.ts` until a full-seed override reproduces the seed. Do NOT weaken this test; it is the correctness foundation of the optimizer.

- [ ] **Step 3: Commit**

```bash
git add src/lib/rulesEngine/optimize.test.ts
git commit -m "Add golden-master: override re-solve equivalence + optimize never-worse"
```

---

## Task 5: Full verification

**Files:**
- Verify only.

- [ ] **Step 1: Full suite + typecheck + build**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: all tests pass; tsc clean; production build succeeds.

- [ ] **Step 2: Confirm the never-worse + determinism properties hold**

Run: `npm test -- optimize solve`
Expected: green — the equivalence, never-worse, and determinism tests all pass.

- [ ] **Step 3: Commit (only if a verification fix was needed)**

If no changes were needed, do not commit. Otherwise:
```bash
git add <fixed files>
git commit -m "Fix Phase 2b verification issues"
```

---

## Self-Review (completed during planning)

**Spec coverage:**
- §5 local-search improvement pass (eviction + fairness, bounded hill-climb, strictly-improving, deterministic) → Tasks 2 (moves + loop) + 3 (wiring). ✓
- §5 "optimization on the call layer, structural derivation re-run" → realized via the `callOverrides` re-solve mechanism (Task 1) instead of a risky construction restructure; weekend-chain/pre-PTO slots excluded from moves (`movableCallSlotIds`). ✓
- §9 golden-master ("never more skips / never worse fairness" + behavior parity when off) → Task 4 (equivalence + never-worse) + Task 3 (optimize=false uses the seed plan). ✓
- §11 feature flag (default on) → `AutoGenerateOptions.optimize` + `resolveOptimizeEnabled` (Task 3). ✓
- User decision "bounded hill-climb" → `MAX_ITERATIONS`, strictly-improving acceptance, no restarts. ✓
- Objective = (skipped, fairnessStdev, burnout) lexicographic via `compareMetrics`, built on Phase 2a's `scoreSolution`. ✓

**Placeholder scan:** No TBD/placeholder steps; every code step shows complete code. The one conditional instruction (Task 1 Step 2 / Task 2 Step 4: temporarily remove then re-add the `extractCallAssignment` import) is an explicit ordering note with exact actions, not a placeholder.

**Type consistency:** `SolveOptions` (callOverrides) defined in Task 1, consumed by `solve` and `optimize`. `extractCallAssignment`, `compareMetrics`, `optimize`, `resolveOptimizeEnabled` signatures stable across Tasks 2–4. `SolutionMetrics` (Phase 2a) reused. `optimize(ctx, opts?)` matches its call sites. `movableCallSlotIds` keys off `source === 'main-loop'` + weekday/friday — consistent with how `solve` labels placements.

**Risk note:** the linchpin is the Task 1/Task 4 equivalence (full-seed override reproduces the seed). It holds by construction because the override path shares all post-pick logic (record/chainDFills/weekend/relief) with the scored path — the only difference is provider selection, and a full-seed override selects exactly the seed's providers. Task 4 proves it empirically; if it fails, fix `solve.ts`, never the test.
