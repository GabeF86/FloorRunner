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
