# Block Prep Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/block-prep` — a site-scoped board listing a site's call takers with inline-editable FTE and PTO allotment, a per-provider availability drawer, a Create Schedule action, and an annual tally card that also mounts on `/dashboard`.

**Architecture:** Two new pure lib modules (`annualTally.ts` for the math, `blockPrepView.ts` for view decisions) sit under one new read-only API route. Every number is assembled from helpers that already own it — `plannerYearCounters`, `entitledOffDays`, `computeScheduleActuals`, `dayTypeBucketOn`, `callBurdenWeight` — and none is re-derived. All writes reuse existing endpoints. No engine change; generation behaviour is untouched.

**Tech Stack:** Next.js 14 App Router (client page + route handler), Supabase (`scheduling` schema, service-role client), TypeScript, vitest (`environment: 'node'`, no jsdom).

**Spec:** `docs/superpowers/specs/2026-09-06-block-prep-board-design.md`

---

## Background an engineer needs before Task 1

**Two different things are called "off days" in this codebase. Do not confuse them.**

1. `entitledOffDays` (`src/lib/rulesEngine/workDays.ts`) — the FTE-derived *budget*: `workingDays − round(workDaysFte × workingDays)`. A 1.0 FTE gets zero. **This is what the board's "Off days" column means**, per Gabriel.
2. `availability_type = 'unavailable'` rows, labelled "Days Off" in the provider profile UI and counted by `plannerYearCounters(...).daysOffDays`. These are *entries someone typed*, not a budget. The board does not show them as the off-days column.

**Blank vs zero is load-bearing.** `pto_weeks` null = "nobody has stated this person's allotment"; `pto_weeks` 0 = "this person genuinely gets none." Gabriel confirmed both exist. Any code that collapses one into the other is a bug.

**Published-only.** Clinical invariant 3: committed = `schedule_versions.version_status = 'published'`. Draft assignments must never appear in the tally. The predicate is single-homed in `src/lib/rulesEngine/committedAssignments.ts` — use `filterPublishedVersions`, never re-inline `.eq('...version_status', 'published')`.

**Run tests with:** `npx vitest run <path>` for one file, `npm test` for the suite. `npm test` surfaces 10 "No test suite found" errors from `src/lib/gridCalculator/` tsx-based tests — that is expected and pre-existing, not something you caused.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/annualTally.ts` (create) | Pure annual math: PTO figures, off-day budget/used, weighted call counts. The shared heart — roster columns and tally card both read it. |
| `src/lib/annualTally.test.ts` (create) | Tests for the above, fixtures modelled on the live Paoli block. |
| `src/lib/blockPrepView.ts` (create) | Pure view decisions: row ordering, blank-vs-zero rendering, inline-edit parsing/bounds, span label. |
| `src/lib/blockPrepView.test.ts` (create) | Tests for the above. |
| `src/app/api/scheduling/block-prep/route.ts` (create) | The one new endpoint. All DB reads. Fail-soft per panel. |
| `src/app/api/scheduling/block-prep/route.helpers.ts` (create) | `loadBlockPrepData(sb, siteId, year)` — testable with an injected fake client. |
| `src/app/api/scheduling/block-prep/route.helpers.test.ts` (create) | Route tests with a fake supabase client. |
| `src/components/AnnualTallyCard.tsx` (create) | The shared tally card, mounted twice. |
| `src/app/(scheduling)/block-prep/page.tsx` (create) | Page: fetch, state, markup. |
| `src/app/(scheduling)/block-prep/RosterCard.tsx` (create) | Roster table + inline editing. |
| `src/app/(scheduling)/block-prep/AvailabilityDrawer.tsx` (create) | Per-provider availability add/edit/delete. |
| `src/app/(scheduling)/providers/[id]/page.tsx` (modify: 659, 699, 785) | Stop collapsing blank `pto_weeks` to 0. |
| `src/app/(scheduling)/dashboard/page.tsx` (modify) | Mount `AnnualTallyCard`. |
| `src/components/AppShell.tsx` (modify: 16-25) | One nav entry. |
| `supabase_scheduling_patch45_pto_weeks_unset.sql` (create) | Clear the 78 untouched zeros. |

---

## Task 1: Make a blank PTO allotment mean "not stated"

`pto_weeks` is nullable with `DEFAULT 0`, and 78 of 83 employment profiles sit at 0 with none at null — the column has never distinguished "gets no vacation" from "nobody filled this in." The API already handles null correctly (`validateAndSplitPatch` maps `''` and `null` to null for `pto_weeks`, and only range-checks real numbers). **The profile editor is the only place blank becomes zero.**

**Files:**
- Modify: `src/app/(scheduling)/providers/[id]/page.tsx:659`, `:699`, `:785`
- Create: `supabase_scheduling_patch45_pto_weeks_unset.sql`

- [ ] **Step 1: Show blank when nothing is stated**

At line 659, replace:

```tsx
  const [ptoWeeks, setPtoWeeks] = useState(String(profile.pto_weeks ?? 0));
```

with:

```tsx
  // Blank means NOT STATED, 0 means a real zero (Gabriel 2026-09-06: "0 is a
  // real number for some of them"). Mirrors the work_days_fte field above.
  const [ptoWeeks, setPtoWeeks] = useState(
    profile.pto_weeks == null ? '' : String(profile.pto_weeks));
```

- [ ] **Step 2: Same in the reset effect**

At line 699, replace:

```tsx
    setPtoWeeks(String(profile.pto_weeks ?? 0));
```

with:

```tsx
    setPtoWeeks(profile.pto_weeks == null ? '' : String(profile.pto_weeks));
```

- [ ] **Step 3: Send null for blank**

At line 785, replace:

```tsx
      pto_weeks: ptoWeeks === '' ? 0 : parseInt(ptoWeeks, 10),
```

with:

```tsx
      pto_weeks: ptoWeeks.trim() === '' ? null : parseInt(ptoWeeks, 10),
```

No validator change is needed: `checkInt` at line 744 already returns early on an empty string, and the API's `validateAndSplitPatch` already maps null to null for this key.

- [ ] **Step 4: Update the profile type**

Find the `EmploymentProfile` interface declaration of `pto_weeks` (line 84) and change:

```tsx
  pto_weeks: number;
```

to:

```tsx
  pto_weeks: number | null;
```

Then find the default-profile literal at line 167 and change `pto_weeks: 0,` to `pto_weeks: null,`.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors mentioning `pto_weeks`. If another site reads `profile.pto_weeks` expecting a number, give it an explicit `?? 0` at that call site rather than widening it back.

- [ ] **Step 6: Write the migration**

Create `supabase_scheduling_patch45_pto_weeks_unset.sql`, following the requirements section at the
end of this task. **Do not author it from scratch and do not copy an earlier draft** — the shipped
file is committed in this repo at the root and is the reference; the requirements below are its spec.
An earlier draft of this plan inlined a version with an inert pre-flight `SELECT`, the `ALTER` outside
the transaction, and an overclaimed no-loss statement. Code review caught all three. The corrected
file is what is committed.

- [ ] **Step 7: Add the missing validator test**

The whole feature now rests on `validateAndSplitPatch` mapping `''` and `null` to null for `pto_weeks` **while preserving a literal `0`**. That contract has no test, while its sibling field does: `src/lib/validation/providers.test.ts` carries a `describe('validateAndSplitPatch — work_days_fte')` block whose first case is named `'BLANK becomes NULL — the "same as FTE" state, never 0'`.

Read that block and add a sibling `describe('validateAndSplitPatch — pto_weeks')` matching its shape and assertion idiom. Cover: blank string → null, explicit null → null, a stated `0` surviving as `0` and explicitly not null, and a positive integer passing through. The stated-zero case is the point of this task and nothing else pins it.

Run: `npx vitest run src/lib/validation/providers.test.ts`
Expected: PASS.

- [ ] **Step 8: Add a hint to the PTO Weeks field**

`src/app/(scheduling)/providers/[id]/page.tsx`, the `<Field label="PTO Weeks" ...>` around line 847, has no `hint` — while the `work_days_fte` field two lines above and the FTE field above that both explain their own blank conventions. This change makes blank load-bearing for the first time and the UI currently says nothing about it. Add a hint in the same style and with the same `·` separator, conveying: blank = not stated, 0 = genuinely no allotment.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(scheduling)/providers/[id]/page.tsx" src/lib/validation/providers.test.ts supabase_scheduling_patch45_pto_weeks_unset.sql
git commit -m "pto_weeks: blank means not stated, zero means zero"
```

Do **not** apply the patch yet. It goes to the live DB only after this code is deployed.

### Migration file requirements (learned in review — do not omit)

The patch is the risky artifact in this task and must carry the sections every comparable patch in this repo carries. Beyond the header, WHY and EFFECT sections:

- **An aborting pre-flight, not a bare SELECT.** A `SELECT` above `COMMIT;` in the same script reports its counts only after the UPDATE has already committed — it reads like a guard and is inert. Use a `DO $$ ... RAISE EXCEPTION` block in the style patch44 uses. Assert the known stated (`pto_weeks > 0`) rows still exist, so the patch refuses to run if someone has been editing allotments and the "these zeros carry no information" premise has expired. Do **not** assert that no nulls exist — CODE-FIRST legitimately allows genuine nulls to appear before the patch runs.
- **`ALTER TABLE ... DROP DEFAULT` inside the transaction**, above `COMMIT;`. Postgres DDL is transactional. Left outside, an ALTER failure strands 78 nulls alongside a live `DEFAULT 0` that keeps feeding both insert paths — silently regenerating the exact problem the patch fixes.
- **A ROLLBACK section**, with both caveats: it is faithful only if run before anyone states a new blank, and a code rollback without it is silently destructive (see Task 11 Step 6).
- **A post-apply VERIFICATION section.**
- **An honest no-loss claim.** "Nothing deliberately entered is lost" is true of the 78 rows as of authoring, but *not* of a real `0` typed between the code deploy and the patch. Say so, and say that real zeros are entered only afterwards.

---

## Task 2: Annual PTO figures

**Files:**
- Create: `src/lib/annualTally.ts`
- Create: `src/lib/annualTally.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/annualTally.test.ts`:

```ts
// Annual tally math. Fixtures mirror the live Paoli roster shape: a 1.0 FTE
// with a stated allotment, a partial-call doc whose WORKING-days FTE is 1.00
// (Hussain), and a call taker with no allotment stated at all.
import { describe, it, expect } from 'vitest';
import { ptoFiguresFor, offDayBudgetFor, type TallyProfile } from './annualTally';
import type { PlannerAvailabilityRow } from './plannerMath';

const profile = (over: Partial<TallyProfile> = {}): TallyProfile => ({
  provider_id: 'p1',
  fte_value: 1,
  work_days_fte: null,
  pto_weeks: 4,
  ...over,
});

const pto = (start: string, end: string, over: Partial<PlannerAvailabilityRow> = {}): PlannerAvailabilityRow => ({
  provider_id: 'p1',
  availability_type: 'pto',
  start_date: start,
  end_date: end,
  approval_status: 'approved',
  ...over,
});

describe('ptoFiguresFor', () => {
  it('counts weekdays used and subtracts them from the allotment', () => {
    // Mon 2026-06-08 .. Fri 2026-06-12 = 5 weekdays.
    const f = ptoFiguresFor(profile({ pto_weeks: 4 }), [pto('2026-06-08', '2026-06-12')], 2026);
    expect(f.usedWeekdays).toBe(5);
    expect(f.allotmentDays).toBe(20);
    expect(f.remainingDays).toBe(15);
  });

  it('counts sold-back days as USED — selling back never refunds the pool', () => {
    const rows = [
      pto('2026-06-08', '2026-06-12'),
      { ...pto('2026-06-08', '2026-06-09'), availability_type: 'pto_sellback' },
    ];
    const f = ptoFiguresFor(profile({ pto_weeks: 4 }), rows, 2026);
    expect(f.usedWeekdays).toBe(5);
    expect(f.soldWeekdays).toBe(2);
    expect(f.remainingDays).toBe(15);
  });

  it('reports NO remaining figure when the allotment is unstated', () => {
    const f = ptoFiguresFor(profile({ pto_weeks: null }), [pto('2026-06-08', '2026-06-12')], 2026);
    expect(f.usedWeekdays).toBe(5);
    expect(f.allotmentDays).toBeNull();
    expect(f.remainingDays).toBeNull();
  });

  it('treats a stated zero as a real zero, not as unstated', () => {
    const f = ptoFiguresFor(profile({ pto_weeks: 0 }), [], 2026);
    expect(f.allotmentDays).toBe(0);
    expect(f.remainingDays).toBe(0);
  });

  it('ignores denied and canceled rows', () => {
    const rows = [pto('2026-06-08', '2026-06-12', { approval_status: 'denied' })];
    expect(ptoFiguresFor(profile(), rows, 2026).usedWeekdays).toBe(0);
  });

  it('counts only the requested year for a range that straddles New Year', () => {
    // 2026-12-30..2027-01-02: 2026 weekdays are Wed 30 + Thu 31 = 2.
    const f = ptoFiguresFor(profile(), [pto('2026-12-30', '2027-01-02')], 2026);
    expect(f.usedWeekdays).toBe(2);
  });
});

describe('offDayBudgetFor', () => {
  it('gives a full-timer zero off days', () => {
    expect(offDayBudgetFor(profile({ fte_value: 1 }), 250)).toBe(0);
  });

  it('gives a 0.75 FTE a quarter of the working days', () => {
    // 250 - round(187.5) = 250 - 188 = 62. entitledOffDays rounds half UP, and
    // that rounding is the engine's — match it, never "fix" it here.
    expect(offDayBudgetFor(profile({ fte_value: 0.75 }), 250)).toBe(62);
  });

  it('keys off WORKING-days FTE, not call FTE (the Hussain case)', () => {
    // Call FTE 0.70 but work_days_fte 1.00 — he works full days, so zero off days.
    expect(offDayBudgetFor(profile({ fte_value: 0.7, work_days_fte: 1 }), 250)).toBe(0);
  });

  it('treats a null FTE as zero rather than throwing', () => {
    expect(offDayBudgetFor(profile({ fte_value: null }), 250)).toBe(250);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/annualTally.test.ts`
Expected: FAIL — `Failed to resolve import "./annualTally"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/annualTally.ts`:

```ts
// Annual tally — the calendar-year figures behind the Block Prep board's
// roster columns and the AnnualTallyCard mounted on it and on /dashboard.
//
// THIS MODULE ASSEMBLES; IT DOES NOT DERIVE. Every rule routes to the helper
// that already owns it:
//   - PTO used / sold-back      → plannerMath.plannerYearCounters, which is
//     itself dateRanges.ptoCounterStats over liveAvailabilityRows
//   - off-day BUDGET            → rulesEngine/workDays.entitledOffDays
//   - PTO netting inside a span → rulesEngine/workDays.ptoWeekdaysCovered
//   - worked-day credit         → plannerMath.computeScheduleActuals
//   - fairness bucket           → rulesEngine/shared.dayTypeBucketOn (DATE-aware:
//     a Monday holiday is a M-Th call)
//   - call split weighting      → callBurden.callBurdenWeight / parentCallCodeOf
//
// THE TALLY IS A VIEW, NEVER AN INPUT (Gabriel 2026-09-06, verbatim: "I want
// each call block to be its own calculation... it wont matter what happened the
// previous block, the number of calls given out will depend on the FTE status").
// Nothing here is read by the engine. There is deliberately NO annual call
// obligation: obligations are per-block, from the stated FTE bands, and an
// annual over/under figure would be a second obligation model running beside
// them. Call counts here are COUNTS. Only PTO and off days, which have real
// annual denominators, carry a "remaining".
//
// BLANK IS NOT ZERO. A null pto_weeks means nobody has stated the allotment and
// yields a null remaining — never 0, never negative. A stated 0 is a real zero
// (Gabriel: "0 is a real number for some of them").

import {
  liveAvailabilityRows,
  plannerYearCounters,
  type PlannerAvailabilityRow,
} from './plannerMath';
import { entitledOffDays } from './rulesEngine/workDays';

// Working days consumed per week of PTO. Deliberately a local constant rather
// than an import from gridCalculator/providerProfile.ts, which holds its own
// copy for its simulator: CLAUDE.md keeps gridCalculator a sibling engine that
// does not share code with the scheduling path, and one definitional integer is
// a smaller cost than crossing that boundary.
export const PTO_WORK_DAYS_PER_WEEK = 5;

/** The employment-profile fields this module needs. */
export interface TallyProfile {
  provider_id: string;
  /** Call FTE. Null on a legacy profile — treated as 0. */
  fte_value: number | null;
  /** Working-days FTE (patch43). Null means "same as fte_value". */
  work_days_fte: number | null;
  /** Annual PTO allotment in weeks. NULL means NOT STATED; 0 is a real zero. */
  pto_weeks: number | null;
}

export interface PtoFigures {
  /** Weekdays consumed from the pool this year, sold-back days INCLUDED. */
  usedWeekdays: number;
  /** Of those, how many were also sold back (worked at premium). Informational. */
  soldWeekdays: number;
  /** pto_weeks x 5, or null when the allotment is unstated. */
  allotmentDays: number | null;
  /** allotmentDays - usedWeekdays, or null when the allotment is unstated. */
  remainingDays: number | null;
}

/**
 * One provider's annual PTO figures. `rows` may be the whole roster's
 * availability; only this provider's rows are used, and dismissed
 * (denied/canceled) rows are ignored by plannerYearCounters.
 */
export function ptoFiguresFor(
  profile: TallyProfile,
  rows: ReadonlyArray<PlannerAvailabilityRow>,
  year: number,
): PtoFigures {
  const mine = rows.filter(r => r.provider_id === profile.provider_id);
  const counters = plannerYearCounters(mine, year);
  const allotmentDays = profile.pto_weeks == null
    ? null
    : profile.pto_weeks * PTO_WORK_DAYS_PER_WEEK;
  return {
    usedWeekdays: counters.pto.weekdaysBooked,
    soldWeekdays: counters.pto.weekdaysSold,
    allotmentDays,
    remainingDays: allotmentDays == null ? null : allotmentDays - counters.pto.weekdaysBooked,
  };
}

/**
 * The off-day BUDGET: working days the provider is not obligated to work,
 * because their working-days FTE is below 1. Independent of PTO — a PTO day is
 * not an off day, it is a paid absence from an obligated day.
 *
 * Note this is NOT the same thing as `availability_type = 'unavailable'` rows,
 * which the provider profile labels "Days Off". Those are typed entries; this
 * is a contractual entitlement.
 */
export function offDayBudgetFor(profile: TallyProfile, workingDaysInYear: number): number {
  return entitledOffDays(
    Number(profile.fte_value ?? 0), workingDaysInYear, profile.work_days_fte);
}

/** Live (non-dismissed) rows for one provider — shared by the callers below. */
export function liveRowsFor(
  providerId: string, rows: ReadonlyArray<PlannerAvailabilityRow>,
): PlannerAvailabilityRow[] {
  return liveAvailabilityRows(rows.filter(r => r.provider_id === providerId));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/annualTally.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/annualTally.ts src/lib/annualTally.test.ts
git commit -m "annualTally: PTO figures and off-day budget"
```

---

## Task 3: Weighted annual call counts

**Files:**
- Modify: `src/lib/annualTally.ts`
- Modify: `src/lib/annualTally.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/annualTally.test.ts`:

```ts
import { annualCallCounts, type TallyShiftType } from './annualTally';
import type { PlannerSlotRow } from './plannerMath';

const SHIFT_TYPES = new Map<string, TallyShiftType>([
  ['C1', { call_burden_weight: 1, parent_call_code: null }],
  ['C2', { call_burden_weight: 1, parent_call_code: null }],
  // A 12-hour split segment: half a call, folded under its parent C1.
  ['C1N12', { call_burden_weight: 0.5, parent_call_code: 'C1' }],
]);

const slot = (
  date: string, code: string, providerId: string | null,
  dayType: string, status = 'assigned',
): PlannerSlotRow => ({
  slot_date: date,
  derived_day_type: dayType,
  shift_types: { code, category: 'call' },
  assignments: providerId ? [{ provider_id: providerId, assignment_status: status }] : [],
});

describe('annualCallCounts', () => {
  it('folds a split segment under its parent at half weight', () => {
    // 2026-09-12 is a Saturday.
    const out = annualCallCounts(
      [slot('2026-09-12', 'C1N12', 'p1', 'saturday')], SHIFT_TYPES, 2026);
    expect(out.get('p1')).toEqual([{ bucket: 'saturday', code: 'C1', count: 0.5 }]);
  });

  it('sums two 12h segments into one whole Saturday C1', () => {
    const out = annualCallCounts([
      slot('2026-09-12', 'C1N12', 'p1', 'saturday'),
      slot('2026-09-19', 'C1N12', 'p1', 'saturday'),
    ], SHIFT_TYPES, 2026);
    expect(out.get('p1')).toEqual([{ bucket: 'saturday', code: 'C1', count: 1 }]);
  });

  it('buckets a Monday holiday as a M-Th call, not a holiday', () => {
    // Labor Day 2026-09-07 is a Monday; its stored day type is the holiday one.
    const out = annualCallCounts(
      [slot('2026-09-07', 'C1', 'p1', 'holiday')], SHIFT_TYPES, 2026);
    expect(out.get('p1')).toEqual([{ bucket: 'weekday', code: 'C1', count: 1 }]);
  });

  it('splits a block that straddles New Year by slot_date', () => {
    const slots = [
      slot('2026-12-28', 'C1', 'p1', 'weekday'),
      slot('2027-01-05', 'C1', 'p1', 'weekday'),
    ];
    expect(annualCallCounts(slots, SHIFT_TYPES, 2026).get('p1'))
      .toEqual([{ bucket: 'weekday', code: 'C1', count: 1 }]);
    expect(annualCallCounts(slots, SHIFT_TYPES, 2027).get('p1'))
      .toEqual([{ bucket: 'weekday', code: 'C1', count: 1 }]);
  });

  it('ignores unfilled slots and canceled assignments', () => {
    const out = annualCallCounts([
      slot('2026-09-08', 'C1', null, 'weekday'),
      slot('2026-09-09', 'C1', 'p1', 'weekday', 'canceled'),
    ], SHIFT_TYPES, 2026);
    expect(out.size).toBe(0);
  });

  it('ignores non-call slots', () => {
    const daySlot: PlannerSlotRow = {
      slot_date: '2026-09-08',
      derived_day_type: 'weekday',
      shift_types: { code: 'D1', category: 'day' },
      assignments: [{ provider_id: 'p1', assignment_status: 'assigned' }],
    };
    expect(annualCallCounts([daySlot], SHIFT_TYPES, 2026).size).toBe(0);
  });

  it('sorts counts by bucket then code', () => {
    const out = annualCallCounts([
      slot('2026-09-13', 'C2', 'p1', 'sunday'),
      slot('2026-09-08', 'C2', 'p1', 'weekday'),
      slot('2026-09-08', 'C1', 'p1', 'weekday'),
    ], SHIFT_TYPES, 2026);
    expect(out.get('p1')).toEqual([
      { bucket: 'sunday', code: 'C2', count: 1 },
      { bucket: 'weekday', code: 'C1', count: 1 },
      { bucket: 'weekday', code: 'C2', count: 1 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/annualTally.test.ts`
Expected: FAIL — `annualCallCounts is not a function`.

- [ ] **Step 3: Write the implementation**

Add to the imports at the top of `src/lib/annualTally.ts`:

```ts
import {
  assignmentFills,
  liveAvailabilityRows,
  plannerYearCounters,
  type PlannerAvailabilityRow,
  type PlannerSlotRow,
} from './plannerMath';
import { entitledOffDays } from './rulesEngine/workDays';
import { dayTypeBucketOn } from './rulesEngine/shared';
import {
  callBurdenWeight, parentCallCodeOf,
  type BurdenWeighted, type ParentCoded,
} from './callBurden';
```

(That replaces the earlier `plannerMath` import block and the `workDays` line — keep one import statement per module.)

Append to `src/lib/annualTally.ts`:

```ts
/** The shift-type columns the weighting needs, keyed by code. */
export type TallyShiftType = BurdenWeighted & ParentCoded;

export interface CallCount {
  /** Fairness bucket: weekday | friday | saturday | sunday. */
  bucket: string;
  /** PARENT call code — a split segment counts under the call it is part of. */
  code: string;
  /** Weighted: a 12h segment is 0.5, a whole call is 1. */
  count: number;
}

// PostgREST embeds slot->assignments as an ARRAY on databases without the
// UNIQUE(schedule_slot_id) constraint and as a single OBJECT on those with it.
// Both shapes are normalized here, same as the dashboard's queries.ts.
function assignmentsOf(slot: PlannerSlotRow): Array<{ provider_id: string | null; assignment_status: string }> {
  const a = slot.assignments;
  if (a == null) return [];
  return Array.isArray(a) ? a : [a];
}

/**
 * Weighted per-provider call counts for one calendar year, keyed by provider id.
 *
 * `slots` MUST already be scoped to published versions at the site of interest
 * — this function does not know about version status and will happily count a
 * draft. The route is responsible for that (clinical invariant 3).
 *
 * Attribution is by `slot_date`, so a block straddling New Year splits between
 * the two years (Gabriel 2026-09-06: "a call on 1/5 counts toward 2027").
 */
export function annualCallCounts(
  slots: ReadonlyArray<PlannerSlotRow>,
  shiftTypes: ReadonlyMap<string, TallyShiftType>,
  year: number,
): Map<string, CallCount[]> {
  const prefix = `${year}-`;
  const byProvider = new Map<string, Map<string, CallCount>>();

  for (const slot of slots) {
    const st = slot.shift_types;
    if (!st || st.category !== 'call') continue;
    if (!slot.slot_date.startsWith(prefix)) continue;

    const meta = shiftTypes.get(st.code);
    const bucket = dayTypeBucketOn(slot.derived_day_type || 'weekday', slot.slot_date);
    const code = parentCallCodeOf(st.code, meta);
    const weight = callBurdenWeight(meta);

    for (const a of assignmentsOf(slot)) {
      if (!assignmentFills(a)) continue;
      const pid = a.provider_id as string;
      let counts = byProvider.get(pid);
      if (!counts) { counts = new Map(); byProvider.set(pid, counts); }
      const key = `${bucket}|${code}`;
      const cur = counts.get(key);
      if (cur) cur.count += weight;
      else counts.set(key, { bucket, code, count: weight });
    }
  }

  const out = new Map<string, CallCount[]>();
  for (const [pid, counts] of byProvider) {
    out.set(pid, [...counts.values()].sort(
      (a, b) => a.bucket.localeCompare(b.bucket) || a.code.localeCompare(b.code)));
  }
  return out;
}

/** Weighted total across every bucket — the roster's "Calls this year" cell. */
export function callTotal(counts: ReadonlyArray<CallCount>): number {
  return counts.reduce((n, c) => n + c.count, 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/annualTally.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/annualTally.ts src/lib/annualTally.test.ts
git commit -m "annualTally: weighted annual call counts by bucket"
```

---

## Task 4: Off days used, and the covered span

Off days used can only be counted where a schedule exists — half of next year is unbuilt. This computes the number **and the span it was counted over**, so the UI can say so rather than implying a full-year figure.

**Files:**
- Modify: `src/lib/annualTally.ts`
- Modify: `src/lib/annualTally.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/annualTally.test.ts`:

```ts
import { computeAnnualTally } from './annualTally';
import type { PlannerHoliday } from './plannerMath';

const HOLIDAYS_2026: PlannerHoliday[] = [
  { holiday_date: '2026-01-01', is_major_holiday: true },
  { holiday_date: '2026-05-25', is_major_holiday: true },
  { holiday_date: '2026-07-04', is_major_holiday: true },
  { holiday_date: '2026-09-07', is_major_holiday: true },
  { holiday_date: '2026-11-26', is_major_holiday: true },
  { holiday_date: '2026-12-25', is_major_holiday: true },
];

describe('computeAnnualTally', () => {
  const base = {
    year: 2026,
    profiles: [profile({ provider_id: 'p1', fte_value: 1, pto_weeks: 4 })],
    availability: [] as PlannerAvailabilityRow[],
    slots: [] as PlannerSlotRow[],
    holidays: HOLIDAYS_2026,
    shiftTypes: SHIFT_TYPES,
    coveredSpans: [] as Array<{ date_start: string; date_end: string }>,
  };

  it('reports a null offDaysUsed when no published block covers the year', () => {
    const t = computeAnnualTally(base);
    expect(t.coveredSpan).toBeNull();
    expect(t.providers.get('p1')!.offDaysUsed).toBeNull();
  });

  it('counts working days in the year excluding major holidays only', () => {
    // 2026-07-04 is a Saturday, so it removes no working day; the other five
    // majors are weekdays. 2026 has 261 weekdays.
    const t = computeAnnualTally(base);
    expect(t.workingDaysInYear).toBe(261 - 5);
  });

  it('counts off days only through the blocks that exist', () => {
    // One published week, Mon 2026-06-08 .. Sun 2026-06-14: 5 working days.
    // The provider is assigned on 2 of them and has no PTO, so 3 are off days.
    const t = computeAnnualTally({
      ...base,
      coveredSpans: [{ date_start: '2026-06-08', date_end: '2026-06-14' }],
      slots: [
        slot('2026-06-08', 'C1', 'p1', 'weekday'),
        slot('2026-06-10', 'C1', 'p1', 'weekday'),
      ],
    });
    expect(t.coveredSpan).toEqual({ start: '2026-06-08', end: '2026-06-14', workingDays: 5 });
    // 2026-06-08 is a call with requires_post_call_rule unset in the fixture,
    // so only the two assigned days are credited.
    expect(t.providers.get('p1')!.offDaysUsed).toBe(3);
  });

  it('does not charge PTO weekdays as off days', () => {
    const t = computeAnnualTally({
      ...base,
      coveredSpans: [{ date_start: '2026-06-08', date_end: '2026-06-14' }],
      slots: [slot('2026-06-08', 'C1', 'p1', 'weekday')],
      availability: [pto('2026-06-09', '2026-06-10')],
    });
    // 5 working days - 1 assigned - 2 PTO = 2 off days.
    expect(t.providers.get('p1')!.offDaysUsed).toBe(2);
  });

  it('clips the covered span to the requested year', () => {
    const t = computeAnnualTally({
      ...base,
      coveredSpans: [{ date_start: '2026-12-28', date_end: '2027-01-10' }],
    });
    expect(t.coveredSpan!.start).toBe('2026-12-28');
    expect(t.coveredSpan!.end).toBe('2026-12-31');
  });

  it('carries PTO, budget and call figures onto every profile row', () => {
    const t = computeAnnualTally({
      ...base,
      profiles: [
        profile({ provider_id: 'p1', fte_value: 1, pto_weeks: 4 }),
        profile({ provider_id: 'p2', fte_value: 0.5, pto_weeks: null }),
      ],
      slots: [slot('2026-06-08', 'C1', 'p1', 'weekday')],
    });
    const p1 = t.providers.get('p1')!;
    expect(p1.pto.allotmentDays).toBe(20);
    expect(p1.offDayBudget).toBe(0);
    expect(p1.callTotal).toBe(1);
    const p2 = t.providers.get('p2')!;
    expect(p2.pto.remainingDays).toBeNull();
    expect(p2.offDayBudget).toBe(128);
    expect(p2.callTotal).toBe(0);
    expect(p2.callCounts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/annualTally.test.ts`
Expected: FAIL — `computeAnnualTally is not a function`.

- [ ] **Step 3: Write the implementation**

Extend the `plannerMath` import in `src/lib/annualTally.ts` to also pull `computeScheduleActuals` and `rangeComposition`:

```ts
import {
  assignmentFills,
  computeScheduleActuals,
  liveAvailabilityRows,
  plannerYearCounters,
  rangeComposition,
  type PlannerAvailabilityRow,
  type PlannerHoliday,
  type PlannerSlotRow,
} from './plannerMath';
import { entitledOffDays, ptoWeekdaysCovered } from './rulesEngine/workDays';
```

Append to `src/lib/annualTally.ts`:

```ts
export interface CoveredSpan {
  date_start: string;
  date_end: string;
}

export interface AnnualTallyInput {
  year: number;
  profiles: ReadonlyArray<TallyProfile>;
  /** Whole-roster availability rows; each MUST carry provider_id. */
  availability: ReadonlyArray<PlannerAvailabilityRow>;
  /** PUBLISHED slots at the site, any date — filtered to the year here. */
  slots: ReadonlyArray<PlannerSlotRow>;
  holidays: ReadonlyArray<PlannerHoliday>;
  shiftTypes: ReadonlyMap<string, TallyShiftType>;
  /** Date ranges of the published blocks at the site that overlap the year. */
  coveredSpans: ReadonlyArray<CoveredSpan>;
}

export interface ProviderAnnualFigures {
  pto: PtoFigures;
  /** Contractual off-day entitlement for the whole year. */
  offDayBudget: number;
  /**
   * Off days consumed, counted ONLY across `coveredSpan`. Null when no
   * published block covers any of the year — an unbuilt month is not a month
   * of days off, and must never be rendered as one.
   */
  offDaysUsed: number | null;
  callCounts: CallCount[];
  callTotal: number;
}

export interface AnnualTally {
  year: number;
  /** Weekdays in the year minus MAJOR holidays (workDays.ts contract). */
  workingDaysInYear: number;
  /**
   * The union of published block ranges, clipped to the year, expressed as its
   * outer bounds plus the working-day count actually used for offDaysUsed.
   * Null when nothing is published in the year.
   */
  coveredSpan: { start: string; end: string; workingDays: number } | null;
  providers: Map<string, ProviderAnnualFigures>;
}

/**
 * The board's whole annual picture in one pass.
 *
 * `slots` must already be published-only and site-scoped; see annualCallCounts.
 */
export function computeAnnualTally(input: AnnualTallyInput): AnnualTally {
  const { year, profiles, availability, slots, holidays, shiftTypes, coveredSpans } = input;

  // The year's working-day set. rangeComposition caps at MAX_PLANNER_RANGE_DAYS
  // (400), comfortably above a 366-day year.
  const comp = rangeComposition(`${year}-01-01`, `${year}-12-31`, holidays);

  // Working days inside a published block, clipped to the year.
  const coveredWorkingDays = new Set<string>();
  for (const d of comp.workingDaySet) {
    if (coveredSpans.some(s => d >= s.date_start && d <= s.date_end)) coveredWorkingDays.add(d);
  }
  const coveredDates = [...coveredWorkingDays].sort();
  const coveredSpan = coveredDates.length === 0 ? null : {
    start: coveredDates[0],
    end: coveredDates[coveredDates.length - 1],
    workingDays: coveredDates.length,
  };

  const counts = annualCallCounts(slots, shiftTypes, year);

  // Worked-day credit across the covered span only. computeScheduleActuals
  // clips to the working-day set it is handed, and returns assigned /
  // post-call-rest / ICU as three DISJOINT sets, so their sizes simply add.
  const yearSlots = slots.filter(s => s.slot_date.startsWith(`${year}-`));
  const actuals = coveredSpan
    ? computeScheduleActuals(yearSlots, availability, coveredWorkingDays, holidays)
    : {};

  const providers = new Map<string, ProviderAnnualFigures>();
  for (const profile of profiles) {
    const pid = profile.provider_id;
    const myCounts = counts.get(pid) ?? [];

    let offDaysUsed: number | null = null;
    if (coveredSpan) {
      const a = actuals[pid];
      const credited = a
        ? a.assignedWorkdays.length + a.postCallRestWorkdays.length + a.icuWorkdays.length
        : 0;
      const ptoInSpan = ptoWeekdaysCovered(liveRowsFor(pid, availability), coveredWorkingDays).size;
      offDaysUsed = Math.max(0, coveredSpan.workingDays - credited - ptoInSpan);
    }

    providers.set(pid, {
      pto: ptoFiguresFor(profile, availability, year),
      offDayBudget: offDayBudgetFor(profile, comp.workingDays),
      offDaysUsed,
      callCounts: myCounts,
      callTotal: callTotal(myCounts),
    });
  }

  return { year, workingDaysInYear: comp.workingDays, coveredSpan, providers };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/annualTally.test.ts`
Expected: PASS, 23 tests.

If the "counts working days in the year" test disagrees, print `comp.workingDays` and check 2026's weekday count and which majors land on weekends before changing the expectation — the arithmetic is `isWorkingDay`'s, and it is the engine's.

- [ ] **Step 5: Run the whole suite to confirm nothing regressed**

Run: `npm test`
Expected: all pass except the 10 pre-existing "No test suite found" errors under `src/lib/gridCalculator/`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/annualTally.ts src/lib/annualTally.test.ts
git commit -m "annualTally: off days used, covered span, whole-tally entry point"
```

---

## Task 5: View logic

Anything the board decides that could be *wrong* lives here beside a test, because vitest runs `environment: 'node'` with no jsdom and a page component is not unit-testable. This is the same split `blockTargetsPanel.ts` established.

**Files:**
- Create: `src/lib/blockPrepView.ts`
- Create: `src/lib/blockPrepView.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/blockPrepView.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  sortRosterRows, allotmentText, remainingText, offDaysText,
  coveredSpanLabel, parseFteInput, parseAllotmentInput,
  type RosterRow,
} from './blockPrepView';

const row = (over: Partial<RosterRow> = {}): RosterRow => ({
  provider_id: 'p1',
  display_name: 'A.Jones',
  last_name: 'Jones',
  fte_value: 1,
  work_days_fte: null,
  pto_weeks: 4,
  call_taker: true,
  partial_call_taker: false,
  pto: { usedWeekdays: 0, soldWeekdays: 0, allotmentDays: 20, remainingDays: 20 },
  offDayBudget: 0,
  offDaysUsed: null,
  callCounts: [],
  callTotal: 0,
  ...over,
});

describe('sortRosterRows', () => {
  it('orders by FTE descending, then last name', () => {
    const rows = [
      row({ provider_id: 'a', last_name: 'Zeta', fte_value: 0.5 }),
      row({ provider_id: 'b', last_name: 'Beta', fte_value: 1 }),
      row({ provider_id: 'c', last_name: 'Alpha', fte_value: 1 }),
    ];
    expect(sortRosterRows(rows).map(r => r.provider_id)).toEqual(['c', 'b', 'a']);
  });

  it('puts a null FTE last rather than first', () => {
    const rows = [
      row({ provider_id: 'a', last_name: 'Alpha', fte_value: null }),
      row({ provider_id: 'b', last_name: 'Beta', fte_value: 0.5 }),
    ];
    expect(sortRosterRows(rows).map(r => r.provider_id)).toEqual(['b', 'a']);
  });
});

describe('allotmentText', () => {
  it('renders an em-dash when the allotment is unstated', () => {
    expect(allotmentText(null)).toBe('—');
  });
  it('renders a stated zero as 0, never as unstated', () => {
    expect(allotmentText(0)).toBe('0');
  });
  it('renders weeks as typed', () => {
    expect(allotmentText(7)).toBe('7');
  });
});

describe('remainingText', () => {
  it('says "not stated" rather than showing a number', () => {
    expect(remainingText({ usedWeekdays: 5, soldWeekdays: 0, allotmentDays: null, remainingDays: null }))
      .toBe('5 used · allotment not stated');
  });
  it('shows used and remaining when stated', () => {
    expect(remainingText({ usedWeekdays: 5, soldWeekdays: 0, allotmentDays: 20, remainingDays: 15 }))
      .toBe('5 of 20 used · 15 left');
  });
  it('notes sold-back days inline', () => {
    expect(remainingText({ usedWeekdays: 5, soldWeekdays: 2, allotmentDays: 20, remainingDays: 15 }))
      .toBe('5 of 20 used (incl. 2 sold back) · 15 left');
  });
  it('does not hide an overdrawn balance', () => {
    expect(remainingText({ usedWeekdays: 25, soldWeekdays: 0, allotmentDays: 20, remainingDays: -5 }))
      .toBe('25 of 20 used · 5 over');
  });
});

describe('offDaysText', () => {
  it('shows the budget alone when nothing is built', () => {
    expect(offDaysText(63, null)).toBe('63 budgeted');
  });
  it('shows used against budget when blocks exist', () => {
    expect(offDaysText(63, 20)).toBe('20 of 63 used');
  });
  it('shows a full-timer as having none', () => {
    expect(offDaysText(0, null)).toBe('none');
  });
});

describe('coveredSpanLabel', () => {
  it('names the span the off-day figure was counted over', () => {
    expect(coveredSpanLabel({ start: '2026-08-10', end: '2026-10-25', workingDays: 55 }))
      .toBe('Off days counted across published blocks only: Aug 10 – Oct 25, 2026 (55 working days).');
  });
  it('says plainly that nothing is published', () => {
    expect(coveredSpanLabel(null))
      .toBe('No published blocks this year — off days show the budget only, with nothing counted against it.');
  });
});

describe('parseFteInput', () => {
  it('accepts a blank working-days FTE as "same as call FTE"', () => {
    expect(parseFteInput('', { allowBlank: true, max: 1 })).toEqual({ ok: true, value: null });
  });
  it('rejects a blank call FTE', () => {
    expect(parseFteInput('', { allowBlank: false, max: 2 }).ok).toBe(false);
  });
  it('rejects a working-days FTE above 1', () => {
    expect(parseFteInput('1.5', { allowBlank: true, max: 1 }).ok).toBe(false);
  });
  it('accepts a call FTE up to 2', () => {
    expect(parseFteInput('1.5', { allowBlank: false, max: 2 })).toEqual({ ok: true, value: 1.5 });
  });
  it('rejects a negative value and non-numbers', () => {
    expect(parseFteInput('-1', { allowBlank: false, max: 2 }).ok).toBe(false);
    expect(parseFteInput('abc', { allowBlank: false, max: 2 }).ok).toBe(false);
  });
});

describe('parseAllotmentInput', () => {
  it('maps blank to null — not stated', () => {
    expect(parseAllotmentInput('')).toEqual({ ok: true, value: null });
  });
  it('keeps a typed zero as a real zero', () => {
    expect(parseAllotmentInput('0')).toEqual({ ok: true, value: 0 });
  });
  it('rejects fractions and negatives', () => {
    expect(parseAllotmentInput('2.5').ok).toBe(false);
    expect(parseAllotmentInput('-1').ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/blockPrepView.test.ts`
Expected: FAIL — `Failed to resolve import "./blockPrepView"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/blockPrepView.ts`:

```ts
// Block Prep board VIEW logic — the decisions the board makes that could be
// wrong, kept next to a test. The page component is markup over these.
// (vitest runs environment:'node' with no jsdom, so a component is not
// unit-testable; same split blockTargetsPanel.ts established.)
//
// The rules that matter here:
//
// 1. BLANK IS NOT ZERO, IN BOTH DIRECTIONS. A null PTO allotment renders an
//    em-dash and a "not stated" caption; a typed 0 renders "0". Parsing goes
//    the same way: blank -> null, "0" -> 0. Collapsing either into the other
//    is the bug this board exists to stop.
//
// 2. NEVER SHOW A NUMBER THAT WASN'T COUNTED. Off days used is null when no
//    published block covers the year, and the label says so rather than
//    printing a 0 that reads as "took no days off".
//
// 3. AN OVERDRAWN BALANCE IS SHOWN, NOT CLAMPED. Someone 5 days past their
//    allotment reads "5 over", because that is a thing a chief needs to see.

import type { CallCount, PtoFigures } from './annualTally';

export interface RosterRow {
  provider_id: string;
  display_name: string;
  last_name: string;
  fte_value: number | null;
  work_days_fte: number | null;
  pto_weeks: number | null;
  call_taker: boolean;
  partial_call_taker: boolean;
  pto: PtoFigures;
  offDayBudget: number;
  offDaysUsed: number | null;
  callCounts: CallCount[];
  callTotal: number;
}

/** FTE descending, then last name. A null FTE sorts last, not first. */
export function sortRosterRows(rows: ReadonlyArray<RosterRow>): RosterRow[] {
  return [...rows].sort((a, b) => {
    const fa = a.fte_value ?? -1;
    const fb = b.fte_value ?? -1;
    if (fa !== fb) return fb - fa;
    return a.last_name.localeCompare(b.last_name);
  });
}

/** The allotment cell. Em-dash for unstated; "0" for a real zero. */
export function allotmentText(ptoWeeks: number | null): string {
  return ptoWeeks == null ? '—' : String(ptoWeeks);
}

/** The PTO cell caption. */
export function remainingText(pto: PtoFigures): string {
  const sold = pto.soldWeekdays > 0 ? ` (incl. ${pto.soldWeekdays} sold back)` : '';
  if (pto.allotmentDays == null) {
    return `${pto.usedWeekdays} used${sold} · allotment not stated`;
  }
  const rem = pto.remainingDays ?? 0;
  const tail = rem < 0 ? `${Math.abs(rem)} over` : `${rem} left`;
  return `${pto.usedWeekdays} of ${pto.allotmentDays} used${sold} · ${tail}`;
}

/** The off-days cell. */
export function offDaysText(budget: number, used: number | null): string {
  if (budget === 0) return 'none';
  if (used == null) return `${budget} budgeted`;
  return `${used} of ${budget} used`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
}

/**
 * The honesty caveat under the off-days column. Off days can only be counted
 * where a schedule exists; this names the span so nobody reads the figure as a
 * full-year number.
 */
export function coveredSpanLabel(
  span: { start: string; end: string; workingDays: number } | null,
): string {
  if (!span) {
    return 'No published blocks this year — off days show the budget only, with nothing counted against it.';
  }
  const start = shortDate(span.start).replace(/, \d{4}$/, '');
  return `Off days counted across published blocks only: ${start} – ${shortDate(span.end)} (${span.workingDays} working days).`;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Parse an FTE cell. `max` is 2 for call FTE (FTE_MAX — the odd partner working
 * two jobs) and 1 for working-days FTE (nobody owes more days than the block
 * has). `allowBlank` is true only for working-days FTE, where blank means
 * "same as call FTE".
 */
export function parseFteInput(
  raw: string, opts: { allowBlank: boolean; max: number },
): ParseResult<number | null> {
  const s = raw.trim();
  if (s === '') {
    return opts.allowBlank
      ? { ok: true, value: null }
      : { ok: false, error: 'FTE is required' };
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'Must be a non-negative number' };
  if (n > opts.max) return { ok: false, error: `Must be ${opts.max} or less` };
  return { ok: true, value: n };
}

/** Parse the PTO allotment cell. Blank -> null (not stated); "0" -> 0 (real). */
export function parseAllotmentInput(raw: string): ParseResult<number | null> {
  const s = raw.trim();
  if (s === '') return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return { ok: false, error: 'Must be a whole number of weeks' };
  return { ok: true, value: n };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/blockPrepView.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/blockPrepView.ts src/lib/blockPrepView.test.ts
git commit -m "blockPrepView: roster ordering, blank-vs-zero rendering, edit parsing"
```

---

## Task 6: The API route

**Files:**
- Create: `src/app/api/scheduling/block-prep/route.helpers.ts`
- Create: `src/app/api/scheduling/block-prep/route.helpers.test.ts`
- Create: `src/app/api/scheduling/block-prep/route.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/scheduling/block-prep/route.helpers.test.ts`:

```ts
// The route's data layer, exercised with an injected fake supabase client —
// the house convention for DB-coupled modules (no network, no DB).
import { describe, it, expect } from 'vitest';
import { loadBlockPrepData } from './route.helpers';

const SITE = 'site-1';

/**
 * Minimal PostgREST-shaped fake. Each table returns a canned { data, error };
 * every builder method returns `this` so any chain of .select/.eq/.in/.gte/.lte
 * /.order resolves to the same envelope. `await`-ability comes from `then`.
 */
function fakeClient(tables: Record<string, { data?: unknown; error?: { message: string } }>) {
  const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const client = {
    calls,
    from(table: string) {
      const record = { table, filters: [] as Array<[string, unknown]> };
      calls.push(record);
      const res = tables[table] ?? { data: [] };
      const builder: Record<string, unknown> = {
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve({ data: res.data ?? null, error: res.error ?? null }).then(resolve);
        },
      };
      for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'or', 'not']) {
        builder[m] = (...args: unknown[]) => {
          record.filters.push([m, args]);
          return builder;
        };
      }
      return builder;
    },
  };
  return client;
}

const PROFILES = [
  {
    provider_id: 'p1', fte_value: 1, work_days_fte: null, pto_weeks: 4,
    call_taker: true, partial_call_taker: false, home_site_id: SITE,
    providers: { id: 'p1', last_name: 'Jones', short_display_name: 'A.Jones', status: 'active' },
  },
  {
    provider_id: 'p2', fte_value: 0.7, work_days_fte: 1, pto_weeks: null,
    call_taker: true, partial_call_taker: false, home_site_id: SITE,
    providers: { id: 'p2', last_name: 'Hussain', short_display_name: 'O.Hussain', status: 'active' },
  },
];

describe('loadBlockPrepData', () => {
  it('returns a roster row per call taker with tally figures attached', async () => {
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES },
      holiday_calendars: { data: [] },
      shift_types: { data: [{ code: 'C1', call_burden_weight: 1, parent_call_code: null }] },
      provider_availability: { data: [] },
      schedule_slots: { data: [] },
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    expect(out.roster.error).toBeNull();
    expect(out.roster.data!.map(r => r.provider_id).sort()).toEqual(['p1', 'p2']);
    const hussain = out.roster.data!.find(r => r.provider_id === 'p2')!;
    // work_days_fte 1.00 despite call FTE 0.70 -> zero off days.
    expect(hussain.offDayBudget).toBe(0);
    expect(hussain.pto.remainingDays).toBeNull();
  });

  it('surfaces a roster query error instead of an empty roster', async () => {
    const sb = fakeClient({
      provider_employment_profiles: { error: { message: 'boom' } },
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { data: [] },
      schedule_slots: { data: [] },
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    expect(out.roster.data).toBeNull();
    expect(out.roster.error).toContain('boom');
  });

  it('surfaces an availability error rather than showing full PTO balances', async () => {
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES },
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { error: { message: 'avail down' } },
      schedule_slots: { data: [] },
      schedules: { data: [] },
    });
    const out = await loadBlockPrepData(sb, SITE, 2026);
    expect(out.roster.data).toBeNull();
    expect(out.roster.error).toContain('avail down');
  });

  it('filters slots to published versions', async () => {
    const sb = fakeClient({
      provider_employment_profiles: { data: PROFILES },
      holiday_calendars: { data: [] },
      shift_types: { data: [] },
      provider_availability: { data: [] },
      schedule_slots: { data: [] },
      schedules: { data: [] },
    });
    await loadBlockPrepData(sb, SITE, 2026);
    const slotCall = sb.calls.find(c => c.table === 'schedule_slots')!;
    const published = slotCall.filters.some(
      ([m, args]) => m === 'eq' && JSON.stringify(args).includes('published'));
    expect(published).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/scheduling/block-prep/route.helpers.test.ts`
Expected: FAIL — `Failed to resolve import "./route.helpers"`.

- [ ] **Step 3: Write the implementation**

Create `src/app/api/scheduling/block-prep/route.helpers.ts`:

```ts
// Block Prep board data layer. All DB reads for /block-prep happen here, in one
// function that takes an injected client so it is testable without a database
// (the convention shared by dashboard/queries.ts and the assistant modules).
//
// FAIL-SOFT, NEVER FAKE ZEROS. Each panel carries { data, error }; a failed
// query surfaces its message on that panel and the page renders a Banner. A
// failed availability read must NOT quietly render everyone at full PTO
// remaining — the same no-silent-clean ethos as EvaluateResult.evaluated.
//
// PUBLISHED ONLY (clinical invariant 3). Slot reads go through
// filterPublishedVersions, the single home of that predicate — never re-inline
// the version_status comparison here.

import { filterPublishedVersions } from '@/lib/rulesEngine/committedAssignments';
import {
  computeAnnualTally, type TallyProfile, type TallyShiftType,
} from '@/lib/annualTally';
import type { RosterRow } from '@/lib/blockPrepView';
import type { PlannerAvailabilityRow, PlannerHoliday, PlannerSlotRow } from '@/lib/plannerMath';

// Same loose client type the other DB-coupled modules use at this seam —
// supabase-js's schema generic otherwise rejects the injected client and the
// test fake alike.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchedulingClient = any;

export interface Panel<T> {
  data: T | null;
  error: string | null;
}

export interface PublishedBlock {
  schedule_id: string;
  schedule_name: string;
  date_start: string;
  date_end: string;
}

export interface BlockPrepData {
  site_id: string;
  year: number;
  roster: Panel<RosterRow[]>;
  blocks: Panel<PublishedBlock[]>;
  coveredSpan: { start: string; end: string; workingDays: number } | null;
}

const PROFILE_COLUMNS =
  'provider_id, fte_value, work_days_fte, pto_weeks, call_taker, partial_call_taker, home_site_id, '
  + 'providers!inner(id, last_name, short_display_name, status)';

const SLOT_COLUMNS =
  'slot_date, derived_day_type, shift_types!inner(code, category, requires_post_call_rule), '
  + 'assignments(provider_id, assignment_status), schedule_versions!inner(version_status, schedule_id)';

function msg(e: unknown, what: string): string {
  const m = (e as { message?: string })?.message;
  return `${what} could not be loaded${m ? `: ${m}` : '.'}`;
}

export async function loadBlockPrepData(
  sb: SchedulingClient, siteId: string, year: number,
): Promise<BlockPrepData> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const [profilesRes, holidaysRes, shiftTypesRes, blocksRes] = await Promise.all([
    sb.from('provider_employment_profiles')
      .select(PROFILE_COLUMNS)
      .eq('home_site_id', siteId)
      .eq('providers.status', 'active')
      .or('call_taker.eq.true,partial_call_taker.eq.true'),
    sb.from('holiday_calendars')
      .select('holiday_date, is_major_holiday')
      .gte('holiday_date', from)
      .lte('holiday_date', to),
    sb.from('shift_types')
      .select('code, call_burden_weight, parent_call_code')
      .eq('site_id', siteId),
    // Published predicate goes through the single home, NOT an inline
    // version_status comparison — CLAUDE.md already tolerates two legacy
    // display-layer inlines and this must not become a third.
    filterPublishedVersions(
      sb.from('schedules')
        .select('id, schedule_name, date_start, date_end, schedule_versions!inner(version_status)')
        .eq('site_id', siteId)
        .lte('date_start', to)
        .gte('date_end', from),
      'schedule_versions',
    ),
  ]);

  const blocks: Panel<PublishedBlock[]> = blocksRes.error
    ? { data: null, error: msg(blocksRes.error, 'Published blocks') }
    : {
      data: (blocksRes.data ?? []).map((s: Record<string, unknown>) => ({
        schedule_id: s.id as string,
        schedule_name: s.schedule_name as string,
        date_start: s.date_start as string,
        date_end: s.date_end as string,
      })),
      error: null,
    };

  if (profilesRes.error) {
    return { site_id: siteId, year, roster: { data: null, error: msg(profilesRes.error, 'Roster') }, blocks, coveredSpan: null };
  }
  if (holidaysRes.error) {
    return { site_id: siteId, year, roster: { data: null, error: msg(holidaysRes.error, 'Holiday calendar') }, blocks, coveredSpan: null };
  }
  if (shiftTypesRes.error) {
    return { site_id: siteId, year, roster: { data: null, error: msg(shiftTypesRes.error, 'Shift types') }, blocks, coveredSpan: null };
  }

  const rows = (profilesRes.data ?? []) as Array<Record<string, unknown>>;
  const providerIds = rows.map(r => r.provider_id as string);

  // Both of these depend on the roster ids, so they run after it.
  const [availRes, slotsRes] = await Promise.all([
    providerIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : sb.from('provider_availability')
        .select('provider_id, availability_type, start_date, end_date, approval_status, reason_code')
        .in('provider_id', providerIds)
        .lte('start_date', to)
        .gte('end_date', from),
    filterPublishedVersions(
      sb.from('schedule_slots')
        .select(SLOT_COLUMNS)
        .eq('site_id', siteId)
        .gte('slot_date', from)
        .lte('slot_date', to),
      'schedule_versions',
    ),
  ]);

  if (availRes.error) {
    return { site_id: siteId, year, roster: { data: null, error: msg(availRes.error, 'Availability') }, blocks, coveredSpan: null };
  }
  if (slotsRes.error) {
    return { site_id: siteId, year, roster: { data: null, error: msg(slotsRes.error, 'Published assignments') }, blocks, coveredSpan: null };
  }

  const profiles: TallyProfile[] = rows.map(r => ({
    provider_id: r.provider_id as string,
    fte_value: r.fte_value == null ? null : Number(r.fte_value),
    work_days_fte: r.work_days_fte == null ? null : Number(r.work_days_fte),
    pto_weeks: r.pto_weeks == null ? null : Number(r.pto_weeks),
  }));

  const shiftTypes = new Map<string, TallyShiftType>(
    ((shiftTypesRes.data ?? []) as Array<Record<string, unknown>>).map(st => [
      st.code as string,
      {
        call_burden_weight: st.call_burden_weight == null ? null : Number(st.call_burden_weight),
        parent_call_code: (st.parent_call_code as string | null) ?? null,
      },
    ]),
  );

  const tally = computeAnnualTally({
    year,
    profiles,
    availability: (availRes.data ?? []) as PlannerAvailabilityRow[],
    slots: (slotsRes.data ?? []) as PlannerSlotRow[],
    holidays: (holidaysRes.data ?? []) as PlannerHoliday[],
    shiftTypes,
    coveredSpans: (blocks.data ?? []).map(b => ({ date_start: b.date_start, date_end: b.date_end })),
  });

  const roster: RosterRow[] = rows.map(r => {
    const pid = r.provider_id as string;
    const p = (r.providers ?? {}) as Record<string, unknown>;
    const figures = tally.providers.get(pid)!;
    return {
      provider_id: pid,
      display_name: (p.short_display_name as string) || (p.last_name as string) || pid,
      last_name: (p.last_name as string) || '',
      fte_value: r.fte_value == null ? null : Number(r.fte_value),
      work_days_fte: r.work_days_fte == null ? null : Number(r.work_days_fte),
      pto_weeks: r.pto_weeks == null ? null : Number(r.pto_weeks),
      call_taker: !!r.call_taker,
      partial_call_taker: !!r.partial_call_taker,
      pto: figures.pto,
      offDayBudget: figures.offDayBudget,
      offDaysUsed: figures.offDaysUsed,
      callCounts: figures.callCounts,
      callTotal: figures.callTotal,
    };
  });

  return {
    site_id: siteId,
    year,
    roster: { data: roster, error: null },
    blocks,
    coveredSpan: tally.coveredSpan,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/scheduling/block-prep/route.helpers.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the route handler**

Create `src/app/api/scheduling/block-prep/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { loadBlockPrepData } from './route.helpers';

// Roster, availability and published assignments all change out of band of this
// page; the Next default caching would serve a stale board for up to an hour.
// Same reasoning as the availability route.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// GET /api/scheduling/block-prep?site_id=...&year=2026
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get('site_id');
  if (!siteId) {
    return NextResponse.json({ error: 'site_id is required' }, { status: 400 });
  }

  const rawYear = searchParams.get('year');
  const year = rawYear == null ? new Date().getUTCFullYear() : Number(rawYear);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: 'year must be a 4-digit year between 2000 and 2100' }, { status: 400 });
  }

  try {
    const data = await loadBlockPrepData(sbSchedulingServer(), siteId, year);
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Block prep data could not be loaded.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/app/api/scheduling/block-prep/
git commit -m "block-prep API: roster + annual tally, fail-soft per panel"
```

---

## Task 7: The annual tally card

**Files:**
- Create: `src/components/AnnualTallyCard.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/AnnualTallyCard.tsx`:

```tsx
'use client';

// Annual tally — the calendar-year running totals, mounted BOTH on /block-prep
// and on /dashboard (Gabriel 2026-09-06: "a window on the scheduling homepage
// that keeps tally of all the call counts, remaining PTO days and remaining off
// days"). Self-contained: it fetches its own data so either host can drop it in
// with a site id and nothing else.
//
// This card shows COUNTS, not over/under. Obligations are per-block, from the
// stated FTE bands, and live in the schedule's own Call Counts modal — linked
// from the block list below the table. Adding an annual over/under here would
// be a second obligation model running beside the bands.
//
// Zero math lives here. Everything comes from lib/annualTally.ts via the
// block-prep route, and every string from lib/blockPrepView.ts.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Banner, Card, EmptyState, Table } from '@/components/ui';
import { formatCallWeight } from '@/lib/callBurden';
import { FAIRNESS_BUCKETS } from '@/lib/rulesEngine/shared';
import { coveredSpanLabel, offDaysText, remainingText, sortRosterRows } from '@/lib/blockPrepView';
import type { BlockPrepData } from '@/app/api/scheduling/block-prep/route.helpers';

const BUCKET_LABELS: Record<string, string> = {
  weekday: 'M–Th',
  friday: 'Fri',
  saturday: 'Sat',
  sunday: 'Sun',
};

export default function AnnualTallyCard({
  siteId,
  year,
  siteName,
  /** Bumped by the host after an edit so the card refetches. */
  refreshKey = 0,
}: {
  siteId: string | null;
  year: number;
  siteName?: string;
  refreshKey?: number;
}) {
  const [data, setData] = useState<BlockPrepData | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!siteId) { setData(null); return; }
    setLoading(true);
    setFatal(null);
    try {
      const res = await fetch(`/api/scheduling/block-prep?site_id=${siteId}&year=${year}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setFatal(body.error || `Request failed (${res.status})`);
        setData(null);
        return;
      }
      setData(await res.json());
    } catch (e) {
      setFatal(e instanceof Error ? e.message : 'Network error');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [siteId, year]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const title = `${year} running tally${siteName ? ` — ${siteName}` : ''}`;

  if (!siteId) {
    return (
      <Card title="Annual tally">
        <EmptyState
          icon="∑"
          title="Pick a site"
          hint="Call counts, PTO and off days are tracked per site — choose one to see the year's running totals."
        />
      </Card>
    );
  }

  if (fatal) {
    return <Card title={title} pad><Banner tone="error">{fatal}</Banner></Card>;
  }

  const roster = data?.roster;
  const rows = roster?.data ? sortRosterRows(roster.data) : undefined;

  // Only render bucket columns the year actually has calls in — a site with no
  // Friday call should not carry an empty Friday column all year.
  const activeBuckets = FAIRNESS_BUCKETS.filter(b =>
    (rows ?? []).some(r => r.callCounts.some(c => c.bucket === b && c.count > 0)));

  const headers = [
    'Provider',
    ...activeBuckets.map(b => BUCKET_LABELS[b] ?? b),
    'Calls',
    'PTO',
    'Off days',
  ];

  return (
    <Card title={title} pad={!!roster?.error}>
      {roster?.error ? (
        <Banner tone="error">{roster.error}</Banner>
      ) : (
        <>
          <Table
            headers={headers}
            minWidth={760}
            rows={loading && !rows ? undefined : (rows ?? []).map(r => [
              <Link
                key="name"
                href={`/providers/${r.provider_id}`}
                style={{ fontWeight: 700, color: 'var(--text-strong)', textDecoration: 'none' }}
              >
                {r.display_name}
              </Link>,
              ...activeBuckets.map(b => {
                const total = r.callCounts
                  .filter(c => c.bucket === b)
                  .reduce((n, c) => n + c.count, 0);
                return total === 0
                  ? <span key={b} style={{ color: 'var(--text-dim)' }}>—</span>
                  : <span key={b}>{formatCallWeight(total)}</span>;
              }),
              <span key="total" style={{ fontWeight: 700 }}>{formatCallWeight(r.callTotal)}</span>,
              <span key="pto" style={{ fontSize: 'var(--fs-sm)' }}>{remainingText(r.pto)}</span>,
              <span key="off" style={{ fontSize: 'var(--fs-sm)' }}>{offDaysText(r.offDayBudget, r.offDaysUsed)}</span>,
            ])}
            empty={
              <EmptyState
                icon="∑"
                title="No call takers at this site"
                hint="Mark a provider as a call taker with this site as their home site and they'll appear here."
              />
            }
          />

          <div style={{
            marginTop: 'var(--space-3)', fontSize: 'var(--fs-xs)',
            color: 'var(--text-muted)', lineHeight: 1.5,
          }}>
            {coveredSpanLabel(data?.coveredSpan ?? null)}
          </div>

          {data?.blocks.error ? (
            <div style={{ marginTop: 'var(--space-3)' }}>
              <Banner tone="error">{data.blocks.error}</Banner>
            </div>
          ) : (data?.blocks.data ?? []).length > 0 && (
            <div style={{ marginTop: 'var(--space-3)' }}>
              <div style={{
                fontSize: 'var(--fs-xs)', color: 'var(--text-muted)',
                marginBottom: 'var(--space-2)',
              }}>
                Per-block obligations live in each schedule&rsquo;s Call Counts:
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                {(data?.blocks.data ?? []).map(b => (
                  <Link
                    key={b.schedule_id}
                    href={`/schedules/${b.schedule_id}`}
                    style={{
                      fontSize: 'var(--fs-sm)', textDecoration: 'none',
                      color: 'var(--blue)', border: '1px solid var(--border-faint)',
                      borderRadius: 'var(--radius-sm)', padding: '4px 10px',
                    }}
                  >
                    {b.schedule_name}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/AnnualTallyCard.tsx
git commit -m "AnnualTallyCard: shared annual counts card"
```

---

## Task 8: The roster card with inline editing

**Files:**
- Create: `src/app/(scheduling)/block-prep/RosterCard.tsx`

- [ ] **Step 1: Write the component**

Create `src/app/(scheduling)/block-prep/RosterCard.tsx`:

```tsx
'use client';

// The call-taker roster with inline FTE / working-days FTE / PTO allotment
// editing. Edits go through the EXISTING provider PATCH route — all three
// columns are on PROFILE_COLUMNS and are already range-checked there, so there
// is no new write path and no second validator to drift.
//
// OPTIMISTIC WITH REVERT. A cell applies immediately and rolls back with an
// error if the PATCH fails, so a rejected value can never sit on screen looking
// saved.
//
// Every string and every parse rule comes from lib/blockPrepView.ts.

import { useState } from 'react';
import Link from 'next/link';
import { Badge, Banner, Button, Card, EmptyState, Table } from '@/components/ui';
import { formatCallWeight } from '@/lib/callBurden';
import {
  allotmentText, offDaysText, parseAllotmentInput, parseFteInput,
  remainingText, sortRosterRows, type RosterRow,
} from '@/lib/blockPrepView';

type Field = 'fte_value' | 'work_days_fte' | 'pto_weeks';

const CELL_INPUT: React.CSSProperties = {
  width: 68, padding: '4px 6px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 'var(--fs-sm)', fontFamily: 'inherit',
};

function EditableCell({
  value, field, providerId, onSaved, onError,
}: {
  value: number | null;
  field: Field;
  providerId: string;
  onSaved: (field: Field, value: number | null) => void;
  onError: (message: string) => void;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  const [saving, setSaving] = useState(false);

  const parse = (raw: string) =>
    field === 'pto_weeks'
      ? parseAllotmentInput(raw)
      : parseFteInput(raw, {
        // Blank working-days FTE means "same as call FTE"; a blank call FTE is
        // not a thing. Working-days FTE caps at 1 — nobody owes more days than
        // the block has.
        allowBlank: field === 'work_days_fte',
        max: field === 'work_days_fte' ? 1 : 2,
      });

  const commit = async () => {
    const original = value == null ? '' : String(value);
    if (text.trim() === original) return;
    const parsed = parse(text);
    if (!parsed.ok) {
      onError(parsed.error);
      setText(original);
      return;
    }
    setSaving(true);
    // Optimistic: show it now, roll back below if the PATCH is refused.
    onSaved(field, parsed.value);
    try {
      const res = await fetch(`/api/scheduling/providers/${providerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: parsed.value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        onError(body.error || `Save failed (${res.status})`);
        onSaved(field, value);
        setText(original);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Network error');
      onSaved(field, value);
      setText(original);
    } finally {
      setSaving(false);
    }
  };

  return (
    <input
      style={{ ...CELL_INPUT, opacity: saving ? 0.6 : 1 }}
      value={text}
      disabled={saving}
      placeholder={field === 'work_days_fte' ? 'same' : field === 'pto_weeks' ? '—' : ''}
      title={
        field === 'work_days_fte'
          ? 'Working-days FTE — the share of working days owed. Blank means the same as call FTE.'
          : field === 'pto_weeks'
            ? 'Annual PTO allotment in weeks. Blank means not stated; 0 means genuinely none.'
            : 'Call FTE — pro-rates the call obligation.'
      }
      onChange={e => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setText(value == null ? '' : String(value));
      }}
    />
  );
}

const HEADERS = [
  'Provider', 'Call FTE', 'Work-days FTE', 'PTO weeks',
  'PTO this year', 'Off days', 'Calls', '',
];

export default function RosterCard({
  rows, error, loading, onPatched, onOpenDrawer,
}: {
  rows: RosterRow[] | null;
  error: string | null;
  loading: boolean;
  /** Applies an edit to the parent's copy so the tally can refetch. */
  onPatched: (providerId: string, field: Field, value: number | null) => void;
  onOpenDrawer: (row: RosterRow) => void;
}) {
  const [cellError, setCellError] = useState<string | null>(null);

  if (error) {
    return <Card title="Call takers" pad><Banner tone="error">{error}</Banner></Card>;
  }

  const sorted = rows ? sortRosterRows(rows) : undefined;

  return (
    <Card title="Call takers" pad={false}>
      {cellError && (
        <div style={{ padding: 'var(--space-3)' }}>
          <Banner tone="error">{cellError}</Banner>
        </div>
      )}
      <Table
        headers={HEADERS}
        minWidth={980}
        rows={loading && !sorted ? undefined : (sorted ?? []).map(r => [
          <div key="name" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <Link
              href={`/providers/${r.provider_id}`}
              style={{ fontWeight: 700, color: 'var(--text-strong)', textDecoration: 'none' }}
            >
              {r.display_name}
            </Link>
            {r.partial_call_taker && <Badge tone="warn">partial</Badge>}
          </div>,
          <EditableCell
            key="fte" value={r.fte_value} field="fte_value" providerId={r.provider_id}
            onSaved={(f, v) => onPatched(r.provider_id, f, v)} onError={setCellError}
          />,
          <EditableCell
            key="wdf" value={r.work_days_fte} field="work_days_fte" providerId={r.provider_id}
            onSaved={(f, v) => onPatched(r.provider_id, f, v)} onError={setCellError}
          />,
          <EditableCell
            key="pto" value={r.pto_weeks} field="pto_weeks" providerId={r.provider_id}
            onSaved={(f, v) => onPatched(r.provider_id, f, v)} onError={setCellError}
          />,
          <span key="ptofig" style={{ fontSize: 'var(--fs-sm)' }}>{remainingText(r.pto)}</span>,
          <span key="off" style={{ fontSize: 'var(--fs-sm)' }}>{offDaysText(r.offDayBudget, r.offDaysUsed)}</span>,
          <span key="calls" style={{ fontWeight: 700 }}>{formatCallWeight(r.callTotal)}</span>,
          <div key="actions" style={{ textAlign: 'right' }}>
            <Button variant="ghost" size="sm" onClick={() => onOpenDrawer(r)}>
              PTO &amp; dates
            </Button>
          </div>,
        ])}
        empty={
          <EmptyState
            icon="◆"
            title="No call takers at this site"
            hint="A provider appears here when they are active, marked as a call taker, and this site is their home site."
          />
        }
      />
      <div style={{
        padding: 'var(--space-3)', fontSize: 'var(--fs-xs)',
        color: 'var(--text-muted)', lineHeight: 1.5, borderTop: '1px solid var(--border-faint)',
      }}>
        Blank work-days FTE means the same as call FTE. A blank PTO weeks cell means no allotment
        has been stated and shows {allotmentText(null)} in the tally; a typed 0 means genuinely none.
      </div>
    </Card>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(scheduling)/block-prep/RosterCard.tsx"
git commit -m "block-prep: roster card with inline FTE and allotment editing"
```

---

## Task 9: The availability drawer

**Files:**
- Create: `src/app/(scheduling)/block-prep/AvailabilityDrawer.tsx`

- [ ] **Step 1: Write the component**

Create `src/app/(scheduling)/block-prep/AvailabilityDrawer.tsx`:

```tsx
'use client';

// Per-provider PTO / off / no-call dates, reachable from the roster without
// visiting eleven separate profiles. Writes go to the SAME availability API the
// profile's Availability tab uses, so a row added here is indistinguishable
// from one added there.
//
// Scoped to the board's year: rows overlapping Jan 1 - Dec 31 of the selected
// year, which is what the tally counts.

import { useCallback, useEffect, useState } from 'react';
import { Badge, Banner, Button, EmptyState, Modal } from '@/components/ui';
import { AVAILABILITY_TYPE_LABELS, type AvailabilityType } from '@/lib/validation/providers';

interface Row {
  id: string;
  availability_type: string;
  start_date: string;
  end_date: string;
  approval_status: string;
  notes: string | null;
}

// The types worth adding from this board. The full vocabulary (FMLA, military
// leave, ICU rotation pairs) stays on the profile's Availability tab, which has
// the dedicated flows for it.
const ADDABLE: AvailabilityType[] = ['pto', 'pto_sellback', 'unavailable', 'no_call_request'];

const TYPE_TONES: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  pto: 'ok',
  pto_sellback: 'danger',
  unavailable: 'neutral',
  no_call_request: 'warn',
};

const INPUT: React.CSSProperties = {
  padding: '8px 10px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 'var(--fs-sm)', fontFamily: 'inherit',
};

export default function AvailabilityDrawer({
  providerId, providerName, year, onClose, onChanged,
}: {
  providerId: string;
  providerName: string;
  year: number;
  onClose: () => void;
  /** Called after any successful write so the board refetches its tally. */
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<AvailabilityType>('pto');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(
        `/api/scheduling/availability?provider_id=${providerId}&from=${year}-01-01&to=${year}-12-31`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `Could not load dates (${res.status})`);
        setRows(null);
        return;
      }
      setRows(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
      setRows(null);
    }
  }, [providerId, year]);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!start || !end) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/scheduling/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_id: providerId,
          availability_type: type,
          start_date: start,
          end_date: end,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `Could not save (${res.status})`);
        return;
      }
      setStart(''); setEnd('');
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Remove this entry?')) return;
    setError(null);
    const res = await fetch(`/api/scheduling/availability/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error || `Could not delete (${res.status})`);
      return;
    }
    await load();
    onChanged();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${providerName} — ${year} dates`}
      width={560}
      footer={<Button variant="secondary" onClick={onClose}>Done</Button>}
    >
      {error && <div style={{ marginBottom: 'var(--space-3)' }}><Banner tone="error">{error}</Banner></div>}

      <div style={{
        display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-end',
        flexWrap: 'wrap', marginBottom: 'var(--space-4)',
      }}>
        <select value={type} onChange={e => setType(e.target.value as AvailabilityType)} style={{ ...INPUT, cursor: 'pointer' }}>
          {ADDABLE.map(t => <option key={t} value={t}>{AVAILABILITY_TYPE_LABELS[t]}</option>)}
        </select>
        <input type="date" value={start} onChange={e => setStart(e.target.value)} style={INPUT} />
        <input type="date" value={end} onChange={e => setEnd(e.target.value)} style={INPUT} />
        <Button onClick={add} disabled={saving || !start || !end}>
          {saving ? 'Adding…' : 'Add'}
        </Button>
      </div>

      {rows == null ? (
        <div style={{ color: 'var(--text-dim)' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon="◷"
          title={`No dates in ${year}`}
          hint="PTO, sell-back, days off and no-call requests added here are the same entries the provider's Availability tab shows."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {rows.map(r => (
            <div
              key={r.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                padding: 'var(--space-2) var(--space-3)',
                border: '1px solid var(--border-faint)', borderRadius: 'var(--radius-sm)',
              }}
            >
              <Badge tone={TYPE_TONES[r.availability_type] ?? 'neutral'}>
                {AVAILABILITY_TYPE_LABELS[r.availability_type as AvailabilityType] ?? r.availability_type}
              </Badge>
              <span style={{ fontSize: 'var(--fs-sm)', marginRight: 'auto' }}>
                {r.start_date} → {r.end_date}
              </span>
              {r.approval_status !== 'approved' && <Badge tone="warn">{r.approval_status}</Badge>}
              <Button variant="ghost" size="sm" style={{ color: 'var(--danger)' }} onClick={() => remove(r.id)}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
```

- [ ] **Step 2: Verify the label map covers the addable types**

Run: `npx tsc --noEmit`
Expected: no errors. `AVAILABILITY_TYPE_LABELS` is a `Record<AvailabilityType, string>` in `src/lib/validation/providers.ts`, so every member of `ADDABLE` is covered by construction.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(scheduling)/block-prep/AvailabilityDrawer.tsx"
git commit -m "block-prep: per-provider availability drawer"
```

---

## Task 10: The page, the nav entry, and the dashboard mount

**Files:**
- Create: `src/app/(scheduling)/block-prep/page.tsx`
- Modify: `src/components/AppShell.tsx:16-25`
- Modify: `src/app/(scheduling)/dashboard/page.tsx`

- [ ] **Step 1: Write the page**

Create `src/app/(scheduling)/block-prep/page.tsx`:

```tsx
'use client';

// Block Prep — the site-scoped board you sit at before building a block
// (Gabriel 2026-09-06). Roster with inline FTE / PTO-allotment editing, a dates
// drawer per provider, the annual tally, and Create Schedule with the site
// already chosen.
//
// Fetch, state and markup only: the math is lib/annualTally.ts behind the
// block-prep route, and the view decisions are lib/blockPrepView.ts.

import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, PageHeader } from '@/components/ui';
import AnnualTallyCard from '@/components/AnnualTallyCard';
import type { BlockPrepData } from '@/app/api/scheduling/block-prep/route.helpers';
import type { RosterRow } from '@/lib/blockPrepView';
import RosterCard from './RosterCard';
import AvailabilityDrawer from './AvailabilityDrawer';

interface Site { id: string; name: string; short_name: string | null }

const CONTROL: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 'var(--fs-sm)', cursor: 'pointer',
};

export default function BlockPrepPage() {
  const [orgId, setOrgId] = useState('');
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState('');
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState<BlockPrepData | null>(null);
  const [loading, setLoading] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [drawerRow, setDrawerRow] = useState<RosterRow | null>(null);
  // Bumped after any write so the tally card refetches alongside the roster.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    (async () => {
      const res = await fetch('/api/scheduling/organizations');
      const orgs = await res.json();
      if (Array.isArray(orgs) && orgs.length > 0) setOrgId(orgs[0].id);
    })();
  }, []);

  useEffect(() => {
    if (!orgId) return;
    (async () => {
      const res = await fetch(`/api/scheduling/sites?org_id=${orgId}`);
      const list = await res.json();
      if (Array.isArray(list)) {
        setSites(list);
        if (list.length > 0) setSiteId(prev => prev || list[0].id);
      }
    })();
  }, [orgId]);

  const load = useCallback(async () => {
    if (!siteId) { setData(null); return; }
    setLoading(true);
    setFatal(null);
    try {
      const res = await fetch(`/api/scheduling/block-prep?site_id=${siteId}&year=${year}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setFatal(body.error || `Request failed (${res.status})`);
        setData(null);
        return;
      }
      setData(await res.json());
    } catch (e) {
      setFatal(e instanceof Error ? e.message : 'Network error');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [siteId, year]);

  useEffect(() => { load(); }, [load]);

  // Apply an inline edit to the local copy. The board does NOT refetch on every
  // keystroke-commit: the roster figures that depend on FTE (off-day budget,
  // PTO remaining) are recomputed server-side, so a refresh is triggered
  // instead, debounced by the fact that commits happen on blur.
  const onPatched = (providerId: string, field: 'fte_value' | 'work_days_fte' | 'pto_weeks', value: number | null) => {
    setData(prev => {
      if (!prev?.roster.data) return prev;
      return {
        ...prev,
        roster: {
          ...prev.roster,
          data: prev.roster.data.map(r =>
            r.provider_id === providerId ? { ...r, [field]: value } : r),
        },
      };
    });
    setRefreshKey(k => k + 1);
  };

  useEffect(() => {
    if (refreshKey > 0) load();
    // `load` is stable per (siteId, year); refreshKey is the explicit trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const site = sites.find(s => s.id === siteId);
  const siteName = site?.short_name || site?.name;
  const thisYear = new Date().getFullYear();
  const years = [thisYear - 1, thisYear, thisYear + 1];

  return (
    <div>
      <PageHeader
        title="Block Prep"
        subtitle="Set the roster up, then build the block."
        actions={
          <Button
            onClick={() => { window.location.href = `/schedules?create=1&site_id=${siteId}`; }}
            disabled={!siteId}
            title={siteId ? 'Create a schedule for this site' : 'Pick a site first'}
          >
            Create Schedule
          </Button>
        }
      />

      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-5)', flexWrap: 'wrap' }}>
        <select value={siteId} onChange={e => setSiteId(e.target.value)} style={CONTROL}>
          {sites.length === 0 && <option value="">No sites</option>}
          {sites.map(s => <option key={s.id} value={s.id}>{s.short_name || s.name}</option>)}
        </select>
        <select value={year} onChange={e => setYear(Number(e.target.value))} style={CONTROL}>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {fatal && <div style={{ marginBottom: 'var(--space-4)' }}><Banner tone="error">{fatal}</Banner></div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <RosterCard
          rows={data?.roster.data ?? null}
          error={data?.roster.error ?? null}
          loading={loading}
          onPatched={onPatched}
          onOpenDrawer={setDrawerRow}
        />
        <AnnualTallyCard
          siteId={siteId || null}
          year={year}
          siteName={siteName}
          refreshKey={refreshKey}
        />
      </div>

      {drawerRow && (
        <AvailabilityDrawer
          providerId={drawerRow.provider_id}
          providerName={drawerRow.display_name}
          year={year}
          onClose={() => setDrawerRow(null)}
          onChanged={() => setRefreshKey(k => k + 1)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Make `/schedules` honour the create query params**

The Create Schedule button navigates with `?create=1&site_id=...`. Open `src/app/(scheduling)/schedules/page.tsx` and, immediately after the `const [showCreate, setShowCreate] = useState(false);` declaration (line 64), add:

```tsx
  // Deep link from /block-prep: open the create modal with the site pre-chosen.
  const [presetSiteId, setPresetSiteId] = useState('');
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('create') === '1') {
      setPresetSiteId(params.get('site_id') || '');
      setShowCreate(true);
    }
  }, []);
```

Then change the modal mount at line 250 from:

```tsx
      {showCreate && <CreateScheduleModal orgId={orgId} sites={sites} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); loadSchedules(); }} />}
```

to:

```tsx
      {showCreate && <CreateScheduleModal orgId={orgId} sites={sites} initialSiteId={presetSiteId} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); loadSchedules(); }} />}
```

And in `CreateScheduleModal` (line 333), change the signature and the `siteId` initial state from:

```tsx
function CreateScheduleModal({ orgId, sites, onClose, onCreated }: { orgId: string; sites: Site[]; onClose: () => void; onCreated: () => void }) {
  const [siteId, setSiteId] = useState('');
```

to:

```tsx
function CreateScheduleModal({ orgId, sites, initialSiteId = '', onClose, onCreated }: { orgId: string; sites: Site[]; initialSiteId?: string; onClose: () => void; onCreated: () => void }) {
  const [siteId, setSiteId] = useState(initialSiteId);
```

- [ ] **Step 3: Add the nav entry**

In `src/components/AppShell.tsx`, change the Scheduling section (lines 16-25) from:

```tsx
  {
    label: 'Scheduling',
    items: [
      { href: '/schedules', label: 'Schedules', icon: '▦' },
```

to:

```tsx
  {
    label: 'Scheduling',
    items: [
      { href: '/block-prep', label: 'Block Prep', icon: '◫' },
      { href: '/schedules', label: 'Schedules', icon: '▦' },
```

- [ ] **Step 4: Mount the tally card on the dashboard**

In `src/app/(scheduling)/dashboard/page.tsx`, add the import beside the existing `PhysicianPlannerCard` import (line 11):

```tsx
import DashboardTallyCard from './DashboardTallyCard';
```

Then, immediately before the `PhysicianPlannerCard` block near line 303, insert:

```tsx
      {/* Annual running tally — the same card /block-prep mounts, pointed at
          the first site so the homepage carries the numbers without a picker
          of its own. */}
      <div style={{ marginTop: 'var(--space-4)' }}>
        <DashboardTallyCard />
      </div>
```

Create `src/app/(scheduling)/dashboard/DashboardTallyCard.tsx`:

```tsx
'use client';

// The dashboard's window onto the annual tally. /dashboard is org-wide and has
// no site picker of its own, so this thin client wrapper carries one and hands
// the choice to the shared AnnualTallyCard. The card itself is identical to the
// one on /block-prep — same component, same route, same numbers.

import { useEffect, useState } from 'react';
import AnnualTallyCard from '@/components/AnnualTallyCard';

interface Site { id: string; name: string; short_name: string | null }

export default function DashboardTallyCard() {
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState('');
  const year = new Date().getFullYear();

  useEffect(() => {
    (async () => {
      const orgRes = await fetch('/api/scheduling/organizations');
      const orgs = await orgRes.json();
      if (!Array.isArray(orgs) || orgs.length === 0) return;
      const res = await fetch(`/api/scheduling/sites?org_id=${orgs[0].id}`);
      const list = await res.json();
      if (Array.isArray(list)) {
        setSites(list);
        if (list.length > 0) setSiteId(list[0].id);
      }
    })();
  }, []);

  const site = sites.find(s => s.id === siteId);

  return (
    <div>
      {sites.length > 1 && (
        <div style={{ marginBottom: 'var(--space-2)' }}>
          <select
            value={siteId}
            onChange={e => setSiteId(e.target.value)}
            style={{
              padding: '6px 10px', borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)', background: 'var(--bg-deep)',
              color: 'var(--text)', fontSize: 'var(--fs-sm)', cursor: 'pointer',
            }}
          >
            {sites.map(s => <option key={s.id} value={s.id}>{s.short_name || s.name}</option>)}
          </select>
        </div>
      )}
      <AnnualTallyCard
        siteId={siteId || null}
        year={year}
        siteName={site?.short_name || site?.name}
      />
    </div>
  );
}
```

- [ ] **Step 5: Typecheck and run the suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: all pass except the 10 pre-existing `src/lib/gridCalculator/` "No test suite found" errors.

- [ ] **Step 6: Run the app and confirm the board loads**

Run: `npm run dev`, then open `http://localhost:3000/block-prep`.

Expected: Paoli selected, 11 call takers listed, Hussain showing "none" in Off days (working-days FTE 1.00), the five stated PTO allotments showing "N of M used", the rest showing "allotment not stated", and the covered-span caption naming the 8/10–10/25 block.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(scheduling)/block-prep/page.tsx" \
        "src/app/(scheduling)/dashboard/DashboardTallyCard.tsx" \
        "src/app/(scheduling)/dashboard/page.tsx" \
        "src/app/(scheduling)/schedules/page.tsx" \
        src/components/AppShell.tsx
git commit -m "block-prep: page, nav entry, dashboard tally mount"
```

---

## Task 11: Deploy, then apply the patch

The patch must not run before the profile-editor fix is live, or the next profile save manufactures fresh meaningless zeros.

- [ ] **Step 1: Merge and push**

```bash
git checkout main
git merge block-prep-board
git push origin main
```

- [ ] **Step 2: Confirm the Vercel build is live**

Open `https://floor-runner.vercel.app/block-prep` and confirm the board renders. Vercel auto-deploys on push to `origin/main`.

- [ ] **Step 3: Apply patch45**

Use the **project-scoped `supabase-floorrunner` MCP server** and verify the ref is `qhwdbtixhzdsgwwtcfrm` before running anything. The global `supabase` and `supabase-chiefos` servers belong to other apps.

Run the SELECT in the patch first and confirm it reports 78 / 5 / 0. If the split differs materially, stop and re-read — someone has been editing allotments and the "these zeros carry no information" premise no longer holds.

Then run the `UPDATE` and the `ALTER TABLE ... DROP DEFAULT`.

- [ ] **Step 4: Update the patch header**

Change `-- STATUS: NOT YET APPLIED.` to `-- STATUS: APPLIED <date>, <rows> rows cleared.` and commit:

```bash
git add supabase_scheduling_patch45_pto_weeks_unset.sql
git commit -m "patch45: record application"
git push origin main
```

- [ ] **Step 5: Restate the real zeros — and not before now**

On `/block-prep`, type `0` into the PTO weeks cell for anyone who genuinely gets no allotment (Gorelick is the likely candidate — per diem). Everyone else stays blank until Gabriel states their number.

**This must happen AFTER Step 3, never between Step 1 and Step 3.** CODE-FIRST puts the fixed editor live while the DB still holds 78 zeros, so a real `0` typed in that window is indistinguishable from a default and `WHERE pto_weeks = 0` wipes it. The patch's WHY section says so; this is the operational half of the same warning.

- [ ] **Step 6: If you ever roll the code back, roll the DB back too**

The highest-consequence failure mode of this change, and it is silent. Pre-change code renders `String(profile.pto_weeks ?? 0)`, so after the patch a Vercel rollback would display all 78 nulls as `0`, and the next save on any of those profiles writes `0` back — re-collapsing "not stated" into "gets none" one provider at a time, with nothing reporting it.

A code rollback therefore requires the patch's ROLLBACK section to run as well. Never roll back one without the other.

---

## Verification checklist

Before calling this done, confirm each against the running app, not from memory:

- [ ] `npm test` passes except the 10 known gridCalculator file errors.
- [ ] `npx tsc --noEmit` is clean.
- [ ] A blank PTO weeks cell saves as null and renders `—`, not `0`.
- [ ] A typed `0` saves as 0 and renders `0` with "0 of 0 used".
- [ ] Hussain's Off days reads "none" despite his 0.70 call FTE.
- [ ] A 0.75 FTE shows a non-zero off-day budget.
- [ ] The tally card on `/dashboard` shows the same numbers as the one on `/block-prep` for the same site and year.
- [ ] Switching the year to one with no published blocks shows the "No published blocks this year" caption and no off-days-used figure.
- [ ] An invalid FTE (e.g. `3`) shows an error and the cell reverts to its previous value.
- [ ] Adding PTO in the drawer updates the provider's PTO column without a page reload.
