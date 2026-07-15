# Split Saturday/Sunday Fairness Buckets — Design

**Date:** 2026-07-15 · **Status:** approved (Gabriel: "I want to first split up saturday and sunday C1's and C2") · **Scope:** engine bucket keys + history RPC (patch24) + Call Counts modal columns. The par-level denominator fix is deliberately deferred (his "first").

## Intent

Call fairness buckets become day-specific for weekends: `saturday|C1`, `saturday|C2`, `sunday|C1`, `sunday|C2` (etc. for C3) instead of the merged `weekend|<code>`. Each category is then independently per-FTE-even with historical deficit carry-forward — over successive blocks every call taker rotates through 1 Sat C1, 1 Sat C2, 1 Sun C1, 1 Sun C2, 1 Fri C1, 1 Fri C2 (exact one-each-per-block is arithmetically impossible with ~4 weekends and ~9 takers; evenness + history produces the rotation across blocks — stated to Gabriel).

## Changes

1. **`dayTypeBucket` (shared.ts:140-146):** `saturday → 'saturday'`, `sunday → 'sunday'` (drop the merge). `friday`/`weekday` unchanged; `federal_holiday/major_holiday → 'holiday'` merge KEPT (not in scope).
2. **`supabase_scheduling_patch24_split_weekend_history.sql`:** CREATE OR REPLACE `historical_call_counts` — the bucket CASE returns `saturday`/`sunday` via `ss.derived_day_type::text` for those values instead of collapsing to `'weekend'`; holiday merge and the patch21 published-only join PRESERVED (start from the patch21 definition, not patch18). History recomputes from raw assignments — no stored aggregates to migrate. The genContext legacy fallback uses dayTypeBucket and follows automatically.
3. **Call Counts modal (`page.tsx` ~2142, ~2167):** the bucket column list `{ key: 'weekend', label: 'Sat/Sun' }` splits into `{ key: 'saturday', label: 'Sat' }` and `{ key: 'sunday', label: 'Sun' }`; the local bucket classifier (~2167) mirrors dayTypeBucket. Expected row + fteTarget follow the keys automatically — verify column count/layout still fits the modal.
4. **Sweep:** any other consumer of the `'weekend'` bucket-key string (metrics.ts fairness, assistant get_call_burden/fairness tools, genContext quota warnings, weekendV2 pattern doc references, tests). NOTE: `counts_as_weekend_burden` shift-type flags, `weekend_call_eligible`, weekend-first fill order, and weekend CHAINS are all unrelated to bucket keys — do not touch.
5. **Golden parity:** solve and solveLegacy consume the same precomputed ctx (bucketTarget built in genContext) — both see the new keys identically, so parity should HOLD. If any parity fixture drifts, stop and report rather than re-baselining.

## Testing
- dayTypeBucket unit expectations updated; both directions pinned (saturday ≠ sunday buckets; a provider's sat-heavy history no longer offsets sun deficits).
- genContext bucket totals/targets tests updated for split keys; quota-warning messages carry the new keys.
- Fixture-level: a two-weekend context where the old merge would allow provider A = 2 Saturdays / provider B = 2 Sundays as "even" — assert the split targets steer A and B toward one of each instead.
- Call Counts modal: fteTarget tests keys; visual check at rollout.
- Golden parity 8/8 unchanged. Full suite; tsc; build.

## Rollout
- Deploy + apply patch24 together (same reverse-window logic as patch21 — until applied, the live RPC returns 'weekend' rows whose keys no longer match, so history contributes nothing rather than wrong data; addHistorical simply keys them into buckets no target reads. Deploy + apply promptly as one step).
- Regenerate nothing automatically; Gabriel regenerates when ready and reviews the Call Counts modal (now with Sat and Sun columns).
