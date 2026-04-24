# Scheduler — How It Works

Target audience: an engineer who needs to change the scheduler. This is the map, not the tour.

## 1. Overview

Two passes, wired in [`/api/scheduling/schedules/[id]/generate`](src/app/api/scheduling/schedules/[id]/generate/route.ts):

1. **Call gen** — [`autoGenerate.ts`](src/lib/rulesEngine/autoGenerate.ts). Physician call shifts (`category='call'`: C1, C2, C3…) and their chained D-shifts (D1–D9 post-/pre-call relief). Greedy, FTE-weighted.
2. **Day-shift gen** — [`dayShiftAutoGen.ts`](src/lib/rulesEngine/dayShiftAutoGen.ts). Day Doc placements (`category='regular'`: 7-3, 7-5, …). Runs after call gen so it sees the D-chain placements and doesn't collide.

Both are idempotent. Neither overwrites manual or already-assigned slots. Shared helpers — date math, PTO constants, bookend logic — live in [`shared.ts`](src/lib/rulesEngine/shared.ts).

## 2. Data touched

| Table | Role |
|---|---|
| `schedule_slots` | What's being filled |
| `assignments` | One row per `(slot, provider)`; holds `source_type`, `validation_flags` |
| `providers` | Must be `status = 'active'` to be considered |
| `provider_employment_profiles` | FTE, `call_taker`/`partial_call_taker`/`is_day_doc`, `available_weekdays`, `days_per_week`, `preferred_day_shift_types` |
| `provider_site_credentials` | Per-site `is_active`, `credentialed`, `can_take_call`, weekend/holiday variants, allowed/excluded shift types |
| `provider_availability` | PTO / FMLA / sick / blocked / etc. with `approval_status` |
| `sites.call_par_level` | Denominator for FTE-share math (defaults to 12) |
| `schedules.included_provider_ids` | Optional pool override set from the UI |

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

## 5. Eligibility pipeline ([`isEligible`](src/lib/rulesEngine/autoGenerate.ts))

Ordered for early return:
1. Provider group match (physician-only today)
2. Same-date conflict (already assigned somewhere on this date in this schedule)
3. Cross-site conflict (assigned at another site on this date)
4. Weekday availability (`available_weekdays[dow]`)
5. C1 post-call guard (not assigned tomorrow, except Saturday)
6. Bucket quota (deficit-adjusted target)
7. Site credentials (active, credentialed, shift-type allow/deny, call/weekend/holiday variants)
8. Sat/Sun adjacent-week PTO exclusion — no planned leave in the Mon-Fri weeks flanking the weekend (see §6.5)
9. Availability with bookend — any approved blocking entry covering the slot (see §6)

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

## 7. Pre-PTO Thursday rule

Before the main loop: for each provider with approved PTO, compute the Thursday of the week *before* the PTO week. If that Thursday's C1 slot is empty and the provider is eligible, place them. If two providers target the same Thursday (PTO same week), first gets C1, second gets C2. Pure best-effort — silently skipped if ineligible.

Motivation: Thursday C1 → Friday post-call → Sat/Sun off → PTO. A single call shift turns a 5-day PTO into a ~10-day break.

## 8. Weekend chain (Paoli pattern)

Saturday C1 → same provider takes **Sunday C2** + **Friday C2**. Saturday C2 → same provider takes **Sunday C1** + **Friday D2**. Handled inside the main loop when a Saturday slot is processed; looks up paired slots via `slotIndex`. C3 is standalone (weekend neuro).

## 9. D-chain relief ([`chainDFills`](src/lib/rulesEngine/autoGenerate.ts))

Fires after a call slot is filled. Fills the structurally-required D-shifts with the *same* provider:

| Trigger | Pre-fill (day − 1) | Post-fill (day + 1) |
|---|---|---|
| Weekday/Friday C1 | D2 | (blocks any assignment — post-call day off) |
| Weekday/Friday C2 | D3 | D1 |
| Sunday C1 | — | (blocks Monday) |
| Sunday C2 | — | D1 |
| Saturday | — | — (handled by weekend chain) |

**D1 > D3 precedence**: when a C2 would pre-fill D3 on a day that's already post-call for that provider (they had a call shift two days before), the D3 is skipped — D1 from the earlier chain wins. The same rule lives in [`sequenceAutoFill.ts`](src/lib/rulesEngine/sequenceAutoFill.ts) for manual placements.

## 10. D4–D9 relief pass

After the main loop, remaining D4+ slots fill from "first on out-list" — providers ranked by distance to their next call shift, then tier, then recency. Keeps the out-list fair without trying to chain further.

## 11. Scoring (tie-break in main loop)

When multiple providers pass eligibility:
1. **Lowest lifetime ratio** = (historical assignments + this-block assignments) / fte_value — ensures part-timers catch up across blocks
2. **Most days since last call** — anti-burnout / anti-back-to-back

Deterministic for reproducibility given same DB state.

## 12. Validation pass

After all call slots are placed, run [`evaluateAssignment`](src/lib/rulesEngine/evaluate.ts) on each call assignment in parallel batches of 10. Writes a `validation_flags` JSON array onto each assignment row. Only call shifts are validated today; D-shifts are structurally derived and don't have independent rules.

## 13. Where to change things

| I want to… | Touch this |
|---|---|
| Add a new availability type that blocks call | Add to `BLOCKING_AVAIL` in [`shared.ts`](src/lib/rulesEngine/shared.ts); add to `BOOKEND_EXTENDING_TYPES` only if it's multi-day planned leave |
| Change the bookend day-of-week math | [`effectivePtoRange`](src/lib/rulesEngine/shared.ts) |
| Add a new shift category (e.g. "backup") | New pass, not a branch inside `autoGenerate` — model it like `dayShiftAutoGen` |
| Exclude a call code from post-call row | [`NON_POST_CALL_CODES`](src/app/(scheduling)/schedules/[id]/page.tsx) — purely UI |
| Change FTE quota math | [Section 7](src/lib/rulesEngine/autoGenerate.ts) in autoGenerate — `bucketTarget` computation |
| Add a new rule type | [`evaluators.ts`](src/lib/rulesEngine/evaluators.ts) — runtime checks on existing assignments |
| Add a new eligibility gate | [`isEligible`](src/lib/rulesEngine/autoGenerate.ts) — pre-placement filter |
| Change weekend chain pattern (not Paoli?) | Inside the main loop where Saturday slots are handled |
| Change pre-PTO placement | [Section 10.5](src/lib/rulesEngine/autoGenerate.ts) "pre-PTO Thursday" |
| Add CRNA scheduling | New engine in parallel to `autoGenerate` — this file is physician-only by design |
| Add swap request / open-call pickup | Not modeled here — see `src/app/api/scheduling/requests/` + evaluator integration |

## 14. Known limitations

- **Cross-block memory is site-scoped.** Moonlighting at other sites doesn't count toward lifetime fairness.
- **No rolling window.** Historical includes everything since inception; consider capping at 2y if you have legacy imports that skew.
- **CRNA gen is missing** entirely.
- **Swaps after publish** don't rebalance quotas — a published schedule is a snapshot.
- **Holiday call** is an `'holiday'` bucket but the engine doesn't model federal-vs-religious distinctions — they share the bucket.
