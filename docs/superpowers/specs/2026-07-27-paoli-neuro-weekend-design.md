# Paoli Neuro Weekend Restructure — Design

**Date:** 2026-07-27 · **Status:** approved (Gabriel, this session) · **Scope:** Paoli only — Friday C3 slot removal, weekendV2 pattern edit, one new `CallPatternDoc` config block, one new pure module, three engine touchpoints, one generation-report addition, one DB patch.

## Intent

Gabriel, verbatim: *"I want the Friday C2 doc to cross cover Neuro call on fridays and the designated neuro call doc is assigned saturday and sunday neuro. In terms of the partial FTE docs, the 0.75 docs should be assigned a neuro weekend but the 0.5 FTE doc should get either a saturday or a sunday not both."*

Today one neuro doc (Doc C) covers C3 from Friday evening through Sunday, plus the Friday D4 day shift — the Saturday-C3 anchor pulls all four onto one provider. After this change:

- **Friday has no neuro line.** Neuro coverage on Friday is part of the Friday C2 role, unnamed on the board (Gabriel's choice over stacking a zero-burden C3 on the C2 doc).
- **The neuro weekend is Sat + Sun**, still one provider, still holding Friday D4 when available.
- **FTE decides the shape.** 1.0 and 0.75 docs take the Sat+Sun pair as one unit; the 0.5 doc takes one weekend day only, either day.
- **The unpaired day goes to a doc who still owes neuro**, and counts as HALF a neuro weekend for them. Nobody else is eligible, so with no short doc available it stays open for the admin. A 1.0 doc has no neuro requirement, so a full-FTE doc is never pulled into a half neuro weekend.
- **Each 0.75 doc owes one full neuro weekend per block**, steered by the engine and flagged by validation when the block ends short. 1.0 docs keep rotating through neuro by the normal fairness math with no per-block requirement.

## The unit: half weekends

Neuro obligation is counted in weekend UNITS, on the same half-weekend arithmetic as the Call Counts Obligatory Weekends column: a Sat+Sun pair is **1.0**, a single weekend day is **0.5**, keyed by the weekend's Saturday (`weekendGroupKey`, `lib/weekendGroup.ts`).

| FTE band | owes per block | shape |
|---|---|---|
| ≥ 1.0 | — (fairness only) | pair |
| 0.75 ≤ FTE < 1.0 | 1.0 unit | pair |
| < 0.75 | 0.5 unit | single day |

A 0.75 doc who takes a leftover single day banks 0.5 and still owes 0.5 — two such days across a block clear the requirement, exactly as one paired weekend would.

**How the 0.5 doc gets "either a Saturday or a Sunday":** Saturday fills before Sunday (`dayTypeFillOrder`), so a Saturday anchor normally chains its Sunday partner. The 0.5 doc lands on **Saturday** by being the Saturday anchor (their pair link is FTE-gated off), or on **Sunday** by taking a remainder day another partial doc's gated anchor left open. There is no separate mechanism for the Sunday case — it is the remainder gate doing its job, which is why the remainder credit must be available to any short doc, not just to whoever created the remainder.

## Decisions taken (and rejected alternatives)

**FTE rules live in the `CallPatternDoc`, not the solver.** Per CLAUDE.md, structure is declared in the pattern; the engine interprets. Two alternatives were rejected on the merits:

- *Scenario/manifest layer (`scenario.ts` `neuroTarget`)* — already models neuro obligations in weekend UNITS, but it is only populated by a workbook import. Ordinary generation would silently ignore Gabriel's rules.
- *`provider_limits` caps (patch34)* — caps are ceilings, and chain admission is whole-block (`capAdmitsPlacements`). A "C3 ≤ 1" cap on the 0.5 doc would refuse the entire Sat+Sun anchor, so they would get **no** neuro rather than one day. Wrong direction and wrong mechanism.

## Changes

1. **`supabase_scheduling_patch38_paoli_neuro_weekend.sql`** — deactivate the Paoli `friday / C3` row in `scheduling.shift_templates` (`is_active = false`; site `2ddd2427-22fb-4290-9c4c-03a957e5af4e`). That single row is the only source of Friday neuro slots (verified: call templates are weekday C1/C2, friday C1/C2/C3, sat C1/C2/C3, sun C1/C2/C3, holidays C1/C2). The patch also replaces the site's active `call_patterns.definition` with the doc from change 2 — the two MUST land together (see Rollout).

2. **`patterns/weekendV2.ts`** — the Saturday-C3 block chain loses its Friday neuro link and gains the FTE gate:

   ```
   before: { trigger: 'C3', links: [ {-1, C3}, {-1, D4}, {+1, C3} ] }
   after:  { trigger: 'C3', links: [ {-1, D4}, {+1, C3, minFte: 0.75} ] }
   ```

   Dropping `{-1, C3}` is not optional: `applyBlockChains` records a `no-slot` `skippedDerived` entry for a link whose target does not exist (invariant 4), so leaving it would log a phantom skip every weekend. `{-1, D4}` stays and remains best-effort — an unavailable neuro doc skips the link and D4 falls through to the normal day-shift fill (Gabriel: *"Friday D4 should be given to the doc on neuro call that weekend if available"*).

3. **`callPattern.ts` — `minFte` on block-chain links.** `BlockChainSchema.links` gains an optional `minFte: z.number().min(0).max(1)`. Absent = always fires (CLASSIC_PATTERN and every other site are byte-identical). The doc-level `neuroWeekend` config block is added alongside:

   ```ts
   neuroWeekend: {
     code: 'C3',
     // Ordered bands, first match wins on `fte >= minFte` descending.
     // `units` = weekend units owed per block; 0 = no requirement
     // (1.0 docs rotate by fairness alone and are never flagged).
     requirementBands: [
       { minFte: 1.0,  units: 0   },
       { minFte: 0.75, units: 1   },
       { minFte: 0,    units: 0.5 },
     ],
   } | null
   ```

   Nullable and absent from every existing doc, so classic/other sites are inert.

4. **`solveKernel.applyBlockChains`** — a link carrying `minFte` is skipped when `chosen.fte_value < minFte` (`CandidateProvider.fte_value` is already on the candidate). The skip is recorded as `skippedDerived` with a new reason `fte-gated`, so a suppressed pair is visible rather than silent (invariant 4). When the gate fires, the target slot id is added to `state.neuroRemainderSlotIds`.

5. **`eligibility.ts` — remainder gate.** A call slot in `state.neuroRemainderSlotIds` admits a provider only when they are still short of their band's neuro requirement by at least half a unit (`owed − credited ≥ 0.5`). That excludes 1.0 docs by construction (they owe 0), so a full-FTE doc is never pulled into a half neuro weekend, while a short 0.75 doc may take the day and bank 0.5. New rejection reason `neuro-remainder`. Placed with the other scenario/limit gates — AFTER every safety gate, so a safety block always wins the reported reason. Inert when `neuroWeekend` is null. No short doc available ⇒ the slot stays unfilled and surfaces in the existing call-only unfilled warnings, which is the intended "leave it for the admin" outcome.

6. **`solveKernel.scoreCall`** — providers short of their neuro requirement sort ahead for `C3` anchors, most-short first. Implemented as a tier term beside the existing `prefTier`, never as a hard gate: a block that cannot satisfy every requirement still fills, and the shortfall is reported by change 7 rather than blanking slots.

7. **`neuroWeekend.ts` (new) + generation report.** The shortfall is reported through the GENERATION report, not `evaluators.ts`. Evaluators are per-assignment (`EvaluationContext` = one slot + that provider's neighbors), so a provider who received **no** neuro at all — the case most worth catching — has no assignment to anchor a flag on and would never be evaluated. Instead:

   - `rulesEngine/neuroWeekend.ts` — pure module owning the whole vocabulary: band lookup (`owedUnitsFor(fte, config)`), unit crediting (`creditedUnits(placements)` — pair 1.0, single day 0.5, grouped by `weekendGroupKey`), and `computeNeuroReport(...)` returning per-provider `{ provider_id, fte, owed, credited, short }`.
   - The solver's gate and steering (changes 5–6) consume the same module, so the report can never disagree with the placement rules.
   - `autoGenerate` surfaces short providers into `GenerationResult.warnings`, exactly as `plan.requestWarnings` is surfaced today, and carries the full rows as `GenerationResult.neuroReport` alongside `workDayReport`. Absent when the pattern states no `neuroWeekend` config — additive, so existing consumers see no new key.

   No `rule_definitions` row and no new evaluator.

## Non-goals

- Other sites. Their patterns have no `neuroWeekend` block and no `minFte` links; behavior is byte-identical.
- Existing schedule versions. Drafts and published versions keep the Friday C3 rows they already have — only newly generated slot sets lose them. Cleaning up open drafts is a separate, explicit step if Gabriel wants it.
- The `is_overlay` flag on C3 stays as-is. With no Friday C3 slot the overlay exemption is unused by this pattern (weekends have no day shifts), but it is not this change's business to remove.

## Testing

- **Pattern/schema:** `minFte` parses, round-trips, and defaults to absent; a doc with `neuroWeekend: null` is accepted; `CLASSIC_PATTERN` and `WEEKEND_V2_PATTERN` still parse.
- **Chain gate (fixture `GenerationContext`, no DB):** a 1.0 anchor takes Sat+Sun; a 0.75 anchor takes Sat+Sun; a 0.5 anchor takes Saturday only, records one `fte-gated` skip, and tags the Sunday slot as a remainder.
- **Remainder pool:** with the Sunday tagged, a 1.0 doc is rejected `neuro-remainder` (owes 0, never short); a 0.75 doc still short by ≥ 0.5 is admitted and banks 0.5; a 0.75 doc already at 1.0 units is rejected; with nobody short the slot is left unfilled (and appears in unfilled-call warnings) rather than falling to a full doc.
- **Requirement steering:** in a block with two neuro weekends and two 0.75 docs, each gets one — asserted on placements, not on scores.
- **Report (`neuroWeekend.ts`):** a 0.75 doc with a Sat-only neuro weekend is short (0.5 of 1.0); with Sat+Sun is not; with two separate single days is not (0.5 + 0.5); a 1.0 doc with no neuro weekend is never short; a 0.5 doc with no neuro day is short (0 of 0.5); a provider with no neuro placements at all still appears in the report (the case an evaluator would have missed entirely).
- **Friday:** no Friday C3 slot is generated; no `no-slot` skipped-derived entries appear for C3; the neuro doc still receives Fri D4 when available and the link is skipped cleanly when not.
- **Regression:** golden parity 8/8 unchanged (classic pattern untouched); existing `weekendV2Pattern.test.ts` expectations updated for the dropped Friday link — every changed expectation reviewed as intentional, never re-baselined wholesale; full `npm test`; `tsc --noEmit`.

## Rollout

- **ORDER: push `main` FIRST, then apply the patch.** CORRECTED 2026-07-27 — this file originally said the opposite, and that order actively misgenerates. `CallPatternDocSchema` is `.strict()`, so the PRE-change deployed code REJECTS the new doc (`Unrecognized key: "minFte"`, `Unrecognized key: "neuroWeekend"`). `genContext` turns a parse failure into `callPattern = undefined` plus a warning, and `solve()` then falls back to `CLASSIC_PATTERN` — so in a DB-first window every Paoli generation produces a classic-pattern schedule (no weekend chains, no `dayTypeFillOrder`, no relief pass, no C2→D1 post-call chain) and still commits, with only a warning to show for it. Code-first is completely safe in the other direction: both new fields are optional, so new code reading the OLD doc is byte-identical to today.
- Apply the patch via the project-scoped `supabase-floorrunner` MCP (ref `qhwdbtixhzdsgwwtcfrm` — verify before applying). Template row and pattern doc still must change together WITHIN the patch (they are one transaction): the deactivated Friday C3 with an unedited pattern logs phantom skips; the edited pattern with a live Friday C3 leaves a Friday neuro slot nobody chains.
- Gabriel regenerates a draft when ready and reviews the weekend: Friday shows C1/C2 only, the neuro doc holds Sat+Sun (+ Fri D4), and the 0.5 doc's weekend shows one neuro day with its partner day either partial-filled or open.
- The Obligatory Weekends column needs no change: weekend units are the widest weekend day's call tiers, and Sat/Sun still carry three each.
