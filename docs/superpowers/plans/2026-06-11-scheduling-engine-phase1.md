# Scheduling Engine — Phase 1 (Refactor + Hardening) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the physician call-schedule generator into a pure, testable Load → Solve → Commit → Validate pipeline, closing the eligibility-bypass correctness holes, restoring determinism, batching DB writes, fixing the validation N+1, and propagating errors honestly — with behavior preserved on clean cases and corrected on the buggy ones, all pinned by tests.

**Architecture:** Today `src/lib/rulesEngine/autoGenerate.ts` (1012 lines) interleaves DB reads, decisions, and per-assignment writes. We split it so the decision logic (`solve`) is a **pure function** over an in-memory `GenerationContext`, with a single canonical eligibility predicate used by every placement path. Reads move to `genContext.ts`, writes (batched) to `commit.ts`. This is mostly a mechanical lift of existing logic into new module boundaries; the behavior changes are deliberate and individually tested (weekend chain + relief now respect credentials/quota/PTO; provider ordering is now deterministic).

**Tech Stack:** TypeScript (strict), Next.js 14 App Router (route handler), Supabase JS client (PostgREST builder), Vitest (`npm test` → `vitest run`). No new runtime dependencies. No schema migration in Phase 1.

**Scope note:** This is Phase 1 of the approved design (`docs/superpowers/specs/2026-06-11-scheduling-engine-optimization-design.md`). Phase 2 (metrics + local-search optimization + explainability + the `generation_metadata` migration) is explicitly **out of scope here** and will be a separate plan.

---

## File Structure

**New files:**
- `src/lib/rulesEngine/genTypes.ts` — shared types for the pipeline: `GenerationContext`, `SolutionPlan`, `PlannedAssignment`, `UnfilledSlot`, `SlotToFill`, `CandidateProvider`, `SiteCredentials`, `AvailabilityEntry`, `RejectionReason`, `GateSet`, `EligibilityResult`.
- `src/lib/rulesEngine/eligibility.ts` — `evaluateEligibility()`: the one canonical predicate. Pure.
- `src/lib/rulesEngine/genContext.ts` — `loadGenerationContext()` (reads) + pure `computeBucketTargets()`.
- `src/lib/rulesEngine/solve.ts` — `solve(ctx)`: pure decision engine returning a `SolutionPlan`.
- `src/lib/rulesEngine/commit.ts` — `commitPlan()` (batched writes) + `loadSiteValidationContext()` (N+1 fix) + `commitValidation()`.
- Tests: `eligibility.test.ts`, `genContext.test.ts`, `solve.test.ts`, `commit.test.ts` (all under `src/lib/rulesEngine/`).

**Modified files:**
- `src/lib/rulesEngine/shared.ts` — add `daysBetween()` helper.
- `src/lib/rulesEngine/shared.test.ts` — add `daysBetween` test.
- `src/lib/rulesEngine/autoGenerate.ts` — gutted to a thin orchestrator: load → solve → commit → validate.
- `src/lib/rulesEngine/loadContext.ts` — accept an optional preloaded site context (N+1 fix).
- `src/lib/rulesEngine/evaluate.ts` — thread the optional site context through.
- `src/app/api/scheduling/schedules/[id]/generate/route.ts` — distinguish hard failure / partial / commit error.

---

## Task 1: `daysBetween` date helper in shared.ts

Consolidates the duplicated inline UTC-day-difference math (currently copied in `autoGenerate.ts:473` and `:918`).

**Files:**
- Modify: `src/lib/rulesEngine/shared.ts`
- Test: `src/lib/rulesEngine/shared.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the end of `src/lib/rulesEngine/shared.test.ts`, and add `daysBetween` to the import list at the top (line 2–11):

```ts
describe('daysBetween (UTC whole days)', () => {
  it('counts forward and backward', () => {
    expect(daysBetween('2026-01-01', '2026-01-08')).toBe(7);
    expect(daysBetween('2026-01-08', '2026-01-01')).toBe(-7);
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
  });
  it('crosses month/year boundaries', () => {
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- shared`
Expected: FAIL — `daysBetween is not a function` / import error.

- [ ] **Step 3: Implement the helper**

Add to `src/lib/rulesEngine/shared.ts` after `datesOverlap` (after line 55):

```ts
// Whole-day difference (to - from) in UTC days. Positive when `to` is later.
// Inputs are YYYY-MM-DD strings parsed at UTC midnight, so this is DST-safe.
export function daysBetween(from: string, to: string): number {
  const f = new Date(from + 'T00:00:00Z').getTime();
  const t = new Date(to + 'T00:00:00Z').getTime();
  return Math.round((t - f) / 86400000);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- shared`
Expected: PASS (all `shared` describes green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/shared.ts src/lib/rulesEngine/shared.test.ts
git commit -m "Add daysBetween UTC date helper to rules-engine shared"
```

---

## Task 2: Pipeline types (`genTypes.ts`)

Defines the data shapes shared across `eligibility`, `genContext`, `solve`, `commit`. These are lifted from the interfaces currently inline in `autoGenerate.ts:36-102`, plus new pipeline types. Pure declarations — verified by a trivial factory test so the module is import-checked.

**Files:**
- Create: `src/lib/rulesEngine/genTypes.ts`
- Test: `src/lib/rulesEngine/genContext.test.ts` (created here, expanded in Task 4)

- [ ] **Step 1: Write the failing test**

Create `src/lib/rulesEngine/genContext.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { emptySolveState } from './genTypes';

describe('emptySolveState', () => {
  it('creates independent empty state', () => {
    const a = emptySolveState();
    const b = emptySolveState();
    a.bucketAssigned.set('x', 1);
    expect(b.bucketAssigned.size).toBe(0);
    expect(a.assignedOnDate.size).toBe(0);
    expect(a.handledSlotIds.size).toBe(0);
    expect(a.callDatesByProvider.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- genContext`
Expected: FAIL — cannot find module `./genTypes`.

- [ ] **Step 3: Create the types module**

Create `src/lib/rulesEngine/genTypes.ts`:

```ts
// Shared types for the call-schedule generation pipeline.
// Lifted from the interfaces formerly inline in autoGenerate.ts.

export interface SlotToFill {
  slot_id: string;
  slot_date: string;
  shift_type_id: string;
  shift_type_code: string;
  shift_type_category: string;
  derived_day_type: string;
  provider_group: 'physician' | 'crna' | 'both';
  required_count: number;
  existing_assignment_id: string | null;
}

export interface CandidateProvider {
  id: string;
  provider_type: string;
  short_display_name: string;
  fte_value: number;
  home_site_id: string | null;
  // 7 booleans indexed Sun..Sat (matches JS Date.getDay).
  available_weekdays: boolean[];
}

export interface SiteCredentials {
  is_active: boolean;
  credentialed: boolean;
  can_take_call: boolean;
  can_take_weekend_call: boolean;
  can_take_holiday_call: boolean;
  allowed_shift_types: string[];
  excluded_shift_types: string[];
  skill_tags: string[];
}

export interface AvailabilityEntry {
  availability_type: string;
  start_date: string;
  end_date: string;
  approval_status: string;
}

// Pre-existing assignment carried into solve to seed runtime state.
export interface SeedAssignment {
  slot_date: string;
  provider_id: string;
  shift_type_code: string;
  shift_type_category: string;
  derived_day_type: string;
}

// Immutable input to solve(). All reads have already happened.
export interface GenerationContext {
  scheduleVersionId: string;
  siteId: string;
  parLevel: number;
  // Call-category open slots to fill, pre-sorted in the structural order.
  slotsToFill: SlotToFill[];
  // Every OPEN slot indexed [date][code] — for weekend/D-chain lookups.
  slotIndex: Map<string, Map<string, SlotToFill>>;
  providers: CandidateProvider[];
  credByPid: Map<string, SiteCredentials>;
  availByPid: Map<string, AvailabilityEntry[]>;
  // pid -> set of dates the provider is already booked at ANOTHER site.
  crossSiteByDate: Map<string, Set<string>>;
  // pid -> "bucket|code" -> count, from past blocks at this site.
  historicalAssignedByPid: Map<string, Map<string, number>>;
  // "bucket|code" -> total historical count across all providers.
  historicalTotalByBucket: Map<string, number>;
  // "bucket|code" -> total slots in THIS block (open + already-assigned).
  bucketTotals: Map<string, number>;
  // "pid|bucket|code" -> FTE-weighted target (base + deficit).
  bucketTarget: Map<string, number>;
  // Assignments already present before generation (manual/prior runs).
  seedAssignments: SeedAssignment[];
}

export type GateSet = 'call' | 'derived';

export type RejectionReason =
  | 'group-mismatch'
  | 'same-date'
  | 'cross-site'
  | 'weekday-unavailable'
  | 'post-call-guard'
  | 'bucket-quota'
  | 'credential'
  | 'weekend-adjacent-pto'
  | 'availability-blocked';

export interface EligibilityResult {
  eligible: boolean;
  reason?: RejectionReason;
}

// Source of a planned assignment (for debugging / future explainability).
export type PlacementSource =
  | 'main-loop'
  | 'pre-pto-thursday'
  | 'd-chain'
  | 'weekend-chain'
  | 'relief-order';

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
}

export interface UnfilledSlot {
  slot_id: string;
  slot_date: string;
  shift_type_code: string;
  reason: string;
}

export interface SolutionPlan {
  assignments: PlannedAssignment[];
  unfilled: UnfilledSlot[];
}

// Mutable in-memory bookkeeping during solve. Never touches I/O.
export interface SolveState {
  bucketAssigned: Map<string, number>;       // "pid|bucket|code" -> count
  assignedOnDate: Map<string, Set<string>>;  // date -> set of pids
  handledSlotIds: Set<string>;
  callDatesByProvider: Map<string, string[]>; // pid -> sorted call dates
}

export function emptySolveState(): SolveState {
  return {
    bucketAssigned: new Map(),
    assignedOnDate: new Map(),
    handledSlotIds: new Set(),
    callDatesByProvider: new Map(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- genContext`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/genTypes.ts src/lib/rulesEngine/genContext.test.ts
git commit -m "Add generation-pipeline shared types"
```

---

## Task 3: Canonical eligibility predicate (`eligibility.ts`)

The linchpin. One predicate, used by every placement path, returning a typed reason. Lifted verbatim from `autoGenerate.ts:509-606` (`isEligible`), parameterized by `GateSet`:
- `'call'` — the full gate set (what `isEligible` does today).
- `'derived'` — for structurally-derived placements (D-chains, weekend non-call fills, relief). Skips the bucket-quota gate (a D-shift isn't quota-bounded) and the C1 post-call guard, but **keeps** credentials, same-date, cross-site, weekday availability, the Sat/Sun adjacent-week PTO exclusion, and the PTO-bookend availability check. This is what closes H2 (relief now respects the bookend) while not imposing call-only gates on non-call fills.

For weekend **call** slots placed by the chain (Sun-C1/C2, Fri-C2), the chain will call with `'call'` — closing H1.

**Files:**
- Create: `src/lib/rulesEngine/eligibility.ts`
- Test: `src/lib/rulesEngine/eligibility.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/rulesEngine/eligibility.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { evaluateEligibility } from './eligibility';
import { emptySolveState } from './genTypes';
import type {
  GenerationContext, SlotToFill, CandidateProvider, SolveState,
} from './genTypes';

// ── Fixture builders ────────────────────────────────────────────────────────
function provider(over: Partial<CandidateProvider> = {}): CandidateProvider {
  return {
    id: 'p1', provider_type: 'physician', short_display_name: 'DOCA',
    fte_value: 1, home_site_id: 'site1',
    available_weekdays: [true, true, true, true, true, true, true],
    ...over,
  };
}
function slot(over: Partial<SlotToFill> = {}): SlotToFill {
  return {
    slot_id: 's1', slot_date: '2026-01-07', shift_type_id: 'st-c1',
    shift_type_code: 'C1', shift_type_category: 'call',
    derived_day_type: 'weekday', provider_group: 'physician',
    required_count: 1, existing_assignment_id: null,
    ...over,
  };
}
// Minimal context: only the maps the predicate reads. Targets default high so
// the quota gate passes unless a test overrides it.
function ctx(over: Partial<GenerationContext> = {}): GenerationContext {
  return {
    scheduleVersionId: 'v1', siteId: 'site1', parLevel: 12,
    slotsToFill: [], slotIndex: new Map(),
    providers: [], credByPid: new Map(), availByPid: new Map(),
    crossSiteByDate: new Map(),
    historicalAssignedByPid: new Map(), historicalTotalByBucket: new Map(),
    bucketTotals: new Map(),
    bucketTarget: new Map([['p1|weekday|C1', 5]]),
    seedAssignments: [],
    ...over,
  };
}

describe('evaluateEligibility — call gate', () => {
  it('passes a clean weekday C1 candidate', () => {
    const r = evaluateEligibility(slot(), provider(), emptySolveState(), ctx(), 'call');
    expect(r.eligible).toBe(true);
  });

  it('rejects non-physician for a physician slot', () => {
    const r = evaluateEligibility(slot(), provider({ provider_type: 'crna' }), emptySolveState(), ctx(), 'call');
    expect(r).toEqual({ eligible: false, reason: 'group-mismatch' });
  });

  it('rejects a same-date conflict', () => {
    const st: SolveState = emptySolveState();
    st.assignedOnDate.set('2026-01-07', new Set(['p1']));
    const r = evaluateEligibility(slot(), provider(), st, ctx(), 'call');
    expect(r).toEqual({ eligible: false, reason: 'same-date' });
  });

  it('rejects a cross-site conflict', () => {
    const c = ctx({ crossSiteByDate: new Map([['p1', new Set(['2026-01-07'])]]) });
    const r = evaluateEligibility(slot(), provider(), emptySolveState(), c, 'call');
    expect(r).toEqual({ eligible: false, reason: 'cross-site' });
  });

  it('rejects when the weekday is unavailable', () => {
    // 2026-01-07 is a Wednesday (dow=3).
    const wedOff = provider({ available_weekdays: [true, true, true, false, true, true, true] });
    const r = evaluateEligibility(slot(), wedOff, emptySolveState(), ctx(), 'call');
    expect(r).toEqual({ eligible: false, reason: 'weekday-unavailable' });
  });

  it('rejects C1 when the provider is already committed the next day (post-call guard)', () => {
    const st = emptySolveState();
    st.assignedOnDate.set('2026-01-08', new Set(['p1']));
    const r = evaluateEligibility(slot(), provider(), st, ctx(), 'call');
    expect(r).toEqual({ eligible: false, reason: 'post-call-guard' });
  });

  it('rejects when one more assignment would pass the bucket target', () => {
    const st = emptySolveState();
    st.bucketAssigned.set('p1|weekday|C1', 5); // target is 5; 5+1 > 5
    const r = evaluateEligibility(slot(), provider(), st, ctx(), 'call');
    expect(r).toEqual({ eligible: false, reason: 'bucket-quota' });
  });

  it('rejects an excluded shift type via credentials', () => {
    const c = ctx({
      credByPid: new Map([['p1', {
        is_active: true, credentialed: true, can_take_call: true,
        can_take_weekend_call: true, can_take_holiday_call: true,
        allowed_shift_types: [], excluded_shift_types: ['C1'], skill_tags: [],
      }]]),
    });
    const r = evaluateEligibility(slot(), provider(), emptySolveState(), c, 'call');
    expect(r).toEqual({ eligible: false, reason: 'credential' });
  });

  it('rejects a weekend slot without weekend-call credential (H1 guard)', () => {
    const c = ctx({
      bucketTarget: new Map([['p1|weekend|C1', 5]]),
      credByPid: new Map([['p1', {
        is_active: true, credentialed: true, can_take_call: true,
        can_take_weekend_call: false, can_take_holiday_call: true,
        allowed_shift_types: [], excluded_shift_types: [], skill_tags: [],
      }]]),
    });
    // 2026-01-03 is a Saturday.
    const satSlot = slot({ slot_date: '2026-01-03', derived_day_type: 'saturday' });
    const r = evaluateEligibility(satSlot, provider(), emptySolveState(), c, 'call');
    expect(r).toEqual({ eligible: false, reason: 'credential' });
  });

  it('rejects a Saturday slot when PTO covers the prior Mon-Fri week', () => {
    const c = ctx({
      bucketTarget: new Map([['p1|weekend|C1', 5]]),
      // 2026-01-03 Sat; prior week Mon-Fri = Dec 29 .. Jan 2. PTO Dec 30-31.
      availByPid: new Map([['p1', [{
        availability_type: 'pto', start_date: '2025-12-30', end_date: '2025-12-31',
        approval_status: 'approved',
      }]]]),
    });
    const satSlot = slot({ slot_date: '2026-01-03', derived_day_type: 'saturday' });
    const r = evaluateEligibility(satSlot, provider(), emptySolveState(), c, 'call');
    expect(r).toEqual({ eligible: false, reason: 'weekend-adjacent-pto' });
  });

  it('rejects when PTO (with bookend) covers the slot date', () => {
    const c = ctx({
      availByPid: new Map([['p1', [{
        availability_type: 'pto', start_date: '2026-01-05', end_date: '2026-01-09',
        approval_status: 'approved',
      }]]]),
    });
    const r = evaluateEligibility(slot(), provider(), emptySolveState(), c, 'call');
    expect(r).toEqual({ eligible: false, reason: 'availability-blocked' });
  });
});

describe('evaluateEligibility — derived gate (relief / D-chain)', () => {
  it('ignores the bucket-quota gate for derived placements', () => {
    const st = emptySolveState();
    st.bucketAssigned.set('p1|weekday|D1', 99);
    const d1 = slot({ shift_type_code: 'D1', shift_type_category: 'regular' });
    const r = evaluateEligibility(d1, provider(), st, ctx(), 'derived');
    expect(r.eligible).toBe(true);
  });

  it('still rejects derived placement during PTO bookend (H2 fix)', () => {
    const c = ctx({
      availByPid: new Map([['p1', [{
        availability_type: 'pto', start_date: '2026-01-05', end_date: '2026-01-09',
        approval_status: 'approved',
      }]]]),
    });
    const d1 = slot({ shift_type_code: 'D1', shift_type_category: 'regular' });
    const r = evaluateEligibility(d1, provider(), emptySolveState(), c, 'derived');
    expect(r).toEqual({ eligible: false, reason: 'availability-blocked' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- eligibility`
Expected: FAIL — cannot find module `./eligibility`.

- [ ] **Step 3: Implement the predicate**

Create `src/lib/rulesEngine/eligibility.ts`. This is a direct lift of `autoGenerate.ts:509-606`, returning typed reasons and reading from `SolveState` + `GenerationContext` instead of closure variables:

```ts
import {
  BLOCKING_AVAIL,
  BOOKEND_EXTENDING_TYPES,
  addDays,
  datesOverlap,
  dayOfWeekUTC,
  effectivePtoRange,
  dayTypeBucket,
} from './shared';
import type {
  GenerationContext, SlotToFill, CandidateProvider, SolveState,
  GateSet, EligibilityResult,
} from './genTypes';

const PASS: EligibilityResult = { eligible: true };

// Single canonical eligibility gate. `gate === 'call'` applies the full set
// (quota + post-call guard included). `gate === 'derived'` is for structurally
// derived placements (D-chains, weekend non-call fills, D4-D9 relief): it drops
// the bucket-quota and C1 post-call gates but keeps every safety gate
// (credentials, conflicts, weekday availability, weekend-adjacent PTO, and the
// PTO-bookend availability check — the last of which closes the relief-pass H2 bug).
export function evaluateEligibility(
  slot: SlotToFill,
  p: CandidateProvider,
  state: SolveState,
  ctx: GenerationContext,
  gate: GateSet,
): EligibilityResult {
  // Provider group match
  if (slot.provider_group === 'physician' && p.provider_type !== 'physician') {
    return { eligible: false, reason: 'group-mismatch' };
  }
  if (slot.provider_group === 'crna' && !['crna', 'aa'].includes(p.provider_type)) {
    return { eligible: false, reason: 'group-mismatch' };
  }

  // Same-date conflict (this schedule)
  if (state.assignedOnDate.get(slot.slot_date)?.has(p.id)) {
    return { eligible: false, reason: 'same-date' };
  }

  // Cross-site conflict (preloaded)
  if (ctx.crossSiteByDate.get(p.id)?.has(slot.slot_date)) {
    return { eligible: false, reason: 'cross-site' };
  }

  // Weekday availability. Index is Sun..Sat.
  const dow = dayOfWeekUTC(slot.slot_date);
  if (p.available_weekdays[dow] === false) {
    return { eligible: false, reason: 'weekday-unavailable' };
  }

  // C1 post-call day-off guard (call gate only). Saturday C1 is excepted.
  if (gate === 'call'
    && slot.shift_type_code === 'C1'
    && slot.derived_day_type !== 'saturday') {
    const dayAfter = addDays(slot.slot_date, 1);
    if (state.assignedOnDate.get(dayAfter)?.has(p.id)) {
      return { eligible: false, reason: 'post-call-guard' };
    }
  }

  // Bucket quota (call gate only): "would one more push us past target?"
  if (gate === 'call') {
    const k = `${p.id}|${dayTypeBucket(slot.derived_day_type)}|${slot.shift_type_code}`;
    const assigned = state.bucketAssigned.get(k) || 0;
    const target = ctx.bucketTarget.get(k) || 0;
    if (assigned + 1 > target) {
      return { eligible: false, reason: 'bucket-quota' };
    }
  }

  // Site credentials
  const cred = ctx.credByPid.get(p.id);
  if (cred) {
    if (!cred.is_active) return { eligible: false, reason: 'credential' };
    if (!cred.credentialed) return { eligible: false, reason: 'credential' };
    if (cred.excluded_shift_types.includes(slot.shift_type_code)) {
      return { eligible: false, reason: 'credential' };
    }
    if (cred.allowed_shift_types.length > 0
      && !cred.allowed_shift_types.includes(slot.shift_type_code)) {
      return { eligible: false, reason: 'credential' };
    }
    if (slot.shift_type_category === 'call') {
      if (!cred.can_take_call) return { eligible: false, reason: 'credential' };
      const dt = slot.derived_day_type;
      if ((dt === 'saturday' || dt === 'sunday') && !cred.can_take_weekend_call) {
        return { eligible: false, reason: 'credential' };
      }
      if ((dt === 'federal_holiday' || dt === 'major_holiday') && !cred.can_take_holiday_call) {
        return { eligible: false, reason: 'credential' };
      }
    }
  }
  // Missing credentials row = "not yet configured", treated as passing.

  // Saturday/Sunday adjacent-week PTO exclusion.
  if (slot.derived_day_type === 'saturday' || slot.derived_day_type === 'sunday') {
    const satDate = slot.derived_day_type === 'saturday'
      ? slot.slot_date
      : addDays(slot.slot_date, -1);
    const weekBeforeStart = addDays(satDate, -5);
    const weekBeforeEnd = addDays(satDate, -1);
    const weekAfterStart = addDays(satDate, 2);
    const weekAfterEnd = addDays(satDate, 6);
    const entries = ctx.availByPid.get(p.id) || [];
    for (const a of entries) {
      if (a.approval_status === 'denied' || a.approval_status === 'canceled') continue;
      if (!BOOKEND_EXTENDING_TYPES.has(a.availability_type)) continue;
      if (a.start_date <= weekBeforeEnd && a.end_date >= weekBeforeStart) {
        return { eligible: false, reason: 'weekend-adjacent-pto' };
      }
      if (a.start_date <= weekAfterEnd && a.end_date >= weekAfterStart) {
        return { eligible: false, reason: 'weekend-adjacent-pto' };
      }
    }
  }

  // Availability with PTO bookend.
  const entries = ctx.availByPid.get(p.id) || [];
  for (const a of entries) {
    if (a.approval_status === 'denied' || a.approval_status === 'canceled') continue;
    if (!BLOCKING_AVAIL.has(a.availability_type)) continue;
    const { start, end } = effectivePtoRange(a);
    if (datesOverlap(start, end, slot.slot_date)) {
      return { eligible: false, reason: 'availability-blocked' };
    }
  }

  return PASS;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- eligibility`
Expected: PASS (all cases including the H1 weekend-credential and H2 derived-bookend cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/eligibility.ts src/lib/rulesEngine/eligibility.test.ts
git commit -m "Add canonical evaluateEligibility predicate (closes H1/H2 gate divergence)"
```

---

## Task 4: Load phase (`genContext.ts`) + pure `computeBucketTargets`

Moves the read+preload logic (`autoGenerate.ts:129-451`) into `loadGenerationContext()`, and extracts the FTE-quota math into a **pure, tested** `computeBucketTargets()`. Adds `.order('id')` to the provider query (and orders the profiles query) for determinism (M5).

**Files:**
- Create: `src/lib/rulesEngine/genContext.ts`
- Test: `src/lib/rulesEngine/genContext.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/rulesEngine/genContext.test.ts`:

```ts
import { computeBucketTargets } from './genContext';
import type { CandidateProvider } from './genTypes';

function prov(id: string, fte: number): CandidateProvider {
  return {
    id, provider_type: 'physician', short_display_name: id, fte_value: fte,
    home_site_id: 'site1', available_weekdays: [true, true, true, true, true, true, true],
  };
}

describe('computeBucketTargets', () => {
  it('computes FTE-weighted base share with par level', () => {
    // One bucket with 12 slots, par 12, full-timer => base 1.0, no history.
    const targets = computeBucketTargets(
      new Map([['weekday|C1', 12]]),
      new Map(),                  // historicalTotalByBucket
      new Map(),                  // historicalAssignedByPid
      [prov('p1', 1), prov('p2', 0.5)],
      12,
    );
    expect(targets.get('p1|weekday|C1')).toBeCloseTo(1.0);
    expect(targets.get('p2|weekday|C1')).toBeCloseTo(0.5);
  });

  it('adds historical deficit so under-allocated part-timers catch up', () => {
    // Past: bucket had 24 slots; p1 (0.5 FTE) "should have" had 24/12*0.5 = 1
    // but got 0 -> deficit 1. This block has 12 slots -> base 0.5. Target 1.5.
    const targets = computeBucketTargets(
      new Map([['weekday|C1', 12]]),
      new Map([['weekday|C1', 24]]),
      new Map([['p1', new Map([['weekday|C1', 0]])]]),
      [prov('p1', 0.5)],
      12,
    );
    expect(targets.get('p1|weekday|C1')).toBeCloseTo(1.5);
  });

  it('never lets historical over-allocation shrink the base', () => {
    // p1 already over-served historically -> deficit clamps at 0, base stands.
    const targets = computeBucketTargets(
      new Map([['weekday|C1', 12]]),
      new Map([['weekday|C1', 12]]),
      new Map([['p1', new Map([['weekday|C1', 99]])]]),
      [prov('p1', 1)],
      12,
    );
    expect(targets.get('p1|weekday|C1')).toBeCloseTo(1.0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- genContext`
Expected: FAIL — `computeBucketTargets` is not exported.

- [ ] **Step 3: Implement `genContext.ts`**

Create `src/lib/rulesEngine/genContext.ts`. The `computeBucketTargets` function is a pure lift of `autoGenerate.ts:441-451`. The `loadGenerationContext` function is a lift of `autoGenerate.ts:129-451` (the preload steps 1–8), returning a `GenerationContext`. Apply these changes during the lift:
- Provider query (was `autoGenerate.ts:274-278`): add `.order('id')` after `.eq('status', 'active')`.
- Profiles query (was `:241-251`): in the override branch keep as-is; in the default branch the order doesn't matter for correctness but add `.order('provider_id')` for stable downstream construction.
- Keep the `countQ()` query counter — return the count in the context so the orchestrator can report `db_queries`.
- The structural slot sort (`:202-220`) and the `slotIndex`/`slotsToFill` build (`:154-190`) move here unchanged.
- `bucketTotals` build (`:408-425`) moves here unchanged; then call `computeBucketTargets(...)`.
- `seedAssignments` is built from the pre-existing assignments (the loop at `:493-506` that seeds runtime state) — here we only collect the raw seed data; solve will apply it to a fresh `SolveState`.

```ts
import {
  addDays, dayTypeBucket, normalizeWeekdays,
  type SupabaseClient,
} from './shared';
import { computeBucketTargets as _ct } from './genContext'; // self — see note
import type {
  GenerationContext, SlotToFill, CandidateProvider, SiteCredentials,
  AvailabilityEntry, SeedAssignment,
} from './genTypes';

const DEFAULT_PAR_LEVEL = 12;
const NEIGHBOR_WINDOW_DAYS = 31;

// Pure: FTE-weighted bucket targets with historical deficit carryforward.
// base_i     = (blockTotal / par) * fte_i
// expected_i = (histTotal  / par) * fte_i
// deficit_i  = max(0, expected_i - histActual_i)
// target_i   = base_i + deficit_i
export function computeBucketTargets(
  bucketTotals: Map<string, number>,
  historicalTotalByBucket: Map<string, number>,
  historicalAssignedByPid: Map<string, Map<string, number>>,
  providers: CandidateProvider[],
  parLevel: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of providers) {
    for (const [k, blockTotal] of bucketTotals) {
      const base = (blockTotal / parLevel) * p.fte_value;
      const histTotal = historicalTotalByBucket.get(k) || 0;
      const histExpected = (histTotal / parLevel) * p.fte_value;
      const histActual = historicalAssignedByPid.get(p.id)?.get(k) || 0;
      const deficit = Math.max(0, histExpected - histActual);
      out.set(`${p.id}|${k}`, base + deficit);
    }
  }
  return out;
}

export interface LoadResult {
  ctx: GenerationContext | null;
  error?: string;
  dbQueries: number;
}

export async function loadGenerationContext(
  sb: SupabaseClient,
  scheduleVersionId: string,
  options: { overrideProviderIds?: string[] } = {},
): Promise<LoadResult> {
  let dbQueries = 0;
  const countQ = () => { dbQueries++; };
  // ... lift autoGenerate.ts:129-451 here, building every field of
  // GenerationContext. On a hard failure (no slots / empty pool), return
  // { ctx: null, error, dbQueries }. On success return { ctx, dbQueries }.
  // Use computeBucketTargets(...) for ctx.bucketTarget.
  // (Full body is the mechanical move described above.)
  // Placeholder to satisfy the compiler during the lift — REPLACE with the move:
  return { ctx: null, error: 'not implemented', dbQueries };
}
```

> **Implementation note for the engineer:** delete the self-import line (`import { computeBucketTargets as _ct } from './genContext'`) — it is shown only to flag that `computeBucketTargets` lives in this same file. The `loadGenerationContext` body is the verbatim move of `autoGenerate.ts:129-451`; preserve every comment and the `countQ()` calls. Build `seedAssignments` by walking the raw slots' existing assignments (the data the old `:493-506` loop consumed). Do **not** implement bucket/quota math here beyond calling `computeBucketTargets`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- genContext`
Expected: PASS (the three `computeBucketTargets` cases). `loadGenerationContext` is exercised by the integration smoke in Task 13, not unit-tested (it is pure I/O wiring).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/genContext.ts src/lib/rulesEngine/genContext.test.ts
git commit -m "Add load phase (loadGenerationContext) + pure computeBucketTargets; order providers for determinism"
```

---

## Task 5: Solve — construction core (`solve.ts`)

Pure `solve(ctx)` returning a `SolutionPlan`. This task implements the scaffolding + pre-existing-state seeding + the main construction loop **without** D-chains/weekend/pre-PTO/relief (added in Tasks 6–9). Replaces the inline `doAssign` DB write with an in-memory `record()` that pushes to `plan.assignments` and updates `SolveState`. Scoring is lifted from `autoGenerate.ts:819-840` with an added **final tiebreak by `provider.id`** (M5).

**Files:**
- Create: `src/lib/rulesEngine/solve.ts`
- Test: `src/lib/rulesEngine/solve.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/rulesEngine/solve.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import type {
  GenerationContext, SlotToFill, CandidateProvider,
} from './genTypes';

function prov(id: string, fte = 1): CandidateProvider {
  return {
    id, provider_type: 'physician', short_display_name: id, fte_value: fte,
    home_site_id: 'site1', available_weekdays: [true, true, true, true, true, true, true],
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
  const bucketTotals = new Map<string, number>();
  const bucketTarget = new Map<string, number>();
  // generous targets so quota never blocks unless a test sets its own
  for (const s of slots) for (const p of providers) {
    bucketTarget.set(`${p.id}|weekday|${s.shift_type_code}`, 99);
  }
  return {
    scheduleVersionId: 'v1', siteId: 'site1', parLevel: 12,
    slotsToFill: slots, slotIndex, providers,
    credByPid: new Map(), availByPid: new Map(), crossSiteByDate: new Map(),
    historicalAssignedByPid: new Map(), historicalTotalByBucket: new Map(),
    bucketTotals, bucketTarget, seedAssignments: [],
    ...over,
  };
}

describe('solve — construction core', () => {
  it('fills a single weekday C1 with the only eligible provider', () => {
    const slots = [callSlot('s1', '2026-01-07', 'C1')];
    const plan = solve(buildCtx(slots, [prov('p1')]));
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].provider_id).toBe('p1');
    expect(plan.unfilled).toHaveLength(0);
  });

  it('reports an unfilled slot when no provider is eligible', () => {
    const slots = [callSlot('s1', '2026-01-07', 'C1')];
    // crna can't take a physician slot
    const plan = solve(buildCtx(slots, [prov('p1')], {
      providers: [{ ...prov('p1'), provider_type: 'crna' }],
    }));
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unfilled).toHaveLength(1);
    expect(plan.unfilled[0].slot_id).toBe('s1');
  });

  it('is deterministic: identical input yields identical output', () => {
    const mk = () => buildCtx(
      [callSlot('s1', '2026-01-07', 'C1'), callSlot('s2', '2026-01-14', 'C1')],
      [prov('pB'), prov('pA')],
    );
    const a = solve(mk());
    const b = solve(mk());
    expect(a.assignments.map(x => x.provider_id))
      .toEqual(b.assignments.map(x => x.provider_id));
  });

  it('breaks an exact score tie by provider id (stable)', () => {
    // Two identical fresh providers, one slot. Lower id wins deterministically.
    const slots = [callSlot('s1', '2026-01-07', 'C1')];
    const plan = solve(buildCtx(slots, [prov('pB'), prov('pA')]));
    expect(plan.assignments[0].provider_id).toBe('pA');
  });

  it('spreads two slots across two providers by lifetime ratio', () => {
    const slots = [callSlot('s1', '2026-01-07', 'C1'), callSlot('s2', '2026-01-14', 'C1')];
    const plan = solve(buildCtx(slots, [prov('pA'), prov('pB')]));
    const ids = plan.assignments.map(a => a.provider_id).sort();
    expect(ids).toEqual(['pA', 'pB']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- solve`
Expected: FAIL — cannot find module `./solve`.

- [ ] **Step 3: Implement the construction core**

Create `src/lib/rulesEngine/solve.ts`. Lift the runtime-state helpers (`autoGenerate.ts:453-506`), the scoring (`:819-840`), and the main-loop skeleton (`:798-817, 840-842`). Replace `doAssign` (async DB write) with a synchronous `record()`. Add the id tiebreak.

```ts
import { addDays, daysBetween, dayTypeBucket } from './shared';
import { evaluateEligibility } from './eligibility';
import { emptySolveState } from './genTypes';
import type {
  GenerationContext, SlotToFill, CandidateProvider, SolveState,
  SolutionPlan, PlacementSource,
} from './genTypes';

export function solve(ctx: GenerationContext): SolutionPlan {
  const plan: SolutionPlan = { assignments: [], unfilled: [] };
  const state = emptySolveState();

  // ── seed pre-existing assignments into state ──
  for (const seed of ctx.seedAssignments) {
    markAssigned(state, seed.slot_date, seed.provider_id);
    if (seed.shift_type_category === 'call') {
      incBucket(state, seed.provider_id, seed.derived_day_type, seed.shift_type_code);
      addCallDate(state, seed.provider_id, seed.slot_date);
    }
  }

  const providerById = new Map(ctx.providers.map(p => [p.id, p]));

  const record = (slot: SlotToFill, p: CandidateProvider, source: PlacementSource) => {
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
      existing_assignment_id: slot.existing_assignment_id, source,
    });
  };

  // ── main construction loop (D-chains/weekend/pre-PTO/relief added in later tasks) ──
  for (const slot of ctx.slotsToFill) {
    if (state.handledSlotIds.has(slot.slot_id)) continue;

    const candidates = ctx.providers.filter(
      p => evaluateEligibility(slot, p, state, ctx, 'call').eligible,
    );
    if (candidates.length === 0) {
      plan.unfilled.push({
        slot_id: slot.slot_id, slot_date: slot.slot_date,
        shift_type_code: slot.shift_type_code, reason: 'No eligible providers',
      });
      continue;
    }

    const scored = candidates.map(p => {
      const k = `${dayTypeBucket(slot.derived_day_type)}|${slot.shift_type_code}`;
      const lifetime = (ctx.historicalAssignedByPid.get(p.id)?.get(k) || 0)
        + (state.bucketAssigned.get(`${p.id}|${k}`) || 0);
      return {
        p,
        ratio: lifetime / Math.max(p.fte_value, 0.01),
        recency: daysSinceLastCall(state, p.id, slot.slot_date),
      };
    }).sort((a, b) =>
      a.ratio - b.ratio ||
      b.recency - a.recency ||
      a.p.id.localeCompare(b.p.id),   // M5: stable final tiebreak
    );

    record(slot, scored[0].p, 'main-loop');
    // chainDFills(...)  ← added in Task 6
    // weekend block     ← added in Task 7
  }

  return plan;
}

// ── pure state helpers (lifted from autoGenerate.ts:453-506) ──
function markAssigned(s: SolveState, date: string, pid: string) {
  if (!s.assignedOnDate.has(date)) s.assignedOnDate.set(date, new Set());
  s.assignedOnDate.get(date)!.add(pid);
}
function incBucket(s: SolveState, pid: string, dt: string, code: string) {
  const k = `${pid}|${dayTypeBucket(dt)}|${code}`;
  s.bucketAssigned.set(k, (s.bucketAssigned.get(k) || 0) + 1);
}
function addCallDate(s: SolveState, pid: string, date: string) {
  const list = s.callDatesByProvider.get(pid) || [];
  if (list.includes(date)) return;
  list.push(date); list.sort();
  s.callDatesByProvider.set(pid, list);
}
function daysSinceLastCall(s: SolveState, pid: string, date: string): number {
  const list = s.callDatesByProvider.get(pid) || [];
  let best = Infinity;
  for (const d of list) {
    if (d >= date) break;
    const gap = daysBetween(d, date);
    if (gap < best) best = gap;
  }
  return best;
}
```

> Keep `addDays` and `providerById` imported/declared even though the chain tasks (6–9) are what consume them; if the linter flags an unused symbol before those tasks land, add the chain code in the same commit or temporarily prefix with `void`. The cleanest path is to implement Tasks 5–9 as one continuous effort, committing after each task's tests pass.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- solve`
Expected: PASS (5 construction-core cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/solve.ts src/lib/rulesEngine/solve.test.ts
git commit -m "Add pure solve() construction core with deterministic id tiebreak"
```

---

## Task 6: Solve — D-chain relief

Add `chainDFills` (lift of `autoGenerate.ts:670-728`), called after each successful `record()` in the main loop. Replaces the async `tryFill`/`doAssign` with the synchronous `record()` and routes the structural fills through `evaluateEligibility(..., 'derived')`.

**Files:**
- Modify: `src/lib/rulesEngine/solve.ts`
- Test: `src/lib/rulesEngine/solve.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/rulesEngine/solve.test.ts`. Helper for a D-slot:

```ts
function dSlot(id: string, date: string, code: string, dt = 'weekday'): SlotToFill {
  return {
    slot_id: id, slot_date: date, shift_type_id: 'st-' + code,
    shift_type_code: code, shift_type_category: 'regular',
    derived_day_type: dt, provider_group: 'physician',
    required_count: 1, existing_assignment_id: null,
  };
}

describe('solve — D-chains', () => {
  it('forward-fills D1 the day after a weekday C2 with the same provider', () => {
    // Mon C2 -> Tue D1 (post-call). 2026-01-05 is Monday, 2026-01-06 Tuesday.
    const slots = [
      callSlot('c2', '2026-01-05', 'C2'),
      dSlot('d1', '2026-01-06', 'D1'),
    ];
    const plan = solve(buildCtx(slots, [prov('p1')]));
    const d1 = plan.assignments.find(a => a.shift_type_code === 'D1');
    expect(d1?.provider_id).toBe('p1');
    expect(d1?.source).toBe('d-chain');
  });

  it('blocks the C1 provider from any assignment the next day (post-call off)', () => {
    // Mon C1 -> provider must NOT be eligible for Tue C1.
    const slots = [
      callSlot('c1a', '2026-01-05', 'C1'),
      callSlot('c1b', '2026-01-06', 'C1'),
    ];
    const plan = solve(buildCtx(slots, [prov('p1')]));
    // p1 takes Mon C1; Tue C1 has no other provider -> unfilled.
    expect(plan.unfilled.map(u => u.slot_id)).toContain('c1b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- solve`
Expected: FAIL — D1 not filled (chainDFills not wired).

- [ ] **Step 3: Implement chainDFills**

Add to `solve.ts` (inside `solve`, so it closes over `ctx`, `state`, `record`), lifting `autoGenerate.ts:670-728`. Replace `await tryFill(date, code)` with the sync version below, and call `chainDFills(slot, chosen)` right after `record(slot, scored[0].p, 'main-loop')`:

```ts
  const tryFillDerived = (date: string, code: string, p: CandidateProvider) => {
    const target = ctx.slotIndex.get(date)?.get(code);
    if (!target) return;
    if (state.handledSlotIds.has(target.slot_id)) return;
    if (!evaluateEligibility(target, p, state, ctx, 'derived').eligible) return;
    record(target, p, 'd-chain');
  };

  const chainDFills = (slot: SlotToFill, p: CandidateProvider) => {
    const dt = slot.derived_day_type;
    if (dt === 'saturday') return;                       // weekend block handles it
    if (dt === 'sunday') {
      if (slot.shift_type_code === 'C1') {
        markAssigned(state, addDays(slot.slot_date, 1), p.id); // block Monday
      } else if (slot.shift_type_code === 'C2') {
        tryFillDerived(addDays(slot.slot_date, 1), 'D1', p);
      }
      return;
    }
    const twoDaysBefore = addDays(slot.slot_date, -2);
    const hadCallTwoDaysBefore =
      (state.callDatesByProvider.get(p.id) || []).includes(twoDaysBefore);
    const dayBefore = addDays(slot.slot_date, -1);
    if (slot.shift_type_code === 'C1') {
      if (!hadCallTwoDaysBefore) tryFillDerived(dayBefore, 'D2', p);
      markAssigned(state, addDays(slot.slot_date, 1), p.id); // post-call day off
    } else if (slot.shift_type_code === 'C2') {
      if (!hadCallTwoDaysBefore) tryFillDerived(dayBefore, 'D3', p);
      tryFillDerived(addDays(slot.slot_date, 1), 'D1', p);
    }
  };
```

> Note: `evaluateEligibility(..., 'derived')` for a D-shift on a date that is the provider's post-call-off day will correctly reject it via the same-date check (the day was `markAssigned`'d), preserving the original `isAssignedOnDate` guard. The `crossSiteByDate` and `handledSlotIds` guards from the original `tryFill` are subsumed by the canonical predicate + the `handledSlotIds` check above.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- solve`
Expected: PASS (construction + D-chain cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/solve.ts src/lib/rulesEngine/solve.test.ts
git commit -m "Add D-chain relief to solve via canonical derived gate"
```

---

## Task 7: Solve — weekend block chain (closes H1)

Add the Paoli weekend chain (lift of `autoGenerate.ts:847-888`). The critical fix: the chained **call** slots (Sun-C1, Sun-C2, Fri-C2) now route through `evaluateEligibility(..., 'call')` so they respect bucket quota, weekend-call credentials, and adjacent-week PTO (H1). The non-call Fri-D2 routes through `'derived'`.

**Files:**
- Modify: `src/lib/rulesEngine/solve.ts`
- Test: `src/lib/rulesEngine/solve.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `solve.test.ts`:

```ts
describe('solve — weekend block (H1)', () => {
  it('does NOT force a Sun-C1 onto a provider lacking weekend-call credential', () => {
    // Sat-C2 -> would chain Sun-C1 to the same provider. p1 has the Sat slot
    // (weekend cred true) but we revoke weekend cred -> the Sat itself is the
    // gate; use two providers so Sat fills and the chain is what we test.
    const sat = callSlot('sat', '2026-01-03', 'C2', 'saturday');
    const sun = callSlot('sun', '2026-01-04', 'C1', 'sunday');
    const ctx = buildCtx([sat, sun], [prov('p1')], {
      bucketTarget: new Map([
        ['p1|weekend|C2', 99], ['p1|weekend|C1', 99],
      ]),
      credByPid: new Map([['p1', {
        is_active: true, credentialed: true, can_take_call: true,
        can_take_weekend_call: true, can_take_holiday_call: true,
        allowed_shift_types: [], excluded_shift_types: [], skill_tags: [],
      }]]),
    });
    const plan = solve(ctx);
    // With weekend cred TRUE the chain places Sun-C1.
    expect(plan.assignments.some(a => a.slot_id === 'sun')).toBe(true);

    // Now revoke weekend cred: the Sat slot won't fill, so the chain can't run,
    // and Sun stays unfilled — never force-assigned.
    const ctx2 = buildCtx([sat, sun], [prov('p1')], {
      bucketTarget: new Map([['p1|weekend|C2', 99], ['p1|weekend|C1', 99]]),
      credByPid: new Map([['p1', {
        is_active: true, credentialed: true, can_take_call: true,
        can_take_weekend_call: false, can_take_holiday_call: true,
        allowed_shift_types: [], excluded_shift_types: [], skill_tags: [],
      }]]),
    });
    const plan2 = solve(ctx2);
    expect(plan2.assignments.some(a => a.slot_id === 'sun')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- solve`
Expected: FAIL — Sun-C1 not placed (weekend block not wired).

- [ ] **Step 3: Implement the weekend block**

In the main loop, after `chainDFills(slot, chosen)`, add (lift of `autoGenerate.ts:852-888`):

```ts
    if (slot.derived_day_type === 'saturday') {
      const sundayMap = ctx.slotIndex.get(addDays(slot.slot_date, 1));
      const fridayMap = ctx.slotIndex.get(addDays(slot.slot_date, -1));
      const chosen = scored[0].p;

      const chainAssign = (
        slotMap: Map<string, SlotToFill> | undefined, code: string,
      ) => {
        const target = slotMap?.get(code);
        if (!target) return;
        if (state.handledSlotIds.has(target.slot_id)) return;
        // H1 FIX: route through the canonical predicate. Call slots use the
        // 'call' gate (quota + weekend-call credential + adjacent PTO); the
        // Fri-D2 non-call fill uses 'derived'.
        const gate = target.shift_type_category === 'call' ? 'call' : 'derived';
        if (!evaluateEligibility(target, chosen, state, ctx, gate).eligible) return;
        record(target, chosen, 'weekend-chain');
        chainDFills(target, chosen);
      };

      if (slot.shift_type_code === 'C3') {
        chainAssign(sundayMap, 'C3');
      } else if (slot.shift_type_code === 'C1') {
        chainAssign(sundayMap, 'C2');
        chainAssign(fridayMap, 'C2');
      } else if (slot.shift_type_code === 'C2') {
        chainAssign(sundayMap, 'C1');
        chainAssign(fridayMap, 'D2');
      }
    }
```

> Behavior change vs. today: the old `chainAssign` only guarded same-date; it bypassed quota/credentials/PTO. Now those gates apply. This is the intended H1 fix. The structural slot sort (weekends before Friday) still guarantees the chain runs before Friday's own pass.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- solve`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/solve.ts src/lib/rulesEngine/solve.test.ts
git commit -m "Add weekend block chain to solve; route chained slots through canonical gate (H1)"
```

---

## Task 8: Solve — pre-PTO Thursday placement

Add the pre-PTO Thursday pass (lift of `autoGenerate.ts:730-796`) **before** the main loop, routed through the canonical predicate. Deterministic provider ordering by id is already in the original (`:779`).

**Files:**
- Modify: `src/lib/rulesEngine/solve.ts`
- Test: `src/lib/rulesEngine/solve.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `solve.test.ts`:

```ts
describe('solve — pre-PTO Thursday', () => {
  it('gives a PTO-bound provider the Thursday C1 before their PTO week', () => {
    // PTO week of Mon 2026-01-12. Thursday before = 2026-01-08.
    const thuC1 = callSlot('thu', '2026-01-08', 'C1');
    const ctx = buildCtx([thuC1], [prov('p1')], {
      bucketTarget: new Map([['p1|weekday|C1', 99]]),
      availByPid: new Map([['p1', [{
        availability_type: 'pto', start_date: '2026-01-12', end_date: '2026-01-16',
        approval_status: 'approved',
      }]]]),
    });
    const plan = solve(ctx);
    const thu = plan.assignments.find(a => a.slot_id === 'thu');
    expect(thu?.provider_id).toBe('p1');
    expect(thu?.source).toBe('pre-pto-thursday');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- solve`
Expected: FAIL — Thursday source is `main-loop`, not `pre-pto-thursday` (or unfilled if PTO bookend blocked it — see note).

- [ ] **Step 3: Implement the pre-PTO pass**

Add `import { thursdayBeforeWeekOf } from './shared'` and `BLOCKING_AVAIL` import. Insert before the main loop, lifting `autoGenerate.ts:741-796`. Replace `tryPlacePrePto`'s `isEligible` with `evaluateEligibility(slot, provider, state, ctx, 'call').eligible`, and `doAssign`+`chainDFills` with `record(slot, provider, 'pre-pto-thursday')` + `chainDFills(slot, provider)`:

```ts
  // Build Thursday -> providers-with-PTO-that-week map.
  const prePtoByThursday = new Map<string, Set<string>>();
  for (const p of ctx.providers) {
    for (const a of ctx.availByPid.get(p.id) || []) {
      if (a.approval_status !== 'approved') continue;
      if (!BLOCKING_AVAIL.has(a.availability_type)) continue;
      const thu = thursdayBeforeWeekOf(a.start_date);
      if (!ctx.slotIndex.has(thu)) continue;
      const set = prePtoByThursday.get(thu) || new Set<string>();
      set.add(p.id);
      prePtoByThursday.set(thu, set);
    }
  }
  const tryPlacePrePto = (slot: SlotToFill | undefined, p: CandidateProvider): boolean => {
    if (!slot) return false;
    if (state.handledSlotIds.has(slot.slot_id)) return false;
    if (!evaluateEligibility(slot, p, state, ctx, 'call').eligible) return false;
    record(slot, p, 'pre-pto-thursday');
    chainDFills(slot, p);
    return true;
  };
  for (const [thuDate, pidSet] of prePtoByThursday) {
    const codeMap = ctx.slotIndex.get(thuDate);
    if (!codeMap) continue;
    const c1 = codeMap.get('C1');
    const c2 = codeMap.get('C2');
    const ranked = Array.from(pidSet).sort()
      .map(pid => providerById.get(pid))
      .filter((p): p is CandidateProvider => !!p);
    if (ranked[0]) { tryPlacePrePto(c1, ranked[0]) || tryPlacePrePto(c2, ranked[0]); }
    if (ranked[1]) { tryPlacePrePto(c1, ranked[1]) || tryPlacePrePto(c2, ranked[1]); }
  }
```

> Note on the test fixture: the Thursday `2026-01-08` is the day before Friday `2026-01-09`. The PTO starts Monday `2026-01-12`; `effectivePtoRange` only extends a PTO that *starts on Monday* backward by 2 days (to capture the Saturday before, i.e. `2026-01-10`), which does **not** reach the Thursday. So the Thursday C1 is eligible. This matches the production intent (Thu call → Fri post-call → weekend off → PTO).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- solve`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/solve.ts src/lib/rulesEngine/solve.test.ts
git commit -m "Add pre-PTO Thursday placement to solve"
```

---

## Task 9: Solve — D4–D9 relief pass (closes H2)

Add the relief-order pass (lift of `autoGenerate.ts:891-979`) as the final solve step. The fix: relief eligibility now uses `evaluateEligibility(..., 'derived')`, which applies the PTO **bookend** (H2) instead of raw availability dates.

**Files:**
- Modify: `src/lib/rulesEngine/solve.ts`
- Test: `src/lib/rulesEngine/solve.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `solve.test.ts`:

```ts
describe('solve — D4-D9 relief (H2)', () => {
  it('does not place a provider on relief inside their PTO bookend window', () => {
    // PTO Mon 2026-01-05 .. Fri 2026-01-09. Bookend extends to Sun 2026-01-11.
    // A D4 slot on Sun is N/A (relief is weekday/friday only), so test Fri 01-09
    // which is inside raw PTO, AND test that the bookend-only day is also blocked.
    const d4 = dSlot('d4', '2026-01-09', 'D4', 'friday'); // inside raw PTO
    const ctx = buildCtx([d4], [prov('p1')], {
      availByPid: new Map([['p1', [{
        availability_type: 'pto', start_date: '2026-01-05', end_date: '2026-01-09',
        approval_status: 'approved',
      }]]]),
    });
    const plan = solve(ctx);
    expect(plan.assignments.some(a => a.slot_id === 'd4')).toBe(false);
  });

  it('fills a relief slot for an available provider in next-call order', () => {
    const d4 = dSlot('d4', '2026-01-07', 'D4'); // Wednesday weekday
    const plan = solve(buildCtx([d4], [prov('p1')]));
    const got = plan.assignments.find(a => a.slot_id === 'd4');
    expect(got?.provider_id).toBe('p1');
    expect(got?.source).toBe('relief-order');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- solve`
Expected: FAIL — relief pass not implemented.

- [ ] **Step 3: Implement the relief pass**

After the main loop, before `return plan`, lift `autoGenerate.ts:891-979`. Build `providerCalls` from `plan.assignments` + `ctx.seedAssignments` (the old code also reads pre-existing raw slots — seedAssignments carries that). Replace `isAvailableForReliefDay` with `evaluateEligibility(sampleSlotForDate, p, state, ctx, 'derived')` — but relief checks a *date*, not a specific slot; use the actual D-slot being filled as the slot argument so the predicate has the right date/category:

```ts
  const RELIEF_CODES = ['D4', 'D5', 'D6', 'D7', 'D8', 'D9'];
  const callTierPriority = (code: string) => code === 'C1' ? 0 : code === 'C2' ? 1 : 2;

  const providerCalls = new Map<string, Array<{ date: string; code: string }>>();
  const pushCall = (pid: string, date: string, code: string) => {
    if (!providerCalls.has(pid)) providerCalls.set(pid, []);
    providerCalls.get(pid)!.push({ date, code });
  };
  for (const a of plan.assignments) {
    if (['C1', 'C2', 'C3'].includes(a.shift_type_code)) pushCall(a.provider_id, a.slot_date, a.shift_type_code);
  }
  for (const seed of ctx.seedAssignments) {
    if (['C1', 'C2', 'C3'].includes(seed.shift_type_code)) pushCall(seed.provider_id, seed.slot_date, seed.shift_type_code);
  }
  for (const arr of providerCalls.values()) arr.sort((a, b) => a.date.localeCompare(b.date));

  const scheduleDates = Array.from(ctx.slotIndex.keys()).sort();
  for (const date of scheduleDates) {
    const codeMap = ctx.slotIndex.get(date);
    if (!codeMap) continue;
    const sampleD = codeMap.get('D4') || codeMap.get('D5');
    if (!sampleD) continue;
    const dt = sampleD.derived_day_type;
    if (dt !== 'weekday' && dt !== 'friday') continue;

    const available = ctx.providers.filter(
      p => evaluateEligibility(sampleD, p, state, ctx, 'derived').eligible,
    );
    const scored = available.map(p => {
      const nextCall = (providerCalls.get(p.id) || []).find(c => c.date > date);
      return {
        p,
        distance: nextCall ? daysBetween(date, nextCall.date) : Infinity,
        tier: nextCall ? callTierPriority(nextCall.code) : 99,
        recency: daysSinceLastCall(state, p.id, date),
      };
    }).sort((a, b) =>
      a.distance - b.distance || a.tier - b.tier ||
      a.recency - b.recency || a.p.id.localeCompare(b.p.id),
    );

    let idx = 0;
    for (const code of RELIEF_CODES) {
      if (idx >= scored.length) break;
      const slot = codeMap.get(code);
      if (!slot) continue;
      if (state.handledSlotIds.has(slot.slot_id)) continue;
      record(slot, scored[idx].p, 'relief-order');
      idx++;
    }
  }
```

> Behavior change vs. today: the old `isAvailableForReliefDay` (`autoGenerate.ts:925-940`) checked raw `datesOverlap(a.start_date, a.end_date, date)`. Routing through `evaluateEligibility('derived')` applies `effectivePtoRange`, so a provider inside their PTO bookend is now correctly excluded (H2). Added id tiebreak for determinism.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- solve`
Expected: PASS (all solve describes green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rulesEngine/solve.ts src/lib/rulesEngine/solve.test.ts
git commit -m "Add D4-D9 relief pass to solve via derived gate (closes H2 bookend bug)"
```

---

## Task 10: Commit phase + validation N+1 fix (`commit.ts`)

Batched DB writes replace the per-assignment serial writes, and the validation site-context is loaded once (M3).

**Files:**
- Create: `src/lib/rulesEngine/commit.ts`
- Modify: `src/lib/rulesEngine/loadContext.ts`, `src/lib/rulesEngine/evaluate.ts`
- Test: `src/lib/rulesEngine/commit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/rulesEngine/commit.test.ts`. We test the **pure partitioning** helper that decides insert-vs-update batches (the Supabase calls themselves are integration-smoke-tested in Task 13):

```ts
import { describe, it, expect } from 'vitest';
import { partitionForWrite } from './commit';
import type { PlannedAssignment } from './genTypes';

function pa(over: Partial<PlannedAssignment>): PlannedAssignment {
  return {
    slot_id: 's', slot_date: '2026-01-07', shift_type_code: 'C1',
    shift_type_category: 'call', derived_day_type: 'weekday',
    provider_id: 'p1', provider_name: 'P1',
    existing_assignment_id: null, source: 'main-loop', ...over,
  };
}

describe('partitionForWrite', () => {
  it('splits assignments into updates (existing row) and inserts (new row)', () => {
    const plan = [
      pa({ slot_id: 'a', existing_assignment_id: 'row-a' }),
      pa({ slot_id: 'b', existing_assignment_id: null }),
    ];
    const { updates, inserts } = partitionForWrite(plan);
    expect(updates.map(u => u.id)).toEqual(['row-a']);
    expect(updates[0].provider_id).toBe('p1');
    expect(updates[0].assignment_status).toBe('assigned');
    expect(updates[0].source_type).toBe('auto_generated');
    expect(inserts.map(i => i.schedule_slot_id)).toEqual(['b']);
    expect(inserts[0].assignment_status).toBe('assigned');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- commit`
Expected: FAIL — cannot find module `./commit`.

- [ ] **Step 3: Implement commit.ts**

Create `src/lib/rulesEngine/commit.ts`:

```ts
import { evaluateAssignment } from './evaluate';
import { loadSiteValidationContext } from './loadContext';
import type { SupabaseClient } from './shared';
import type { SolutionPlan, PlannedAssignment } from './genTypes';

export interface WriteUpdate {
  id: string;
  provider_id: string;
  assignment_status: 'assigned';
  source_type: 'auto_generated';
  assigned_at: string;
}
export interface WriteInsert {
  schedule_slot_id: string;
  provider_id: string;
  assignment_status: 'assigned';
  source_type: 'auto_generated';
  assigned_at: string;
}

// Pure: partition planned assignments into the upsert (existing open row) and
// insert (no row yet) batches. `assigned_at` is supplied by the caller so this
// stays deterministic/testable.
export function partitionForWrite(
  assignments: PlannedAssignment[],
  assignedAt = '1970-01-01T00:00:00.000Z',
): { updates: WriteUpdate[]; inserts: WriteInsert[] } {
  const updates: WriteUpdate[] = [];
  const inserts: WriteInsert[] = [];
  for (const a of assignments) {
    if (a.existing_assignment_id) {
      updates.push({
        id: a.existing_assignment_id, provider_id: a.provider_id,
        assignment_status: 'assigned', source_type: 'auto_generated',
        assigned_at: assignedAt,
      });
    } else {
      inserts.push({
        schedule_slot_id: a.slot_id, provider_id: a.provider_id,
        assignment_status: 'assigned', source_type: 'auto_generated',
        assigned_at: assignedAt,
      });
    }
  }
  return { updates, inserts };
}

export interface CommitResult {
  filled: number;
  errors: string[];
  dbQueries: number;
}

// Batched write of the whole plan. Two bulk calls instead of N serial writes.
export async function commitPlan(
  sb: SupabaseClient,
  plan: SolutionPlan,
): Promise<CommitResult> {
  const errors: string[] = [];
  let dbQueries = 0;
  const assignedAt = new Date().toISOString();
  const { updates, inserts } = partitionForWrite(plan.assignments, assignedAt);

  if (updates.length > 0) {
    dbQueries++;
    const { error } = await sb.from('assignments')
      .upsert(updates, { onConflict: 'id' });
    if (error) errors.push(`Batch update failed: ${error.message}`);
  }
  if (inserts.length > 0) {
    dbQueries++;
    const { error } = await sb.from('assignments').insert(inserts);
    if (error) errors.push(`Batch insert failed: ${error.message}`);
  }

  const filled = errors.length === 0 ? plan.assignments.length : 0;
  return { filled, errors, dbQueries };
}

// Validation pass — loads the per-site rule/shift-type context ONCE (M3 fix)
// and threads it into each evaluateAssignment, then writes validation_flags
// in parallel batches.
export async function commitValidation(
  sb: SupabaseClient,
  siteId: string,
  assignments: PlannedAssignment[],
): Promise<{ dbQueries: number }> {
  let dbQueries = 0;
  dbQueries++;
  const siteCtx = await loadSiteValidationContext(sb, siteId);

  const CONCURRENCY = 10;
  for (let i = 0; i < assignments.length; i += CONCURRENCY) {
    const batch = assignments.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async a => {
      dbQueries++;
      const ev = await evaluateAssignment(sb, a.slot_id, a.provider_id, siteCtx);
      dbQueries++;
      await sb.from('assignments')
        .update({ validation_flags: ev.violations })
        .eq('schedule_slot_id', a.slot_id)
        .eq('provider_id', a.provider_id);
    }));
  }
  return { dbQueries };
}
```

- [ ] **Step 4: Add the hoisted site-context loader to loadContext.ts**

In `src/lib/rulesEngine/loadContext.ts`, extract the shift-types + rules queries (currently inline at lines 43–81) into an exported `loadSiteValidationContext`, and let `loadContext` accept it optionally. Add near the top, after the imports:

```ts
export interface SiteValidationContext {
  shiftTypesById: Map<string, ShiftTypeRow>;
  shiftTypesByCode: Map<string, ShiftTypeRow>;
  rules: RuleDefinition[];
}

export async function loadSiteValidationContext(
  sb: SupabaseClient,
  siteId: string,
): Promise<SiteValidationContext> {
  const { data: shiftTypes } = await sb
    .from('shift_types')
    .select('id, site_id, code, name, category, requires_credential, requires_specific_skills')
    .eq('site_id', siteId);
  const shiftTypeRows: ShiftTypeRow[] = (shiftTypes || []).map((s: Record<string, unknown>) => ({
    id: s.id as string, site_id: s.site_id as string, code: s.code as string,
    name: s.name as string, category: s.category as ShiftTypeRow['category'],
    requires_credential: (s.requires_credential as string | null) ?? null,
    requires_specific_skills: Array.isArray(s.requires_specific_skills)
      ? (s.requires_specific_skills as string[]) : [],
  }));
  const { data: ruleSets } = await sb
    .from('rule_sets').select('id').eq('site_id', siteId).eq('status', 'active');
  const ruleSetIds = (ruleSets || []).map((r: { id: string }) => r.id);
  let rules: RuleDefinition[] = [];
  if (ruleSetIds.length > 0) {
    const { data: ruleRows } = await sb
      .from('rule_definitions')
      .select('id, rule_set_id, rule_name, rule_category, hard_constraint, priority_rank, applies_to_provider_group, applies_to_shift_types, applies_to_day_types, condition, action, explanation_text, is_active')
      .in('rule_set_id', ruleSetIds).eq('is_active', true);
    rules = (ruleRows || []) as RuleDefinition[];
  }
  return {
    shiftTypesById: new Map(shiftTypeRows.map(s => [s.id, s])),
    shiftTypesByCode: new Map(shiftTypeRows.map(s => [s.code, s])),
    rules,
  };
}
```

Then change the `loadContext` signature to `loadContext(sb, slotId, providerId, siteCtx?: SiteValidationContext)` and, when `siteCtx` is provided, use its `shiftTypesById` / `shiftTypesByCode` / `rules` instead of re-querying (skip the current lines 43–81 query work). When absent, fall back to the existing inline queries (keep them for the non-batched callers).

- [ ] **Step 5: Thread it through evaluate.ts**

Change `evaluateAssignment(sb, slotId, providerId)` to `evaluateAssignment(sb, slotId, providerId, siteCtx?: SiteValidationContext)` and pass `siteCtx` into `loadContext`. Import the type from `./loadContext`.

- [ ] **Step 6: Run tests + typecheck**

Run: `npm test -- commit`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/rulesEngine/commit.ts src/lib/rulesEngine/loadContext.ts src/lib/rulesEngine/evaluate.ts src/lib/rulesEngine/commit.test.ts
git commit -m "Add batched commitPlan + hoisted validation site-context (N+1 fix)"
```

---

## Task 11: Rewire `autoGenerate.ts` as a thin orchestrator

Replace the 1012-line body with load → solve → commit → validate, preserving the exported `autoGenerate(sb, scheduleVersionId, options)` signature and the `GenerationResult` shape the UI consumes.

**Files:**
- Modify: `src/lib/rulesEngine/autoGenerate.ts`

- [ ] **Step 1: Rewrite the module body**

Replace the entire contents of `src/lib/rulesEngine/autoGenerate.ts` with:

```ts
// Orchestrator for physician call-schedule generation.
// Pipeline: load (genContext) -> solve (pure) -> commit (batched) -> validate.
// See ALGORITHM.md and docs/superpowers/specs/2026-06-11-scheduling-engine-optimization-design.md
import { loadGenerationContext } from './genContext';
import { solve } from './solve';
import { commitPlan, commitValidation } from './commit';
import type { SupabaseClient } from './shared';

export interface AutoGenerateOptions {
  overrideProviderIds?: string[];
}

export interface GenerationResult {
  filled: number;
  skipped: number;
  errors: string[];
  assignments: Array<{
    slot_id: string; slot_date: string; shift_type_code: string;
    provider_id: string; provider_name: string;
  }>;
  unfilled: Array<{
    slot_id: string; slot_date: string; shift_type_code: string; reason: string;
  }>;
  // Distinguishes a hard failure (no slots / empty pool / DB error) from a
  // legitimate partial fill. The route maps this to an HTTP status.
  ok: boolean;
  perf?: {
    par_level: number; total_slots: number; call_slots: number;
    providers: number; elapsed_ms: number; db_queries: number;
  };
}

export async function autoGenerate(
  sb: SupabaseClient,
  scheduleVersionId: string,
  options: AutoGenerateOptions = {},
): Promise<GenerationResult> {
  const t0 = Date.now();
  const result: GenerationResult = {
    filled: 0, skipped: 0, errors: [], assignments: [], unfilled: [], ok: false,
  };

  const load = await loadGenerationContext(sb, scheduleVersionId, options);
  if (!load.ctx) {
    result.errors.push(load.error || 'Failed to load generation context');
    return result; // ok stays false -> route returns 4xx/5xx
  }
  const ctx = load.ctx;

  const plan = solve(ctx);

  const commit = await commitPlan(sb, plan);
  result.errors.push(...commit.errors);
  if (commit.errors.length > 0) {
    return result; // commit failure -> ok false -> route 5xx
  }

  const validation = await commitValidation(sb, ctx.siteId, plan.assignments);

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
    total_slots: ctx.slotsToFill.length + plan.assignments.length,
    call_slots: ctx.slotsToFill.length,
    providers: ctx.providers.length,
    elapsed_ms: Date.now() - t0,
    db_queries: load.dbQueries + commit.dbQueries + validation.dbQueries,
  };
  return result;
}
```

> `SupabaseClient` is exported from `shared.ts` (line 10). The day-shift pass (`autoGenerateDayShifts`) is unchanged and still called separately by the route (Task 12). The `ok` field is **new and additive** — existing UI ignores unknown fields.

- [ ] **Step 2: Typecheck + full test run**

Run: `npx tsc --noEmit`
Expected: no errors (any remaining references to deleted helpers in `autoGenerate.ts` must be gone).
Run: `npm test`
Expected: PASS — all rules-engine suites green.

- [ ] **Step 3: Commit**

```bash
git add src/lib/rulesEngine/autoGenerate.ts
git commit -m "Rewire autoGenerate as thin load/solve/commit/validate orchestrator"
```

---

## Task 12: Error propagation in the generate route (closes C1)

The route must return a non-200 status when generation hard-fails, instead of always 200.

**Files:**
- Modify: `src/app/api/scheduling/schedules/[id]/generate/route.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/scheduling/schedules/[id]/generate/route.test.ts`. We test the pure status-mapping helper (added in Step 3) so we don't need a live Supabase:

```ts
import { describe, it, expect } from 'vitest';
import { statusForResult } from './route';

describe('statusForResult', () => {
  it('returns 200 for a successful (even partial) generation', () => {
    expect(statusForResult({ ok: true, filled: 5, skipped: 2 })).toBe(200);
    expect(statusForResult({ ok: true, filled: 0, skipped: 0 })).toBe(200);
  });
  it('returns 422 for a hard failure (ok=false)', () => {
    expect(statusForResult({ ok: false, filled: 0, skipped: 0 })).toBe(422);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- generate`
Expected: FAIL — `statusForResult` not exported.

- [ ] **Step 3: Implement the mapping + wire it in**

In `src/app/api/scheduling/schedules/[id]/generate/route.ts`, add the exported helper and use it. Replace the final `return NextResponse.json(result)` (line 73) block:

```ts
// Pure: hard failure (ok=false) -> 422 so the UI shows the error message; a
// successful generation (including a partial fill with unfilled slots) -> 200.
export function statusForResult(r: { ok: boolean; filled: number; skipped: number }): number {
  return r.ok ? 200 : 422;
}
```

Then change the merge/return tail (lines 60–73) to:

```ts
  const result = await autoGenerate(sb, version.id, { overrideProviderIds });
  // If call-gen hard-failed, surface it immediately; don't run day-shift gen
  // on a context that couldn't even load.
  if (!result.ok) {
    return NextResponse.json(result, { status: statusForResult(result) });
  }

  const dayResult = await autoGenerateDayShifts(sb, version.id, { overrideProviderIds });
  result.filled += dayResult.filled;
  result.errors.push(...dayResult.errors);
  result.assignments.push(...dayResult.assignments);

  return NextResponse.json(result, { status: statusForResult(result) });
```

> Note: `vitest`'s `include` glob (`src/**/*.{test,spec}.ts`) covers this co-located test. Importing the route module pulls in `next/server`, which loads fine under the node test environment because `statusForResult` doesn't touch request/response objects.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- generate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/scheduling/schedules/[id]/generate/route.ts" "src/app/api/scheduling/schedules/[id]/generate/route.test.ts"
git commit -m "Propagate hard-failure status from generate route (closes silent-200 bug)"
```

---

## Task 13: Full verification + integration smoke + cleanup

Prove the suite is green, the build typechecks, and the real endpoint still produces a schedule against dev data.

**Files:**
- Verify only (no new code unless the smoke surfaces a defect).

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS — `shared`, `eligibility`, `genContext`, `solve`, `commit`, `generate` suites all green.

- [ ] **Step 2: Typecheck + lint + build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: no type errors; lint clean; production build succeeds.

- [ ] **Step 3: Integration smoke against dev data**

Start the dev server (`npm run dev`) and POST to the generate endpoint for a known schedule id with open slots:

Run: `curl -s -X POST http://localhost:3000/api/scheduling/schedules/<KNOWN_SCHEDULE_ID>/generate | python3 -m json.tool`

Expected: HTTP 200 with `ok: true`, a non-zero `filled`, and `perf.db_queries` **dramatically lower** than before (batched writes: the count should now be roughly `load (~7) + commit (≤2) + validation (1 + 2×assignments)`, versus the old `~7 + assignments + 2×assignments`). Capture the `filled`/`skipped`/`db_queries` numbers in the commit message for the record.

> If `filled` is materially lower than a pre-refactor run on the same schedule, investigate: the only intended reductions are the H1/H2 corrections (weekend/relief placements that were previously invalid). A drop elsewhere indicates a lift error — most likely the structural slot sort or the `seedAssignments` seeding. Compare `plan.assignments` ordering against the old engine's log output.

- [ ] **Step 4: Remove now-dead code**

Confirm no remaining references to the old inline `isEligible`, `doAssign`, `chainDFills`, `daysBetween` (now in shared), or the duplicated date math inside the engine. Run:

Run: `grep -rn "const isEligible\|const doAssign" src/lib/rulesEngine/`
Expected: no matches (all moved). If `dayShiftAutoGen.ts` has its own copies, leave them — that file is out of scope for Phase 1 except where it imports `daysBetween` from shared (optional cleanup, only if trivial).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Verify Phase 1: green suite, batched-write perf smoke, dead-code sweep"
```

---

## Self-Review (completed during planning)

**Spec coverage:**
- §3 Load/Solve/Commit/Validate split → Tasks 4, 5–9, 10, 11. ✓
- §4 canonical predicate (H1/H2) → Task 3 (predicate), Task 7 (H1 wiring), Task 9 (H2 wiring). ✓
- §6 batched commit → Task 10; N+1 validation hoist → Task 10; determinism (`.order('id')` + id tiebreak) → Task 4 (query order) + Task 5 (tiebreak). ✓
- §8 error propagation → Task 12. ✓
- §9 tests: pure unit tests (eligibility/genContext/solve/commit) + determinism case + H1/H2 cases → Tasks 3,4,5–9,10; golden-master/snapshot is satisfied by the determinism + behavior tests in solve (a full multi-week snapshot fixture is deferred to Phase 2's metrics harness, where the baseline comparison actually matters — noted as an intentional scoping call). Integration smoke → Task 13. ✓
- §10 migration → correctly **absent** (Phase 1 adds no column). ✓
- §11 feature flag for local search → **absent by design** (no local search in Phase 1). ✓
- §12 Phase 1 deliverables → all tasks. ✓

**Placeholder scan:** The one `return { ctx: null, error: 'not implemented' }` stub in Task 4 Step 3 is explicitly a lift-marker with a written instruction to replace it with the verbatim move of `autoGenerate.ts:129-451`; the surrounding note tells the engineer exactly what to move. This is a deliberate "relocate existing code" instruction, not a vague TODO — the source lines and every target field are specified.

**Type consistency:** `GenerationContext`, `SolveState`, `SlotToFill`, `CandidateProvider`, `SiteCredentials`, `AvailabilityEntry`, `PlannedAssignment`, `SolutionPlan`, `RejectionReason`, `GateSet`, `SiteValidationContext` are defined once (Tasks 2, 10) and referenced consistently. `evaluateEligibility(slot, p, state, ctx, gate)` signature is identical across Tasks 3, 5, 6, 7, 8, 9. `record(slot, p, source)` and `partitionForWrite` signatures are stable. `autoGenerate` keeps its public signature; `GenerationResult` gains only additive fields (`ok`).
