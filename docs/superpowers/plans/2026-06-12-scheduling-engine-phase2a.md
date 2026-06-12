# Scheduling Engine — Phase 2a (Explainability + Metrics) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the call-schedule generator *explain itself* — record why each provider got each slot and why each unfilled slot couldn't be filled — and add a pure metrics harness (`scoreSolution`) that quantifies a schedule's quality (fairness, skips, burnout), all additively and with no change to which assignments are produced.

**Architecture:** Phase 1 left a clean pure pipeline (Load → Solve → Commit → Validate) where `solve()` already records a `source` per assignment and the canonical `evaluateEligibility` already returns a typed `RejectionReason`. Phase 2a (a) enriches each `PlannedAssignment` with an `explanation` (ratio/recency/competing-candidates at decision time), (b) attaches per-candidate rejection reasons to each `UnfilledSlot`, (c) adds a pure `metrics.ts` `scoreSolution(plan, ctx)`, (d) persists explanations to a new additive `generation_metadata jsonb` column (graceful no-op if absent), and (e) surfaces explanations + metrics in the generate API result. This is the measurement + transparency layer that Phase 2b's local-search optimizer will consume. No assignment logic changes.

**Tech Stack:** TypeScript (strict), Next.js 14 App Router, Supabase JS (PostgREST), Vitest (`npm test`). One additive SQL migration (applied by the user, not by the agent).

**Scope note:** This is Phase 2a of the approved optimization design (`docs/superpowers/specs/2026-06-11-scheduling-engine-optimization-design.md`, §5/§7/§9, and the §14 as-built notes). Phase 2b (local-search optimization built on this metrics harness) is a SEPARATE later plan. Surfacing explanations/metrics in the schedules **UI** is also out of scope here — 2a makes the data available via the API + DB; a UI task can consume it later.

---

## File Structure

**New files:**
- `src/lib/rulesEngine/metrics.ts` — pure `scoreSolution(plan, ctx): SolutionMetrics`.
- `src/lib/rulesEngine/metrics.test.ts` — tests for the metrics math.
- `supabase/migrations/20260612000000_add_assignment_generation_metadata.sql` — additive `generation_metadata jsonb` column.

**Modified files:**
- `src/lib/rulesEngine/genTypes.ts` — add `AssignmentExplanation`, `CandidateRejection`, `SolutionMetrics`; add `explanation?` to `PlannedAssignment`; add `candidates` to `UnfilledSlot`.
- `src/lib/rulesEngine/solve.ts` — `record()` takes an optional explanation; main-loop populates it; unfilled slots get per-candidate rejection reasons.
- `src/lib/rulesEngine/solve.test.ts` — assertions for explanation + unfilled candidates.
- `src/lib/rulesEngine/commit.ts` — best-effort `generation_metadata` write (column-existence probe); export the probe.
- `src/lib/rulesEngine/commit.test.ts` — test the metadata row-building helper.
- `src/lib/rulesEngine/autoGenerate.ts` — compute `scoreSolution`, surface `metrics` + per-assignment `explanation` + `unfilled.candidates` in `GenerationResult`; wire the metadata write.

---

## Task 1: New explainability + metrics types

Add the types Phase 2a introduces. `PlannedAssignment` keeps its existing `source` field (nothing reads it yet, but it's the placement category); we ADD an optional `explanation` for the richer detail, and add per-candidate rejection info to `UnfilledSlot`.

**Files:**
- Modify: `src/lib/rulesEngine/genTypes.ts`
- Test: `src/lib/rulesEngine/genContext.test.ts` (a tiny type-smoke test; this file already exists)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/rulesEngine/genContext.test.ts`:

```ts
import type {
  AssignmentExplanation, CandidateRejection, SolutionMetrics,
} from './genTypes';

describe('phase 2a types', () => {
  it('AssignmentExplanation / CandidateRejection / SolutionMetrics are constructible', () => {
    const e: AssignmentExplanation = {
      ratioAtAssignment: 1.5, daysSinceLastCall: 7, competingCandidates: 3,
    };
    const c: CandidateRejection = {
      provider_id: 'p1', provider_name: 'DOCA', reason: 'bucket-quota',
    };
    const m: SolutionMetrics = {
      filled: 10, skipped: 1, fairnessStdev: 0.25, burnout: 0, providersUsed: 4,
    };
    expect(e.competingCandidates).toBe(3);
    expect(c.reason).toBe('bucket-quota');
    expect(m.fairnessStdev).toBeCloseTo(0.25);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- genContext`
Expected: FAIL — `AssignmentExplanation` (etc.) not exported from `./genTypes`.

- [ ] **Step 3: Add the types**

In `src/lib/rulesEngine/genTypes.ts`, add these exports (after the existing `RejectionReason` / `PlacementSource` declarations):

```ts
// Richer "why this assignment" detail, captured at decision time. The
// PlacementSource (main-loop / d-chain / weekend-chain / …) stays on
// PlannedAssignment.source; this holds the numeric detail that only the
// main-loop scoring path has.
export interface AssignmentExplanation {
  ratioAtAssignment?: number;       // lifetime bucket-ratio of the chosen provider
  daysSinceLastCall?: number | null; // null when they had no prior call (was Infinity)
  competingCandidates?: number;      // how many providers were eligible for this slot
}

// One provider's reason for being ineligible for a slot that ended up unfilled.
export interface CandidateRejection {
  provider_id: string;
  provider_name: string;
  reason: RejectionReason;
}

// Quantified quality of a SolutionPlan. The objective Phase 2b minimizes.
export interface SolutionMetrics {
  filled: number;          // assignments made
  skipped: number;         // call slots left unfilled
  fairnessStdev: number;   // population stdev of per-provider call ratio (load / fte)
  burnout: number;         // count of too-tight call spacings (see metrics.ts)
  providersUsed: number;   // distinct providers who received >= 1 call this block
}
```

Then modify the existing `PlannedAssignment` interface to add the optional explanation, and the existing `UnfilledSlot` interface to add candidates:

```ts
export interface PlannedAssignment {
  slot_id: string;
  slot_date: string;
  shift_type_code: string;
  shift_type_category: string;
  derived_day_type: string;
  provider_id: string;
  provider_name: string;
  existing_assignment_id: string | null;
  source: PlacementSource;
  explanation?: AssignmentExplanation;   // NEW (main-loop populates; structural omits)
}

export interface UnfilledSlot {
  slot_id: string;
  slot_date: string;
  shift_type_code: string;
  reason: string;
  candidates?: CandidateRejection[];      // NEW (per-provider "why not")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- genContext`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/genTypes.ts src/lib/rulesEngine/genContext.test.ts
git commit -m "Add Phase 2a explainability + metrics types"
```

---

## Task 2: Populate explanations + unfilled candidate reasons in solve()

`solve.ts` already computes `ratio`, `recency`, and the candidate list in the main loop — we just capture them. For unfilled call slots we re-run the canonical predicate over all providers to collect typed reasons. Structural placements (chains/weekend/relief/pre-PTO) keep `source` only (no numeric detail). **No change to which assignments are produced.**

**Files:**
- Modify: `src/lib/rulesEngine/solve.ts`
- Test: `src/lib/rulesEngine/solve.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/rulesEngine/solve.test.ts` (reuse the existing `prov`/`callSlot`/`buildCtx` helpers already in the file):

```ts
describe('solve — explainability (Phase 2a)', () => {
  it('records an explanation with competing-candidate count on a main-loop pick', () => {
    const slots = [callSlot('s1', '2026-01-07', 'C1')];
    const plan = solve(buildCtx(slots, [prov('pA'), prov('pB')]));
    const a = plan.assignments.find(x => x.slot_id === 's1');
    expect(a?.source).toBe('main-loop');
    expect(a?.explanation).toBeDefined();
    expect(a?.explanation?.competingCandidates).toBe(2);
    // first call for both providers -> no prior call -> daysSinceLastCall null
    expect(a?.explanation?.daysSinceLastCall).toBeNull();
    expect(typeof a?.explanation?.ratioAtAssignment).toBe('number');
  });

  it('attaches per-candidate rejection reasons to an unfilled slot', () => {
    const slots = [callSlot('s1', '2026-01-07', 'C1')];
    // single provider, but make them a CRNA so the physician slot rejects them
    const ctx = buildCtx(slots, [{ ...prov('p1'), provider_type: 'crna' }]);
    const plan = solve(ctx);
    expect(plan.assignments).toHaveLength(0);
    const u = plan.unfilled.find(x => x.slot_id === 's1');
    expect(u?.candidates).toBeDefined();
    expect(u?.candidates).toHaveLength(1);
    expect(u?.candidates?.[0]).toEqual({
      provider_id: 'p1', provider_name: 'p1', reason: 'group-mismatch',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- solve`
Expected: FAIL — `explanation` is undefined and `unfilled[].candidates` is undefined.

- [ ] **Step 3: Implement**

In `src/lib/rulesEngine/solve.ts`:

(a) Add `AssignmentExplanation` and `CandidateRejection` to the type import from `./genTypes`:

```ts
import type {
  GenerationContext, SlotToFill, CandidateProvider, SolveState,
  SolutionPlan, PlacementSource, AssignmentExplanation, CandidateRejection,
} from './genTypes';
```

(b) Change `record` to accept an optional explanation and store it:

```ts
  const record = (
    slot: SlotToFill, p: CandidateProvider, source: PlacementSource,
    explanation?: AssignmentExplanation,
  ) => {
    markAssigned(state, slot.slot_date, p.id);
    if (slot.shift_type_category === 'call') {
      incBucket(state, p.id, slot.derived_day_type, slot.shift_type_code);
    }
    if (['C1', 'C2', 'C3'].includes(slot.shift_type_code)) {
      addCallDate(state, p.id, slot.slot_date);
    }
    state.handledSlotIds.add(slot.slot_id);
    plan.assignments.push({
      slot_id: slot.slot_id, slot_date: slot.slot_date,
      shift_type_code: slot.shift_type_code,
      shift_type_category: slot.shift_type_category,
      derived_day_type: slot.derived_day_type,
      provider_id: p.id, provider_name: p.short_display_name,
      existing_assignment_id: slot.existing_assignment_id, source, explanation,
    });
  };
```

(c) In the main construction loop, replace the unfilled-push block and the winning `record(...)` call. Find:

```ts
    if (candidates.length === 0) {
      plan.unfilled.push({
        slot_id: slot.slot_id, slot_date: slot.slot_date,
        shift_type_code: slot.shift_type_code, reason: 'No eligible providers',
      });
      continue;
    }
```

Replace with (collect typed reasons for every provider — cheap, only for unfilled slots):

```ts
    if (candidates.length === 0) {
      const candidateReasons: CandidateRejection[] = ctx.providers.map(p => {
        const r = evaluateEligibility(slot, p, state, ctx, 'call');
        return {
          provider_id: p.id, provider_name: p.short_display_name,
          reason: r.reason ?? 'group-mismatch',
        };
      });
      plan.unfilled.push({
        slot_id: slot.slot_id, slot_date: slot.slot_date,
        shift_type_code: slot.shift_type_code,
        reason: 'No eligible providers', candidates: candidateReasons,
      });
      continue;
    }
```

Then find the winning placement:

```ts
    record(slot, scored[0].p, 'main-loop');
    chainDFills(slot, scored[0].p);
```

Replace the `record(...)` line (keep the `chainDFills` line unchanged) with one that passes the captured detail. The `scored[0]` object already holds `ratio` and `recency`:

```ts
    const winner = scored[0];
    record(slot, winner.p, 'main-loop', {
      ratioAtAssignment: winner.ratio,
      daysSinceLastCall: Number.isFinite(winner.recency) ? winner.recency : null,
      competingCandidates: candidates.length,
    });
    chainDFills(slot, winner.p);
```

(d) The weekend block reads `scored[0].p` as `chosen` (`const chosen = scored[0].p;`) — that line is unaffected; leave it. Structural `record(...)` calls (chains, weekend, relief, pre-PTO) keep their current 3-arg form (no explanation) — they are correct as-is.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- solve`
Expected: PASS (all existing solve tests + the 2 new explainability tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/solve.ts src/lib/rulesEngine/solve.test.ts
git commit -m "Capture assignment explanations + unfilled candidate reasons in solve"
```

---

## Task 3: `metrics.ts` — pure `scoreSolution`

The quality yardstick. Pure function over a `SolutionPlan` + `GenerationContext`. Defines fairness as the population standard deviation of each pool provider's **lifetime call ratio** (`(historical + this-block) call count / fte`) — matching the engine's lifetime-ratio scoring objective — and burnout as the count of too-tight call spacings within this block.

**Files:**
- Create: `src/lib/rulesEngine/metrics.ts`
- Test: `src/lib/rulesEngine/metrics.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/rulesEngine/metrics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { scoreSolution } from './metrics';
import type {
  GenerationContext, CandidateProvider, SolutionPlan, PlannedAssignment,
} from './genTypes';

function prov(id: string, fte = 1): CandidateProvider {
  return {
    id, provider_type: 'physician', short_display_name: id, fte_value: fte,
    home_site_id: 'site1', available_weekdays: [true, true, true, true, true, true, true],
  };
}
function callA(over: Partial<PlannedAssignment>): PlannedAssignment {
  return {
    slot_id: 's', slot_date: '2026-01-07', shift_type_code: 'C1',
    shift_type_category: 'call', derived_day_type: 'weekday',
    provider_id: 'pA', provider_name: 'pA',
    existing_assignment_id: null, source: 'main-loop', ...over,
  };
}
function ctx(providers: CandidateProvider[],
            historical: Map<string, Map<string, number>> = new Map()): GenerationContext {
  return {
    scheduleVersionId: 'v1', siteId: 'site1', parLevel: 12,
    slotsToFill: [], slotIndex: new Map(), providers,
    credByPid: new Map(), availByPid: new Map(), crossSiteByDate: new Map(),
    historicalAssignedByPid: historical, historicalTotalByBucket: new Map(),
    bucketTotals: new Map(), bucketTarget: new Map(), seedAssignments: [],
  };
}

describe('scoreSolution', () => {
  it('counts filled and skipped', () => {
    const plan: SolutionPlan = {
      assignments: [callA({ slot_id: 'a', provider_id: 'pA' })],
      unfilled: [{ slot_id: 'b', slot_date: '2026-01-08', shift_type_code: 'C1', reason: 'x' }],
    };
    const m = scoreSolution(plan, ctx([prov('pA'), prov('pB')]));
    expect(m.filled).toBe(1);
    expect(m.skipped).toBe(1);
    expect(m.providersUsed).toBe(1);
  });

  it('fairnessStdev is 0 when equal-FTE providers carry equal call load', () => {
    const plan: SolutionPlan = {
      assignments: [
        callA({ slot_id: 'a', slot_date: '2026-01-07', provider_id: 'pA' }),
        callA({ slot_id: 'b', slot_date: '2026-01-14', provider_id: 'pB' }),
      ],
      unfilled: [],
    };
    const m = scoreSolution(plan, ctx([prov('pA'), prov('pB')]));
    expect(m.fairnessStdev).toBeCloseTo(0);
  });

  it('fairnessStdev is positive when one provider carries all the load', () => {
    const plan: SolutionPlan = {
      assignments: [
        callA({ slot_id: 'a', slot_date: '2026-01-07', provider_id: 'pA' }),
        callA({ slot_id: 'b', slot_date: '2026-01-14', provider_id: 'pA' }),
      ],
      unfilled: [],
    };
    const m = scoreSolution(plan, ctx([prov('pA'), prov('pB')]));
    expect(m.fairnessStdev).toBeGreaterThan(0);
  });

  it('folds historical counts into the lifetime ratio', () => {
    // pB has 2 historical calls; pA has none. Give pA 2 this block -> equal lifetime.
    const hist = new Map([['pB', new Map([['weekday|C1', 2]])]]);
    const plan: SolutionPlan = {
      assignments: [
        callA({ slot_id: 'a', slot_date: '2026-01-07', provider_id: 'pA' }),
        callA({ slot_id: 'b', slot_date: '2026-01-14', provider_id: 'pA' }),
      ],
      unfilled: [],
    };
    const m = scoreSolution(plan, ctx([prov('pA'), prov('pB')], hist));
    expect(m.fairnessStdev).toBeCloseTo(0); // both at lifetime 2
  });

  it('counts a burnout when one provider has two weekday calls one day apart', () => {
    // Mon 2026-01-05 and Tue 2026-01-06, both pA, both weekday -> 1 burnout.
    const plan: SolutionPlan = {
      assignments: [
        callA({ slot_id: 'a', slot_date: '2026-01-05', provider_id: 'pA' }),
        callA({ slot_id: 'b', slot_date: '2026-01-06', provider_id: 'pA' }),
      ],
      unfilled: [],
    };
    const m = scoreSolution(plan, ctx([prov('pA')]));
    expect(m.burnout).toBe(1);
  });

  it('does NOT count a weekend Sat/Sun pair as burnout', () => {
    // Sat 2026-01-03 + Sun 2026-01-04 is the intended weekend chain, not burnout.
    const plan: SolutionPlan = {
      assignments: [
        callA({ slot_id: 'a', slot_date: '2026-01-03', derived_day_type: 'saturday', provider_id: 'pA' }),
        callA({ slot_id: 'b', slot_date: '2026-01-04', derived_day_type: 'sunday', provider_id: 'pA' }),
      ],
      unfilled: [],
    };
    const m = scoreSolution(plan, ctx([prov('pA')]));
    expect(m.burnout).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- metrics`
Expected: FAIL — cannot find module `./metrics`.

- [ ] **Step 3: Implement `metrics.ts`**

Create `src/lib/rulesEngine/metrics.ts`:

```ts
import { daysBetween } from './shared';
import type { GenerationContext, SolutionPlan, SolutionMetrics } from './genTypes';

const CALL_CODES = ['C1', 'C2', 'C3'];
// Two call dates closer than this (in days) count as a burnout, UNLESS both
// fall on a weekend (the intended Sat/Sun weekend chain is adjacent by design).
const BURNOUT_MIN_GAP_DAYS = 2;
const WEEKEND_DAY_TYPES = new Set(['saturday', 'sunday']);

// Sum a provider's historical call count across all buckets.
function historicalCallTotal(ctx: GenerationContext, pid: string): number {
  const byBucket = ctx.historicalAssignedByPid.get(pid);
  if (!byBucket) return 0;
  let total = 0;
  for (const n of byBucket.values()) total += n;
  return total;
}

function populationStdev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(variance);
}

// Pure quality score for a solved schedule. Used as a report today and as the
// objective Phase 2b's local search minimizes.
export function scoreSolution(plan: SolutionPlan, ctx: GenerationContext): SolutionMetrics {
  const filled = plan.assignments.length;
  const skipped = plan.unfilled.length;

  // This-block call counts + call dates per provider.
  const blockCallCount = new Map<string, number>();
  const callDates = new Map<string, Array<{ date: string; weekend: boolean }>>();
  for (const a of plan.assignments) {
    if (!CALL_CODES.includes(a.shift_type_code)) continue;
    blockCallCount.set(a.provider_id, (blockCallCount.get(a.provider_id) || 0) + 1);
    const list = callDates.get(a.provider_id) || [];
    list.push({ date: a.slot_date, weekend: WEEKEND_DAY_TYPES.has(a.derived_day_type) });
    callDates.set(a.provider_id, list);
  }

  // Fairness: stdev over the pool of lifetime ratio = (historical + block) / fte.
  const ratios: number[] = [];
  for (const p of ctx.providers) {
    const lifetime = historicalCallTotal(ctx, p.id) + (blockCallCount.get(p.id) || 0);
    ratios.push(lifetime / Math.max(p.fte_value, 0.01));
  }
  const fairnessStdev = populationStdev(ratios);

  // Burnout: per provider, count adjacent (date-sorted) call pairs spaced
  // < BURNOUT_MIN_GAP_DAYS apart that are NOT a weekend pair.
  let burnout = 0;
  for (const list of callDates.values()) {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < sorted.length; i++) {
      const gap = daysBetween(sorted[i - 1].date, sorted[i].date);
      if (gap < BURNOUT_MIN_GAP_DAYS && !(sorted[i - 1].weekend && sorted[i].weekend)) {
        burnout++;
      }
    }
  }

  return {
    filled,
    skipped,
    fairnessStdev,
    burnout,
    providersUsed: blockCallCount.size,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- metrics`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/metrics.ts src/lib/rulesEngine/metrics.test.ts
git commit -m "Add pure scoreSolution metrics harness (fairness/skips/burnout)"
```

---

## Task 4: Additive `generation_metadata` migration

A single nullable jsonb column. The agent writes the migration file ONLY; the user applies it to their database. Code in Task 5 writes to it best-effort and no-ops gracefully if it's absent.

**Files:**
- Create: `supabase/migrations/20260612000000_add_assignment_generation_metadata.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260612000000_add_assignment_generation_metadata.sql`:

```sql
-- Phase 2a: per-assignment generation explainability.
-- Additive + nullable. Holds { source, ratioAtAssignment?, daysSinceLastCall?,
-- competingCandidates? } written by the auto-generator. Safe to apply anytime;
-- the app writes it best-effort and no-ops if the column is absent.
ALTER TABLE scheduling.assignments
  ADD COLUMN IF NOT EXISTS generation_metadata jsonb;
```

- [ ] **Step 2: Verify it parses (no DB apply)**

Run: `test -f supabase/migrations/20260612000000_add_assignment_generation_metadata.sql && grep -q "generation_metadata" supabase/migrations/20260612000000_add_assignment_generation_metadata.sql && echo OK`
Expected: `OK`. (Do NOT apply to the database — the user applies it. There is no test runner for SQL here.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260612000000_add_assignment_generation_metadata.sql
git commit -m "Add additive generation_metadata jsonb migration"
```

---

## Task 5: Best-effort metadata write + probe in commit.ts

Persist each assignment's explanation to `generation_metadata`, but only if the column exists. A pure `buildMetadataUpdate` helper builds the per-assignment `{ source, ...explanation }` payload (unit-tested); a `columnExists` probe checks the schema once; `commitMetadata` writes in batches and is best-effort (a missing column or any error is non-fatal).

**Files:**
- Modify: `src/lib/rulesEngine/commit.ts`
- Test: `src/lib/rulesEngine/commit.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/rulesEngine/commit.test.ts`:

```ts
import { buildMetadataPayload } from './commit';
import type { PlannedAssignment } from './genTypes';

function pa(over: Partial<PlannedAssignment>): PlannedAssignment {
  return {
    slot_id: 's', slot_date: '2026-01-07', shift_type_code: 'C1',
    shift_type_category: 'call', derived_day_type: 'weekday',
    provider_id: 'p1', provider_name: 'P1',
    existing_assignment_id: null, source: 'main-loop', ...over,
  };
}

describe('buildMetadataPayload', () => {
  it('folds source + explanation into one jsonb payload', () => {
    const payload = buildMetadataPayload(pa({
      source: 'main-loop',
      explanation: { ratioAtAssignment: 1.5, daysSinceLastCall: 7, competingCandidates: 3 },
    }));
    expect(payload).toEqual({
      source: 'main-loop',
      ratioAtAssignment: 1.5, daysSinceLastCall: 7, competingCandidates: 3,
    });
  });

  it('handles a structural assignment with no explanation', () => {
    const payload = buildMetadataPayload(pa({ source: 'd-chain', explanation: undefined }));
    expect(payload).toEqual({ source: 'd-chain' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- commit`
Expected: FAIL — `buildMetadataPayload` not exported.

- [ ] **Step 3: Implement**

In `src/lib/rulesEngine/commit.ts`:

(a) Add the import for the type:

```ts
import type { SolutionPlan, PlannedAssignment } from './genTypes';
```
(if `PlannedAssignment` is not already imported there — `SolutionPlan` already is; add `PlannedAssignment`).

(b) Add the pure payload builder:

```ts
// Pure: fold source + explanation detail into the jsonb stored on the row.
export function buildMetadataPayload(a: PlannedAssignment): Record<string, unknown> {
  return { source: a.source, ...(a.explanation ?? {}) };
}
```

(c) Add a one-shot column-existence probe:

```ts
// Cheap probe: does scheduling.assignments have the generation_metadata column?
// Mirrors the call_par_level graceful-fallback pattern. Returns false on any error.
export async function hasGenerationMetadataColumn(sb: SupabaseClient): Promise<boolean> {
  const { error } = await sb.from('assignments').select('generation_metadata').limit(1);
  return !error;
}
```

(d) Add the best-effort batched metadata writer:

```ts
// Best-effort: write generation_metadata per assignment. Caller should only
// invoke this when hasGenerationMetadataColumn() is true. Batched updates,
// keyed by (schedule_slot_id, provider_id) like the validation pass.
export async function commitMetadata(
  sb: SupabaseClient,
  assignments: PlannedAssignment[],
): Promise<{ dbQueries: number; errors: string[] }> {
  const errors: string[] = [];
  let dbQueries = 0;
  const CONCURRENCY = 10;
  for (let i = 0; i < assignments.length; i += CONCURRENCY) {
    const batch = assignments.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async a => {
      dbQueries++;
      const { error } = await sb.from('assignments')
        .update({ generation_metadata: buildMetadataPayload(a) })
        .eq('schedule_slot_id', a.slot_id)
        .eq('provider_id', a.provider_id);
      if (error) errors.push(`metadata write failed for slot ${a.slot_id}: ${error.message}`);
    }));
  }
  return { dbQueries, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- commit`
Expected: PASS (existing `partitionForWrite` tests + the 2 new `buildMetadataPayload` tests).
Also run: `npx tsc --noEmit 2>&1 | grep -E "commit\.ts" || echo "no commit type errors"`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/commit.ts src/lib/rulesEngine/commit.test.ts
git commit -m "Add best-effort generation_metadata write + column probe to commit"
```

---

## Task 6: Surface metrics + explanations in the orchestrator

Wire it together: compute `scoreSolution`, write metadata best-effort (only if the column exists), and extend `GenerationResult` with `metrics` plus per-assignment `explanation` and the already-present `unfilled.candidates`. All additive — existing UI ignores unknown fields.

**Files:**
- Modify: `src/lib/rulesEngine/autoGenerate.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/rulesEngine/autoGenerate.test.ts` (tests only the pure result-shaping helper added in Step 3 — the full pipeline needs a DB and is covered by the manual smoke):

```ts
import { describe, it, expect } from 'vitest';
import { toResultAssignment } from './autoGenerate';
import type { PlannedAssignment } from './genTypes';

describe('toResultAssignment', () => {
  it('maps a planned assignment to the API shape including explanation + source', () => {
    const pa: PlannedAssignment = {
      slot_id: 's1', slot_date: '2026-01-07', shift_type_code: 'C1',
      shift_type_category: 'call', derived_day_type: 'weekday',
      provider_id: 'p1', provider_name: 'DOCA', existing_assignment_id: null,
      source: 'main-loop',
      explanation: { ratioAtAssignment: 1.5, daysSinceLastCall: 7, competingCandidates: 3 },
    };
    expect(toResultAssignment(pa)).toEqual({
      slot_id: 's1', slot_date: '2026-01-07', shift_type_code: 'C1',
      provider_id: 'p1', provider_name: 'DOCA',
      source: 'main-loop',
      explanation: { ratioAtAssignment: 1.5, daysSinceLastCall: 7, competingCandidates: 3 },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- autoGenerate`
Expected: FAIL — `toResultAssignment` not exported.

- [ ] **Step 3: Implement**

In `src/lib/rulesEngine/autoGenerate.ts`:

(a) Extend the imports:

```ts
import { commitPlan, commitValidation, commitMetadata, hasGenerationMetadataColumn } from './commit';
import { scoreSolution } from './metrics';
import type { UnfilledSlot, PlannedAssignment, AssignmentExplanation, SolutionMetrics, PlacementSource } from './genTypes';
```

(b) Extend the `GenerationResult` interface: change the `assignments` element type and add `metrics`:

```ts
export interface GenerationResult {
  filled: number;
  skipped: number;
  errors: string[];
  assignments: Array<{
    slot_id: string; slot_date: string; shift_type_code: string;
    provider_id: string; provider_name: string;
    source: PlacementSource;
    explanation?: AssignmentExplanation;
  }>;
  unfilled: UnfilledSlot[];
  ok: boolean;
  metrics?: SolutionMetrics;
  perf?: {
    par_level: number; total_slots: number; call_slots: number;
    providers: number; elapsed_ms: number; db_queries: number;
  };
}
```

(c) Add the exported pure mapper (replaces the inline `.map` shape):

```ts
// Pure: planned assignment -> the API/UI assignment shape (now includes the
// placement source + explanation for the schedule UI's "why" view).
export function toResultAssignment(a: PlannedAssignment) {
  return {
    slot_id: a.slot_id, slot_date: a.slot_date, shift_type_code: a.shift_type_code,
    provider_id: a.provider_id, provider_name: a.provider_name,
    source: a.source, explanation: a.explanation,
  };
}
```

(d) In the success path, after `commitValidation` and before/within the result mapping, write metadata best-effort and compute metrics. Replace the existing block:

```ts
  // Map plan -> the legacy result shape the UI expects.
  result.filled = commit.filled;
  result.skipped = plan.unfilled.length;
  result.assignments = plan.assignments.map(a => ({
    slot_id: a.slot_id, slot_date: a.slot_date, shift_type_code: a.shift_type_code,
    provider_id: a.provider_id, provider_name: a.provider_name,
  }));
  result.unfilled = plan.unfilled;
  result.ok = true;
  result.perf = {
    par_level: ctx.parLevel,
    total_slots: load.totalSlots,
    call_slots: ctx.slotsToFill.length, // open (unfilled) call slots at generation time
    providers: ctx.providers.length,
    elapsed_ms: Date.now() - t0,
    db_queries: load.dbQueries + commit.dbQueries + validationQueries,
  };
  return result;
```

with:

```ts
  // Persist per-assignment explanations, best-effort + graceful if the column
  // is absent (mirrors the call_par_level fallback). Never flips ok to false.
  let metadataQueries = 0;
  try {
    if (await hasGenerationMetadataColumn(sb)) {
      const meta = await commitMetadata(sb, plan.assignments);
      metadataQueries = meta.dbQueries;
      if (meta.errors.length > 0) {
        result.errors.push(`Some explanation metadata was not saved (${meta.errors.length} rows).`);
      }
    }
  } catch (e: unknown) {
    result.errors.push(
      `Explanation metadata pass failed (assignments were still saved): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Map plan -> the result shape (now with source + explanation per assignment).
  result.filled = commit.filled;
  result.skipped = plan.unfilled.length;
  result.assignments = plan.assignments.map(toResultAssignment);
  result.unfilled = plan.unfilled;
  result.metrics = scoreSolution(plan, ctx);
  result.ok = true;
  result.perf = {
    par_level: ctx.parLevel,
    total_slots: load.totalSlots,
    call_slots: ctx.slotsToFill.length, // open (unfilled) call slots at generation time
    providers: ctx.providers.length,
    elapsed_ms: Date.now() - t0,
    db_queries: load.dbQueries + commit.dbQueries + validationQueries + metadataQueries,
  };
  return result;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- autoGenerate`
Expected: PASS.
Run: `npm test`
Expected: full suite green.
Run: `npx tsc --noEmit`
Expected: clean.
Run: `npm run build`
Expected: production build succeeds (this is the route's transitive dependency; build must pass).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/autoGenerate.ts src/lib/rulesEngine/autoGenerate.test.ts
git commit -m "Surface metrics + per-assignment explanations in generation result; write metadata best-effort"
```

---

## Task 7: Full verification + cleanup

**Files:**
- Verify only.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all pass (Phase 1's 54 + the Phase 2a additions across genContext, solve, metrics, commit, autoGenerate).

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors; production build succeeds.

- [ ] **Step 3: Confirm additivity (no behavior change to assignments)**

Run: `npm test -- solve`
Expected: all existing solve assignment/placement tests still pass unchanged — Phase 2a only *adds* explanation/candidate data, it does not change which provider gets which slot.

- [ ] **Step 4: Report the migration handoff**

Confirm the migration file exists and print its contents for the user to apply:
Run: `cat supabase/migrations/20260612000000_add_assignment_generation_metadata.sql`
Expected: the `ALTER TABLE … ADD COLUMN IF NOT EXISTS generation_metadata jsonb;` statement. Note in the final report that the user must apply this (e.g. via the Supabase SQL editor or `supabase db push`) for explanations to persist; until then the code no-ops gracefully and explanations are still returned in the API response.

- [ ] **Step 5: Commit (only if any verification fix was needed)**

If steps 1–3 required no changes, do not commit. Otherwise:
```bash
git add <fixed files>
git commit -m "Fix verification issues in Phase 2a"
```

---

## Self-Review (completed during planning)

**Spec coverage:**
- §7 explainability — per-assignment reason (Task 2 main-loop explanation + Task 1 types), per-unfilled-slot candidate rejection (Task 2), `generation_metadata jsonb` persistence (Task 4 migration + Task 5 write + Task 6 wiring), returned in API result (Task 6). ✓
- §9 metrics harness `scoreSolution` — Task 3. ✓ (Golden-master snapshot remains deferred to Phase 2b, where it gains a baseline to diff against — consistent with the §14 as-built note.)
- §7 "graceful no-op if column absent" — Task 5 probe + Task 6 best-effort wiring. ✓
- Additive-only / no assignment-logic change — enforced by Task 7 Step 3 (existing solve tests unchanged). ✓
- Phase 2b (local search) — explicitly out of scope; this plan builds only the measurement + transparency layer it needs. ✓

**Placeholder scan:** No TBD/TODO/"add error handling" placeholders; every code step shows complete code; the migration is a concrete one-line DDL.

**Type consistency:** `AssignmentExplanation` (`ratioAtAssignment`/`daysSinceLastCall`/`competingCandidates`), `CandidateRejection` (`provider_id`/`provider_name`/`reason`), `SolutionMetrics` (`filled`/`skipped`/`fairnessStdev`/`burnout`/`providersUsed`) are defined once in Task 1 and used identically in Tasks 2/3/5/6. `buildMetadataPayload`, `commitMetadata`, `hasGenerationMetadataColumn`, `scoreSolution`, `toResultAssignment` signatures are stable across the tasks that reference them. `PlannedAssignment.source` (existing) + `.explanation` (new optional) are used consistently.
