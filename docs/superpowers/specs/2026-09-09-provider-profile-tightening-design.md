# Provider profile tightening — design

**Date:** 2026-09-09
**Status:** approved (Gabriel, 2026-09-09)
**Scope:** parts 1 and 2 of a four-part sequence. Parts 3 and 4 get their own specs.

---

## The four-part sequence

Gabriel asked for a set of profile changes plus a visual redesign. They decompose
into four pieces that must ship in this order, and he approved the ordering:

1. **Profile cleanup** — delete dead controls, rename one field, add two. *This spec.*
2. **Assignment History breakdown** — call counts split by code. *This spec.*
3. **Specialty Call Taker** — a durable per-provider contract that replaces the
   FTE-band obligation. Touches the obligation model, the solver's caps, the Call
   Counts census and the Block Prep board. **Its own spec.**
4. **Visual redesign** of the profile page. Last, because restyling a screen and
   then deleting half its fields is wasted work.

Parts 1 and 2 are independent of each other and of part 3. Neither touches the
rules engine.

---

## Part 1 — Profile cleanup

All of this lives in the **Employment & Scheduling** tab of
`src/app/(scheduling)/providers/[id]/page.tsx` (the `EmploymentTab` component).

### 1.1 What gets removed

Eighteen controls and four whole section headers:

| Section | Controls removed |
| --- | --- |
| Call Eligibility | Weekend Call, Holiday Call, Night Call, Backup Call, Late Shift |
| Capabilities *(whole section)* | Can Supervise CRNAs, Can Work Solo, Can Cover Offsite |
| Specialty Eligibility *(whole section)* | Trauma, OB, Cardiac, Endoscopy, EP Lab |
| Limits *(whole section)* | Max Monthly Calls, Max Consecutive Calls |
| Frequency Targets *(whole section)* | Weekend Target, Holiday Target, Friday Target |

The `enableAllCallTypes()` helper goes with them — its only job was to switch on
the five call-eligibility toggles when Call Taker or Partial Call Taker was
ticked. Ticking Call Taker keeps its other effect (clearing Day Doc).

Gabriel also listed **Float** under specialty eligibility. It has no control on
this page — `float_eligible` is writable through the API but was never rendered —
so there is nothing to remove. Noted here so its absence doesn't read as an
oversight.

### 1.2 Columns are retained, not dropped

**No `DROP COLUMN`.** The UI stops rendering and stops writing these fields; the
stored values stay exactly as they are.

This is deliberate. Dropping eighteen columns is an irreversible migration whose
only benefit is tidiness, and `validation/providers.ts` would have to shed them
from `ALLOWED_FIELDS` in lockstep or every PATCH naming one would start failing.
Keeping the columns means the change is a pure UI edit that can be reverted by
restoring a component, and it leaves the API contract untouched.

The corollary is that the **save payload must stop sending these keys**. If
`handleSave` still wrote `weekend_call_eligible` from component state, the state
would be whatever the removed toggle last defaulted to — writing invented data
over real data on every save. Removing the keys from the payload means the stored
values are simply never touched again.

### 1.3 Verification that nothing live reads them

Checked before designing the removal, because a dead-looking field that something
still reads is the expensive mistake here.

- `backup_call_eligible` — appears in `src/lib/gridCalculator/callBurden.ts` as a
  field of `CallRosterEntry` and as the `backupPool` filter. Its only non-test
  importer is `src/lib/gridCalculator/fteSimulator.ts`, which **hardcodes
  `backup_call_eligible: true`** when it builds a roster, and `fteSimulator` in
  turn has no non-test importer. So no value from the database reaches that
  filter today.
- `weekend_call_eligible`, `holiday_call_eligible` — named in the provider-list
  query in `src/app/(scheduling)/providers/page.tsx` and in the type it feeds,
  but never rendered. Both drop out of the `select()` string.
- The remaining fifteen appear only in `providers/[id]/page.tsx` and in
  `validation/providers.ts` (`ALLOWED_FIELDS` and its per-key coercion), which
  stays as it is per 1.2.
- `src/lib/blockPrepView.ts` mentions `max_weekly_hours`, `max_monthly_calls` and
  `max_consecutive_calls` **in a comment only**, explaining which integer columns
  share a parsing convention. The comment stays accurate — the columns still
  exist — but is reworded so it doesn't cite controls a reader can no longer find.

### 1.4 What gets renamed

**Max Weekly Hours → Weekly Hours.** Label only. The column
(`provider_employment_profiles.max_weekly_hours`) keeps its name; renaming it
would touch the validation coercion list and the API for no gain. One profile of
83 has a value.

### 1.5 What gets added

**A. Employment status gains `employed_non_call_taker`**, labelled
"Employed (non-call)". Current distribution across 83 profiles: 42 full_time,
26 part_time, 15 per_diem, and nobody on the other five values.

**B. `is_employed_call_taker`** — a new boolean on
`provider_employment_profiles`, rendered as a toggle beside Partner and Partner
Track and **mutually exclusive with both**, matching how those two already behave
(ticking one clears the other). Default `false`.

It does **not** get backfilled. 76 of 83 profiles are currently neither Partner
nor Partner Track; defaulting all of them to Employed Call Taker would invent a
fact about 15 per diems and every day doc. None of the three ticked is the honest
representation of a profile nobody has classified yet.

**C. A legacy-value escape hatch on the employment-status select.** The enum has
eight values; `EMPLOYMENT_STATUSES` in `validation/providers.ts` lists seven —
`employed` is in the database type but not in the allow-list. A profile carrying
it would render a select with no matching option and then be **rejected on
save**, so no employment change could ever be persisted for that provider. Zero
rows are affected today, so this is latent rather than live, but the fix is the
idiom already used by the fellowship select a few hundred lines down in the same
file: render the current value as a trailing `(legacy)` option when it isn't in
the list. Three lines, in a control this change is already editing.

The allow-list itself gains only `employed_non_call_taker`. Adding `employed`
is out of scope — it is a separate question about what that status means.

### 1.6 Migration — patch47

```sql
ALTER TYPE scheduling.employment_status ADD VALUE IF NOT EXISTS 'employed_non_call_taker';

ALTER TABLE scheduling.provider_employment_profiles
  ADD COLUMN IF NOT EXISTS is_employed_call_taker boolean NOT NULL DEFAULT false;
```

Both statements are idempotent, so the patch is safe to re-run.

**Not wrapped in `BEGIN`/`COMMIT`.** `ALTER TYPE ... ADD VALUE` adds a value that
cannot be *used* until the adding transaction commits, and mixing it into a
transaction with other work is the classic way to get a patch that half-applies.
Two independent auto-committed statements is the correct shape here.

### 1.7 Deploy order — **DATABASE FIRST**

This reverses the house rule for call-pattern patches, and the reversal is the
point.

The pattern-doc rule is code-first because a doc carrying an unknown key fails
the strict schema and falls back to `CLASSIC_PATTERN` *silently*. Nothing here is
silent, and the failure runs the other way:

- Code shipped first, DB second → the select offers "Employed (non-call)" and
  saving it writes an enum value the type does not have. The PATCH 500s.
- Code shipped first → `handleSave` sends `is_employed_call_taker` against a
  table with no such column. **Every save on the tab fails**, not just saves that
  touch the new toggle.
- DB shipped first, code second → the extra enum value is offered by nothing and
  the extra column stays `false` for everyone. Inert.

So: **apply patch47 to `qhwdbtixhzdsgwwtcfrm`, confirm it, then push.**

---

## Part 2 — Assignment History call-code breakdown

Gabriel: *"not just '10 Weekday Call' but 10 and then broken down into 3-C1,
7-C2 etc."*

### 2.1 Where the breakdown is computed, and why not the client

`GET /api/scheduling/providers/:id/burden` already returns both halves of what
this needs: a `burden` map of six category totals, and a `history` array carrying
`shift_code` for every assignment. So the breakdown *could* be tallied on the
client from `history`.

It should not be. The bucketing rule — an assignment counts as call when
`counts_toward_call_burden` is true **or** its category is `call`, and it lands in
weekday / friday / weekend / holiday by `derived_day_type` — lives in the route,
and `history` rows do not carry `counts_toward_call_burden` at all. A client-side
tally would therefore be a *second, differently-informed* implementation of the
same rule sitting directly beneath the first one's output. That is the exact
defect shape the Block Prep review caught twice: two implementations that agree
on today's data and are free to drift.

**The route computes the breakdown, in the same loop, behind the same predicate.**

### 2.2 New module — `src/lib/callCodeBreakdown.ts`

Pure, no DB, unit-tested. It owns the bucketing rule that is currently inline in
the route, and the route imports it — so there is one implementation, not two.

```ts
/** The six keys the Assignment History cards render, in display order. */
export const BURDEN_BUCKETS = [
  'total_assignments', 'total_call', 'weekday_call',
  'friday_call', 'weekend_call', 'holiday_call',
] as const;
export type BurdenBucket = typeof BURDEN_BUCKETS[number];

export interface BreakdownRow { code: string; count: number }

export interface TallyInput {
  shift_code: string;
  shift_category: string;
  day_type: string | null;
  counts_toward_call_burden: boolean;
}

export interface TallyResult {
  burden: Record<BurdenBucket, number>;
  breakdown: Record<BurdenBucket, BreakdownRow[]>;
}

export function tallyBurden(rows: readonly TallyInput[]): TallyResult;

/** "3 C1 · 7 C2" — empty string for an empty bucket. */
export function formatBreakdown(rows: readonly BreakdownRow[]): string;
```

### 2.3 Rules

**Raw counts, not weighted.** A code's count is how many assignments carry it.
The existing `burden` totals are already raw assignment counts, and the ask is to
decompose a number Gabriel is already looking at — re-deriving it under
`callBurdenWeight` would change the totals, which is beyond the request and would
make the card disagree with its own heading.

**No parent folding.** A 12-hour `C2N12` segment shows as `C2N12`, not folded
into `C2` via `parentCallCodeOf`. A breakdown exists to show the actual codes,
and not folding keeps the arithmetic exact — folding would mix whole and split
shifts under one label while the total above stayed a raw count.

Together those two rules give the invariant the tests pin:

> For every bucket, the breakdown counts sum **exactly** to the bucket total.

This also sidesteps the `0.3333` truncation entirely — no float comparison is
involved anywhere in this feature.

**Ordering** is count descending, then code ascending. Deterministic, and the
common codes lead.

**`total_assignments`** breaks down over every code, call or not.
**`total_call`** and the four day-type buckets break down over call codes only.
An assignment that is not call contributes to `total_assignments` and to nothing
else — unchanged from today.

### 2.4 Route change

`burden/route.ts` maps its rows into `TallyInput` and returns
`{ period, burden, breakdown, history }`. `history` is unchanged.

`burden` **must stay byte-identical** to what the route returns today — this is a
display addition, not a re-count. A fixture test pins the current output against
`tallyBurden` so the extraction cannot quietly change a number.

### 2.5 Rendering

`HistoryTab` gains one line under each of the six big numbers:

```
        12
   Weekday Call
   5 C1 · 7 C2
```

Empty buckets render nothing extra, so a provider with no holiday call sees the
card exactly as it looks today.

---

### 1.8 A pure seam for the form logic — `src/lib/providerEmploymentForm.ts`

The three behaviours worth pinning here — what the save payload contains, which
toggles clear which, and how an off-list employment status is offered — are all
pure functions of component state that currently live inline in a 4,000-line
component where nothing can reach them.

They move to a small pure module, following the `blockPrepView.ts` precedent from
the Block Prep work: view logic in a lib module, the component imports it.

```ts
/** Exactly the keys the Employment & Scheduling tab writes. */
export function employmentSavePayload(s: EmploymentFormState): Record<string, unknown>;

/** Partner / Partner Track / Employed Call Taker are mutually exclusive. */
export type Partnership = 'partner' | 'partner_track' | 'employed_call_taker' | null;
export function partnershipFromProfile(p: {
  is_shareholder: boolean; is_partner_track: boolean; is_employed_call_taker: boolean;
}): Partnership;
export function partnershipFlags(v: Partnership): {
  is_shareholder: boolean; is_partner_track: boolean; is_employed_call_taker: boolean;
};

/** The status list, with an off-list current value appended as "(legacy)". */
export function employmentStatusOptions(
  current: string,
): Array<{ value: string; label: string }>;
```

Modelling the trio as **one `Partnership` value** rather than three booleans is
what makes the exclusion invariant hold by construction: there is no state in
which two are true, so no toggle handler can forget to clear a sibling. The
booleans are derived at the storage boundary only. A profile that somehow has two
flags set in the database resolves by fixed precedence — partner, then partner
track, then employed call taker — so it is displayed, not crashed on.

## Testing

The repo runs vitest under `environment: 'node'` with no jsdom, so component
*interaction* is untestable but **render output is testable** via
`renderToStaticMarkup` (precedent: `src/components/ui/Modal.test.tsx`). The pure
seams above are what carry the real assertions.

| What | How |
| --- | --- |
| `tallyBurden` bucketing | Fixture rows covering every day type, call and non-call, the `counts_toward_call_burden`-true-but-category-not-`call` case, and the reverse |
| Sum invariant | Property-style assertion over a mixed fixture: every bucket's breakdown sums to its total |
| Ordering | Ties on count resolve by code ascending |
| `formatBreakdown` | Empty, single, multiple |
| Burden parity | The route's totals for a fixture match the pre-change hand-computed values |
| Employment save payload | The removed keys are absent from what `handleSave` emits; `is_employed_call_taker` is present |
| Mutual exclusion | Ticking any of Partner / Partner Track / Employed Call Taker clears the other two |
| Legacy status option | A profile with an off-list status renders it as a `(legacy)` option rather than dropping it |

`npm run build` is the last check before any push — a page may only export a
fixed set of fields, and both `tsc --noEmit` and vitest pass on a build that
`next build` rejects.

---

## Known residuals

- Eighteen columns remain in `provider_employment_profiles` with no UI. They
  keep their current values and stay writable through the API. Dropping them is a
  separate decision.
- `employment_status` still carries `employed`, which `EMPLOYMENT_STATUSES` does
  not allow. Zero rows use it; the `(legacy)` option in 1.5C keeps such a row
  editable rather than resolving what the status means.
- The Assignment History totals remain **unweighted** — a 12-hour call segment
  counts as a whole assignment there, while the Call Counts modal and the Block
  Prep board weight it at 0.5. The two surfaces answer different questions ("what
  did they work" versus "what do they owe"), but the difference is not labelled
  on the card. Worth revisiting when part 3 lands, since Specialty Call Taker
  contracts are expressed in whole shifts.
- Preferences & Specialties still has six of its eight groups empty across the
  roster. Out of scope here; a candidate for part 4.
