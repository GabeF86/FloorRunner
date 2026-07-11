# Scheduler — How It Works

Target audience: an engineer who needs to change the scheduler. This is the map, not the tour.

## 1. Overview

Two passes, wired in [`/api/scheduling/schedules/[id]/generate`](src/app/api/scheduling/schedules/[id]/generate/route.ts):

1. **Call gen** — [`autoGenerate.ts`](src/lib/rulesEngine/autoGenerate.ts) orchestrates: [`loadGenerationContext`](src/lib/rulesEngine/genContext.ts) (all DB reads) → [`solve()`](src/lib/rulesEngine/solve.ts) (pure greedy — interprets the site's **CallPatternDoc**, see §15) → [`optimize()`](src/lib/rulesEngine/optimize.ts) (bounded hill-climb) → [`commitPlan`](src/lib/rulesEngine/commit.ts) (batched writes) → batch validation ([`batchValidate.ts`](src/lib/rulesEngine/batchValidate.ts)). Physician call shifts (`category='call'`) and their pattern-derived D-shifts.
2. **Day-shift gen** — [`dayShiftAutoGen.ts`](src/lib/rulesEngine/dayShiftAutoGen.ts). Day Doc placements (`category='regular'`, `generation_engine='day_pool'`). Runs after call gen so it sees the D-chain placements and doesn't collide.

Both are idempotent. Neither overwrites manual or already-assigned slots. Shared helpers — date math, PTO constants, bookend logic, the canonical `isBlockingAvailability` predicate — live in [`shared.ts`](src/lib/rulesEngine/shared.ts).

**Structure is data, not code.** Weekend/block chains, post-/pre-call fills, post-call day-off blocks, spans, placement passes, relief config and optimizer scope all come from the site's active `scheduling.call_patterns` row; `solve()` interprets whatever the doc says. No active pattern row → `CLASSIC_PATTERN` fallback (identical behavior to the pre-v2 hard-coded engine). Validation constraints stay in `rule_definitions` (§12) — patterns say how schedules are *built*, rules say what they must *satisfy*.

**What comes back** (`GenerationResult`): `assignments` (with placement `source` + scoring `explanation`), `unfilled` (per-slot candidate rejections, trimmed to 3 + `omittedCandidates` by [`trimUnfilled`](src/lib/rulesEngine/trimUnfilled.ts)), `skippedDerived` (§9), `warnings` (load-time advisories, §15), `optimizeStats` (§11), `metrics`/`seedMetrics`, `perf`.

## 2. Data touched

| Table | Role |
|---|---|
| `call_patterns` | The active CallPatternDoc per site — all structural behavior (§15) |
| `schedule_slots` | What's being filled |
| `assignments` | One row per `(slot, provider)`; holds `source_type`, `validation_flags` |
| `providers` | Must be `status = 'active'` to be considered |
| `provider_employment_profiles` | FTE, `call_taker`/`partial_call_taker`/`is_day_doc`, `available_weekdays`, `days_per_week`, `preferred_day_shift_types` |
| `provider_site_credentials` | Per-site `is_active`, `credentialed`, `can_take_call`, weekend/holiday variants, allowed/excluded shift types |
| `provider_availability` | PTO / FMLA / sick / blocked / etc. with `approval_status` — PENDING blocks (`isBlockingAvailability`) |
| `shift_types` | Behavior flags the engine reads per code: `call_rank`, `relief_rank`, `is_overlay`, `generation_engine`, `requires_post_call_rule` (patch18 columns) |
| `sites.call_par_level` | Denominator for FTE-share math (defaults to 12) |
| `schedules.included_provider_ids` | Optional pool override set from the UI |

Historical fairness counts come from the `scheduling.historical_call_counts` RPC (one aggregate query); if the function is missing (patch18 not applied) genContext falls back to the legacy row scan and pushes a warning.

## 3. Pool selection

**Call gen default pool** (ignored when `included_provider_ids` is set):

```
home_site_id = schedule.site_id
AND (call_taker = true OR partial_call_taker = true)
AND providers.status = 'active'
AND provider_type = 'physician'
```

**Day-shift default pool**: same but with `is_day_doc = true` instead of the call-taker flags.

**Override pool**: `IN (schedules.included_provider_ids)`. Skips home-site + call-taker/day-doc gates. Eligibility (credentials, availability, conflicts, quotas) still applies.

## 4. Bucket quotas — FTE-weighted with deficit carryforward

Slots are grouped by **(bucket, shift_code)**. Buckets come from [`dayTypeBucket`](src/lib/rulesEngine/shared.ts): `weekday`, `friday`, `weekend` (Sat+Sun merged), `holiday`.

Per provider, per bucket:
```
base     = (block_total_slots / site.call_par_level) × fte_value
expected = (historical_total_slots / site.call_par_level) × fte_value
deficit  = max(0, expected − historical_actual)    # past under-allocation
target   = base + deficit
```

Eligibility check uses `assigned + 1 > target` — i.e., "would one more push us past target?". Older `assigned >= target` caused 0.5 FTE and 1.0 FTE to both cap at 1 when targets rounded below 2.

**Why Sat+Sun share a bucket**: without the merge, a 12-week block produced target `1.0` for full-timers and `0.5` for half-timers — both integer-capped at 1. Merging doubles bucket totals to 24, giving targets 2.0 vs 1.0 — distinguishable.

**Why historical deficit**: block-local quotas can't represent fractional targets (0.3 FTE → target 0.72 → cap 0 every block forever). Deficit adds past shortfall to the current block's target so part-timers catch up.

**Quota relaxation**: when a call slot's ONLY obstacle is that *every* provider fails the bucket quota, `solve()` places the provider with the lowest lifetime ratio anyway (placement source `'quota-relaxed'`, explanation attached) instead of leaving the slot unfilled. A schedule never goes uncovered purely because quota math ran out. genContext also warns at load time when `Σ FTE-weighted targets < bucket total` — check `call_par_level` vs pool FTE.

## 5. Eligibility pipeline ([`evaluateEligibility`](src/lib/rulesEngine/eligibility.ts))

One canonical gate for every placement. `gate === 'call'` applies the full set; `gate === 'derived'` (D-chains, non-call block fills, relief) drops the quota + post-call gates but keeps every safety gate. Ordered for early return:

1. Provider group match (physician-only today)
2. Same-date conflict — unless the slot's shift type is `is_overlay` (overlay shifts neither consume nor collide with the one-assignment-per-day budget)
3. Conflict elsewhere — assigned in any OTHER schedule on this date: another site, or another schedule at this same site (invariant 3: any site, any schedule version). Sibling versions of the *current* schedule are clones and deliberately don't count. Preloaded ±1 day around the block; same scoping in `dayShiftAutoGen`
4. Weekday availability (`available_weekdays[dow]`)
5. Post-call guard (call gate) — **pattern-driven**: a code whose day-chain `blocks` the next day can't be placed when the provider is already busy that next day. Day-type scoping (e.g. classic Saturday C1 exemption) falls out of the pattern doc, not a code literal
6. Bucket quota (call gate; deficit-adjusted target)
7. Site credentials (active, credentialed, shift-type allow/deny, call/weekend/holiday variants)
8. Sat/Sun adjacent-week PTO exclusion — no planned leave in the Mon-Fri weeks flanking the weekend (see §6.5)
9. Availability with bookend — any blocking entry covering the slot (see §6). PENDING requests block (`isBlockingAvailability`) — only denied/canceled are ignored, in every engine and in validation

## 6. PTO bookend rule ([`effectivePtoRange`](src/lib/rulesEngine/shared.ts))

Applies only to PTO / FMLA / parental_leave / military_leave (multi-day planned leave). Extends the block:
- **+2 days back** if entry starts on Monday (captures the Saturday before)
- **+2 days forward** if entry ends on Friday (captures the Sunday after)

Sick / jury_duty / unavailable / blocked are single-day types and don't extend. PTO that already begins/ends on a weekend isn't extended further — the weekend is already inside the range.

## 6.5. Sat/Sun adjacent-week PTO exclusion

Hard rule layered on top of the bookend. For any Sat or Sun call slot, the provider is ineligible if they have planned leave (PTO / FMLA / parental / military) covering any day of either flanking Mon-Fri week:
- `[satDate - 5, satDate - 1]` — the week leading up to the weekend
- `[satDate + 2, satDate + 6]` — the week following the weekend

Friday slots are intentionally exempt — a provider may take the Friday immediately before their PTO week, though this is reserved for extenuating circumstances and is left to scheduler discretion.

**Why this isn't just more bookend:** the bookend extends only when PTO touches Mon or Fri of the adjacent week. This rule catches mid-week leave (e.g. PTO Tue-Thu the week prior) that the bookend wouldn't reach but that still shouldn't share a weekend with the provider's planned time off. Limited to the `BOOKEND_EXTENDING_TYPES` set — single-day / ad-hoc types (sick, jury, blocked) are not meant to imply a recovery window.

## 7. Placement passes (classic: pre-PTO Thursday)

Data: `doc.placementPasses` — the classic doc carries one pass: `{ kind: 'pre_pto', relativeDay: 'thursday_prior_week', codes: ['C1','C2'], maxProviders: 2, enabled: true }`.

Before the main loop: for each provider with blocking PTO (pending included — the same `isBlockingAvailability` predicate that blocks placement also *drives* this placement), compute the Thursday of the week *before* the PTO week. Up to `maxProviders` PTO-bound providers per Thursday each take the first `codes` entry whose slot is open and for which they're eligible (classic: C1 preferred, else C2). Pure best-effort — silently skipped if ineligible.

Motivation: Thursday C1 → Friday post-call → Sat/Sun off → PTO. A single call shift turns a 5-day PTO into a ~10-day break.

## 8. Block chains (classic: the Paoli Saturday weekend chain)

Data: `doc.blocks` — same-provider multi-day chains anchored on a day type. Each anchor day-type block maps a trigger code to links `{offset, code}` the *same provider* also takes. The classic doc anchors on Saturday:

| Saturday trigger | Same provider also takes |
|---|---|
| C1 | Sunday C2, Friday C2 |
| C2 | Sunday C1, Friday D2 |
| C3 | Sunday C3 |

Handled when the main loop places (or a seed occupies) the anchor slot; target slots are looked up via `slotIndex`. Call-category targets are gated with the full call gate, non-call targets with the derived gate; suppressed non-call fills are recorded in `skippedDerived` (call targets fall through to the main loop — never dropped). A different structure (e.g. Friday-anchored chains) is a pattern edit, not an engine edit.

## 9. Day chains (post-/pre-call fills and blocks)

Data: `doc.dayChains` — per trigger code + day-type scope, `links` (fill `{offset, code}` with the same provider, optionally suppressed by `unlessCallWithinDays`) and `blocks` (mark `{offset}` unavailable for that provider — the post-call day off). The classic doc:

| Trigger | Day types | Pre-fill (day − 1) | Post (day + 1) |
|---|---|---|---|
| C1 | weekday/friday/holidays | D2 (unless call within 2 days) | **blocked** — post-call day off |
| C1 | sunday | — | **blocked** |
| C2 | weekday/friday/holidays | D3 (unless call within 2 days) | D1 |
| C2 | sunday | — | D1 |
| (saturday) | — | — | handled by the §8 block chain |

`unlessCallWithinDays` is the generalized **D1 > D3 precedence**: a C2's D3 pre-fill is suppressed when the provider had a call within the window (their D1 from the earlier chain wins). [`sequenceAutoFill.ts`](src/lib/rulesEngine/sequenceAutoFill.ts) interprets the same dayChains for manual placements (with provider-wide any-site/any-version conflict checks) and returns the same skip vocabulary.

**skippedDerived (clinical invariant 4):** every suppressed derived fill is recorded on the plan — `{date, code, provider_id, reason}` with reason `pto` | `cross-site` | `occupied` | `no-slot` | `ineligible` | `already-handled` — and surfaced through `GenerationResult.skippedDerived` and the generate route. A blocked D1 is left *unassigned and reported*, never silently dropped and never given to the blocked provider.

Seeded/manual call assignments get the same treatment before solving: [`seedSolveState`](src/lib/rulesEngine/solve.ts) applies each seed's pattern block offsets, so a seeded Monday C1 blocks that provider's Tuesday everywhere (clinical invariant 1 includes seeds).

## 10. Relief pass

Data: `doc.reliefPass` (`{enabled, dayTypes}`) + relief codes from `shift_types.relief_rank` ordering (legacy D4–D9 fallback when `ctx.shiftTypes` is absent). For each schedule date with any open relief-code slot on an in-scope day type, providers are ranked "first on out-list": distance to their next call (any call-category code, soonest first), then that call's `call_rank` tier, then most-recently-called, then id. Per code, the scan restarts from rank 0, skipping providers already placed that date or ineligible for that specific slot — a provider skipped for D5 (excluded shift type) is still considered for D6. Un-fillable relief slots land in `unfilled` with reason `'No eligible relief provider'`.

## 11. Scoring + optimizer

When multiple providers pass eligibility (main loop, spans, quota relaxation — one shared tuple):
1. **Lowest lifetime ratio** = (historical assignments + this-block assignments) / fte_value — part-timers catch up across blocks (clinical invariant 5)
2. **Most days since last call** — anti-burnout / anti-back-to-back
3. Provider id — deterministic for reproducibility given the same DB state

**Optimizer** ([`optimize.ts`](src/lib/rulesEngine/optimize.ts)): bounded hill-climb over the greedy plan. Movable slots = main-loop call placements whose day type ∈ `doc.optimizerMovableDayTypes` (classic: weekday+friday — block-chain/pre-PTO placements are structurally coupled and never moved). Objective is lexicographic: fewer skips, then lower per-FTE fairness stdev, then lower burnout ([`metrics.ts`](src/lib/rulesEngine/metrics.ts); burnout exemption windows are derived from `doc.blocks`, so pattern-designed adjacent calls don't count against a plan). Trials are pre-gated with `evaluateEligibility` against the seed state (a hoisted rejection skips many re-solves) and budgeted by `maxResolves` (5000) and wall clock (`wallClockMs`, default 2000 ms, `SCHEDULING_OPTIMIZE_WALL_MS` env override). Observability: `optimizeStats = {resolves, gatedSkips, wallMs}` on the generation result.

## 12. Validation pass

After commit, [`commitValidation`](src/lib/rulesEngine/commit.ts) delegates to [`batchValidateVersion`](src/lib/rulesEngine/batchValidate.ts): **every** assignment row in the version, loaded in ~5 preload queries, evaluated in memory with the same pure [`evaluators.ts`](src/lib/rulesEngine/evaluators.ts) the serial path uses, persisted as `validation_flags` with one bulk upsert (chunked at 500).

**The `evaluated` flag (clinical invariant 6 — never silently report clean):** every result carries `evaluated: boolean`. A failed preload declines the *whole* pass (validating against empty maps would report clean); an assignment whose context can't be built or whose evaluator threw comes back `evaluated: false` and is **excluded from the write**. All write sites (commit, validate route, neighbor revalidation) skip the DB write and surface `validation-unavailable` when `!evaluated` — stale flags beat false-clean flags.

Evaluator notes:
- **Fairness scales per FTE** (clinical invariant 5): the monthly burden threshold is `ceil(base × fte_value)`, so a 0.5-FTE provider flags at half the count a 1.0-FTE does.
- **Sequence rules are trigger-anchored**: `applies_to_shift_types` scopes which *trigger* codes the rule covers; `applies_to_day_types` scopes the day the *trigger assignment* falls on (e.g. weekday-only post-call chains) — in both directions: when the evaluated slot is the trigger, its own day type is checked; when a prior-day trigger implicates this slot, the *prior* assignment's day type is checked. Neither field ever scopes the linked shift.
- **Unknown `requirement_type`** in an eligibility rule produces a warning-severity `Unknown rule vocabulary: <type>` violation instead of a silent skip.
- Time-off checks route through `isBlockingAvailability` — pending blocks in validation exactly as in generation.

## 13. Where to change things

| I want to… | Touch this |
|---|---|
| Change the weekend/block chain structure | Edit the site's call pattern — `blocks` — via the assistant or `PUT /api/scheduling/call-patterns`. Not solve.ts |
| Change post-call day-off or D-fill structure | Call pattern `dayChains` (links/blocks) — assistant or `PUT /api/scheduling/call-patterns` |
| Add a multi-day same-provider obligation (beeper span) | Call pattern `spans` |
| Change pre-PTO placement (codes, cap, on/off) | Call pattern `placementPasses` |
| Change relief scope or ordering | Call pattern `reliefPass` + `shift_types.relief_rank` |
| Change what the optimizer may move | Call pattern `optimizerMovableDayTypes` |
| Add/rename a call code, mark an overlay shift, hand a code to the day pool | `shift_types` row flags: `call_rank`, `relief_rank`, `is_overlay`, `generation_engine` — no engine edits |
| Express a structure the pattern schema can't | Extend `CallPatternDocSchema` in [`callPattern.ts`](src/lib/rulesEngine/callPattern.ts) + teach `solve()` the new field. Never re-hardcode structure in the engine |
| Add a new availability type that blocks call | Add to `BLOCKING_AVAIL` in [`shared.ts`](src/lib/rulesEngine/shared.ts); add to `BOOKEND_EXTENDING_TYPES` only if it's multi-day planned leave |
| Change the bookend day-of-week math | [`effectivePtoRange`](src/lib/rulesEngine/shared.ts) |
| Add a new shift category (e.g. "backup") | New pass, not a branch inside the call engine — model it like `dayShiftAutoGen` |
| Exclude a call code from the post-call row | [`NON_POST_CALL_CODES`](src/app/(scheduling)/schedules/[id]/page.tsx) — purely UI |
| Change FTE quota math | `bucketTarget` computation in [`genContext.ts`](src/lib/rulesEngine/genContext.ts) |
| Add a new rule type | [`evaluators.ts`](src/lib/rulesEngine/evaluators.ts) — runtime checks on existing assignments |
| Add a new eligibility gate | [`evaluateEligibility`](src/lib/rulesEngine/eligibility.ts) — pre-placement filter (mind the call/derived gate split) |
| Add CRNA scheduling | New engine in parallel — call gen is physician-only by design |
| Add swap request / open-call pickup | Not modeled here — see `src/app/api/scheduling/requests/` + evaluator integration |

## 14. Known limitations

- **Cross-block memory is site-scoped.** Moonlighting at other sites doesn't count toward lifetime fairness.
- **No rolling window.** Historical includes everything since inception; consider capping at 2y if you have legacy imports that skew.
- **CRNA gen is missing** entirely.
- **Swaps after publish** don't rebalance quotas — a published schedule is a snapshot.
- **Holiday call** is a `'holiday'` bucket but the engine doesn't model federal-vs-religious distinctions — they share the bucket.
- **Legacy `required_count > 1` slots** are only covered for one provider (schedule creation now materializes sibling slots; old rows draw a load warning).

## 15. Call patterns

The declarative vocabulary lives in [`callPattern.ts`](src/lib/rulesEngine/callPattern.ts) (`CallPatternDocSchema`, zod, strict — unknown keys rejected). One `status='active'` row per site in `scheduling.call_patterns` (partial unique index); replaced atomically by `PUT /api/scheduling/call-patterns` (archives the old active) or the assistant's `update_call_pattern` tool (which snapshots first for undo). No row, or an invalid doc → `CLASSIC_PATTERN` fallback + a warning.

The classic pattern (mirrored by the patch18 seed — keep all three in sync):

```json
{
  "version": 1,
  "blocks": [{ "anchorDayType": "saturday", "chains": [
    { "trigger": "C3", "links": [{ "offset": 1, "code": "C3" }] },
    { "trigger": "C1", "links": [{ "offset": 1, "code": "C2" }, { "offset": -1, "code": "C2" }] },
    { "trigger": "C2", "links": [{ "offset": 1, "code": "C1" }, { "offset": -1, "code": "D2" }] }
  ] }],
  "dayChains": [
    { "trigger": "C1", "dayTypes": ["weekday", "friday", "federal_holiday", "major_holiday"],
      "links": [{ "offset": -1, "code": "D2", "unlessCallWithinDays": 2 }], "blocks": [{ "offset": 1 }] },
    { "trigger": "C1", "dayTypes": ["sunday"], "blocks": [{ "offset": 1 }] },
    { "trigger": "C2", "dayTypes": ["weekday", "friday", "federal_holiday", "major_holiday"],
      "links": [{ "offset": -1, "code": "D3", "unlessCallWithinDays": 2 }, { "offset": 1, "code": "D1" }] },
    { "trigger": "C2", "dayTypes": ["sunday"], "links": [{ "offset": 1, "code": "D1" }] }
  ],
  "spans": [],
  "placementPasses": [{ "kind": "pre_pto", "relativeDay": "thursday_prior_week",
                        "codes": ["C1", "C2"], "maxProviders": 2, "enabled": true }],
  "reliefPass": { "enabled": true, "dayTypes": ["weekday", "friday"] },
  "optimizerMovableDayTypes": ["weekday", "friday"]
}
```

(Holidays appear in the dayChains scopes because the legacy engine treated every non-Sat/Sun day type identically — omitting them would silently lose the holiday post-call day off.)

Field map: `blocks` → §8; `dayChains` → §9 (+ the §5 post-call guard); `spans` → multi-day same-provider obligations scored against every covered slot (unfilled with `'No provider can cover full span'` when nobody can take all of them); `placementPasses` → §7; `reliefPass` → §10; `optimizerMovableDayTypes` → §11. Day types: `weekday | friday | saturday | sunday | federal_holiday | major_holiday`.

**Load-time warnings** (`ctx.warnings` → `GenerationResult.warnings`, non-fatal): missing patch18 objects ("shift_types engine columns missing — apply patch18", "call_patterns table missing — apply patch18", "historical_call_counts RPC unavailable — using legacy scan"), an active pattern that fails schema validation (fallback to classic), pattern codes with no matching shift type at the site (`patternWarnings`), quota shortfalls (§4), legacy `required_count > 1` slots.

**Clinical invariants** (from CLAUDE.md — violating any of these is a bug, never a tradeoff, no matter what a pattern doc says):
1. Post-call day off after a 24h in-house call (`requires_post_call_rule` shift types) — including seeded/manual assignments.
2. PTO/availability always respected; PENDING PTO blocks in every engine (`isBlockingAvailability` in `shared.ts`).
3. No cross-site double-booking (any site, any schedule version).
4. Skipped derived shifts (e.g. D1 post-C2 blocked by PTO/cross-site) must be left unassigned AND recorded (`plan.skippedDerived`), never silently dropped.
5. Call burden distributes per-FTE (bucket quotas + fairness metrics).
6. Validation must never silently report clean on failure (`EvaluateResult.evaluated`).

Golden parity: `solve()` with the classic pattern reproduces the frozen legacy engine (`solveLegacy.ts`, kept in-tree deliberately) on the parity fixtures, except four enumerated intentional fixes (IF-1 seeded post-call blocking, IF-2 relief reachability/rescan, IF-3 quota relaxation, IF-4 skippedDerived reporting) — see `goldenParity.test.ts`.
