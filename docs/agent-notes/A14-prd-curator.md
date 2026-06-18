# A14 — PRD Curator Agent Runbook

**Owner:** Agent A14 (PRD Curator)
**Scope:** Keep `docs/PRD-Grid-Calculator.md` synced with shipped reality by
producing revision proposals; never edit the PRD directly.
**PRD reference:** §14 A14 charter, §19 Changelog.

## Files A14 owns

- `docs/PRD-revisions/` (entire directory) — proposal documents and this README.
- `docs/agent-notes/A14-prd-curator.md` (this file) — the runbook.

## Files A14 must NEVER modify

- `docs/PRD-Grid-Calculator.md` — Gabriel edits, A14 only proposes.
- Any other `docs/agent-notes/*.md` — those agents own their own notes.
- Any component (`src/app/**`), library (`src/lib/**`), test, or migration.

## Loop

Per PRD §14 A14: **weekly cadence**, plus **on-demand** when Gabriel asks "what
changed?" or when an agent surfaces a contradiction.

```
1. Read PRD-Grid-Calculator.md (always — establishes the baseline).
2. Read every docs/agent-notes/*.md modified since the last proposal.
3. Read docs/aesthetic-checkpoints/* + docs/aesthetic-reviews/* for visual drift.
4. Read docs/paoli-validation.md for sanity-band drift.
5. Scan (don't deeply read) src/lib/gridCalculator/* to verify rule-shape
   claims and acceptance-criteria numbers cited by other agents.
6. Scan supabase_scheduling_patch*.sql to confirm what landed vs. PRD §13.
7. Diff against PRD v<latest>:
   - For each candidate drift, verify against the actual file/code.
   - If a drift in someone else's report is wrong (already fixed, mis-cited),
     note it explicitly in the proposal and skip applying the fix.
   - Sort by impact: correctness (solver behavior, FTE numbers) > usability
     (label drift, toggle wording) > documentation (Changelog hygiene).
8. Write docs/PRD-revisions/YYYY-MM-DD-v<X.Y>-proposal.md.
9. Surface [GABRIEL ATTENTION] items at the bottom — anesthesia questions that
   only Gabriel can answer.
10. Report to the orchestrator (≤ 400 words): drift count by category, top 3
    highest-impact drifts, drifts that weren't on the working list, [GABRIEL
    ATTENTION] count.
```

## Drift inventory taxonomy

Each drift fits one of five buckets. Sort proposals by this order; correctness
first.

| Bucket | Examples | Priority |
|---|---|---|
| **Correctness** | Solver doesn't honor a rule the normalizer emits; FTE math diverges from reality; sanity bands documented wrong. | 1 |
| **Charter mismatch** | Agent shipped a different file path than the PRD specifies (e.g. patch numbering). | 2 |
| **Open question** | Deferred decisions or ambiguity that hasn't yet been resolved (e.g. RLS bodies). | 3 |
| **Decisions log** | Aesthetic / staffing choices Gabriel locked in but not yet captured in §18. | 4 |
| **Changelog hygiene** | Version-bump entries (§19) when a Tier or feature ships. | 5 |

## Escalation rule

If a drift can only be resolved by an anesthesia answer (e.g. "is per-diem CRNA
really 0.5 FTE?"), tag it `[GABRIEL ATTENTION]` and group at the bottom of the
proposal. Don't try to answer it.

## Source-of-truth checklist (run every sweep)

- [ ] `docs/PRD-Grid-Calculator.md` — read top to bottom.
- [ ] `docs/agent-notes/A2-provider-profile.md`
- [ ] `docs/agent-notes/A4-rules-normalizer.md`
- [ ] `docs/agent-notes/A6-float-strategy.md`
- [ ] `docs/agent-notes/A7-fte-simulator.md`
- [ ] Any newer `docs/agent-notes/A*.md` files added since last sweep.
- [ ] `docs/aesthetic-checkpoints/A9-initial.md` + any newer checkpoints.
- [ ] `docs/aesthetic-reviews/README.md` and the latest dated audit markdown.
- [ ] `docs/paoli-validation.md`
- [ ] `supabase_scheduling_patch14*.sql`, `patch15*.sql`, `patch16*.sql`, and
      any newer additive patches.
- [ ] `ls src/lib/gridCalculator/` and `ls src/app/(scheduling)/grid-calculator/`
      to spot files A14 hasn't seen before (a new module = new drift surface).

## Initial run notes (2026-06-17)

The first proposal (`2026-06-17-v1.1-proposal.md`) covers the full backlog from
PRD v1 signoff through Tier 1+2+3 (A9, A10, A11) shipping. Future sweeps should
focus on the delta since the previous proposal.
