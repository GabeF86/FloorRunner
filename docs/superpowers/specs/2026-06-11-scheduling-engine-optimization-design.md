# Scheduling Engine — Optimization & Hardening

**Date:** 2026-06-11
**Status:** Approved (design), pending implementation plan
**Scope:** Physician call-schedule auto-generation engine (`src/lib/rulesEngine/`)
**Out of scope:** Auth/tenant isolation, staffing calculator, floor runner, CRNA scheduling, day-shift engine internals (touched only where it shares the new eligibility predicate / context helpers).

## 1. Goal

Make the call-schedule auto-generation engine **faster, more accurate, and more powerful**, where:

- **Faster** = eliminate the serial per-assignment DB writes and the per-assignment N+1 validation queries.
- **More accurate** = close the eligibility-bypass correctness holes, restore the documented determinism guarantee, and propagate errors honestly.
- **More powerful** = move from single-pass greedy to **construct + deterministic local search** ("Approach A"), producing fewer skipped slots and tighter fairness, with **explainability** ("why this person got this slot" / "why this slot couldn't be filled").

This is the first of four planned sub-projects (the others: platform/auth, staffing calculator, floor runner). Deployment context today is internal/single-user, so auth is deliberately deferred.

## 2. Background — current engine

See `ALGORITHM.md` for the authoritative description. In brief, `src/lib/rulesEngine/autoGenerate.ts` (1012 lines) runs a single-pass greedy loop:

1. Preload slots, pool, credentials, availability, cross-site conflicts, historical counts (steps 1–6.5).
2. Compute FTE-weighted bucket quotas with historical deficit carryforward.
3. Pre-PTO Thursday placement pass.
4. Main greedy loop: for each call slot (in a structurally-required order), pick the lowest-lifetime-ratio eligible provider, write to DB immediately, then chain D-shifts / weekend blocks inline.
5. D4–D9 relief pass.
6. Per-assignment validation in parallel batches of 10.

### Problems this design fixes (from review)

| ID | Severity | Problem |
|---|---|---|
| C1 | CRITICAL | `generate` route returns HTTP 200 even when every slot fails; engine never throws, errors are swallowed into `result.errors[]`. |
| H1 | HIGH | Weekend `chainAssign` bypasses `isEligible` → force-assigns Sun/Fri call slots past bucket quota, weekend-call credentials, and adjacent-week PTO. |
| H2 | HIGH | D4–D9 relief pass uses raw availability dates, not `effectivePtoRange` → places providers inside their PTO bookend window. |
| M3 | MEDIUM | Validation is an N+1 amplifier: `loadContext` issues ~7 sequential queries **per assignment**; site-level shift-types/rules are identical across assignments but re-queried each time. |
| M5 | MEDIUM | Scoring tie-break has no final stable key, and provider/slot queries have no `.order()` → non-deterministic output, breaking the ALGORITHM.md §11 determinism guarantee. |
| Perf | HIGH | Each assignment is written with its own `await sb.insert/update` inside the loop — hundreds of serial round-trips dominate runtime. |
| Quality | — | Greedy strands later slots: a provider is consumed on a slot another provider could have covered, leaving a later slot with zero eligible candidates (an avoidable skip). |

## 3. Architecture: Load → Solve → Commit → Validate

Split `autoGenerate.ts` into focused modules. The central principle: **Solve is a pure, I/O-free function** — that is what makes it testable, deterministic, and cheap to optimize in memory.

| Module | Responsibility | I/O |
|---|---|---|
| `rulesEngine/genContext.ts` → `loadGenerationContext(sb, versionId, options)` | All reads; returns an immutable `GenerationContext`: slots, provider pool, per-site credentials, availability, cross-site conflicts, historical counts, parLevel, bucket totals/targets. No decisions. | reads only |
| `rulesEngine/eligibility.ts` → `evaluateEligibility(slot, provider, state, ctx)` | The **single canonical eligibility predicate**. Returns `{ eligible: boolean, reason?: RejectionReason }`. Used by construction, D-chains, weekend chains, relief, **and** local-search repair moves. | pure |
| `rulesEngine/metrics.ts` → `scoreSolution(plan, ctx)` | The objective function: `{ filled, skipped, fairness, burnout, violations }`. | pure |
| `rulesEngine/solve.ts` → `solve(ctx)` | Construction + chains + local-search improvement. Returns `{ plan, metrics, feasible }`. | pure |
| `rulesEngine/commit.ts` → `commitPlan(sb, plan)` | Batched assignment writes + batched validation. | writes only |
| `rulesEngine/autoGenerate.ts` | Thin orchestrator: load → solve → commit → validate → return. Preserves the existing exported signature and `GenerationResult` shape. | — |

`loadContext.ts` / `evaluate.ts` (the per-assignment *validation* context — distinct from the new generation context) stay, but the site-level shift-types + rule-definitions load is hoisted out and passed in once (M3 fix).

### Data types (sketch)

```ts
interface SolutionPlan {
  assignments: PlannedAssignment[];   // intended (slot, provider) with explanation
  unfilled: UnfilledSlot[];           // slot + per-candidate rejection reasons
}
interface PlannedAssignment {
  slot_id: string; slot_date: string; shift_type_code: string;
  provider_id: string; provider_name: string;
  explanation: AssignmentExplanation;
}
type RejectionReason =
  | 'group-mismatch' | 'same-date' | 'cross-site' | 'weekday-unavailable'
  | 'post-call-guard' | 'bucket-quota' | 'credential'
  | 'weekend-adjacent-pto' | 'availability-blocked';
interface AssignmentExplanation {
  reason: 'lowest-ratio' | 'pre-pto-thursday' | 'weekend-chain'
        | 'd-chain' | 'relief-order' | 'repair-eviction' | 'fairness-swap';
  detail?: string;
  ratioAtAssignment?: number; daysSinceLastCall?: number; competingCandidates?: number;
}
```

## 4. The canonical eligibility predicate

Extract one `evaluateEligibility` containing the full gate currently in `isEligible` (group match, same-date conflict, cross-site conflict, weekday availability, C1 post-call guard, bucket quota, site credentials, Sat/Sun adjacent-week PTO exclusion, availability-with-bookend). It returns a typed `RejectionReason` on the first failing gate. **Every** placement path routes through it:

- Main construction loop (today: `isEligible`).
- D-chain `tryFill` (today: ad-hoc `handledSlotIds` / `isAssignedOnDate` / `crossSiteByDate` checks only).
- Weekend `chainAssign` (today: **bypasses** → H1).
- D4–D9 `isAvailableForReliefDay` (today: raw availability, **no bookend** → H2).

Structural placements (D-chains, weekend chain, relief) legitimately ignore *some* gates (e.g. a D-shift isn't a call shift, so the bucket quota doesn't apply). The predicate takes a parameter describing which gate-set applies (`'call'` vs `'relief'`/`'derived'`), so the canonical logic is shared without forcing inappropriate gates. The key change: weekend-chain **call** slots get the call gate-set (closing H1), and relief gets the PTO-bookend-aware availability check (closing H2).

## 5. The Solve phase (the optimization)

Order is chosen so structural invariants stay intact:

1. **Pre-PTO Thursday** pass — unchanged logic, via the canonical predicate; records `pre-pto-thursday` explanation.
2. **Construct call assignment** in the *existing structurally-required order* (weekends before Friday before weekday; within a date, C2/C3 before C1). **This ordering is load-bearing for the Paoli weekend chain and is NOT changed.** Pick lowest-lifetime-ratio + most-days-since-last-call, with a new **final stable tiebreak by `provider.id`** (M5 fix).
3. **Local-search improvement pass** over *non-chain weekday/Friday call slots only* (the bulk of slots and where skips occur):
   - **Eviction / augmenting move:** for an unfilled slot U, find provider P eligible for U but currently assigned to slot S that another eligible provider Q could cover; apply P→U, Q→S. Directly removes skips greedy can't. Depth-limited to chains of length ≤ 2.
   - **Fairness swap:** reassign a slot from an over-allocated provider to an under-allocated eligible provider when it strictly lowers fairness variance without creating a skip or violation.
   - **Hill-climbing, deterministic:** accept only strictly-improving moves; fixed iteration order (sorted by slot date/code then provider id); **no RNG**. Bounded by a max-iteration / time budget.
   - Weekend-chain slots are excluded from v1 improvement (tightly coupled, rarely the skip source). Noted as a future extension.
4. **Derive D-chains, weekend chains, D4–D9 relief** from the *final* call assignment, all via the canonical predicate. Because optimization runs on the call layer *before* D-shifts are derived, moves stay cheap and chain-safe.

**Objective:** `J = w_skip·skipped + w_fair·fairnessVariance + w_burn·burnout`, weights `w_skip ≫ w_fair > w_burn` (filling slots dominates). `fairnessVariance` is defined as the **population standard deviation of per-provider lifetime bucket-ratios** (`lifetime_assignments / fte_value`, per bucket, averaged across buckets) — chosen over Gini for simplicity and because it directly penalizes the outliers local search should fix; a Gini variant is a possible later refinement, not part of this scope. `burnout` = count of short-gap / back-to-back call placements (gap below a named threshold). Weights are named constants, tunable against seeded data.

## 6. Performance

- **Batched commit:** Solve emits the full plan in memory; `commitPlan` performs two bulk calls — one bulk `insert` for new assignment rows, one bulk `upsert` (by id) for existing open rows — replacing the per-assignment serial `await`s. Single biggest runtime win.
- **Validation N+1 fix (M3):** hoist the per-site shift-types + rule-definitions load out of `loadContext` into a single load, passed into `evaluateAssignment`. Validation stays batched/parallel but does far fewer queries.
- **Determinism (M5):** add `.order('id')` to the provider and slot queries; final tiebreak by `provider.id`; no RNG in local search.

## 7. Explainability

- **Per assignment:** persist `explanation` to a new **nullable `generation_metadata jsonb`** column on `assignments` (additive migration; the commit path no-ops gracefully if the column is absent, matching the existing `sites.call_par_level` fallback pattern). Also returned in the API result.
- **Per unfilled slot:** the canonical predicate yields a rejection reason per provider; for any zero-candidate slot, return `unfilled[].candidates = [{ provider_id, provider_name, reason }]`. No DB row exists for an unfilled slot, so this lives only in the API result.

## 8. Error propagation (C1)

`solve` returns `{ plan, metrics, feasible }`. The orchestrator and `generate` route distinguish:

- **Hard failure** (no slots in version / empty pool / load error) → `4xx`/`5xx` with message.
- **Partial fill** (some unfilled slots, with reasons) → `200` — a legitimate result, not a crash.
- **Commit / validation DB error** → `5xx`, surfaced (not swallowed).

The day-shift pass's errors are surfaced the same way rather than silently merged.

## 9. Testing

- **Pure unit tests** (`solve.test.ts`, `metrics.test.ts`, `eligibility.test.ts`) over synthetic in-memory `GenerationContext` fixtures — **no DB**. Cases: basic fill; part-timer cross-block fairness (deficit carryforward); PTO bookend; Sat/Sun adjacent-week PTO exclusion; weekend chain; C1 post-call guard; eviction move reduces skips; fairness swap lowers variance; **determinism** (same input twice → identical output).
- **Golden-master:** snapshot the current engine's output on a representative fixture. Assert:
  - **Phase 1:** refactored Load/Solve/Commit produces the *same* assignments (behavior parity).
  - **Phase 2:** local search produces **never more skips and never worse fairness** than the Phase-1 baseline.
- Run via the existing `vitest` setup (`npm test`). Extends `src/lib/rulesEngine/shared.test.ts`.

## 10. Migration

One additive migration: `ALTER TABLE scheduling.assignments ADD COLUMN generation_metadata jsonb` (nullable). Commit path writes it when present, no-ops when absent. No destructive changes. (The pending `20260524000000_add_assignment_unique_constraints.sql` in the working tree is complementary and assumed to land independently.)

## 11. Rollout / safety

- **Behavior parity is the Phase-1 bar** — golden-master enforces "no surprises."
- **Feature flag** the local-search pass (an `AutoGenerateOptions` flag, default on) so it can be toggled off to fall back to pure construction.
- No change to the exported `autoGenerate` signature or `GenerationResult` shape beyond *additive* fields (`unfilled[].candidates`, `assignments[].explanation`, richer `perf`).

## 12. Phasing (two review checkpoints)

- **Phase 1 — Refactor + canonical predicate + batched writes + N+1 fix + determinism + error propagation + parity tests.** Same schedules, but fast, testable, deterministic, with the bypass holes (H1/H2) closed and honest errors (C1). Delivers "faster + more accurate."
- **Phase 2 — Metrics + local-search improvement + explainability.** Delivers "more powerful": fewer skips, tighter fairness, explainable — proven by the metrics harness against the Phase-1 baseline.

Each phase ends with green tests and is independently valuable.

## 13. Explicit design decisions (defaults, flagged for review)

- Construction ordering is unchanged (load-bearing for the weekend chain); all optimization comes from the improvement pass.
- Weekend-chain slots are excluded from the v1 improvement pass.
- Phase-1 behavior parity is mandatory; the golden-master is the safety net.
- Explainability is in scope (chosen during brainstorming).
- CRNA scheduling, better-than-local-search solvers (min-cost flow / ILP), and rolling-window fairness are explicitly **out of scope** — the architecture leaves room to swap the Solve internals later (min-cost flow as a future seed for construction).
