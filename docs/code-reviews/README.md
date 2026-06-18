# Code Reviews

Owned by Agent **A13 (Code Review)** per PRD §14.

This folder holds every formal code review the A13 agent produces. There is
one report per review event, named `YYYY-MM-DD-<scope>.md`.

## When A13 reviews

- **Initial merge:** the bulk grid-calculator surface area on `main` before
  the first set of PRs lands. Captured in `2026-06-17-initial.md`.
- **On-PR:** every subsequent PR opened by any agent in the fleet. A13 attaches
  a review report in this folder (link from the PR description) and posts the
  same findings as PR comments via `gh pr review`.
- **Ad-hoc:** when Gabriel asks A13 to re-audit a specific module (e.g. after
  a numerical-correctness scare in A7 or A8).

## Review depth

Effort level: **high** for the initial merge and for any PR that touches
`solver.ts`, `fteSimulator.ts`, `callBurden.ts`, `rulesNormalizer.ts`, or any
SQL migration. Effort level: **medium** for UI components and `state.ts`.

## Report format

Each report is a single Markdown file with these sections:

1. **Summary** — files reviewed, LOC, finding counts by severity, recommendation
   (`merge-ok` / `merge-after-fixes` / `block-merge`).
2. **Findings** — one block per finding, ordered ERROR → WARN → INFO. Each
   block names file:line, category (correctness / universality / security /
   type-safety / performance / docs), the issue (2-3 sentences), and a
   suggested fix (1-2 sentences, no patches — A13 flags, the owning agent
   fixes).
3. **Cross-agent integration audit** — one-line verdict per inter-agent seam
   (A3↔A6, A3↔A7, A4↔A3, A8↔A7, A1↔A5, etc.).
4. **What's good** — 2–4 bullets keeping the bar honest.

## Severity ladder

- **CRITICAL** — security vulnerability (e.g. user input flowing unvalidated to
  a system call, an API key logged, or a clinical-safety regression). Posted
  at the very top of the report, blocks merge regardless of other findings.
- **ERROR** — a real bug A13 would block a real PR over (off-by-one, null-deref,
  race, math error, RLS gap, universality leak in a `src/lib/gridCalculator/`
  module).
- **WARN** — degraded quality (type-safety lapse, perf smell, doc drift,
  missing validation at a module boundary) that should be fixed but isn't
  a merge blocker on its own.
- **INFO** — observation worth recording but not action-required (style note,
  potential future refactor).

A13 never raises a finding for "missing trailing newline" or other formatter-
class issues. The bar is "would I block a real PR for this?".

## Cross-agent integration audit charter

The agent fleet ships in parallel. The biggest risk is that A6 / A7 / A8 build
against A3's documented shapes but the production code paths drift. Each
report verifies the following seams from the consuming side (i.e. does the
caller actually read the producer's output shape correctly?):

- **A1 ↔ A5** — distance-matrix primitives reused; A5 doesn't duplicate them.
- **A3 ↔ A6** — `floatStrategy.applyFloatStrategy()` consumes the solver's
  `SolvedGrid` from real code, not just fixtures.
- **A3 ↔ A7** — `fteSimulator.solve(...)` per simulated day passes the same
  `SolverInput` the solver expects.
- **A4 ↔ A3** — `normalizeRules` returns a `CoverageRuleSet` matching what
  the solver consumes (site name vs id keying, etc.).
- **A8 ↔ A7** — `callBurden.distributeCall(...)` is called once per simulator
  run with a roster shape it actually understands.

## Escalation

If A13 finds a `CRITICAL`, it pings Gabriel immediately via the standard
`PushNotification` channel and refuses to mark the PR as reviewable until
the issue is acknowledged.

If A13 finds the same finding repeated across ≥3 reviews from the same agent,
it adds a "pattern note" to that agent's runbook in `docs/agent-notes/` so the
owning agent can adjust its own pre-flight checks.
