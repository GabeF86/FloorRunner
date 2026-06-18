# A12 — Test Loop Agent — Runbook

**Charter (PRD §14, A12):** Maintain property-based + scenario tests across solver, simulator, normalizer, supervisability, float, and call burden. Run continuously (`/loop 1h` during active development). Surface unknown failure modes as notifications.

**Run cadence:** `/loop 1h` while any of A3 / A4 / A6 / A7 / A8 / A11 are actively committing. Pause when the fleet is idle.

---

## 1. Test inventory (as of first run, 2026-06-17)

All test files live under `src/lib/gridCalculator/__tests__/`. The runner convention is **`npx tsx <file>`** — zero runtime dependencies, no vitest/jest config, established by A3 in `solver.test.ts` and adopted by every subsequent agent.

| File | Owner | Tests | Notes |
|---|---|---|---|
| `solver.test.ts` | A3 | 11 | Scenario coverage of staffing patterns, ratio caps, cross-site supervision, determinism. |
| `floatStrategy.test.ts` | A6 | 7 | Severity bands, `break_priority` / `emergency_priority` / `balanced` modes, idempotence. |
| `callBurden.test.ts` | A8 | 10 | FTE-weighted greedy, postures, Gini, pinned share clamping. |
| `supervisability.test.ts` | A5 | 9 | Distance bands → safe/warning/blocked, off-campus hard-rule, edge style rendering. |
| `rulesNormalizer.test.ts` | A4 | 13 | Anthropic-mocked LLM responses, prompt caching, conflict surfacing. |
| `fteSimulator.test.ts` | A7 | 12 | Seeded Monte Carlo, worst-case vs p95 binding, float auto-bump, holiday calendar. |
| `paoliSeed.test.ts` | A11 | 11 | End-to-end Paoli pipeline, FTE sanity envelope, determinism. |
| `_property/solver-conservation.property.test.ts` | A12 | 2 | Property: provider conservation across 100 random trials. |
| **Total** | | **75** | All passing on first run. |

Fixtures: `src/lib/gridCalculator/__tests__/fixtures/normalizer-responses.json` (canned Anthropic responses, no real API calls).

## 2. Runner command

```bash
npx tsx scripts/run-grid-tests.ts
```

This wraps every `*.test.ts` (and `*.property.test.ts`) under `__tests__/` in series, prints a unified summary, and exits non-zero on any failure. Per-file output is streamed live so failures surface immediately, and the trailing summary table re-prints pass/fail counts and durations:

```
========================================
Grid Calculator test summary
========================================
   ok   2/2 passed, 0 failed — src/lib/gridCalculator/__tests__/_property/solver-conservation.property.test.ts (355ms)
   ok   10/10 passed, 0 failed — src/lib/gridCalculator/__tests__/callBurden.test.ts (397ms)
   ok   7/7 passed, 0 failed — src/lib/gridCalculator/__tests__/floatStrategy.test.ts (366ms)
   ok   12/12 passed, 0 failed — src/lib/gridCalculator/__tests__/fteSimulator.test.ts (695ms)
   ok   11/11 passed, 0 failed — src/lib/gridCalculator/__tests__/paoliSeed.test.ts (1150ms)
   ok   13/13 passed, 0 failed — src/lib/gridCalculator/__tests__/rulesNormalizer.test.ts (430ms)
   ok   11/11 passed, 0 failed — src/lib/gridCalculator/__tests__/solver.test.ts (364ms)
   ok   9/9 passed, 0 failed — src/lib/gridCalculator/__tests__/supervisability.test.ts (406ms)
----------------------------------------
  TOTAL  75/75 passed, 0 failed across 8 file(s) in 4163ms
```

Total wall time: ~4.5s on a local Mac. Cheap enough to loop hourly.

## 3. Loop cadence

```text
/loop 1h "Run the Grid Calculator test loop: npx tsx scripts/run-grid-tests.ts. If anything fails, identify the failing file, summarize the failure, and post a notification with the test name + owning agent. Do not silently fix failures owned by other agents — escalate to that agent's note."
```

When the fleet pauses for the day, stop the loop. When A7's nightly cron is added (PRD §14 A7) it will share this runner.

## 4. Initial findings (first run, 2026-06-17)

- **75 / 75 tests passing.** No pre-existing failures discovered.
- **No tsc errors.** `npx tsc --noEmit` is clean across the repo (project-wide check).
- **Runner determinism verified.** Two consecutive runs of the new property test produce byte-identical stdout under the same `BASE_SEED`.
- **No silent fixes performed.** Per A12's escalation rule, this agent does not modify other agents' files.

## 5. The first property test — what it covers, why it was picked

Added at `src/lib/gridCalculator/__tests__/_property/solver-conservation.property.test.ts`.

**Property:** *solver assignment conservation* — across 100 randomly generated `(config, sites, rules, roster, distanceMatrix)` tuples, the solver output must satisfy eight conservation invariants:

1. Every `crnaIds[*]` in any assignment is in the roster as a CRNA.
2. Every non-null `anesthesiologistId` in any assignment is in the roster as an MD.
3. Every `floats[*].providerId` is in the roster.
4. No CRNA appears in two different rooms' `crnaIds`.
5. No CRNA appears in BOTH a room assignment AND `floats[]`.
6. No MD that supervises a room also appears in `floats[]` (the float pool is for surplus only).
7. Every `crossSiteSupervisor.providerId` equals the room's `anesthesiologistId` and exists in the roster.
8. Every `assignment.roomId` maps to a real room in the input sites.

**Why this was picked first (over the other five candidates in the charter):**

- **Highest blast radius if it ever broke.** Double-booking a provider is the kind of bug that would *silently* let the simulator produce wildly optimistic FTE numbers. Every downstream consumer (A6 float strategy, A7 simulator, A8 call burden) depends on the solver's output being conservative.
- **Easy to randomize.** The solver's input surface is well-typed and small; generating a valid random scenario is ~80 LOC.
- **Determinism is already covered.** `solver.test.ts` test #7 asserts byte-equal output across two `solve()` calls; promoting this to a property would have added marginal value.
- **Idempotence is already promoted** in `floatStrategy.test.ts` test #6.
- **FTE-ratio invariance** is already partially covered by `callBurden.test.ts` test #2 across 0.5 / 0.8 / 1.0 FTEs.
- **Simulator monotonicity** is expensive (each MC run is ~50–1000 trials × the full pipeline). Worth adding once but not as the *first* property — too slow for `/loop 1h`.
- **Supervisability transitivity** (e.g. `near → near ⇒ not same_room`) isn't actually an invariant in `supervisability.ts` because `same_room` is a categorical band, not a derived relation. Asserting it would be wrong.

## 6. Backlog of proposed property tests

Each entry below has been considered, rationalized, and ranked by ROI. **Pick one at a time** as the loop matures.

### B1. Simulator monotonicity (HIGH ROI, LATER)
**Property:** Increasing `roster.length` by 1 (adding one extra eligible CRNA or MD) never *increases* the recommended FTE for the same `(config, sites, rules)`.

**Rationale:** Adds confidence to A7's worst-case + Monte Carlo math. Catches the regression where the simulator double-counts surplus capacity.

**Cost:** Each comparison is `runMonteCarlo` × 2. With `trialsCount: 30` per run, ~30 trials at ~50 ms each = ~1.5s × 2 = 3s per comparison. 20 comparisons = 60s. Too slow for `/loop 1h`? No — still fine. Worth adding once Monte Carlo speed is profiled.

**Owner if added:** A12 (this agent), feature-flag behind `PROPERTY_SLOW=1`.

### B2. callBurden FTE-ratio invariance (MEDIUM ROI)
**Property:** For a random eligible roster of size ≤ 30, the ratio between any two providers' `primaryCallNights` is within ±1 of their FTE ratio.

**Rationale:** Generalizes `callBurden.test.ts` test #2 (0.5 / 0.8 / 1.0) to arbitrary mixes. Catches off-by-one bugs in the greedy.

**Cost:** Cheap — `distributeCall` is O(n log n) per trial; 100 trials ≈ 30 ms.

**Owner if added:** A12.

### B3. floatStrategy idempotence as a property (LOW-MEDIUM ROI)
**Property:** `applyFloatStrategy(applyFloatStrategy(x)) === applyFloatStrategy(x)` for randomly generated `(grid, surplus, sites, distanceMatrix)`.

**Rationale:** `floatStrategy.test.ts` test #6 already asserts this for one fixed grid. Property-testing it catches drift if A6's strategy code grows new branches.

**Cost:** Cheap. ~100 trials in ~200 ms.

**Owner if added:** A12, gated to a comment-link back to A6's existing test so they don't drift.

### B4. Solver determinism as a property (LOW ROI — already covered)
**Property:** `solve(x) === solve(x)` byte-for-byte across 100 random `x`.

**Rationale:** `solver.test.ts` test #7 covers one case. Generalization is nice but the solver is structurally deterministic (no `Math.random`, no `Date.now`); the bigger risk is a future agent adding non-deterministic logic. The conservation property covers this implicitly because it would expose non-determinism as conservation failures.

**Decision:** Skip unless a non-deterministic regression appears.

### B5. Supervisability symmetry (MEDIUM ROI)
**Property:** For every distance edge `(A, B)`, `resolver.isSupervisable(A, B) === resolver.isSupervisable(B, A)`. (The PRD says edges are direction-agnostic; this asserts the implementation respects it.)

**Rationale:** Single edge can never be a directional rule; if the resolver ever caches asymmetrically (e.g. by `siteA<siteB` only), the bug would surface here.

**Cost:** Trivial.

**Owner if added:** A12.

### B6. Empty-roster never throws (LOW ROI — covered by scenario tests)
Each module already has a scenario test for empty/degenerate inputs. Property-fuzzing the inputs would add marginal coverage. Skip unless we see a crash.

### B7. Rules normalizer round-trip (DEFERRED to A4)
Property: `normalizeRules(text).rules` is structurally valid `CoverageRuleSet`. Defers to A4 because it requires Anthropic-mock fixtures that A4 owns. Note for A4 to consider.

---

## 7. How to add a new property test

1. Drop a new file in `src/lib/gridCalculator/__tests__/_property/` named `<topic>.property.test.ts`. The runner picks it up automatically via the suffix.
2. Reuse the inline mulberry32 RNG pattern from `solver-conservation.property.test.ts` so each property is reproducible from a single integer seed. (Do NOT depend on `fast-check` — it's not in `package.json` and adding it requires Gabriel's sign-off.)
3. Define your property as a single function `(ctx) => void` that throws via `node:assert/strict` on failure. Include the trial number and seed in the assertion message so failures are reproducible.
4. Loop the property `PROPERTY_TRIALS` times (default 100). On failure, collect the first 3 failing trials and emit them as a single `assert.fail()` so the harness reports cleanly.
5. Add a second test that proves your generator is deterministic across two runs with the same seed — exactly like the second test in `solver-conservation.property.test.ts`. This catches accidental non-determinism in the generator itself.
6. Verify locally:
   ```bash
   npx tsx src/lib/gridCalculator/__tests__/_property/<your-file>.property.test.ts
   npx tsx scripts/run-grid-tests.ts   # confirms it joins the unified report
   npx tsc --noEmit
   ```
7. Update the inventory table in §1 of this runbook (+1 to the total) and the backlog in §6 (strike the entry you just shipped).

## 8. Escalation playbook

When a test fails inside `/loop 1h`:

1. **Identify the owning agent** from the inventory table (§1). The file path is the source of truth.
2. **Do NOT silently fix** the failure. The owning agent needs to see it.
3. **Post a notification** with: the test name, the owning agent's identifier (A3 / A4 / …), the assertion message, and the truncated input (for property tests, include the seed + trial number so the agent can reproduce locally with `BASE_SEED=<n>`).
4. **If the failure is the runner itself** (file silently exits non-zero with no parseable summary), note it as an A12 owned issue and fix in `scripts/run-grid-tests.ts`. Otherwise, leave the failing test to its owner.
5. **If the failure persists across two loop iterations**, escalate to Gabriel with a single concise summary line per PRD §14 escalation rule.

## 9. Files owned by A12

- `src/lib/gridCalculator/__tests__/_property/` — new property tests live here.
- `scripts/run-grid-tests.ts` — the unified runner.
- `docs/agent-notes/A12-test-loop.md` — this runbook.

A12 must NOT modify any existing test file, library file, component, or seed.
