# Scheduler — How It Works

Target audience: an engineer who needs to change the scheduler. This is the map, not the tour.

## 1. Overview

Two passes, wired in [`/api/scheduling/schedules/[id]/generate`](src/app/api/scheduling/schedules/[id]/generate/route.ts):

1. **Call gen** — [`autoGenerate.ts`](src/lib/rulesEngine/autoGenerate.ts) orchestrates: [`loadGenerationContext`](src/lib/rulesEngine/genContext.ts) (all DB reads) → [`solve()`](src/lib/rulesEngine/solve.ts) (pure greedy — interprets the site's **CallPatternDoc**, see §15) → [`optimize()`](src/lib/rulesEngine/optimize.ts) (bounded hill-climb) → [`commitPlan`](src/lib/rulesEngine/commit.ts) (batched writes) → batch validation ([`batchValidate.ts`](src/lib/rulesEngine/batchValidate.ts)). Physician call shifts (`category='call'`) and their pattern-derived D-shifts.
2. **Day-shift gen** — [`dayShiftAutoGen.ts`](src/lib/rulesEngine/dayShiftAutoGen.ts). Day Doc placements (`category='regular'`, `generation_engine='day_pool'`). Runs after call gen so it sees the D-chain placements and doesn't collide.

Both are idempotent. Neither overwrites manual or already-assigned slots. Shared helpers — date math, PTO constants, bookend logic, the canonical `isBlockingAvailability` predicate — live in [`shared.ts`](src/lib/rulesEngine/shared.ts).

**solve() module layout (2026-07-20 decomposition):** [`solve.ts`](src/lib/rulesEngine/solve.ts) keeps setup, the `SolverRun` construction, the main call loop (incl. quota relaxation) and `seedSolveState`. The placement kernel — `record`, `tryFillDerived`, `applyDayChains`, `applyBlockChains`, `scoreCall`, `rankByNextCall`, `overrideFor`, `pushUnfilled` — lives in [`solveKernel.ts`](src/lib/rulesEngine/solveKernel.ts) as functions over the `SolverRun` bundle. `SolveState` + its pure mutators live in [`solveState.ts`](src/lib/rulesEngine/solveState.ts) (re-exported through `genTypes.ts`). The non-main passes live in [`passes/`](src/lib/rulesEngine/passes): `prePto.ts` (§7), `spans.ts`, `relief.ts` (§10), `mopUp.ts` (§10.5). `WorkDayBudget`/`ProviderWorkDayBudget` live beside their arithmetic in [`workDays.ts`](src/lib/rulesEngine/workDays.ts) (also re-exported through `genTypes.ts`).

**Structure is data, not code.** Weekend/block chains, post-/pre-call fills, post-call day-off blocks, spans, placement passes, relief config and optimizer scope all come from the site's active `scheduling.call_patterns` row; `solve()` interprets whatever the doc says. No active pattern row → `CLASSIC_PATTERN` fallback (identical behavior to the pre-v2 hard-coded engine). Validation constraints stay in `rule_definitions` (§12) — patterns say how schedules are *built*, rules say what they must *satisfy*.

**What comes back** (`GenerationResult`): `assignments` (with placement `source` + scoring `explanation`), `unfilled` (per-slot candidate rejections, trimmed to 3 + `omittedCandidates` by [`trimUnfilled`](src/lib/rulesEngine/trimUnfilled.ts)), `skippedDerived` (§9), `warnings` (load-time advisories, §15), `requestGrants` (no-call request grant report, §11), `workDayReport` (per-provider working-days accounting, §4.6), `optimizeStats` (§11), `metrics`/`seedMetrics`, `perf`.

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

Slots are grouped by **(bucket, shift_code)**. Buckets come from [`dayTypeBucket`](src/lib/rulesEngine/shared.ts): `weekday`, `friday`, `saturday`, `sunday` (split 2026-07-15 so each weekend day balances independently), `holiday` (federal+major merged).

Per provider, per bucket:
```
par      = min(site.call_par_level, Σ pool fte_value)   # effectiveParLevel — clamp, never starve
base     = (block_total_slots / par) × fte_value
expected = (historical_total_slots / par) × fte_value
deficit  = max(0, expected − historical_actual)    # past under-allocation
target   = max(1, base + deficit)                  # floorBucketTargets (fte > 0 only)
```

Eligibility check uses `assigned + 1 > target` — i.e., "would one more push us past target?". Older `assigned >= target` caused 0.5 FTE and 1.0 FTE to both cap at 1 when targets rounded below 2.

**Par clamp (2026-07-16)**: a stored `call_par_level` above the pool's summed FTE makes every target proportionally short (Σ targets = bucket_total × poolFte/par < bucket_total) — structurally under-quota'd before a single slot is placed. `effectiveParLevel` clamps the denominator down to Σ pool FTE (never up). The load-time shortfall warning is still computed from the STORED par so a stale row stays visible — it now says the targets were clamped instead of predicting unfilled slots.

**At-least-one floor (2026-07-16)**: the saturday/sunday bucket split (patch24) shrank weekend buckets to a handful of slots per block, driving per-provider targets below 1 — and the strict check then gave *every* provider zero capacity in those buckets. (`Sat+Sun` used to share a merged bucket precisely to keep targets above 1; the split is the right fairness mechanism, so the floor now provides that guarantee instead.) Every positive-FTE provider's target is floored to 1 per bucket; fairness *ordering* is untouched — `scoreCall`'s lifetime-ratio sort still decides who actually gets the slot. Both clamp and floor live in genContext target computation, NOT in the eligibility gate — parity fixtures hand-build their target maps and stay meaningful.

**Why historical deficit**: block-local quotas can't represent fractional targets (0.3 FTE → target 0.72 → cap 0 every block forever). Deficit adds past shortfall to the current block's target so part-timers catch up.

**Quota relaxation (unconditional, 2026-07-16)**: whenever a call slot's full-gate sweep is empty, `solve()` re-gates every provider with ONLY the bucket quota waived (`'call-no-quota'` — every safety gate still runs) and places the lowest-lifetime-ratio survivor (placement source `'quota-relaxed'`, explanation attached). Quota math must never leave a fillable slot empty; only hard clinical blocks may. (The old trigger — *every* rejection is `bucket-quota` — was poisoned by a single hard-blocked provider in the sweep, permanently stranding slots the quota-blocked-but-otherwise-eligible providers could legally take.) When even relaxation finds nobody, the unfilled report carries each provider's REAL blocker.

## 4.5. Fill modes + whole-number obligations (2026-07-17)

The generate route accepts `{ fillMode: 'all' | 'obligatory' }` (body, default `'all'`; UI: the fill-mode select beside Auto-Generate, persisted in localStorage).

**Whole-number obligations (accounting):** each provider's obligatory call count = `round(totalCallSlots / effectivePar × FTE)` — TOTAL level, round-half-up (1.5→2, 1.3→1, 0.45→0). Single-homed: rounding + extra math + the effective-par clamp in [`src/lib/fteTarget.ts`](src/lib/fteTarget.ts) (`roundedObligation`, `extraCalls`, `selectOverParAssignmentIds`, `clampParToPoolFte`), engine census in [`obligation.ts`](src/lib/rulesEngine/obligation.ts) (`computeObligations`), UI census in `computeCallObligationCensus` (same file). `effectivePar = min(stored call_par_level, generation-pool ΣFTE)` **everywhere** — `genContext.effectiveParLevel` delegates to the shared clamp, and the schedule grid's over-par memo and the Call Counts modal consume ONE census (every call-category slot: holiday-dated included, any call code, filled or not — the engine's open-slots + call-seeds count), so engine cap and UI labeling cannot disagree on what's obligatory. Calls up to the rounded obligation are never counted or labeled extra; only the provider's LAST N calls (chronological, code tiebreak; N = actual − obligation) get the grid/modal OVER treatment. Category-level fairness (fractional `bucketTarget` + deficits, §4) is untouched — rounding defines accounting and the obligatory-mode cap, never fill order.

**`fillMode: 'obligatory'`** (`SolveOptions.fillMode`, a flag-gated code path — `'all'` is the pre-change engine byte for byte, pinned against `__fixtures__/fillAllPlan.golden.json`):
- Each provider receives at most their rounded total obligation in CALL assignments; seeded/manual calls consume the cap; every real call placement (chain links included) increments it.
- **Chain atomicity:** the whole block counts against the cap upfront — an anchor is eligible only when cap-room ≥ 1 + its live call-category links (target exists, unhandled, category call). Severed links free the reserved room back up. Spans are charged atomically the same way.
- NO quota-relaxation sweep (§4). Capped slots stay open, reported in `unfilled` with reason `'obligation-cap'` (new additive `RejectionReason`; slot-level reason is `'obligation-cap'` when the cap was the binding constraint, real gate reasons otherwise).
- The optimizer never runs (its fewer-unfilled objective fights deliberately-open cap slots, and the `'call-no-quota'` pin gate would bypass the cap) — the deterministic greedy plan is the obligatory answer. Non-call placements (d-chains, relief, mop-up) are never capped; the day-shift engine is unaffected.

## 4.6. FTE working-days cap (2026-07-17)

A second, orthogonal budget to §4/§4.5's call-fairness quotas: how many *days* a provider owes the department this block. Single-homed in [`workDays.ts`](src/lib/rulesEngine/workDays.ts).

- **workingDays(block)** = weekdays in `[date_start, date_end]` MINUS **major** federal holidays (`holiday_calendars.is_major_holiday`, the "big six") that fall on weekdays. Minor federal holidays (MLK, Juneteenth, …) stay in — the department works them.
- **required** = `round(FTE × workingDays) − nettingPtoWeekdays` (floored at 0). PTO nets 1:1 regardless of FTE (Gabriel: `round(1.0×200) − 25 = 175`). Netting set = `pto/fmla/parental_leave/military_leave` (BOOKEND_EXTENDING_TYPES); **sick/jury_duty/unavailable/blocked deliberately do NOT net** (sick = involuntary short-term absence, still an owed day → honest "under"; `unavailable` days-off ARE the entitledOff being consumed; ICU-`blocked` credits as *worked*, not PTO).
- **entitledOff** = `workingDays − round(FTE × workingDays)` — the partial's inherent unscheduled weekdays, on top of post-call days.
- **Credited as worked** (counts toward `required`, deduped per working day): weekday assignments from ANY pass (call, D-codes, relief, mop-up, day-pool), post-call rest days on weekdays (mandated rest is earned), ICU-week weekdays (`blocked` rows with `reason_code` `icu_week`/`icu_post_call` — working elsewhere). **Weekend / major-holiday placements credit nothing** (work on non-working days).

**Enforcement is opt-in by ctx** to protect parity: `genContext` computes a per-provider `workDayBudget` (loads the block's major holidays; PTO already loaded) and stamps `ctx.workDayBudget`; bare/parity fixtures never set it ⇒ byte-identical no-cap behavior (the `fillAllPlan.golden.json` pin runs `solve(buildFixtureContext())`, no budget). When present, `evaluateEligibility` refuses a WEEKDAY placement once a provider's credited count reaches `required` (new additive reason `workdays-cap`), placed AFTER every safety gate (never overrides safety — only adds restriction). The gate applies to `call` and `derived`; it is **waived under `call-no-quota`** (optimizer pins / chain call links must not self-reject), and quota relaxation re-applies the cap explicitly in `solve()` so a cap-bound slot is left open (`workdays-cap`) rather than resurrected. Weekend calls consume no credit; their post-call Monday consumes one when marked. The credited ledger is single-homed in `SolveState.creditedWorkDays`. The day-doc engine's `effective_block_cap` is superseded by `required` (floor kept as fallback when workingDays is degenerate; an explicit `days_per_week` remains authoritative). `sequenceAutoFill` exposes an opt-in `capExceeded` seam (the manual-edit route passes none — manual edits follow the scheduler).

**Report** (`GenerationResult.workDayReport`, [`workDayReport.ts`](src/lib/rulesEngine/workDayReport.ts)): per call-taker `{fte, workingDays, ptoDays, required, credited:{assignments,postCall,icu,total}, entitledOff, delta}`, recomputed from the FINAL plan + seeds + ICU availability. Surfaced in the schedule page's generation banner with over/under highlighted.

## 5. Eligibility pipeline ([`evaluateEligibility`](src/lib/rulesEngine/eligibility.ts))

One canonical gate for every placement, three gate sets (`GateSet` in [`genTypes.ts`](src/lib/rulesEngine/genTypes.ts)): `'call'` applies the full set; `'call-no-quota'` is `'call'` minus the bucket quota and the workdays cap — a re-assertion/structural-obligation gate used by IF-3 quota relaxation (§4), block-chain call links (§8), and the optimizer's pre-gate + pin re-validation (§11); `'derived'` (D-chains, non-call block fills, relief, mop-up) drops the quota + post-call gates but keeps every safety gate. Ordered for early return:

1. Provider group match (physician-only today)
2. Same-date conflict — unless the slot's shift type is `is_overlay` (overlay shifts neither consume nor collide with the one-assignment-per-day budget). Two adjacent checks close the overlay holes: **call-on-call** — a CALL-category placement collides with ANY same-date call, overlay or not (`callDatesByProvider` sees calls the day budget missed); and an OVERLAY placement is separately refused on a pattern post-call BLOCKED day (`blockedOnDate` — overlays skip the day budget, so they must consult the block map directly; invariant 1)
3. Conflict elsewhere — assigned in any OTHER schedule on this date: another site, or another schedule at this same site (invariant 3: any site, any schedule version). Sibling versions of the *current* schedule are clones and deliberately don't count. Preloaded ±1 day around the block; same scoping in `dayShiftAutoGen`
4. Weekday availability (`available_weekdays[dow]`)
5. Post-call guard (call gates, `'call-no-quota'` included) — **pattern-driven**: a code whose day-chain `blocks` the next day can't be placed when the provider is already busy that next day. Day-type scoping (e.g. classic Saturday C1 exemption) falls out of the pattern doc, not a code literal
6. Bucket quota (the full `'call'` gate ONLY — waived under `'call-no-quota'`; deficit-adjusted target)
7. Site credentials (active, credentialed, shift-type allow/deny, call/weekend/holiday variants)
8. Sat/Sun adjacent-week PTO exclusion — no planned leave in the Mon-Fri weeks flanking the weekend (see §6.5)
9. Availability with bookend — any blocking entry covering the slot (see §6). PENDING requests block (`isBlockingAvailability`) — only denied/canceled are ignored, in every engine and in validation
10. FTE working-days cap (§4.6) — `'call'` and `'derived'` gates only, waived under `'call-no-quota'` (quota relaxation re-applies it manually in `solve()`); deliberately LAST so a safety block always wins the reported reason

## 6. PTO bookend rule ([`effectivePtoRange`](src/lib/rulesEngine/shared.ts))

Applies only to PTO / FMLA / parental_leave / military_leave (multi-day planned leave). Extends the block:
- **+2 days back** if entry starts on Monday (captures the Saturday before)
- **+2 days forward** if entry ends on Friday (captures the Sunday after)

Sick / jury_duty / unavailable / blocked are single-day types and don't extend. PTO that already begins/ends on a weekend isn't extended further — the weekend is already inside the range.

### PTO sell-back date-level override (`pto_sellback`, 2026-07-20)

A non-dismissed `pto_sellback` availability row means the provider **is working** those dates — the chief bought the PTO back. It is **not** a blocking type (`isBlockingAvailability` never matches it; `BLOCKING_AVAIL` is unchanged); instead it overrides blocking coverage **date by date**: a date covered by a live sell-back row is not blocked even if PTO or any other blocking row covers it — **including PENDING PTO**. That is the invariant-2 nuance, and it is the feature's meaning: pending PTO still blocks everywhere else, but a sell-back row is a chief-entered decision that supersedes the request on exactly the covered dates. Single home: `isDateBlocked` / `isSellbackOverridden` ([`shared.ts`](src/lib/rulesEngine/shared.ts)) — every per-date consumer routes through it (eligibility's availability gate §5/9, `dayShiftAutoGen`'s blocked-date precompute, `sequenceAutoFill`'s linked-day check, validation's `timeOff` evaluator, the assistant's open-slot hints). `isBlockingAvailability` remains the row-level classifier.

Interactions, kept deliberately simple in v1 (all stated, none silent):

- **Bookend (§6):** `effectivePtoRange` itself is unchanged. The override applies to bookend-EXTENDED coverage too — selling back the Saturday a Monday-start PTO bookends over unblocks that Saturday at the date level. (In `evaluateEligibility` the §6.5 adjacent-week exclusion usually still excludes such weekend dates — see next point.)
- **Adjacent-week exclusion (§6.5) stays ROW-based:** a sold-back day inside a PTO week does not resurrect the flanking weekend's call eligibility — the surrounding planned leave still exists. Likewise the pre-PTO Thursday index (§7) stays row-based.
- **Working-days contract (§4.6):** PTO netting subtracts sell-back-covered weekdays (`ptoWeekdaysCovered`) — a sold-back day is **owed again**, raising `required` back up. It credits as worked only when an assignment actually lands on it (the normal placement credit path); a standalone sell-back row credits nothing.
- **Standalone rows:** a sell-back row overlapping no blocking time is legal and changes nothing (the UI hints this).
- **Validation:** `timeOff` must not flag a PTO violation on a sold-back date (the assignment is exactly what the sell-back sanctions); `no_call_request` soft flags still apply.

Zero-sellback inputs are byte-identical to the pre-change engine. The pin that actually guards this is the **fill-mode golden plans** (`fillAllPlan.golden.json` + the obligatory-mode / no-call-request plan pins), which run `solve()` through the live shared eligibility path. Golden parity is structurally incapable of catching a shared-eligibility change — `solveLegacy` imports the live `evaluateEligibility`, so a mutation there shifts both sides identically and parity stays green.

## 6.5. Sat/Sun adjacent-week PTO exclusion

Hard rule layered on top of the bookend. For any Sat or Sun call slot, the provider is ineligible if they have planned leave (PTO / FMLA / parental / military) covering any day of either flanking Mon-Fri week:
- `[satDate - 5, satDate - 1]` — the week leading up to the weekend
- `[satDate + 2, satDate + 6]` — the week following the weekend

Friday slots are intentionally exempt — a provider may take the Friday immediately before their PTO week, though this is reserved for extenuating circumstances and is left to scheduler discretion.

**Why this isn't just more bookend:** the bookend extends only when PTO touches Mon or Fri of the adjacent week. This rule catches mid-week leave (e.g. PTO Tue-Thu the week prior) that the bookend wouldn't reach but that still shouldn't share a weekend with the provider's planned time off. Limited to the `BOOKEND_EXTENDING_TYPES` set — single-day / ad-hoc types (sick, jury, blocked) are not meant to imply a recovery window.

## 7. Placement passes (classic: pre-PTO Thursday)

Code: [`passes/prePto.ts`](src/lib/rulesEngine/passes/prePto.ts). Data: `doc.placementPasses` — the classic doc carries one pass: `{ kind: 'pre_pto', relativeDay: 'thursday_prior_week', codes: ['C1','C2'], maxProviders: 2, enabled: true }`.

Before the main loop: for each provider with blocking PTO (pending included — the same `isBlockingAvailability` predicate that blocks placement also *drives* this placement), compute the Thursday of the week *before* the PTO week. Up to `maxProviders` PTO-bound providers per Thursday each take the first `codes` entry whose slot is open and for which they're eligible (classic: C1 preferred, else C2). Pure best-effort — silently skipped if ineligible.

Motivation: Thursday C1 → Friday post-call → Sat/Sun off → PTO. A single call shift turns a 5-day PTO into a ~10-day break.

## 8. Block chains (classic: the Paoli Saturday weekend chain)

Data: `doc.blocks` — same-provider multi-day chains anchored on a day type. Each anchor day-type block maps a trigger code to links `{offset, code}` the *same provider* also takes. The classic doc anchors on Saturday:

| Saturday trigger | Same provider also takes |
|---|---|
| C1 | Sunday C2, Friday C2 |
| C2 | Sunday C1, Friday D2 |
| C3 | Sunday C3 |

Handled when the main loop places the anchor slot (a seeded/manual anchor does NOT trigger chain fills — seeds only mark solve state); target slots are looked up via `slotIndex`. Call-category targets are gated with `'call-no-quota'` (2026-07-16: a chain link is a structural same-provider obligation whose anchor was already fairness-scored — the bucket quota must not sever the designed pairing; every safety gate still runs), non-call targets with the derived gate. EVERY severed link — call targets included — is recorded in `skippedDerived`; a safety-severed call target still falls through to the main loop (never dropped), but the severance itself is observable. A different structure (e.g. Friday-anchored chains) is a pattern edit, not an engine edit.

## 9. Day chains (post-/pre-call fills and blocks)

Data: `doc.dayChains` — per trigger code + day-type scope, `links` (fill `{offset, code}` with the same provider, optionally suppressed by `unlessCallWithinDays`) and `blocks` (mark `{offset}` unavailable for that provider — the post-call day off). The classic doc:

| Trigger | Day types | Pre-fill (day − 1) | Post (day + 1) |
|---|---|---|---|
| C1 | weekday/friday/holidays | D2 (unless call within 2 days) | **blocked** — post-call day off |
| C1 | sunday | — | **blocked** |
| C2 | weekday/friday/holidays | D3 (unless call within 2 days) | D1 |
| C2 | sunday | — | D1 |
| (saturday) | — | — | handled by the §8 block chain |

`unlessCallWithinDays` (classic only) is the generalized **D1 > D3 precedence**: a C2's D3 pre-fill is suppressed when the provider had a call within the window (their D1 from the earlier chain wins). [`sequenceAutoFill.ts`](src/lib/rulesEngine/sequenceAutoFill.ts) interprets the same dayChains for manual placements (with provider-wide any-site/any-version conflict checks) and returns the same skip vocabulary.

**Pre-call fills are unconditional under Weekend v2 (Gabriel 2026-07-20):** "Pre-call status should be given to anyone on call the following day. D1 status is only dependent on the Call status from the day before, and D2 and D3 Status is only for the call status on the following day." The `unlessCallWithinDays: 2` conditions on Weekend v2's C1→D2 and C2→D3 links were ported from legacy behavior on 2026-07-12, never requested — they waived the pre-call fill after ANY call within 2 days (a neuro C3 weekend cost Jones her Monday D2). Weekend v2's DATA dropped the condition (patch33); the schema FEATURE stays for patterns that still use it (classic does), and so does the `'sequence-orphan: pre-call fill waived'` reporting (§10.5).

**D1 OVERRIDES D2 (explicit pinned rule, Gabriel 2026-07-20):** when a provider has C2 on day X−1 AND C1 on day X+1, day X is their D1 — no waiver needed. Generation: slots fill in date order, so the C2's `+1 D1` lands first and the later C1's `−1 D2` pre-fill severs on the same-date gate — a RECORDED `'occupied'` skip (invariant 4), with the sequence-owned D2 slot left open and reported `'sequence-orphan: chain link severed'` (pinned in `weekendV2Pattern.test.ts`). Manual path (`sequenceAutoFill`): a manual C2 evicts an auto-generated D2 pre-fill occupying its post-call day (post-call links evict outranked pattern pre-fills); a manual C1's D2 pre-fill declines `'occupied'` when the D1 already holds the day — pre-call links (negative offsets) never evict (pinned in `sequenceAutoFill.test.ts`).

**skippedDerived (clinical invariant 4):** every suppressed derived fill is recorded on the plan — `{date, code, provider_id, reason}` with reason `pto` | `cross-site` | `occupied` | `no-slot` | `ineligible` | `already-handled` | `overridden` (the last: an optimizer `callOverrides` pin severed a chain pairing whose designed partner had NO hard block — the severance stays observable even though the pinned provider fills the slot) — and surfaced through `GenerationResult.skippedDerived` and the generate route. A blocked D1 is left *unassigned and reported*, never silently dropped and never given to the blocked provider.

Seeded/manual call assignments get the same treatment before solving: [`seedSolveState`](src/lib/rulesEngine/solve.ts) applies each seed's pattern block offsets, so a seeded Monday C1 blocks that provider's Tuesday everywhere (clinical invariant 1 includes seeds).

## 10. Relief pass

Code: [`passes/relief.ts`](src/lib/rulesEngine/passes/relief.ts). Data: `doc.reliefPass` (`{enabled, dayTypes}`) + relief codes from `shift_types.relief_rank` ordering (legacy D4–D9 fallback when `ctx.shiftTypes` is absent). For each schedule date with any open relief-code slot on an in-scope day type, providers are ranked "first on out-list": distance to their next call (any call-category code, soonest first), then that call's `call_rank` tier, then most-recently-called, then id. Per code, the scan restarts from rank 0, skipping providers already placed that date or ineligible for that specific slot — a provider skipped for D5 (excluded shift type) is still considered for D6. **Sequence-owned relief-code slots are NOT relief inventory** (2026-07-17, see §10.5): a relief-code slot the active pattern could target as a chain link (e.g. weekend-v2's Friday D4, the Sat-C3 block-chain link) is skipped outright — if its chain fired it's already handled; if the chain broke it must stay open for the mop-up sweep to report. Un-fillable relief slots land in `unfilled` with reason `'No eligible relief provider'`.

## 10.5. Mop-up sweep (orphaned call-engine day slots)

Code: [`passes/mopUp.ts`](src/lib/rulesEngine/passes/mopUp.ts). After relief (2026-07-16): any still-open NON-call slot whose shift type has `generation_engine = 'call'` (the D-chain and relief codes) is an orphan — its trigger call went unfilled or its chain severed, and the day-pool engine deliberately skips call-owned slots, so it used to vanish from every report. The sweep fills each one via the `'derived'` gate (every safety gate; no quota) using the same relief-style ranking (source `'day-mop-up'`), and reports anything still open in `unfilled` (`'No eligible provider for call-engine day slot'`; slots the relief pass already reported are not double-reported). `skippedDerived` records stay untouched — the designated provider's suppression remains observable even when another provider covers the slot (invariant 4). Requires `ctx.shiftTypes` (engine-ownership is a patch18 column); without it the sweep is skipped.

**Sequence-owned carve-out (2026-07-17, live bug: 27 violating rows):** a slot the ACTIVE pattern doc could target as a chain link — any dayChains link or block-chain link whose `anchorDate + offset` lands on the slot's date with a matching code and anchor day type — belongs to the chain's provider and NOBODY else (D1 to yesterday's C2 person, D2/D3 pre-call fills to tomorrow's C1/C2 person, weekend-v2's Friday D4 to the Sat-C3 provider). The single home for this predicate is [`computeSequenceOwnedSlotIds`](src/lib/rulesEngine/sequenceOwnership.ts); the relief pass (§10) and this sweep both SKIP the owned set — the legitimate writers are the chain fills themselves (`applyDayChains`/`applyBlockChains`), `sequenceAutoFill` (manual-edit companion) and seeds. When a chain breaks, its D1/D2/D3/Fri-D4 stays OPEN and is reported here exactly once with an honest reason (precedence: severed > waived > source unfilled):

- `'sequence-orphan: chain link severed'` — `skippedDerived` records the designated provider's suppression for that (date, code)
- `'sequence-orphan: pre-call fill waived'` — the link was skipped by `unlessCallWithinDays` (anchor filled; by-design skip, deliberately NOT a `skippedDerived` event — solve tracks these in `waivedLinkKeys`)
- `'sequence-orphan: chain source unfilled'` — otherwise (the trigger call itself went unfilled)

Two deliberate breadth decisions in `computeSequenceOwnedSlotIds` (over-exclusion leaves a slot open and reported; under-exclusion hands it to the wrong provider — clinically worse): (1) anchor-slot existence is NOT required — a version with no C2 slot on the anchor date still owns the D1 (a permanent, reported orphan, not free inventory); (2) OUT-OF-BLOCK anchors still own in-block targets — a D1 on the first block day belongs to the previous block's C2 person; day types for dates with no slots in the version are derived from the day of week (holiday typing is unknowable there, acceptable because every shipped pattern scopes holiday day types with weekday, and Sat/Sun — the types that gate block chains — derive exactly). Spans are deliberately NOT ownership: the span pass places and reports its own slots atomically, and unfilled span slots fall to the main call loop.

## 11. Scoring + optimizer

When multiple providers pass eligibility (main loop, spans, quota relaxation — one shared tuple, `scoreCall` in [`solveKernel.ts`](src/lib/rulesEngine/solveKernel.ts)):
0. **No-call-request sort tier** (2026-07-17, SOFT — never a gate): candidates with a live `no_call_request` covering the slot date (`isActiveNoCallRequest`, shared.ts — pending counts, denied/canceled don't) sort behind every unpenalized candidate, so a requester is chosen only when nobody without a request passes the gates. Among penalized candidates, the fewest requests already violated this run wins (**fair denial** — the counter includes seeded calls on requested dates and every real placement path). Zero live requests ⇒ the tuple degenerates to 1–3 below, byte-identical plans (pinned against `fillAllPlan.golden.json`). Applies in BOTH fill modes; in obligatory mode a violated placement still consumes the cap. `GenerationResult.requestGrants` reports per provider the requested block dates split into granted/violated (computed from the FINAL plan in [`requestGrants.ts`](src/lib/rulesEngine/requestGrants.ts)); validation independently soft-flags violated assignments ("No-call request")
1. **Lowest lifetime ratio** = (historical assignments + this-block assignments) / fte_value — part-timers catch up across blocks (clinical invariant 5)
2. **Most days since last call** — anti-burnout / anti-back-to-back
3. Provider id — deterministic for reproducibility given the same DB state

**Optimizer** ([`optimize.ts`](src/lib/rulesEngine/optimize.ts)): bounded hill-climb over the greedy plan. Movable slots (`movableCallSlotIds`) = main-loop **and quota-relaxed** call placements (2026-07-16: a quota-relaxed fill is an ordinary scored placement whose bucket happened to be exhausted) whose day type ∈ `doc.optimizerMovableDayTypes` (classic: weekday+friday — block-chain/pre-PTO placements are structurally coupled and never moved) — **excluding `plan.chainAnchorSlotIds`** (2026-07-16 PROOF defect 2: a chain ANCHOR, stamped by `applyBlockChains`, must never move — its chain partner is pinned separately, so moving the anchor severs the designed same-provider pairing, e.g. weekend-v2's Friday C1 whose +2 Sunday C2 partner is pinned). Objective is lexicographic: fewer skips, then lower per-FTE fairness stdev, then lower burnout ([`metrics.ts`](src/lib/rulesEngine/metrics.ts); burnout exemption windows are derived from `doc.blocks`, so pattern-designed adjacent calls don't count against a plan). **Fill monotonicity** (`keepsEveryIncumbentFill`, 2026-07-16 PROOF defect 1): a trial is acceptable ONLY if every slot filled in the incumbent plan stays filled — all categories, not just call. The aggregate `skipped` metric alone let accepted trials TRADE a filled slot for a hole at equal-or-better skip counts (a pinned provider made ineligible by cascaded shifts dropped its slot without re-opening it to the pool); with this gate, optimizer-introduced holes are structurally impossible. Trials are pre-gated with `evaluateEligibility` against the seed state (a hoisted rejection skips many re-solves) and budgeted by `maxResolves` (5000) and wall clock (`wallClockMs`, default 2000 ms, `SCHEDULING_OPTIMIZE_WALL_MS` env override). Pre-gate AND the trial's pin re-validation (`overrideFor`) both use `'call-no-quota'` (2026-07-16): a pin re-asserts an already-made placement, so re-checking the quota made every quota-relaxed pin self-reject ('Forced provider ineligible') and gated eviction moves into quota-starved slots dead on arrival; gate-monotonicity holds identically for the weaker gate. Observability: `optimizeStats = {resolves, gatedSkips, wallMs}` on the generation result.

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
| Change obligation rounding / extra-call accounting / OVER selection | [`src/lib/fteTarget.ts`](src/lib/fteTarget.ts) (+ [`obligation.ts`](src/lib/rulesEngine/obligation.ts) for the engine census) — §4.5 |
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

Field map: `blocks` → §8 (`applyBlockChains`, solveKernel.ts); `dayChains` → §9 (`applyDayChains`, solveKernel.ts; + the §5 post-call guard); `spans` → multi-day same-provider obligations scored against every covered slot ([`passes/spans.ts`](src/lib/rulesEngine/passes/spans.ts); unfilled with `'No provider can cover full span'` when nobody can take all of them); `placementPasses` → §7; `reliefPass` → §10; `optimizerMovableDayTypes` → §11. Day types: `weekday | friday | saturday | sunday | federal_holiday | major_holiday`.

**Load-time warnings** (`ctx.warnings` → `GenerationResult.warnings`, non-fatal): missing patch18 objects ("shift_types engine columns missing — apply patch18", "call_patterns table missing — apply patch18", "historical_call_counts RPC unavailable — using legacy scan"), an active pattern that fails schema validation (fallback to classic), pattern codes with no matching shift type at the site (`patternWarnings`), quota shortfalls (§4), legacy `required_count > 1` slots.

**Clinical invariants** (from CLAUDE.md — violating any of these is a bug, never a tradeoff, no matter what a pattern doc says):
1. Post-call day off after a 24h in-house call (`requires_post_call_rule` shift types) — including seeded/manual assignments.
2. PTO/availability always respected; PENDING PTO blocks in every engine (`isBlockingAvailability` in `shared.ts`).
3. No cross-site double-booking (any site, any schedule version).
4. Skipped derived shifts (e.g. D1 post-C2 blocked by PTO/cross-site) must be left unassigned AND recorded (`plan.skippedDerived`), never silently dropped.
5. Call burden distributes per-FTE (bucket quotas + fairness metrics).
6. Validation must never silently report clean on failure (`EvaluateResult.evaluated`).

Golden parity: `solve()` with the classic pattern reproduces the frozen legacy engine (`solveLegacy.ts`, kept in-tree deliberately) on the parity fixtures, except five enumerated intentional fixes (IF-1 seeded post-call blocking, IF-2 relief reachability/rescan, IF-3 quota relaxation, IF-4 skippedDerived reporting, IF-5 pending PTO drives the pre-PTO Thursday placement) — see `goldenParity.test.ts`.
