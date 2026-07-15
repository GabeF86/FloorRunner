# Call-Only Unfilled Counts + Day/Call Pool Eligibility — Design

**Date:** 2026-07-14 · **Status:** approved in conversation (3 asks + enforcement decision) · **Scope:** dashboard rollup, open-slot validation, one new eligibility evaluator. No schema changes.

Gabriel's asks, verbatim intent:
1. Only call shifts count as "unfilled slots."
2. Unfilled day slots must not show the "?" badge.
3. 7-3/7-5 slots only go to day docs; D1–D9 slots are reserved for call takers.

Enforcement decision (Gabriel): wrong-pool assignments are **hard-flagged but allowed** — red "!" through every path, never blocked, never hidden.

## Current behavior (investigated 2026-07-14)

- Generation banner ("X could not be filled") already counts call slots only (`genContext.ts:284` filters `category === 'call'`). No change needed.
- Dashboard attention rollup (`dashboard/queries.ts` `attentionFor`) counts EVERY slot with no filling assignment — its query (`ATTENTION_COLUMNS`, line ~244) doesn't load shift_type category at all.
- The "?" is the soft-validation badge (`schedules/[id]/page.tsx:1409-1422`); it appears on unfilled day slots because the always-on `openSlot` evaluator (`evaluators.ts:717-753`) writes a soft `open_slot` flag on every open slot with no category check. Unfilled cell content is "—" (or red "OPEN" for posted open call) — the content is fine, only the badge is wrong.
- Auto-generation already enforces ask 3 in both directions: day-pool engine owns only `generation_engine='day_pool'` slots (7-3/7-5 in live data) and pools only `is_day_doc=true` physicians; D1–D9 are `category='regular', generation_engine='call'` (patch18) and are filled by the call engine (chains + relief pass) whose pool is `call_taker OR partial_call_taker` (`genContext.ts:380-383`). The unguarded paths are manual grid edits and the assistant's `assign_provider` (`scheduleAssistant/mutations.ts` `assignProviderToSlot`) — both run `evaluateAssignment` and surface flags, so a new evaluator covers both automatically.

## Changes

### 1. Dashboard unfilled = call only
- `ATTENTION_COLUMNS` gains a `shift_types(category)` embed; `AttentionSlotRow` gains the field; `attentionFor` increments `unfilled` only when `category === 'call'`.
- `assigned`/`checked`/`hard` accounting stays category-blind (unchanged) — those aggregate real assignments and violations, which remain meaningful for day slots.
- Tests: `attnSlot` fixture builder defaults `shift_types: { category: 'call' }` (keeps existing assertions meaningful); new case proving an unfilled `regular` slot is NOT counted; the 1499-slot rollup test keeps its intent via the call default.

### 2. No soft open-slot flag for non-call slots (fix at the source)
- `evaluators.ts` `openSlot` default branch (lines ~743-750): emit the soft `open_slot` violation only when `ctx.shiftType.category === 'call'`. The rule-driven deadline branch (can escalate to hard) is untouched.
- Effect: no "?" badge on unfilled day slots (grid), no soft-count inflation (dashboard), no open-day-slot noise in validation reports. Day cells keep the plain "—".
- Verify during implementation that the assistant's `get_open_slots`/coverage tools enumerate open slots from assignment rows, NOT from `open_slot` flags; if any tool is flag-driven, repoint it to rows so the assistant still sees open day shifts.
- The grid renderer needs no change (badge disappears because the flag is never written). Existing already-written `open_slot` flags on day slots in the live DB will clear on the next validation run of each version; note this in rollout.

### 3. Pool-eligibility evaluator (hard, non-blocking)
- New always-on evaluator in `evaluators.ts` (same registration pattern as `openSlot`), fires only when a provider IS assigned:
  - Slot owned by the day pool (`shift_types.generation_engine === 'day_pool'`): provider's employment profile must have `is_day_doc = true`, else hard violation `pool_eligibility`: "<code> is a Day Doc shift — <name> is not a Day Doc."
  - Slot with code matching `/^D[0-9]+$/i` and `generation_engine === 'call'` (the derived/relief D-codes): profile must have `call_taker OR partial_call_taker`, else hard violation: "<code> is reserved for call takers — <name> is not a call taker."
  - Missing employment profile → treat as ineligible for both pools (hard flag with a "no employment profile" message) — never silently pass (invariant 6 spirit).
- Keyed on `generation_engine` (data-driven), not hardcoded code lists, except the D-code regex which mirrors the engine's own ownership convention (patch18). If a site later adds day codes, marking them `day_pool` makes the rule follow automatically.
- Surfaces everywhere `validation_flags` already surface: grid "!" badge, dashboard hard counts, assistant `assign_provider` responses, batch validation. No blocking anywhere.
- The evaluator needs the provider's profile flags in its context — extend the evaluator context load if they're not already fetched (check `evaluateAssignment`'s provider load).

## Non-goals
- No change to generation pools or engines (already correct).
- No change to the "filled" count asymmetry in the generation banner (counts call+day fills; fine).
- No blocking UI. No schema changes. No new rule_definition rows required (always-on evaluator, like openSlot's default branch); site-configurable severity can come later if ever needed.

## Testing
- Evaluator unit tests (day doc on D5 → hard; call taker on 7-3 → hard; correct pools → clean; missing profile → hard; open slot stays untouched by this evaluator).
- openSlot: soft flag on open call slot still emitted; NOT emitted for open regular slot; deadline-hard branch unaffected.
- Dashboard rollup tests per §1.
- Full suite + tsc + build; goldens must be untouched (no engine fill behavior changes).

## Risks
- Existing soft `open_slot` flags on day slots persist until each version revalidates — cosmetic, self-healing.
- Providers with neither flag set (not day doc, not call taker) will now hard-flag on BOTH slot families — correct behavior, but if the roster data has unset flags for legitimate workers, the grid will light up; check live data during rollout and report counts to Gabriel before merging.
