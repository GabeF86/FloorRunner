# A6 — Float Strategy Agent Notes

**Owner:** Agent A6 (Float Strategy)
**Scope:** `src/lib/gridCalculator/floatStrategy.ts` — replace A3's placeholder
float emitter; emit a Float Health badge.
**Tests:** `src/lib/gridCalculator/__tests__/floatStrategy.test.ts` (7 cases).

## Public API

```ts
applyFloatStrategy(grid: SolvedGrid, options: {
  mode: FloatStrategyMode;
  surplus: FloatSurplusProvider[];
  sites: GridSite[];
  distanceMatrix?: DistanceMatrixWithBands;
  expectedDisruptions?: ExpectedDisruptions;
}): SolvedGrid

assessFloatHealth(grid: SolvedGrid, surplus: FloatSurplusProvider[],
                  expectedDemand?: number): FloatHealth
```

Both are pure functions. `applyFloatStrategy` is idempotent (test #6) so A7
(FTE Simulator) can call it once per simulated day without worrying about
order-of-operations side effects.

## Float math

- **Demand:** each non-float room provider contributes 3 breaks/day
  (morning / lunch / afternoon). Counted heads:
  - `solo_md` rooms: the MD.
  - `supervised_md_crna` rooms: each CRNA. (The supervising MD is NOT counted —
    they rotate between cases.)
  - `solo_crna_with_remote_md` rooms: each CRNA.
- **Supply:** each float covers 5 breaks/day (Paoli's `bkFloats = totalFloats * 5`
  adapted universally).
- **Severity bands** (PRD §12, mirrors Paoli ~358):
  - ≥100% → `ok`
  - 75-99% → `tight`
  - 50-74% → `warning`
  - <50% → `critical`
- **Edge case:** 0 demand + 0 supply → `ok` ("no break demand").

## Mode behaviors

- `break_priority` — every float leans to the largest site (the "Main-OR
  -equivalent"). Stable: ties broken by lowest `position`, then id.
- `emergency_priority` — every float leans to the largest **trauma-likely** site.
  The trauma-likely site is found by scoring sites by room count minus a
  proximity penalty (distance band cost) relative to the largest site. When no
  distance matrix is supplied, this collapses to "largest site" — the sensible
  universal default per PRD §14.
- `balanced` — even-indexed floats lean break, odd-indexed lean emergency.
  Single float → break (the day-to-day need). Falls back gracefully if either
  anchor is missing (e.g. only one site).

## Signals I'd want from A3 (not blocking — graceful fallbacks in place)

These would let `floatStrategy.ts` produce better lean decisions without me
recomputing them locally. None are blocking; the module ships today without
them. Filing here so A3 can pick them up when they touch `solver.ts` next.

1. **Site size metadata on the SolvedGrid.** Today A6 receives the full `sites`
   array via `ApplyFloatStrategyOptions` and recomputes "largest site" each
   call. If the solver emitted a `sites` digest (e.g. `{ siteId, roomCount,
   staffedRoomCount }[]`) the strategy could distinguish "8 rooms total" from
   "8 rooms but 3 unstaffed" — the latter shouldn't anchor breaks.
2. **Proximity-to-largest-site annotation.** A precomputed `nearestSiteId` per
   site (using the distance matrix) would skip the `proximityCostBetween` scan
   inside `pickEmergencyAnchorSite`. Cheap optimization; A7 will call the
   strategy 1,000+ times per Monte Carlo run.
3. **Per-room acuity tag passthrough.** `GridRoom.acuityHint` is captured by
   A1/A4 but not surfaced in `RoomAssignment`. Knowing which rooms are
   trauma-likely vs. low-acuity would let `emergency_priority` weight trauma
   bays specifically rather than relying on the "largest site = trauma center"
   heuristic. Universal enough to belong in the solver output.
4. **Coordinator/Floor-Runner role flag.** PRD §17 has an open question about
   whether Floor Runner becomes a universal "Coordinator" concept. When that's
   resolved, `RoomAssignment` should expose a `isFloorRunner` or
   `isCoordinator` boolean so the demand calc can subtract those heads (per
   PRD §14 wording: "non-Float, non-Float-Coordinator CRNA"). Today we don't
   subtract any — Paoli's Floor Runner is the only known instance and is
   currently expressed via room-level guidelines.

## Universality

No FloorRunner-specific imports. The `staffingCalculator/paoli.ts` break
analysis was *studied* (severity-band thresholds, demand/supply framing) but
not imported. Paoli's hospital-specific assumptions (Endo MD, OB MD, Floor
Runner cap) stay in `seeds/paoli.ts` per PRD §17.

## Handoff to A7 (FTE Simulator)

Per-day loop in `fteSimulator.ts` should look like:

```ts
for (const day of simulatedYear) {
  const solved = solve({ ...input, roster: dayRoster });
  const surplus = computeSurplus(dayRoster, solved); // A7-owned helper
  const grid   = applyFloatStrategy(solved, {
    mode: config.floatStrategy,
    surplus,
    sites,
    distanceMatrix,
    expectedDisruptions: day.disruptions,
  });
  const health = assessFloatHealth(grid, surplus);
  // PRD §12: if health < 'tight' on > 10% of days, bump float CRNAs by 1.
}
```

A7 owns the "compute surplus" helper — it knows which providers are sidelined
by leave buckets that day. A6 has no opinion on that mapping.

## Test coverage

7 tests, matching A3's tsx + node:assert harness:

1. `0 surplus + 4 rooms` → critical (PRD §14 acceptance bullet).
2. `2 surplus + 6 rooms` under `break_priority` → both floats lean to Main OR.
3. `emergency_priority` with Main OR + Endo → at least one float leans to
   the trauma-likely (largest) site.
4. `balanced` produces a deterministic, repeatable split.
5. Severity bands (`ok`/`tight`/`warning`/`critical`) match PRD §12 thresholds.
6. Idempotent — running twice produces byte-identical output (assignments,
   floats, violations).
7. Defensive: empty sites array → `leansToSiteId: null` (no crash).
