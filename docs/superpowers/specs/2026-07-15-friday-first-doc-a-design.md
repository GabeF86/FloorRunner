# Friday-First Doc A — Re-anchor + Pattern-Data Fill Order Design

**Date:** 2026-07-15 · **Status:** approved (Gabriel: "For DOC A position, I want you to fill the Friday C1 first and then fill the Sunday C2 with the same doc") · **Scope:** CallPatternDoc schema extension + weekendV2 pattern change, shipping on the `neuro-overlay` branch (one pattern-doc rollout).

## Problem

Doc A is sunday-anchored today: the engine picks the Sunday C2 person, and a −2 back-link claims Friday C1. When the Sunday anchor starves (quota/eligibility — routine under par 12 vs 8.82 ΣFTE), the Friday C1 link never fires and Friday C1 goes blank unless the fallback pass finds someone. Gabriel wants the in-house Friday C1 chosen FIRST, with Sunday C2 riding along to the same doc — the correct failure ordering (home-call Sunday starves before in-house Friday).

## Blocker: fill order is hardcoded

genContext sorts slotsToFill with a hardcoded dayOrder (saturday 0, sunday 1, friday 2, weekday 3, holidays 4). A friday-anchored block only works if the friday pass runs BEFORE sunday (else the sunday pass claims Sun C2 independently). Per CLAUDE.md: never hardcode structure — extend the pattern schema.

## Changes

1. **CallPatternDoc schema (`callPattern.ts`):** new optional field `dayTypeFillOrder?: string[]` — an ordered list of day-type names (values from the derived_day_type vocabulary: saturday, sunday, friday, weekday, federal_holiday, major_holiday). Absent → the current default order EXACTLY (saturday, sunday, friday, weekday, holidays-with-weekday-fallback semantics preserved). Validation: unknown names → load warning (pattern-warning conventions like callFillOrderWarnings); listed day types get their index; unlisted fall to the tail (current `?? 5` semantics). Document in the schema comment + the assistant's CALL_PATTERN_DOC_SCHEMA description if that schema enumerates fields (check — update_call_pattern is zod-validated; keep in sync).
2. **genContext sort:** consult the active pattern's dayTypeFillOrder when present (genContext already knows the pattern — it reads callFillOrder). The IMPORTANT comment at ~296-315 (sort reads derived_day_type directly, not dayTypeBucket) still applies — the order list is keyed on derived_day_type values, NOT buckets.
3. **weekendV2.ts pattern:**
   - `dayTypeFillOrder: ['saturday', 'friday', 'sunday', 'weekday', 'federal_holiday', 'major_holiday']` (holidays keep tail position — verify against current default behavior for holiday call slots).
   - REMOVE the sunday-anchored block (`{ anchorDayType: 'sunday', chains: [{ trigger: 'C2', links: [{ offset: -2, code: 'C1' }] }] }`).
   - ADD a friday-anchored block: `{ anchorDayType: 'friday', chains: [{ trigger: 'C1', links: [{ offset: 2, code: 'C2' }] }] }`.
   - Verify the rest of Doc A still assembles: Saturday blocked via Fri C1's existing dayChain `blocks: [{offset: 1}]`; Monday D1 via the sunday C2 dayChain `links: [{offset: 1, code: 'D1'}]` — CONFIRM dayChains fire on block-link placements (current live behavior implies yes: today's Fri C1 is itself a link placement and its Saturday block works — pin with a test). Thursday D2: the friday C1 dayChain's `{offset: -1, code: 'D2', unlessCallWithinDays: 2}` — Doc A now has Sun C2 two days after Fri C1; verify unlessCallWithinDays suppresses/permits identically to current live behavior (whatever today produces for Doc A must not change — pin it).
4. **Pass interaction proof (test):** full weekend fixture under the new order — saturday pass: Doc B (Sat C2 → Fri C2 + Sun C1), Doc D (Sat C1 → Fri D2, Sun blocked), Doc C (Sat C3 → Fri C3 + Fri D4 + Sun C3); friday pass: Doc A (Fri C1 anchor → Sun C2 link, Sat blocked, Mon D1); sunday pass: nothing left but leftovers. Assert all four docs distinct and every weekend slot filled; assert the starved-sunday scenario now leaves Sunday C2 (not Friday C1) as the unfilled slot when the pool can't cover Doc A.
5. **patch25 re-emit** (same branch): the emitted pattern-doc update now carries BOTH changes (D4 link + re-anchor + dayTypeFillOrder). One live rollout.
6. **Golden parity:** classic pattern has no dayTypeFillOrder → default order → parity untouched (8/8, zero fixture edits). solveLegacy: NEVER edited; it consumes ctx.slotsToFill pre-sorted by genContext, so the schema field flows through context — confirm parity fixtures use the classic pattern only.

## Non-goals
- No change to Doc B/C/D chains. No engine-hardcoded order variants. No changes to callFillOrder (within-date) semantics — the two fields compose (dayTypeFillOrder = across dates/day-types; callFillOrder = within a date).

## Rollout
Ships with the neuro-overlay branch: deploy + patch25 (re-emitted) as one step; Gabriel regenerates August and verifies Doc A's Friday C1 fills first and blanks (if any) moved to Sunday C2.
