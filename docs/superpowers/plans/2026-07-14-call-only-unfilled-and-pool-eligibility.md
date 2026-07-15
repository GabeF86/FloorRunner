# Call-Only Unfilled Counts + Pool Eligibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Unfilled counts and open-slot warnings become call-only; a new always-on evaluator hard-flags wrong-pool assignments (day doc on D1–D9; neither-day-doc-nor-call-taker on 7-3/7-5).

**Architecture:** Three independent changes: (1) dashboard rollup gains a category embed and gates its unfilled counter; (2) `openSlot` evaluator's default soft branch gates on call category; (3) new `poolEligibility` evaluator keyed on `shift_types.generation_engine` + employment-profile flags, which requires threading `generation_engine` into `ShiftTypeRow` and the profile flags into `EvaluationContext`. Spec: `docs/superpowers/specs/2026-07-14-call-only-unfilled-and-pool-eligibility-design.md` (read it first — it records the asymmetric rule and the live-data dry run).

**Tech Stack:** Next.js 14 / Supabase / vitest. Branch `sched-pools` (exists). Test baseline: 675 passed + 10 documented gridCalculator "No test suite found" file errors.

---

### Task 1: Dashboard unfilled = call slots only

**Files:**
- Modify: `src/app/(scheduling)/dashboard/queries.ts` (~lines 86-90, 244, 205)
- Test: `src/app/(scheduling)/dashboard/queries.test.ts`

- [x] **Step 1.1:** Add failing tests: extend the `attnSlot` builder (~line 48) with a `shift_types: { category: 'call' }` default; add a case where an unfilled `shift_types: { category: 'regular' }` slot does NOT increment `unfilled` (but its assigned/hard accounting still counts when assigned); run `npx vitest run "src/app/(scheduling)/dashboard/queries.test.ts"` — new case fails.
- [x] **Step 1.2:** Implement: `ATTENTION_COLUMNS` (line ~244) gains `shift_types(category)`; `AttentionSlotRow` gains `shift_types: { category: string } | { category: string }[] | null` (check how other embeds in this file handle PostgREST one-vs-array shape — there is an `asArray`/embed helper convention; UI v1 notes say `embedArray` is required for slot→assignments embeds, mirror whatever `queries.ts` already does for one-to-one embeds); in `attentionFor` (~line 205) gate: only increment `unfilled` when the embedded category is `'call'`. `assigned`/`checked`/`hard` stay category-blind.
- [x] **Step 1.3:** Run the file's tests — all pass. Check the 1499-row rollup test still asserts its intent (builder default 'call' keeps it green).
- [x] **Step 1.4:** Commit `feat: dashboard unfilled count is call-slots-only`.

### Task 2: Open-slot soft warning = call slots only

**Files:**
- Modify: `src/lib/rulesEngine/evaluators.ts` (openSlot, ~lines 743-753)
- Test: `src/lib/rulesEngine/evaluators.test.ts`
- Verify-only: `src/lib/scheduleAssistant/tools.ts` (get_open_slots / coverage data source)

- [x] **Step 2.1:** Failing tests in evaluators.test.ts (find the existing openSlot describe block and mirror fixture style): open `regular` slot → NO soft `open_slot` violation; open `call` slot → soft violation still emitted; rule-driven deadline branch still fires for a regular slot with an `open_slot` rule (deadline escalation is category-blind and unchanged).
- [x] **Step 2.2:** Implement — in openSlot's default branch, wrap the soft push:

```ts
  // Default: soft warning for open CALL slots only. An open day (regular/
  // float/admin) slot is normal scheduler workflow, not a warning — Gabriel
  // 2026-07-14. Rule-driven deadlines above remain category-blind.
  if (ctx.shiftType.category === 'call') {
    violations.push({
      rule_id: null,
      rule_name: 'Open slot',
      category: 'open_slot',
      severity: 'soft',
      message: `${ctx.shiftType.code} on ${ctx.slot.slot_date} has no provider assigned.`,
    });
  }
```

- [x] **Step 2.3:** Verify the assistant still sees open day slots: read `get_open_slots` + coverage tools in `src/lib/scheduleAssistant/tools.ts` — confirm they enumerate from assignment rows / provider_id null, NOT from `open_slot` validation flags. If any tool filters on the flag, repoint it to rows (and say so in the report). Also grep `open_slot` across src/ for other consumers.
- [x] **Step 2.4:** Full engine tests (`npm test`) — goldens untouched (this evaluator doesn't affect fill). Commit `feat: open-slot soft warning only for call slots`.

### Task 3: poolEligibility evaluator (hard, non-blocking)

**Files:**
- Modify: `src/lib/rulesEngine/types.ts` (ShiftTypeRow + EvaluationContext), `src/lib/rulesEngine/loadContext.ts`, `src/lib/rulesEngine/evaluators.ts`, `src/lib/rulesEngine/batchValidate.ts` (context build path — check!)
- Test: `src/lib/rulesEngine/evaluators.test.ts` + whichever context-build test file covers loadContext selects

- [x] **Step 3.1:** Read first (adaptation points): how `loadContext.ts` selects shift types (add `generation_engine` to that select) and the provider embed at ~line 210 (`provider_employment_profiles(fte_value)` → add `call_taker, partial_call_taker, is_day_doc`); how `batchValidate.ts` builds contexts (same fields must arrive there — if it shares loadContext, nothing extra; if it has its own selects, extend them identically); the `RuleCategory` union (reuse `'eligibility'` with `rule_id: null` like other implicit checks — do NOT invent a new category value unless the union is a free string).
- [x] **Step 3.2:** Types: `ShiftTypeRow` gains `generation_engine: string | null`; `EvaluationContext` gains:

```ts
  // Employment-profile pool flags (null = no profile row — treat as
  // ineligible for both pools, never silently pass)
  poolFlags: { call_taker: boolean; partial_call_taker: boolean; is_day_doc: boolean } | null;
```

- [x] **Step 3.3:** Failing tests (fixture style per file conventions — pure contexts, no DB):
  - day doc (poolFlags `{is_day_doc: true, call_taker: false, partial_call_taker: false}`) on D5 (`code:'D5'`, `generation_engine:'call'`, category `'regular'`) → 1 hard violation, message mentions "reserved for call takers".
  - call taker on 7-3 (`generation_engine:'day_pool'`) → NO violation (PTO sell-back / pickup is legitimate).
  - day doc on 7-3 → no violation. Call taker on D1 → no violation.
  - neither-flag provider on 7-3 → hard ("neither a Day Doc nor a call taker"); on D5 → hard.
  - `poolFlags: null` (no profile) on D5 AND on 7-3 → hard, message mentions missing profile.
  - open slot (providerId null) → evaluator returns [].
  - C1 assignment (category `'call'`, engine `'call'`, code not D-regex) → evaluator returns [] regardless of flags (call slots have their own pool gating at generation; not this evaluator's job).
- [x] **Step 3.4:** Implement the evaluator (register it wherever `openSlot` is registered as always-on):

```ts
// ── Pool eligibility ────────────────────────────────────────────────────────
// Always-on (Gabriel 2026-07-14, spec 2026-07-14): D1–D9 are reserved for
// call takers — a day doc there is a hard flag. Day-pool slots (7-3/7-5) are
// auto-generated for day docs, but call takers may hold them legitimately
// (PTO sell-back, extra shifts) — only a provider who is NEITHER flags.
// Hard-flag, never block: exceptions stay possible, nothing is hidden.
const D_CODE = /^D[0-9]+$/i;

const poolEligibility: Evaluator = ctx => {
  if (!ctx.providerId) return [];
  const st = ctx.shiftType;
  const isDerivedDCode = D_CODE.test(st.code) && st.generation_engine === 'call';
  const isDayPoolSlot = st.generation_engine === 'day_pool';
  if (!isDerivedDCode && !isDayPoolSlot) return [];

  const f = ctx.poolFlags;
  const violations: RuleViolation[] = [];
  const noProfile = ' (no employment profile on file)';

  if (isDerivedDCode && !(f?.call_taker || f?.partial_call_taker)) {
    violations.push({
      rule_id: null,
      rule_name: 'Pool eligibility',
      category: 'eligibility',
      severity: 'hard',
      message: `${st.code} is reserved for call takers — this provider is not a call taker${f ? '' : noProfile}.`,
    });
  }
  if (isDayPoolSlot && !(f?.is_day_doc || f?.call_taker || f?.partial_call_taker)) {
    violations.push({
      rule_id: null,
      rule_name: 'Pool eligibility',
      category: 'eligibility',
      severity: 'hard',
      message: `${st.code} is a day shift — this provider is neither a Day Doc nor a call taker${f ? '' : noProfile}.`,
    });
  }
  return violations;
};
```

  (Exact message wording/name lookup: match the file's conventions — other evaluators don't embed provider names, they rely on the flag being attached to the assignment; keep messages provider-name-free like the sketch.)
- [x] **Step 3.5:** Wire the data: loadContext select extensions (shift type `generation_engine`; profile flags into `poolFlags`, defaulting booleans with `?? false` when the row exists, `null` when no profile row). Extend batchValidate's path identically if separate. Every fixture/context builder used by tests gains `poolFlags: null` default and `generation_engine: null` on shift types so unrelated tests don't break (grep for `shiftType` fixture builders in `__fixtures__`).
- [x] **Step 3.6:** All tests green (`npm test` — 675+new baseline; goldens untouched). Verify `evaluateAssignment` (assistant path) picks the fields up automatically via loadContext — the assistant's assign_provider surfacing needs zero changes.
- [x] **Step 3.7:** Commit `feat: pool-eligibility evaluator — D-codes call-takers-only, day slots need day-doc or call-taker`.

### Task 4: Gates, final review, merge, deploy, close-out

- [x] **Step 4.1:** Full gates: `npx tsc --noEmit`, `npm test`, `npx next build`. Goldens: `npx vitest run src/lib/rulesEngine/goldenParity.test.ts` explicitly.
- [x] **Step 4.2:** schedule-engine-reviewer over the full `main..sched-pools` diff (engine files changed → mandatory per repo convention) + general reviewer for the dashboard change.
- [x] **Step 4.3:** Live sanity after merge+deploy: re-run the spec's dry-run query against live data — expect zero `eligibility` pool flags on existing assignments; trigger a revalidation of the October schedule version and confirm (a) Havildar/Ganiyu 7-3s stay clean, (b) open day slots lose their `open_slot` soft flags, (c) dashboard unfilled counts drop to call-only numbers. Report before/after counts to Gabriel.
- [x] **Step 4.4:** Merge `sched-pools` → main (--no-ff), push (deploys), verify prod dashboard loads. Plan close-out note + memory update (pool-eligibility rule semantics + the asymmetry rationale).

---

## Self-review
- Spec coverage: §1→Task 1, §2→Task 2, §3→Task 3, rollout/risks→Task 4.3. Enforcement decision (hard, non-blocking)→Task 3 severity. Asymmetry (call takers on 7-3 OK)→Task 3.3 second case.
- Adaptation points (deliberate, flagged in-task): PostgREST embed shape in queries.ts (1.2), openSlot test fixture style (2.1), loadContext/batchValidate select structure + RuleCategory union (3.1), fixture builder defaults (3.5).
- Type consistency: `poolFlags` defined once (3.2), consumed in 3.4/3.5; `generation_engine: string | null` on ShiftTypeRow everywhere.

---

## Close-out (2026-07-14)

Merged `sched-pools` → main (`bbee25f`) and deployed. All 3 tasks via subagent-driven
development with per-task reviews; schedule-engine-reviewer over the full branch
returned one FIX-FIRST finding — the evaluator's `/^D[0-9]+$/i` regex re-hardcoded
shift structure — fixed by keying the rule on `generation_engine === 'call' &&
category !== 'call'` (data-driven; a future call-derived code not named D* can't
escape). 693 tests + goldens + tsc + build green at merge.

Live rollout verification (scripts/revalidateAllVersions.ts, added this plan):
revalidated the single live schedule ("Paoli Hospital - Schedule - August 2026",
2026-08-09→11-01 — note: the "October" 7-3 pickups live in this same schedule).
Before → after: regular-slot open_slot soft flags 278 → 0 (268 open day rows now
badge-free); call open_slot flags 61 → 61 (kept); Pool-eligibility hard flags: 0
(all D1–D9 held by call takers; Havildar/Ganiyu call-taker 7-3 pickups correctly
pass per the asymmetric rule). Zero validation errors, 711/711 rows evaluated.

Engine-reviewer notes for later (not blockers): three null-generation_engine
conventions coexist (genContext default day_pool / dayShiftAutoGen legacy regex
fallback / evaluator skip) — fold into the existing Task-15 regex-fallback cleanup.
