# Measurement scripts

Read-only harnesses that load a REAL schedule version and race engine variants
purely in memory. They never call `commitPlan` — nothing is written.

Deliberately OUTSIDE `src/` so `npm test` never picks them up: they hit the
live database, which a unit suite must not.

    MEASURE_VERSION=<schedule_version_id> \
      npx vitest run --root . scripts/measure/spacing.measure.ts

## spacing.measure.ts — 2026-07-31

Answers "would enabling the optimizer improve C1 spacing?" on the live Paoli
block (177 call slots, 11 providers, par 11), by rebuilding the version as a
from-scratch board (every call slot open) and running each variant.

Result, and it is a NEGATIVE one:

| variant                     | calls | unfilled | avg gap | C1 ≤2 | C1 ≤3 | over cap |
|-----------------------------|-------|----------|---------|-------|-------|----------|
| obligatory greedy (shipped) |   152 |       59 |   11.36 |     2 |     9 |        0 |
| obligatory + optimizer      |   152 |       59 |   11.36 |     2 |     9 |        0 |
| obligatory + multiStart K=8 |   152 |       59 |   11.36 |     2 |     9 |        0 |
| all greedy                  |   176 |       26 |   10.34 |     2 |    11 |       10 |
| all + optimizer             |   176 |       19 |    9.96 |     3 |    13 |       11 |
| all + multiStart K=8        |   176 |       17 |   10.18 |     5 |    15 |        9 |

1. In OBLIGATORY mode the optimizer is inert — byte-identical output after
   4387 re-solves, 1916 of them gated. With every provider at their obligation
   cap there is no slack: any swap pushes someone over, and
   planWithinObligations rejects it. Multi-start likewise collapses (25ms for
   8 starts, same plan) — the tie-break rotation never binds.
2. In FILL-ALL both make spacing WORSE while making coverage better. Their
   objective is coverage and fairness; `spacingScore`'s gap terms rank below
   its coverage terms, so the race trades adjacency for filled slots.
3. Coverage and spacing are in direct tension on this block. 177 slots across
   ~8.7 pool FTE means filling more necessarily packs calls closer, and the
   shipped obligatory greedy already has the best spacing of any variant
   BECAUSE it fills the fewest.

So "turn on the optimizer" is not the lever. The lever, if one is wanted, is a
placement-time minimum-gap preference in scoreCall for same-parent-code calls —
obligatory mode leaves 59 slots open anyway, so being pickier costs little.
