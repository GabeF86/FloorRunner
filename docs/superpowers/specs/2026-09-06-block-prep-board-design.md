# Block Prep Board — Design

**Date:** 2026-09-06 · **Status:** approved (Gabriel, this session) · **Scope:** one new page, one new shared card mounted in two places, one new read API route, two new pure modules, one DB patch (data-only), one small edit to the provider profile editor. **No engine change. No generation-behaviour change.**

## Intent

Gabriel, verbatim: *"I want to make schedule building much more streamlined. I want there to be a scheduling dashboard that shows a list of all call takers at that site, their FTE status that can be edited, Their PTO / off / holidays / dates (editable) and then a create schedule option. There should also be a window on the scheduling homepage that keeps tally of all the call counts, remaining PTO days and remaining off days etc..."*

Everything in that sentence exists somewhere in FloorRunner today. None of it is in one place:

| What he wants | Where it lives today |
|---|---|
| Call takers at a site | `/providers`, org-wide, filtered by credentialed site — FTE is **read-only** in the table |
| Edit FTE | `/providers/[id]` → Scheduling tab, one provider at a time |
| Edit PTO / off dates | `/providers/[id]` → Availability tab, one provider at a time |
| Create schedule | `/schedules` → Create Schedule modal |
| Call counts | `/schedules/[id]` → Call Counts modal, **one block only** |
| PTO used | `/providers/[id]` → Availability tab header counter, no entitlement to compare against |

So preparing an 11-provider block means eleven profile visits plus two other pages, and the only place any of it adds up is a modal inside a schedule that does not exist yet. **This spec builds no new domain machinery.** It is a consolidation surface over helpers that already own every number on it.

## Decisions taken (and rejected alternatives)

**A new page, not an extension of `/dashboard`.** `/dashboard` is org-wide — every site's schedules, every site's pending requests, and a Physician Planner card that already carries a whole-roster table. This board is inherently one-site-at-a-time. Folding it in would force the dashboard to become site-scoped and put two roster tables on one screen, which is how they drift. *Rejected:* extending `/providers` with a site filter and inline editing — cheapest, but `/providers` is org-wide personnel admin across ~85 providers of every type, Create Schedule has no natural home there, and the annual tally card would still have to be built for the dashboard anyway.

**Annual tallies are a VIEW, never an input.** Gabriel, verbatim: *"I want each call block to be its own calculation and I want there to be a running tally of all the metrics that can be viewed at any point, but essentially it wont matter what happened the previous block, the number of calls given out will depend on the FTE status."* Generation is untouched. Obligations stay per-block, from the FTE bands (`obligations.bands`, patch44). The board reads; it does not steer.

**There is therefore NO annual call obligation.** An earlier draft of this design derived one by pro-rating each block's band across the year. That is dropped: with each block its own calculation, an annual over/under figure would be a second obligation model running alongside the stated bands, which is exactly the failure `blockTargets.ts` warns about. The annual tally shows **counts**. Over/under stays per-block, in the Call Counts modal, where the bands live. PTO and off days *do* have real annual denominators (the entitlement and `entitledOffDays`), so those alone show a remaining figure.

**Existing history use is left alone.** `genContext`'s `historical_call_counts` RPC only affects *ordering* — which of two eligible providers is picked first — and never changes how many calls a block owes anyone. That is already consistent with "it won't matter what happened the previous block." Changing it would be its own change with its own spec.

**Calendar year, attributed by `slot_date`.** Gabriel, verbatim: *"Calendar year, and a call on 1/5 counts toward 2027."* Paoli runs back-to-back 11-week blocks and the 10/26/2026–1/10/2027 block straddles New Year's; its January calls are 2027's. No block-based "scheduling year".

**Holidays are out of scope.** Gabriel: *"dont worry about the holidays for now."* `holiday_calendars` is org-wide and already correct for 2026–27; the board consumes it (major holidays leave the working-day set) but offers no editing and no per-provider holiday column.

## The page

**Route:** `/block-prep`, first item in the **Scheduling** nav section, above Schedules. Named for what it is rather than "Scheduling Dashboard", because `/dashboard` already owns the label "Dashboard" in the sidebar.

**Header:** site picker · year picker (for the annual figures) · **Create Schedule** primary button, opening the existing modal from `/schedules` with the site pre-filled.

### Card 1 — Call takers at ⟨site⟩

One row per provider where `status = 'active'`, `home_site_id` = the selected site, and `call_taker OR partial_call_taker`. At Paoli that is 11 people, Gorelick (per diem, 0.00 FTE) included.

| Column | Editable | Source |
|---|---|---|
| Name | — | links to `/providers/[id]` |
| Call FTE | inline | `provider_employment_profiles.fte_value` |
| Working-days FTE | inline | `work_days_fte`; **blank = same as call FTE** (existing convention) |
| PTO allotment (weeks) | inline | `pto_weeks`; **blank = not stated**, typed `0` = a real zero |
| PTO used / remaining | — | annual, see contract below |
| Off days budget / used | — | annual, see contract below |
| Calls this year | — | annual weighted total |

Blank versus zero is load-bearing and is why the DB patch exists: Gabriel confirmed *"0 is a real number for some of them"*, so the board must be able to say "nobody has stated this person's allotment" without saying "this person gets none."

Each row expands to a **drawer** carrying that provider's PTO, sell-back, off and no-call entries for the selected year, with the same add / edit / delete flows the Availability tab uses, against the same API. A row created here is indistinguishable from one created on the profile.

### Card 2 — Annual tally

The Call Counts modal's shape, spanning the calendar year across every **published** block at the site instead of one block: per-provider call counts by fairness bucket and code, PTO remaining, off days. Below the table, the year's published blocks are listed with links to each one's own Call Counts — that is where per-block over/under lives.

Built as `src/components/AnnualTallyCard.tsx` so the identical component mounts on `/dashboard` — the window Gabriel asked for on the scheduling homepage.

## The numbers — contract

Every figure routes through the helper that already owns it, so that this board and the grid cannot drift.

**A correction to an earlier draft of this line.** It used to claim the board "re-derives nothing", and that overstates what is actually guaranteed. The board's call counts come from `plannerMath.computeScheduleActuals`; the Call Counts modal's come from `callCountColumns.computeCallCountColumns` and `fteTarget.actualCallsFor`. Those are **independent implementations**, and their predicates differ in three ways:

| | Board (`plannerMath`) | Modal (`callCountColumns`) |
|---|---|---|
| What counts as a call | `shift_types.category === 'call'` | `isCallCountCode(parentCode)` — C1/C2/C3 only |
| Filled predicate | excludes `canceled` / `declined` | requires a `provider_id` |
| Null `derived_day_type` | falls back to `derivedDayTypeFor` | dropped |

Verified against the live database: every Paoli call code folds to C1/C2/C3, there are no null `derived_day_type` rows in 2026, and only `assigned` and `open` are ever written. **So the two surfaces agree on every number they can currently produce — by coincidence, not by construction.** A future divergence would be silent. What *is* structurally guaranteed is narrower and still worth having: the bucketing, the split-call weighting, the PTO netting, the working-day arithmetic and the published-only predicate are each single-homed and shared.

| Figure | Definition | Owning helper |
|---|---|---|
| Working days in year | Weekdays Jan 1 – Dec 31 minus **major** holidays | `workDays.isWorkingDay` / `workingDaysInRange` |
| Calls this year | Published assignments with `slot_date` in the year, at this site, `shift_types.category = 'call'` | `plannerMath.computeScheduleActuals` |
| — its bucket | Date-aware: a Monday holiday is a M–Th call | `shared.dayTypeBucketOn` |
| — its weight | C1N12 = 0.5 of a C1; segments fold under the parent code | `callBurden.callBurdenWeight` / `parentCallCodeOf` |
| — its visibility | **Published versions only** (invariant 3) | `committedAssignments.filterPublishedVersions` |
| PTO used | Weekdays covered by PTO rows in the year, **sold-back days included** | `dateRanges.ptoCounterStats(...).weekdaysBooked` |
| PTO remaining | `pto_weeks × 5 − weekdaysBooked`; **omitted entirely when `pto_weeks` is null** | `dateRanges.PTO_WORK_DAYS_PER_WEEK` |
| Off-day budget | `WD − round(effectiveWorkDaysFte × WD)`, independent of PTO | `workDays.entitledOffDays` |
| Off days used | Working days inside published blocks at the site, minus credited worked days, minus PTO weekdays | `computeScheduleActuals` (assigned ∪ post-call ∪ ICU, disjoint) |
| Required working days | `round(workFte × WD) − PTO`, floored at 0 | `workDays.requiredWorkDays` |

`computeScheduleActuals` returns raw per-code counts; the burden weighting and parent folding are applied on top by `annualTally.ts`. (An earlier draft said this matched "the order `callCountDays.ts` applies them" — `callCountDays.ts` computes no call counts at all. See the correction above.)

**Three figures carry an explicit honesty caveat and must render it:**

1. **Off days used** can only be counted where a schedule exists. Half of 2027 is unbuilt. The column reads as *"N used, through the blocks that exist"* and names the covered span — it must never treat unbuilt months as days off.
2. **PTO remaining** is absent, not zero, when `pto_weeks` is null. The used figure still shows.
3. **The off-day budget** is absent, not zero, when the provider's FTE is unknown. `offDayBudgetFor` returns null for a null or non-finite `fte_value` and the column reads *"FTE not stated"*. This is a deliberate divergence from the rest of the codebase, which coerces a missing FTE with `|| 1` (`fteTarget.ts:606`, `dayShiftAutoGen.ts:367`) — a coercion that also swallows a stated `0`. Those call sites feed the engine and must keep moving; a read-only board can afford to refuse to guess, and given the whole feature exists to distinguish "not stated" from "genuinely none", guessing here would undercut it.

A stated `0` is a different matter and is NOT null: it delegates to `entitledOffDays` like any other number. `entitledOffDays` already handles the case that motivated this whole column: it keys off `effectiveWorkDaysFte`, so Hussain — call FTE 0.70, working-days FTE 1.00 — is entitled to **zero** off days despite a partial call contract, and a 1.0 FTE is likewise zero. No new arithmetic.

**A per diem gets "n/a", not a number** (Gabriel, 2026-09-06, answering the question this raised). At a *stated* 0.00 FTE the formula yields every working day in the year — literally correct, since they owe no working days, but useless on screen and contradicting the Physician Planner card, which coerces the same provider to 1.0 FTE and shows zero. So the off-day budget has **three** states, and they must render differently:

| State | When | Renders |
|---|---|---|
| A number | The computed entitlement is greater than zero | `N budgeted` / `M of N used` |
| `none` | The computed entitlement is zero — owes every working day | `none` |
| `n/a` | Effective working-days FTE is 0 — owes no working days at all | `n/a` |
| `FTE not stated` | `fte_value` null, non-finite or negative | `FTE not stated` |

Note which side of the formula each state keys off. Only `n/a` is decided by the FTE, because it means *owes nothing*. The other two are decided by the **computed answer**, not by an FTE threshold — specifying them as "eff is 1" and "0 < eff < 1" left a call FTE of 1.5 (legal: `FTE_MAX` is 2, for a partner working two jobs) matching no state at all, and let a working-days FTE of 0.999 round to a zero entitlement while still matching "a number", rendering `0 budgeted` — the very string this ruling exists to abolish.

`none` and `n/a` are opposite facts and must never collapse into one string: a full-timer has zero off days because they owe everything, a per diem has no off-day concept because they owe nothing. The fourth state is a data gap worth fixing, not a correct answer, so it stays distinguishable. `offDayBudgetFor` returns a discriminated union rather than `number | null` so every consumer is forced to handle all four.

**Sick days do NOT count as off days** (Gabriel, 2026-09-06). A working day inside a published block counts as an off day only if nothing else explains it. Days that do not count: those credited as worked (assignment, post-call rest, ICU), those covered by PTO-netting leave, and those covered by a **non-entitlement absence** — sick, jury duty, and plain `blocked`.

That last set is *derived*, never hand-typed: `BLOCKING_AVAIL − PTO_NETTING_TYPES − {unavailable}`, both sets owned by the engine (`rulesEngine/shared.ts`, `rulesEngine/workDays.ts`). `unavailable` is deliberately excluded from the subtraction because `workDays.ts` already states that those rows **are** the off-day entitlement being consumed. Conference, CME and admin are not in `BLOCKING_AVAIL` at all — the provider was schedulable and simply wasn't scheduled — so those days do remain off days.

Because these date sets can overlap (an ICU `blocked` row is both credited-as-worked and a blocking absence), the count is computed as a **union of explained dates subtracted from the covered working days**, not as a chain of subtractions that could double-count.

**Cross-site:** call counts are **this site's call only**, matching the per-site obligation bands. A provider taking call at another site does not appear in this site's tally.

## Writes

**No new write endpoints.** Every edit goes through a route that already validates it:

| Edit | Route | Note |
|---|---|---|
| Call FTE, working-days FTE, PTO allotment | `PATCH /api/scheduling/providers/[id]` | all three on `PROFILE_COLUMNS`; bounds already enforced (`FTE_MIN`/`FTE_MAX`; working-days FTE capped at 1) |
| PTO / off / no-call dates | `POST` / `PATCH` / `DELETE /api/scheduling/availability` | identical to the Availability tab |
| Create schedule | `POST /api/scheduling/schedules` | existing modal, site pre-filled |

### The one data change

`pto_weeks` is nullable with `DEFAULT 0`, and **78 of 83 employment profiles sit at 0 with none at null** — the column has never distinguished "gets no vacation" from "nobody filled this in."

**`supabase_scheduling_patch45_pto_weeks_unset.sql`** sets those 78 rows to NULL. The five stated values (Farkas 9, Amusa 7, Hussain 7, Chamchad 6, Vu 6) are untouched. Nothing deliberately entered is lost, because nothing at 0 is currently distinguishable from the column default.

Paired code change, and it is a **one-line UI fix only**: the profile Scheduling tab writes `pto_weeks: ptoWeeks === '' ? 0 : parseInt(...)`, collapsing blank to 0. It must send `null` for blank. The API needs nothing — `validateAndSplitPatch` already maps `''` and `null` to null for `pto_weeks` and only range-checks actual numbers. The UI is the sole place blank becomes zero.

**Deploy order:** code first, then the patch. Not for the strict-schema reason patch38/44 carry — this is a plain column with no `.strict()` parser behind it — but so the editor stops manufacturing fresh zeros before the existing ones are cleared. `gridCalculator/providerProfile.ts` already reads `profile.pto_weeks ?? DEFAULT_PTO_WEEKS`, so nulls are safe there today; **`DEFAULT_PTO_WEEKS` is 0**, meaning the simulator treats unset as zero PTO exactly as it does now. No behaviour change there.

## Modules

The math lives in lib and the page is markup over it — the split `blockTargetsPanel.ts` established. vitest runs `environment: 'node'` with no jsdom, so component *interaction* cannot be tested; anything with a rule, threshold or wording choice therefore lives in lib where it can be exercised across many inputs. Component **render paths** are a different matter and are tested: `src/components/ui/Modal.test.tsx` asserts markup through `renderToStaticMarkup` in the node environment with no extra dependencies, and every component here follows it.

- **`src/lib/annualTally.ts`** — pure. Given providers, employment profiles, availability rows, published slot rows, holidays and shift types, returns per-provider annual figures: weighted call counts by bucket and code, PTO used and remaining, off-day budget and used, and the covered-span metadata the honesty caveat needs. *Assembles* the single-homed helpers; re-implements none. This is the shared heart — the roster columns and the tally card both read from it, so they cannot disagree.
- **`src/lib/blockPrepView.ts`** — pure view logic: row ordering, blank-vs-zero rendering, inline-edit parsing and bounds, column plan.
- **`src/app/api/scheduling/block-prep/route.ts`** — the one new endpoint. `GET ?site_id=&year=`. All DB reads here, bounded selects, published-only via `committedAssignments.ts`. `dynamic = 'force-dynamic'`, no-store — this data changes out of band, same reasoning as the availability route.
- **`src/components/AnnualTallyCard.tsx`** — the shared card. Mounted on `/block-prep` and `/dashboard`.
- **`src/app/(scheduling)/block-prep/page.tsx`** — fetch, state, markup only.
- **`src/components/AppShell.tsx`** — one nav entry.

## Failure behaviour

The board fails soft **per card**, the way `/dashboard` already does: a query error renders a `Banner` for that card alone and **never renders a number it could not compute**. This is the display-layer form of invariant 6 — a failed read must not read as a clean zero. Specifically:

- A failed assignments read shows an error in the tally card, not zero calls for everyone.
- A failed availability read shows an error where the PTO figures would be, not full remaining balances. **The roster fails as one panel** rather than degrading column by column: the PTO, off-day and call figures all derive from the same reads, and a row showing a name and an FTE beside three blank columns invites the reader to treat the blanks as zeros. Splitting the roster into a profile panel and a figures panel is a reasonable future refinement; it is deliberately not the shipped contract.
- Null `pto_weeks` renders an em-dash and a "not stated" affordance, never a computed remaining.
- A **truncated** read is an error, not a short answer. The year-wide reads page until exhausted; if paging cannot complete, the panel says so rather than rendering a partial tally as fact. This matters concretely: measured 2026-09-06, Paoli holds 717 published 2026 slot rows against a 1000-row per-request cap, so the second published block of a year crosses it.
- Providers with published call at the site who are **absent from the roster** — a mid-year status change, cross-site coverage, or someone not flagged as a call taker — have their calls counted by the tally but no row to show them on. The route surfaces those ids and the card footnotes them, rather than letting the count disappear. There is a live instance at Paoli today.

Inline edits apply optimistically and **revert with an error message** if the PATCH fails, so a rejected FTE cannot linger on screen looking saved.

## Testing

Fixtures are built from the live 8/10–10/25 Paoli block, the way `statedObligationCensus.test.ts` does. No DB; the route is tested with an injected fake supabase client, per the house convention.

`annualTally.test.ts` — the cases that matter:

1. A C1N12 counts as **half** a C1, folded under the parent code.
2. Havildar's shared 12-hour Saturday does not read as a whole call.
3. The 10/26/2026–1/10/2027 block splits at the year boundary: its January dates land in 2027, its October–December dates in 2026, and the two years sum to the block's total.
4. A Monday holiday's calls land in the **M–Th** bucket, not a holiday bucket.
5. PTO remaining counts sold-back days as **used**.
6. Null `pto_weeks` yields no remaining figure at all — not 0, not negative.
7. Off-day budget is **zero** for a 1.0 FTE *and* zero for Hussain (call FTE 0.70, working-days FTE 1.00).
8. Draft-version assignments are excluded from every count.

`blockPrepView.test.ts` — row ordering; blank-vs-zero allotment rendering; FTE parse and bounds; the "through the blocks that exist" span label.

## Out of scope / follow-ups

- **Holidays**, per Gabriel — neither the group calendar editor nor a per-person holiday column.
- **Cross-site annual totals.** Counts are this site's call only; revisit if he wants a group-wide burden view.
- **Making the picker ignore prior blocks.** `historical_call_counts` still orders candidates by lifetime fairness. Gabriel was told this explicitly and it stays; if he wants it removed, that is a separate engine change with its own spec.
- **`src/lib/callCountDays.ts` line 180** embeds a raw NUL character directly in the source, inside the sentinel `const BLOCK_KEY` (uncommitted work). The sentinel behaves exactly as its comment intends, but the raw control byte makes the whole file read as *binary* to `grep` and `ripgrep`, which then silently return no matches for every search against it. Fix is to spell the NUL as a backslash escape in the string literal rather than embedding the byte. Unrelated to this work; noted so it is not lost.

---

## What review caught (2026-09-06/07)

Every task went through spec-compliance review then code-quality review, each with mutation testing. Recording the defects that were caught before shipping, because several are the kind that recur:

**Would have produced wrong clinical numbers:**

1. **Silent truncation.** The year-wide slot read had no row-count guard. PostgREST caps un-ranged selects at 1000 rows and returns *no error*; Paoli holds 717 published 2026 slot rows, so the second published block of a year would have crossed it and the tally would have quietly under-counted calls. Now paged, with an exact-count backstop that distinguishes "page budget exhausted" from "row count changed mid-read".
2. **ICU pairs orphaned at the year boundary.** A fix that inferred "this ICU week has no post-call Monday" from a *year-scoped* fetch would have offered a live Remove on ten consecutive December week-starts whose Monday sits in January — creating exactly the orphan the lock exists to prevent, in the window when a chief is most likely to be doing block prep. Absence is now only trusted when the partner's date is provably inside the fetched window.
3. **`no_call_request` bypassing the per-window cap.** The drawer briefly offered it as an addable type. The profile writes those through the request-intake route, tagged to the window, one row per date — which is how `max_no_call_requests` is counted. An untagged range row counts as zero against the cap while the engine still honours it in full.
4. **ICU days double-subtracted.** Off-days-used was a chain of subtractions over overlapping sets; an ICU `blocked` row is both credited-as-worked *and* a blocking absence, so it was charged twice. Now a union of explained dates.

**Would have broken the build or the UI:**

5. **The branch did not compile in a clean checkout.** A component imported `FAIRNESS_BUCKETS` from `rulesEngine/shared`, which existed only as an uncommitted working-tree edit belonging to unrelated in-flight work. Every local test run was green; a fresh checkout gave 4 type errors and 13 test failures, and pushing would have broken the Vercel build. **Lesson: with a large uncommitted working tree, verify in a detached worktree, not in place.**
6. **An edit that silently reverted itself.** The post-edit refetch was triggered by the *optimistic* update, so the GET raced the PATCH that caused it and could read pre-edit data. The chief would type an FTE, tab out, and watch it snap back — with no self-correction until reload. The refetch now fires from the PATCH's `finally`.
7. **A stale roster under a fresh title.** Switching site or year rendered the previous selection's rows, while the tally card beside it correctly blanked. Both cards now share one freshness guard.
8. **The honesty caveat overstating coverage.** With disjoint published blocks, the covered-span label collapsed the gap: two blocks at either end of a year read as "Jan 5 – Dec 20", implying near-total coverage of a year it had counted half of.

**Rendering that bypassed its own tested rule:** the PTO cell's "not stated" em-dash came from a literal in markup while the tested function that owns that string rendered nowhere — so changing the placeholder would have left every test green while the UI diverged, on the exact rule the feature exists to protect.

## Known residuals

Both are documented at their call sites:

- **The row-freeze on re-sort is unpinned.** Keying roster cells per provider (necessary to stop one provider's in-flight edit bleeding into another's row) means a re-sort replaces the input rather than moving it, dropping keyboard focus. The mitigation freezes row order while any cell is focused or saving. The component→helper edge can't be pinned under a render-only strategy, because the frozen-order state is set by an effect that never fires during SSR. Consequence is focus loss, not a wrong number.
- **A per-diem at a stated 0.00 FTE.** Resolved to render `n/a` rather than a full-year off-day budget. Note the Physician Planner card on the same dashboard coerces a missing-or-zero FTE to 1.0 and shows zero; the two surfaces answer differently for the same provider by design, and the board's answer is the honest one.

## Deploy sequence

Order matters — step 5 before step 4 loses data.

1. Merge `block-prep-board` to `main` and push. Vercel auto-deploys.
2. Confirm the build is live at https://floor-runner.vercel.app/block-prep.
3. Verify the Supabase project ref is `qhwdbtixhzdsgwwtcfrm` before touching anything.
4. Run `supabase_scheduling_patch45_pto_weeks_unset.sql`. Its `DO` block aborts if fewer than five stated allotments remain — if it fires, someone has been editing allotments and the "these zeros carry no information" premise has expired. Re-read before overriding.
5. **Only now** enter the real PTO allotments from the board, including the genuine zeros. A real `0` typed before step 4 is indistinguishable from the 78 defaults and gets cleared with them.
6. If the code is ever rolled back, roll the DB back too. Pre-change code renders a null allotment as `0`, and the next save on any of those profiles writes that `0` back as real data — one provider at a time, silently.
