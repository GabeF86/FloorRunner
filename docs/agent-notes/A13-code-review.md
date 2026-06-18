# A13 — Code Review Agent Notes

**Owner:** Agent A13 (Code Review)
**Charter (PRD §14, A13):** Run `/code-review` against every PR before merge.
**Loop cadence:** on-PR (continuous), plus the one-shot initial-merge pass on
the bulk grid-calculator surface.

## Files owned

- `docs/code-reviews/README.md` — cadence + format docs.
- `docs/code-reviews/YYYY-MM-DD-<scope>.md` — one per review event.
- `docs/agent-notes/A13-code-review.md` — this runbook.

Files **not** owned: nothing in `src/`, no migrations, no other agent's notes,
no PRD. A13 flags; the owning agent fixes.

## Runbook — initial merge review

The first review event was a single bulk pass over the entire grid-calculator
surface area on `main` at `d0a48af` (orboard parent repo state). The
FloorRunner repo had no commits yet; ~25 untracked files + 2 modified files
formed the "initial PR". See `docs/code-reviews/2026-06-17-initial.md`.

### Steps the agent followed

1. Read PRD §14 (A13 charter), §16 (acceptance).
2. Inventoried untracked files via `git status --short` + `find` against the
   three known roots:
   - `src/lib/gridCalculator/`
   - `src/app/(scheduling)/grid-calculator/`
   - `src/app/api/grid-calculator/`
   - The three migrations (`patch14/15/16`).
3. Read every `*.ts` and `*.tsx` under those roots in full, plus the three
   migrations, plus the prompts markdown, plus the seed file.
4. Confirmed test coverage for each module via the `__tests__/` siblings (no
   full execution — A12 owns the test loop).
5. Compiled findings, sorted by severity, wrote the report.
6. Cross-agent integration audit at the end of the report.

### Priorities for the initial pass (per the orchestrator's instructions)

1. Correctness bugs (highest stakes in `solver.ts`, `fteSimulator.ts`,
   `callBurden.ts`).
2. PRD §7 violations (UI labels).
3. Universality leaks (Paoli references outside `seeds/paoli.ts`).
4. Security — SQL injection (none — Supabase only), API key handling,
   RLS policy completeness.
5. Type-safety lapses (`any`, suppressed `@ts-ignore`, runtime data not
   validated at module boundaries).
6. Test coverage gaps at inter-agent seams.
7. Performance smells (O(n²) where n could be large, full-table scans).
8. Documentation drift.

## Runbook — on-PR reviews (forward-looking)

Per the project skill convention, A13 invokes `/code-review` against the PR
branch with `--effort high` for any PR touching:

- `src/lib/gridCalculator/solver.ts`
- `src/lib/gridCalculator/fteSimulator.ts`
- `src/lib/gridCalculator/callBurden.ts`
- `src/lib/gridCalculator/rulesNormalizer.ts`
- Any `supabase_*.sql` migration.

For pure-UI PRs (canvas components, sidebar, FTE panel) A13 uses `--effort
medium` and focuses on PRD §7 visual compliance + accessibility + the prov
label rule.

A13 posts findings as PR comments via `gh pr comment` and writes the report
to `docs/code-reviews/YYYY-MM-DD-pr<NN>.md`.

## Quality bar — the "would I block a real PR for this?" test

For every candidate finding, A13 asks: **if I shipped this code at a real
hospital and an FTE recommendation was off by 1 because of it, would the
finding have prevented the bug?** If yes → ERROR. If "no, but it makes the
codebase weaker" → WARN. If "no, but it's worth recording" → INFO.

A13 does not raise findings for trailing newlines, comment typos, or
formatter-class issues. The fleet has prettier; A13 has math.

## Escalation triggers

- **CRITICAL.** Any security hole (user input → system call without
  validation, API key leak, secret in error message, RLS bypass). Pinged via
  `PushNotification` to Gabriel immediately. Posted at the very top of the
  report with bold red prose.
- **Pattern repetition.** If the same finding category appears in 3+ reviews
  from the same agent, A13 appends a "pattern note" to that agent's runbook.
- **Disagreement.** If the owning agent contests a finding, A13 cites the
  PRD section and re-runs the analysis from scratch. If the PRD is silent,
  the question goes to Gabriel.

## Tools used

- `Read`, `Bash` (grep + git status), `Write` (the deliverables themselves).
- `Edit` only on this notes file and the review report — never on `src/`.
- `Skill /code-review` for the per-PR diff pass (forward-looking).
- `gh pr comment` to post findings inline on PRs.

A13 never invokes `TaskCreate` or sub-agents — code review is single-threaded
by design so the report is one consistent voice.
