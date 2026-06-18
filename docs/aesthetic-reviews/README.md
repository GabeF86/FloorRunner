# Aesthetic Reviews — A10 Loop

**Owner:** Agent A10 — Aesthetic Review Loop
**Charter:** PRD §14, A10. Periodic visual audit of the Grid Calculator
canvas + FTE panel; compare against PRD §7 and the locked Variant C baseline;
surface drift to Gabriel.

This directory is the home for A10's outputs:

| File | Purpose |
|---|---|
| `baseline.json` | Machine-readable snapshot of every locked aesthetic constraint. Updated only on a fresh aesthetic checkpoint approved by Gabriel. |
| `YYYY-MM-DD-<topic>.md` | Markdown audit reports — one per checkpoint or one-off review. |
| `YYYY-MM-DD.json` | Raw JSON output from `scripts/aesthetic-audit.ts` (weekly runs). |

---

## What this loop is (and isn't)

**It is** a static code + DOM-shape audit. The script greps the
`/src/app/(scheduling)/grid-calculator` files for the patterns the locked
baseline requires (color tokens, label literals, dimensional constants,
layout constants), and emits a structured findings report.

**It isn't** a screenshot pipeline. A10 sub-agents don't have reliable
browser tooling in the Claude Code harness; running Puppeteer / Playwright
from a sub-agent is flaky and produces brittle pixel-diffs. The static check
is intentionally cheaper, deterministic, and CI-friendly.

If pixel-level review is needed later, Gabriel can invoke the `/verify` skill
in a fresh session to launch the app, screenshot the canvas, and eyeball.
The static audit is the **weekly** gate; the screenshot review is the
**checkpoint** gate.

---

## How to invoke

### One-off

```sh
npx tsx scripts/aesthetic-audit.ts
```

Prints the JSON report to stdout. Exits **0** if no `severity: 'error'`
findings; exits **1** otherwise.

### Weekly snapshot

```sh
npx tsx scripts/aesthetic-audit.ts > docs/aesthetic-reviews/$(date +%F).json
```

Writes the snapshot to a date-stamped file in this directory. Future weeks
diff the new snapshot against the previous one to surface drift over time
(simple `diff` works; the JSON is stable-ordered).

### CI gate (proposal — Gabriel registers)

```yaml
# .github/workflows/aesthetic-audit.yml (proposed)
on: [pull_request]
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx tsx scripts/aesthetic-audit.ts
```

The script's non-zero exit code fails the job on any drift.

---

## Cadence (proposed)

| Mode | Frequency | Trigger | Output |
|---|---|---|---|
| Static audit | **Weekly** | Cron via `/schedule` | JSON snapshot in this directory |
| Drift escalation | On error | Audit exit code 1 | `PushNotification` to Gabriel (see below) |
| Checkpoint review | Ad-hoc | Gabriel requests | Full markdown report (annotated) |

**Recommended weekly slot:** Monday 09:00 local — the file lands before the
Tuesday standup.

**Registration command (Gabriel only — A10 does not register):**

```
/schedule weekly mon 09:00 npx tsx scripts/aesthetic-audit.ts > docs/aesthetic-reviews/$(date +%F).json
```

Or for the simpler `/loop` flavor:

```
/loop 7d /aesthetic-audit
```

The `/aesthetic-audit` slash-command shape would simply invoke the script
and post a summary; concrete slash registration is a Gabriel-side task.

---

## Checkpoint refresh workflow

When Gabriel approves a new layout variant or color update, the baseline
needs to roll forward in lockstep:

1. **Update the checkpoint doc.** Add a new file in
   `docs/aesthetic-checkpoints/AN-<topic>.md` describing the change and the
   final approved values. (A9 + Gabriel.)
2. **Update `baseline.json`.** Bump the `version` field, set `lockedAt` to
   the approval date, and edit only the fields that changed. Leave a comment
   in the next audit report explaining the diff.
3. **Update `state.ts` constants.** `LAYOUT_VARIANT` and `LAYOUT_DIMENSIONS`
   are the single source of truth in code. The audit cross-checks them
   against `baseline.json`.
4. **Re-run the audit.** Verify the previous-baseline findings have cleared
   and no new drift was introduced by the migration. Save the JSON snapshot
   as `YYYY-MM-DD-checkpoint-<n>.json`.
5. **Write a markdown report.** Title: `YYYY-MM-DD-checkpoint-<n>.md`.
   Include before/after notes, the variant flag, and any decisions Gabriel
   made on aesthetic ambiguities.

The checkpoint doc owns the **rationale**; baseline.json owns the
**machine-readable constraints**; this directory's markdown owns the
**audit history**.

---

## Escalation

Any `severity: 'error'` finding gets surfaced to Gabriel immediately. The
recommended wiring is:

1. The cron-registered `/schedule` job pipes the script's stderr / exit
   code into a `PushNotification` tool call. Sketch:

   ```
   #!/bin/sh
   if ! npx tsx scripts/aesthetic-audit.ts > /tmp/audit.json; then
     gh issue create --title "Aesthetic drift detected on $(date +%F)" \
        --body "$(cat /tmp/audit.json | jq '.findings')" \
        --assignee gabrielfarkas
   fi
   cp /tmp/audit.json docs/aesthetic-reviews/$(date +%F).json
   ```

2. Alternatively, the `/loop` skill registers a recurring task that runs
   the audit and posts a Slack-style notification on failure. The skill is
   Gabriel-side; A10 documents the wiring but does not call it.

`severity: 'warn'` findings are logged in the JSON but do not escalate —
they accumulate as a watch-list the next weekly run picks up.

---

## Files Gabriel cares about

| When | Open | Why |
|---|---|---|
| A new finding lands | The dated markdown report | Human-readable; suggested fixes inline. |
| A checkpoint is moving | `baseline.json` | Edit the values that changed. |
| Adding a new visual rule | `baseline.json` → `rules[]` | Add a new entry with a `check` shape (see existing rules). |
| New `check.kind` needed | `scripts/aesthetic-audit.ts` → `runCheck()` switch | Add a handler. Type-safe; the `never` exhaustiveness check catches missing branches. |

---

## File ownership

A10 owns:

- `docs/aesthetic-reviews/` (this directory)
- `scripts/aesthetic-audit.ts`

A10 does **not** modify:

- Any component file under `src/app/(scheduling)/grid-calculator/` (A9 owns).
- Any library file under `src/lib/gridCalculator/` (A1/A3/A4/A5/A6/A7/A8 own).
- The PRD or any aesthetic checkpoint doc (Gabriel + A9 own).

When the audit catches drift, A10 **flags** the file:line — it does not
silently patch.

---

## Quick reference — current locked baseline

(Snapshot from `baseline.json` for human readability — the JSON file is the
source of truth.)

- **Layout variant:** `hybrid` (Variant C — locked 2026-06-17 by Gabriel).
- **Lane header width:** **160 px**.
- **Room card min-width:** **220 px**.
- **Shimmer:** **200 ms** fade-up + blur-out.
- **Colors:**
  - Anesthesiologist amber family `#f59e0b`.
  - CRNA cyan family `#0ea5e9`.
  - Cross-site supervision: dashed purple `#a855f7`.
  - Float: dashed slate (outlined, no fill).
  - Over-ratio violation: red `#ef4444` border.
- **Labels in rendered UI:** ALWAYS `"Anesthesiologist"` / `"CRNA"`. NEVER
  the literal `"MD"` (internal type names + SQL columns are exempt).
- **9 visual rules** codified in `baseline.json` → `rules[]`.
