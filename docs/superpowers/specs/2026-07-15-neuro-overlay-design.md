# Neuro Overlay — Doc C's Friday Day Shift + Evening C3 Design

**Date:** 2026-07-15 · **Status:** approved (Gabriel: "D4 on Friday should also be Neuro call") · **Scope:** C3 becomes an overlay shift; Friday D4 slots exist; the Sat-C3 block carries Friday D4; engine same-date checks honor overlays in both directions.

## Intent (Gabriel's Doc C, corrected 2026-07-15)

Doc C works a REGULAR DAY (D4) on Friday and starts neuro call (C3) that evening, then carries C3 Saturday and Sunday. One person, one block: Fri D4 + Fri C3 (overlay) + Sat C3 + Sun C3. Docs A/B/D verified already correct in the live pattern.

## Grounding

- `is_overlay` exists end-to-end in the call engine: eligibility.ts:39-44 exempts overlay SLOT placement from the one-assignment-per-day budget; solve.ts has isOverlay helpers (~43, ~429 — verify what they gate: overlay assignments must also NOT mark assignedOnDate, so a later non-overlay same-date placement passes). C3 is currently `is_overlay=false` in live data.
- Friday D4 slots DO NOT EXIST: D4's only template row is `day_type='weekday'` (excludes friday, its own day_type). C3 templates cover fri/sat/sun. Templates are (site_id, schedule_layer, day_type, shift_type_id, required_count) rows.
- The live pattern's Sat C3 anchor links Fri C3 + Sun C3 (weekendV2.ts). patch19 seeded the live `call_patterns` doc from the WEEKEND_V2_PATTERN constant via an emit script (scripts/emitWeekendV2Patch.ts) — keep constant and live doc in sync the same way.
- D4 is `category='regular', generation_engine='call'` — block-chain links already fill regular codes (Doc D's Fri D2), same mechanics. poolEligibility: D4 requires call_taker — Doc C is one. C3 has `requires_post_call_rule=false` (no post-call blocking — Doc C works through the weekend).

## Changes

### Code
1. **weekendV2.ts**: Sat C3 anchor chain gains `{ offset: -1, code: 'D4' }` → links: Fri C3, Fri D4, Sun C3. Comment updated with the Doc C semantics.
2. **Engine overlay audit (both directions), fixing what's missing:**
   - solve/seedSolveState: placing or seeding an OVERLAY assignment must not mark `assignedOnDate` (verify current behavior; fix if it marks). Placing a non-overlay onto a date where the provider holds only overlay assignments must pass. Chain-link ordering (C3 overlay then D4, or D4 then C3) must work in either order.
   - dayShiftAutoGen: the already-assigned-on-date exclusion must ignore overlay-type assignments (needs is_overlay on its conflict-row select).
   - sequenceAutoFill: occupied checks on windowAssignments must ignore overlay rows (verify stCols carries is_overlay; extend if not).
   - committedAssignments/cross-schedule conflict scans (crossSiteByDate/externalConflictByDate): an overlay assignment in ANOTHER schedule blocking this one — cross-site overlay semantics: a published overlay C3 elsewhere SHOULD still block (the person is on neuro call — clinically busy at that site... actually C3 is home/evening call; cross-SITE same-day day work at another site is precisely what Doc C does at the same site). DECISION: keep cross-schedule blocking as-is for v1 (conservative — overlay coexistence is same-site block design; cross-site overlaps stay conservative). Document in code.
   - Validation: verify no evaluator hard-flags same-provider same-date same-site pairs (crossSite is cross-site only); coverage/pooleligibility unaffected (D4 call_taker ✓).
3. Tests: chain places all four pieces on one provider (Fri D4 + Fri C3 + Sat C3 + Sun C3), both link orders; day engine skips someone holding non-overlay but not someone holding ONLY overlay; sequenceAutoFill occupied ignores overlay; golden parity untouched (classic pattern has no overlay codes; C3 overlay flag comes from ctx fixtures — parity fixtures unchanged).

### Data (patch25, applied at rollout with the deploy)
4. `UPDATE scheduling.shift_types SET is_overlay = true WHERE code = 'C3'`.
5. INSERT the Friday D4 shift_template row (mirror the weekday D4 row's site/layer/required_count, day_type='friday').
6. INSERT missing Friday D4 slots (+ their `open` assignment rows, one-row-per-slot model) into EXISTING draft schedule versions, idempotent (NOT EXISTS guards), derived_day_type='friday'.
7. Update the live call_patterns active definition with the new Sat-C3 chain (emit from the constant, patch19-style).

## Non-goals
- No other overlay shift types; no C3 template changes; no post-call rule change for C3; cross-schedule overlay semantics stay conservative (documented).

## Rollout
Deploy + patch25 as one step; Gabriel regenerates and verifies Doc C's block appears as one person's Fri D4/C3 + Sat/Sun C3 in the grid and Call Counts.

---

## Close-out (2026-07-15)

Shipped with the friday-first re-anchor (merge `d0efa5a`; patch25 applied + verified
structurally: C3 is_overlay=true, Friday D4 template active, 11 Friday D4 slots
backfilled into the drafts, live pattern carries the D4 link).

Engine review round 1 was FIX-FIRST with three PROVEN severity-1 findings — the
naive overlay exemption allowed call-on-call stacking (Sat C1 onto the Sat C3
holder, even with free providers) and post-call blocked-day bypass. Final overlay
semantics: an overlay CALL coexists with REGULAR day work only; call-category
placements collide with ANY same-date call; blocked days always bind
(SolveState.blockedOnDate). sequenceAutoFill uses a two-sided category-aware
coexists predicate. All collision directions negatively tested. Follow-up
candidate from review: no evaluator flags same-provider/same-site/same-date call
pairs (construction prevents; manual edits aren't flagged) — small evaluator later.
