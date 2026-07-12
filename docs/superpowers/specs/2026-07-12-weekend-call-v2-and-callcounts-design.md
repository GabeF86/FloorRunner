# Weekend Call v2 + Call Counts Expectations — Design

**Date:** 2026-07-12 · **Status:** approved by Gabriel (chat) · **Source:** `~/Downloads/proposed_weekend_call_structure (1).png`

Four independent work items: (1) month-view name fit, (2) new weekend call structure as pattern data, (3) in-house-first / best-effort fill guarantees, (4) FTE expectations in the Call Counts modal.

## Context

The site (Paoli, `2ddd2427-…`) runs the "Classic" active `CallPatternDoc`: the Saturday C1 person carries Fri C2 + Sun C2 (and Mon D1 via day chain); the Saturday C2 person carries Sun C1 + Fri D2; Neuro (C3) covers Sat→Sun. The proposed structure spreads the weekend across four people and extends Neuro to Friday. All shift codes already exist (`C1` in-house w/ post-call rule, `C2` home call, `C3` Neuro, `D1` post-2nd-call day, `D2` pre-1st-call day).

## Non-goals

- **No engine rewrite.** The structure is expressible in the existing pattern schema (`callPattern.ts`) — blocks, day chains, links. `CLASSIC_PATTERN`, `solveLegacy`, and golden-parity fixtures are untouched.
- **No change to the June 2026 draft** (user choice). It keeps its old-structure slots; the new pattern applies to schedules created after the switch. Accepted caveat: the pattern is site-wide, so a *manual* regenerate of the June draft would rebuild it under the new structure, with Friday C3 recorded unfillable (that draft has no Fri C3 slots).
- No new validation rules; `rule_definitions` unchanged.

## 1. Month view — names fit

`page.tsx` grid: assigned names render 13px/800/nowrap inside `minmax(74px, 1fr)` columns (month view floor 74px → overflow). Change, **month view only**:

- name font 13 → 11 (weight stays 800),
- column floor `minmax(74px,1fr)` → `minmax(82px,1fr)` and the `minWidth` formula's 74 → 82,
- `overflow: hidden; textOverflow: ellipsis` on the name span as a safety net (all views — harmless).

Week/Calendar views keep current sizing.

## 2. New weekend structure (pattern data)

Person-shape target (from the graphic):

| Person | Fri | Sat | Sun | Mon |
|---|---|---|---|---|
| A | C1 in-house | off (post-call) | C2 home | D1 |
| B | C2 home | C2 home | C1 in-house | off (post-call) |
| C | C3 Neuro | C3 Neuro | C3 Neuro | normal |
| E | D2 (pre-call day) | C1 in-house | off (post-call) | normal |

New active `CallPatternDoc` (replaces "Classic (ported from engine)", which is archived, not deleted):

```json
{
  "version": 1,
  "spans": [],
  "blocks": [
    { "anchorDayType": "saturday", "chains": [
      { "trigger": "C3", "links": [{ "offset": -1, "code": "C3" }, { "offset": 1, "code": "C3" }] },
      { "trigger": "C1", "links": [{ "offset": -1, "code": "D2" }] },
      { "trigger": "C2", "links": [{ "offset": -1, "code": "C2" }, { "offset": 1, "code": "C1" }] }
    ]},
    { "anchorDayType": "sunday", "chains": [
      { "trigger": "C2", "links": [{ "offset": -2, "code": "C1" }] }
    ]}
  ],
  "dayChains": [
    { "trigger": "C1", "dayTypes": ["weekday", "friday", "federal_holiday", "major_holiday"],
      "links": [{ "offset": -1, "code": "D2", "unlessCallWithinDays": 2 }], "blocks": [{ "offset": 1 }] },
    { "trigger": "C1", "dayTypes": ["saturday"], "blocks": [{ "offset": 1 }] },
    { "trigger": "C1", "dayTypes": ["sunday"], "blocks": [{ "offset": 1 }] },
    { "trigger": "C2", "dayTypes": ["weekday", "friday", "federal_holiday", "major_holiday"],
      "links": [{ "offset": -1, "code": "D3", "unlessCallWithinDays": 2 }, { "offset": 1, "code": "D1" }] },
    { "trigger": "C2", "dayTypes": ["sunday"], "links": [{ "offset": 1, "code": "D1" }] }
  ],
  "reliefPass": { "enabled": true, "dayTypes": ["weekday", "friday"] },
  "placementPasses": [
    { "kind": "pre_pto", "relativeDay": "thursday_prior_week", "codes": ["C1", "C2"], "maxProviders": 2, "enabled": true }
  ],
  "optimizerMovableDayTypes": ["weekday", "friday"],
  "callFillOrder": "call_rank"
}
```

Deltas vs Classic: Sat C1 chain loses `±1 C2`, gains `-1 D2`; Sat C2 chain swaps `-1 D2` for `-1 C2`; Sat C3 gains `-1 C3`; **new Sunday-anchored block** (`C2 → −2 C1` = Doc A: Sun C2 person carries Fri C1); **new saturday day-chain** (`C1 → block +1` = Doc E's Sun off). Everything else (weekday chains, D1>D3 precedence, relief, pre-PTO pass, Mon-D1-after-Sun-C2, Mon-off-after-Sun-C1) carries over unchanged.

Mechanics that make this work without engine edits (per ALGORITHM.md §8–9): chain call-links are gated with the full call gate and **fall through to the main loop when blocked**; a link-filled Sun C2 still fires its own sunday day chain (that is how Mon D1 works in Classic today); non-call links (`D2`) record `skippedDerived` when blocked. The Fri C2 link's day-chain interaction (D1/D3 suppression around adjacent calls) is identical to Classic's Fri-C2-as-link behavior — tests pin it.

**Plus one row in `shift_templates`:** Friday `C3` (active), so schedules created after the switch materialize Fri C3 slots. (Sat/Sun C3 templates already exist.)

**Rollout:** `supabase_scheduling_patch19_weekend_v2_pattern.sql` — archive current active pattern row, insert the new doc as active (zod-validated by a script before application), insert the Friday C3 template. Applied to the live DB via the `supabase-floorrunner` MCP after review, per CLAUDE.md migration convention.

## 3. In-house priority, best-effort fill

Requirement: in-house calls (C1) are the priority; when chain links can't be honored (PTO, cross-site, occupied), the schedule still fills as fully as possible.

Design = *prove the existing engine already guarantees this, add a lever only if a probe falsifies it*:

- **Golden-shape test:** generate a weekend from a pure fixture context under the new doc with an unconstrained pool → assert the exact A/B/C/E shape of §2, including Sat/Sun post-call offs and Mon D1.
- **Chain-break probes:** (a) Sat-C2 anchor's best candidate has Sunday PTO → Sun C1 must still be **filled** (standalone via main-loop fall-through, different provider), skip recorded; (b) Fri-C1 anchor blocked for Sun C2 → Sun C2 filled standalone, Mon D1 follows the *actual* Sun C2 assignee; (c) Fri D2 link blocked → recorded in `skippedDerived`, Sat C1 unaffected.
- **Priority verification:** confirm `shift_types.call_rank` ranks C1 first and that within-day fill order cannot starve a C1 behind C2/C3 under pool pressure (probe with a minimal pool). The lever IS implemented: an opt-in `callFillOrder: 'call_rank'` pattern-schema field that makes `solve()` process same-day call slots in `call_rank` order when a doc sets it; absent, legacy fill order applies, so Classic and every other existing pattern carry zero golden-parity risk. Any divergence introduced when the field is set on the new weekend-v2 doc must be enumerated in `goldenParity.test.ts` or the change is rejected.

Invariants 1–6 all continue to apply; nothing in this item weakens PTO/pending-PTO blocking, cross-site checks, or skip recording.

## 4. Call Counts modal — FTE + expectations

Formula (user choice A, matches existing red-cell/Extra-Calls math): `expected(provider, bucket, code) = (bucket-code slot total ÷ site call_par_level) × fte_value`, par level currently 12, FTE from `grid.profiles.fte_value` (default 1).

- Extract the target math into one exported helper (used by grid red-cells, `getExtra`, and the new displays) with unit tests — three call sites, one formula.
- Provider cell: `S. Smith · 0.75` (FTE dimmed; omit when profile absent).
- Each bucket×code count cell: `3 (2.6)` — expected at one decimal, dimmed, smaller font; `—` cells show `— (2.6)` only when expected ≥ 0.05, else stay `—`.
- New **Expected** row immediately under **Total**: per bucket×code column Σ expected across listed providers (one decimal); Call Total column shows Σ of row expectations. Extra Calls and PTO columns show `—` in this row.
- Print stylesheet unaffected (same table structure, one extra row).

Interpretation aid (documented in a row tooltip): when the Expected row is below the Total row, the roster's summed FTE is under the par level — the shortfall is exactly the extra-call burden someone must absorb.

## Testing summary

- Engine: new `weekendV2Pattern.test.ts` fixture suite (§3 above) — pure `GenerationContext`, no DB.
- UI: unit tests for the extracted expectation helper; existing suite stays green; `npm test` + `tsc` + `next build`.
- Golden parity: must remain green with zero new enumerated divergences unless item 3's lever is triggered (then divergences enumerated explicitly).
- Live verification after patch19: create a throwaway future-dated schedule at the site, generate, spot-check one weekend against the A/B/C/E shape, then delete it.

## Risks

- **Day-chain cascade off a link:** §2 relies on link-filled slots firing their own day chains (true in Classic for Sun C2 → Mon D1). The golden-shape test pins it; if it fails for the Friday-anchored block specifically, the fallback is adding `{offset 3, code "D1"}` to the Friday chain — same outcome, no engine change.
- **Anchor order between Friday and Saturday blocks — RESOLVED** by the sunday-anchored expression: the engine fills saturday → sunday → friday → weekday, so a `-2` back-link from the Sunday C2 anchor fires before Friday is processed, meaning it reliably claims Fri C1 regardless of block ordering — no dependency on Friday being placed by the main loop first. Probe (b) covers the failure mode.
- **June draft manual regenerate** rebuilds under the new pattern (accepted, documented above).
