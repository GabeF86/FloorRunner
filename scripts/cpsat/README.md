# CP-SAT benchmark

Measures how far the greedy call engine is from the best schedule that exists.
**A measuring instrument, not a production path.** Nothing here is deployed,
nothing writes to the database, and the Next.js app does not import it.

## Running it

```bash
python3 -m pip install -r scripts/cpsat/requirements.txt

npx tsx scripts/exportCpsatModel.ts <scheduleVersionId> model.json
python3 scripts/cpsat/model.py model.json --mode all
python3 scripts/cpsat/model.py model.json --mode obligatory
npx tsx scripts/compareCpsat.ts <scheduleVersionId> model.json
```

## What makes the comparison honest

The solver never decides whether a provider *may* take a slot. That verdict
comes from the engine's own `evaluateEligibility`, exported as the variable
domain. A solver that "wins" by forgetting the adjacent-week PTO rule has not
beaten the engine — so it is not allowed to forget it. The only thing measured
is the **arrangement** of placements both sides agree are legal.

The exporter also carries calls already committed elsewhere in the block
(`priorCalls` / `busyDates`). The first version did not, and the benchmark then
handed the solver 16 calls of capacity the engine had already spent — reporting
a gap that was partly the harness. A benchmark that flatters the challenger is
worse than no benchmark.

## What the gap does NOT include

Everything the engine does that is not optimisation: chains it constructs
rather than constrains, seeds it refuses to overwrite, targeted and scoped
runs, stale-seed eviction, request tiers, and the per-slot per-candidate
rejection report a chief reads when a slot will not fill. A solver matching the
numbers would still have to grow all of that.

## Results, 2026-09-22

| block | mode | engine | optimal | gap |
|---|---|---|---|---|
| Jun 15 – Aug 30 (175 slots, from scratch) | fill-all | 1.345 | 0.300 | 4.5× |
| Jun 15 – Aug 30 | **obligatory** | **0.086** | **0.086** | **1.0× — already optimal** |
| Oct 26 – Jan 4 (146 slots, 16 prior calls) | fill-all | 2.894 | 0.416 | 7.0× |
| Oct 26 – Jan 4 | **obligatory** | **1.749** | **0.341** | **5.1×** |

The headline is the difference between the two blocks, not either number.
On a block generated **from scratch** the engine reaches the proven optimum in
obligatory mode — every provider exactly at their obligation. On a block that
is **partly built already** it strands obligations: six of ten providers finish
short (Kalawadia 9 of 15 owed) where the solver gets all ten to their number.

Partly-built is the realistic case — generate, hand-edit, regenerate.

## Can the existing optimizer close the gap? No — measured 2026-09-22

`scripts/measureOptimizerScope.ts` raises the optimizer's budget and lets it
move weekend slots, on the October block that fell 5.1× short.

| arm | fill-all stdev | obligatory stdev |
|---|---|---|
| baseline (2s, weekday+friday) | 2.894 | 1.749 |
| budget 30s | 2.894 | 1.749 |
| weekends movable | 2.894 | 1.749 |
| both | 2.894 | 1.749 |
| **CP-SAT, proved optimal** | **0.416** | **0.341** |

**Nothing moves.** The instrumentation says why:

- **Fill-all: the optimizer is CONVERGED, not starved.** 528 re-solves at a
  2-second budget and 528 at 30 seconds — it stops because no improving move
  exists, not because it ran out of time.
- **Obligatory: it IS budget-limited** — 1,647 re-solves at 2s, 10,372 at 30s
  — and six times the work found nothing. Same local optimum.
- **Weekends barely widen the set.** Movable slots go 73 → 76 (fill-all) and
  45 → 48 (obligatory). Three more slots, because nearly every weekend slot is
  a chain anchor or a chain link and both are excluded by design.

The optimizer's move set is two moves: a 2-slot eviction to fill a gap, and a
single fairness swap. Getting from 1.749 to 0.341 needs multi-slot
rearrangements in which no single move improves — a local optimum a
hill-climber cannot leave by construction. More time cannot help. More scope
cannot help. The answer is a richer move set (ruin-and-recreate, 3-opt) or a
solver.

### Chains survived, and the guard is why

Broken-chain count is IDENTICAL across all four arms: 1 in fill-all, 2 in
obligatory. Widening the movable day types created none. The two-layer guard
holds — links carry source `weekend-chain`/`d-chain` and are never movable;
anchors are excluded by id from `chainAnchorSlotIds`.

Those 1–2 are not optimizer damage. They exist in the GREEDY plan before the
optimizer runs, with both ends placed by the main loop, and both are RECORDED
in `skippedDerived` with honest reasons — `occupied` (the Friday C2 was taken
before the Saturday anchor reached it) and `pto` (the Friday C1 holder is on
leave the Sunday its +2 link lands on). Clinical invariant 4 holding: a
severed link is reported, never silently dropped.
