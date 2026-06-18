## PRD revisions — A14 curator workflow

**Owner:** Agent A14 — PRD Curator.
**Charter:** PRD §14, A14. Keep `docs/PRD-Grid-Calculator.md` synced with shipped
reality. Surface drift; never silently rewrite the PRD.

This directory holds **revision proposals** for the Grid Calculator PRD. Each
proposal is a markdown patch document that Gabriel reviews, approves (or edits),
and then applies in one pass to `PRD-Grid-Calculator.md`. The PRD itself is
edited only by Gabriel — A14 writes the diff and waits.

---

### File naming

```
YYYY-MM-DD-v<X.Y>-proposal.md
```

- `YYYY-MM-DD` — the date the proposal was assembled.
- `v<X.Y>` — the PRD version the proposal would land. The current PRD is `v1`
  (see `PRD-Grid-Calculator.md` "Status" line). A revision that adds Changelog
  entries + Decisions log entries without structural edits bumps the minor
  number (`v1.1`); a revision that rewrites a numbered section bumps the
  major (`v2`).
- `proposal.md` — proposed text, never the canonical PRD.

When Gabriel approves and applies the proposal, A14 archives it in place (do
not delete) and starts the next proposal at the next version.

---

### Proposal document shape

Every proposal opens with a single TL;DR table:

| # | Drift | PRD section | Impact |
|---|---|---|---|

Then each drift is its own section with this template:

```markdown
### Drift N — <short title>

- **Source of truth:** <which file/agent/finding revealed it>
- **PRD section affected:** §<n>
- **Proposed text:** the exact paragraph/line to insert (markdown-ready)
- **Why:** 1–2 sentences explaining the cost of not fixing this.
```

`[GABRIEL ATTENTION]` items group at the bottom of the proposal. These are
drifts that can only be resolved by Gabriel answering a substantive anesthesia
question — A14 does not guess.

The document ends with a **"Ready-to-apply patch"** appendix listing every
section the PRD would gain, in the order Gabriel would paste them in.

---

### Cadence

- **Weekly** sweep per PRD §14 A14: A14 reads every agent's notes, the audit
  reports, validation reports, and the shipped code (scan), then diffs against
  the PRD and assembles a proposal.
- **On-demand** when Gabriel asks "what changed?" or when an agent posts a
  change that contradicts the PRD.
- **First run** (this one): full inventory of every known drift from PRD v1 to
  the state of the world on 2026-06-17.

---

### What A14 never does

- Modify `PRD-Grid-Calculator.md` directly.
- Modify any agent's notes file.
- Modify any component, library, test, or migration.
- Resolve anesthesia ambiguity unilaterally — those items get
  `[GABRIEL ATTENTION]` and wait.

### What A14 always does

- Verifies every drift against the actual file/code, not just secondhand
  reports. If a drift in the orchestrator's working list is wrong (e.g.
  already fixed), the proposal says so and skips it.
- Sorts drifts by impact: correctness > usability > documentation.
- Surfaces drifts even when they are uncomfortable (e.g. an open question that
  has been deferred for weeks).
