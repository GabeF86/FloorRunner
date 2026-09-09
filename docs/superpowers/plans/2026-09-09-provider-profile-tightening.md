# Provider Profile Tightening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip 18 dead controls from the provider Employment & Scheduling tab, add an employment status and a partnership option, and break the Assignment History call totals down by shift code.

**Architecture:** Two independent parts. Part 1 is a UI edit plus one additive migration — behaviour-preserving for every field it removes, because the columns stay and simply stop being written. Part 2 extracts the burden route's bucketing rule into a pure, tested module so the code breakdown is computed once, in the same loop, behind the same predicate as the totals it decomposes. Form logic that is worth testing moves out of the 4,000-line page component into a pure lib module.

**Tech Stack:** Next.js 14 App Router, React, Supabase (`scheduling` schema), vitest (`environment: 'node'`, no jsdom).

**Spec:** `docs/superpowers/specs/2026-09-09-provider-profile-tightening-design.md`

---

## Critical context for every task

**Read this before starting any task.**

1. **`npm run build` is mandatory before any push.** A Next.js page may only export a fixed set of fields (`default`, `metadata`, `dynamic`, `revalidate`, …). Any other named export fails `next build` **while `tsc --noEmit` and `npm test` both pass**. This has shipped a broken build in this repo before.
2. **Tests:** `npm test` (vitest). Single file: `npx vitest run src/lib/foo.test.ts`. Ten "No test suite found" errors from `src/lib/gridCalculator/**/__tests__/` are **expected** — those are tsx-based legacy tests.
3. **No jsdom.** You cannot simulate clicks. Test pure functions directly; test render output with `renderToStaticMarkup` from `react-dom/server` if needed.
4. **The database is live production.** Ref `qhwdbtixhzdsgwwtcfrm` ("Floor Runner"), reached through the **`supabase-floorrunner`** MCP server only. The `supabase` and `supabase-chiefos` servers belong to other apps. Verify the ref before applying anything.
5. **Deploy order for this change is DATABASE FIRST.** See Task 1.
6. Public repo. Never commit secrets.

**File map:**

| Path | Role in this change |
| --- | --- |
| `supabase_scheduling_patch47_employment_options.sql` | **create** — the migration |
| `src/lib/callCodeBreakdown.ts` | **create** — pure burden bucketing + code tally |
| `src/lib/callCodeBreakdown.test.ts` | **create** — its tests |
| `src/lib/providerEmploymentForm.ts` | **create** — pure form logic seam |
| `src/lib/providerEmploymentForm.test.ts` | **create** — its tests |
| `src/app/api/scheduling/providers/[id]/burden/route.ts` | modify — use the pure module, return `breakdown` |
| `src/app/(scheduling)/providers/[id]/page.tsx` | modify — the whole of Part 1, plus rendering the breakdown |
| `src/app/(scheduling)/providers/page.tsx` | modify — drop two unused columns from the select |
| `src/lib/validation/providers.ts` | modify — allow-list the two new fields |
| `src/lib/blockPrepView.ts` | modify — reword one stale comment |

---

## Task 1: Migration patch47 (DATABASE FIRST)

**Files:**
- Create: `supabase_scheduling_patch47_employment_options.sql`

**Why this one is database-first**, unlike the call-pattern patches: if the code ships first, `handleSave` sends `is_employed_call_taker` to a table without that column and **every save on the tab fails** — not just saves that touch the new toggle. Shipping the DB first is inert: the extra enum value is offered by nothing and the extra column stays `false`.

- [ ] **Step 1: Write the migration**

Create `supabase_scheduling_patch47_employment_options.sql`:

```sql
-- supabase_scheduling_patch47_employment_options.sql
-- Provider profile tightening, part 1 (Gabriel 2026-09-09):
--   1. a new employment status, "Employed (non-call)"
--   2. a third partnership standing, "Employed Call Taker", alongside
--      is_shareholder and is_partner_track
--
-- PROJECT: apply ONLY to Supabase ref qhwdbtixhzdsgwwtcfrm ("Floor Runner").
--
-- STATUS: not yet applied.
--
-- ── ORDER: DATABASE FIRST ───────────────────────────────────────────────────
-- This REVERSES the call-pattern rule, and the reversal is the point. A
-- pattern doc is code-first because an unknown key fails the strict schema and
-- falls back to CLASSIC_PATTERN silently. Nothing here is silent and the
-- failure runs the other way: if the code ships first, the tab's save payload
-- names is_employed_call_taker against a table with no such column, and EVERY
-- save on the Employment & Scheduling tab 400s -- not only the ones that touch
-- the new toggle. Applying this first is inert: the new enum value is offered
-- by no UI, and the new column is false for all 83 profiles.
--
-- ── NO TRANSACTION ──────────────────────────────────────────────────────────
-- Deliberately NOT wrapped in BEGIN/COMMIT. A value added by ALTER TYPE ...
-- ADD VALUE cannot be USED until the adding transaction commits, and bundling
-- it with other work is the standard way to get a patch that half-applies.
-- Two independent auto-committed statements is the correct shape.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- Both statements carry IF NOT EXISTS. Safe to re-run.
--
-- ── NO BACKFILL ─────────────────────────────────────────────────────────────
-- is_employed_call_taker defaults false and stays false. 76 of 83 profiles are
-- currently neither Partner nor Partner Track; defaulting them all to Employed
-- Call Taker would invent a fact about 15 per diems and every day doc. "None of
-- the three" is the honest state for a profile nobody has classified.

ALTER TYPE scheduling.employment_status
  ADD VALUE IF NOT EXISTS 'employed_non_call_taker';

ALTER TABLE scheduling.provider_employment_profiles
  ADD COLUMN IF NOT EXISTS is_employed_call_taker boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN scheduling.provider_employment_profiles.is_employed_call_taker IS
  'Partnership standing: employed physician who takes call. Mutually exclusive '
  'with is_shareholder and is_partner_track -- the UI models the three as one '
  'value and derives the booleans at the storage boundary (patch47).';
```

- [ ] **Step 2: Verify the target project before applying**

Use the `supabase-floorrunner` MCP server. Run:

```sql
select current_database(), current_setting('search_path');
select count(*) as profiles from scheduling.provider_employment_profiles;
```

Expected: 83 profiles. If it is not 83, **stop** — you are pointed at the wrong project.

- [ ] **Step 3: Record the pre-state**

```sql
select employment_status::text as status, count(*) from scheduling.provider_employment_profiles group by 1 order by 2 desc;
```

Expected exactly: `full_time` 42, `part_time` 26, `per_diem` 15.

- [ ] **Step 4: Apply the two statements**

Run each `ALTER` separately through the `supabase-floorrunner` MCP server (they cannot share a transaction).

- [ ] **Step 5: Verify**

```sql
select enumlabel from pg_enum e
  join pg_type t on t.oid = e.enumtypid
  join pg_namespace n on n.oid = t.typnamespace
 where n.nspname = 'scheduling' and t.typname = 'employment_status'
 order by e.enumsortorder;

select column_name, data_type, column_default, is_nullable
  from information_schema.columns
 where table_schema = 'scheduling'
   and table_name = 'provider_employment_profiles'
   and column_name = 'is_employed_call_taker';

select count(*) filter (where is_employed_call_taker) as should_be_zero
  from scheduling.provider_employment_profiles;
```

Expected: nine enum labels ending in `employed_non_call_taker`; one column row, `boolean`, default `false`, `NOT NULL`; `should_be_zero` = 0.

- [ ] **Step 6: Update the patch header and commit**

Change `-- STATUS: not yet applied.` to record the date applied and the verification results, matching the style of patch46's header.

```bash
git add supabase_scheduling_patch47_employment_options.sql
git commit -m "patch47: employed non-call status + employed-call-taker flag"
```

---

## Task 2: The pure breakdown module

**Files:**
- Create: `src/lib/callCodeBreakdown.ts`
- Test: `src/lib/callCodeBreakdown.test.ts`

This module owns the bucketing rule that currently sits inline in the burden route. The route will import it in Task 3, so there is one implementation rather than two.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/callCodeBreakdown.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  BURDEN_BUCKETS,
  tallyBurden,
  formatBreakdown,
  type TallyInput,
} from './callCodeBreakdown';

function row(over: Partial<TallyInput> = {}): TallyInput {
  return {
    shift_code: 'C1',
    shift_category: 'call',
    day_type: 'weekday',
    counts_toward_call_burden: true,
    ...over,
  };
}

describe('tallyBurden — bucketing', () => {
  it('counts a weekday call in total_assignments, total_call and weekday_call', () => {
    const { burden } = tallyBurden([row()]);
    expect(burden.total_assignments).toBe(1);
    expect(burden.total_call).toBe(1);
    expect(burden.weekday_call).toBe(1);
    expect(burden.friday_call).toBe(0);
    expect(burden.weekend_call).toBe(0);
    expect(burden.holiday_call).toBe(0);
  });

  it('routes every day type to its bucket', () => {
    const { burden } = tallyBurden([
      row({ day_type: 'weekday' }),
      row({ day_type: 'friday' }),
      row({ day_type: 'saturday' }),
      row({ day_type: 'sunday' }),
      row({ day_type: 'federal_holiday' }),
      row({ day_type: 'major_holiday' }),
    ]);
    expect(burden.weekday_call).toBe(1);
    expect(burden.friday_call).toBe(1);
    expect(burden.weekend_call).toBe(2); // saturday + sunday
    expect(burden.holiday_call).toBe(2); // federal + major
    expect(burden.total_call).toBe(6);
  });

  it('counts as call when the flag is true even if the category is not call', () => {
    const { burden } = tallyBurden([
      row({ shift_category: 'regular', counts_toward_call_burden: true }),
    ]);
    expect(burden.total_call).toBe(1);
  });

  it('counts as call when the category is call even if the flag is false', () => {
    const { burden } = tallyBurden([
      row({ shift_category: 'call', counts_toward_call_burden: false }),
    ]);
    expect(burden.total_call).toBe(1);
  });

  it('a non-call assignment reaches total_assignments and nothing else', () => {
    const { burden, breakdown } = tallyBurden([
      row({ shift_code: '7-3', shift_category: 'regular', counts_toward_call_burden: false }),
    ]);
    expect(burden.total_assignments).toBe(1);
    expect(burden.total_call).toBe(0);
    expect(burden.weekday_call).toBe(0);
    expect(breakdown.total_assignments).toEqual([{ code: '7-3', count: 1 }]);
    expect(breakdown.total_call).toEqual([]);
  });

  it('a call assignment with an unrecognised day type still counts as call', () => {
    // total_call must not silently lose rows the four day-type buckets miss.
    const { burden } = tallyBurden([row({ day_type: null })]);
    expect(burden.total_call).toBe(1);
    expect(burden.weekday_call).toBe(0);
    expect(burden.friday_call).toBe(0);
    expect(burden.weekend_call).toBe(0);
    expect(burden.holiday_call).toBe(0);
  });

  it('returns all six buckets at zero for an empty history', () => {
    const { burden, breakdown } = tallyBurden([]);
    for (const b of BURDEN_BUCKETS) {
      expect(burden[b]).toBe(0);
      expect(breakdown[b]).toEqual([]);
    }
  });
});

describe('tallyBurden — breakdown', () => {
  const mixed: TallyInput[] = [
    ...Array.from({ length: 3 }, () => row({ shift_code: 'C1' })),
    ...Array.from({ length: 7 }, () => row({ shift_code: 'C2' })),
    row({ shift_code: 'C2', day_type: 'saturday' }),
    row({ shift_code: 'C3', day_type: 'sunday' }),
    row({ shift_code: '7-3', shift_category: 'regular', counts_toward_call_burden: false }),
  ];

  it("breaks a bucket down by code, Gabriel's 3 C1 / 7 C2 case", () => {
    const { breakdown } = tallyBurden(mixed);
    expect(breakdown.weekday_call).toEqual([
      { code: 'C2', count: 7 },
      { code: 'C1', count: 3 },
    ]);
  });

  it('every bucket breakdown sums EXACTLY to its total', () => {
    const { burden, breakdown } = tallyBurden(mixed);
    for (const b of BURDEN_BUCKETS) {
      const sum = breakdown[b].reduce((acc, r) => acc + r.count, 0);
      expect(sum, `bucket ${b}`).toBe(burden[b]);
    }
  });

  it('does not fold split segments into their parent code', () => {
    // C2N12 stays C2N12. Folding would mix whole and split shifts under one
    // label while the raw total above stayed a plain assignment count.
    const { breakdown } = tallyBurden([
      row({ shift_code: 'C2' }),
      row({ shift_code: 'C2N12' }),
    ]);
    expect(breakdown.weekday_call).toEqual([
      { code: 'C2', count: 1 },
      { code: 'C2N12', count: 1 },
    ]);
  });

  it('orders by count descending, then code ascending', () => {
    const { breakdown } = tallyBurden([
      row({ shift_code: 'C3' }),
      row({ shift_code: 'C1' }),
      row({ shift_code: 'C2' }),
      row({ shift_code: 'C2' }),
    ]);
    expect(breakdown.weekday_call).toEqual([
      { code: 'C2', count: 2 },
      { code: 'C1', count: 1 },
      { code: 'C3', count: 1 },
    ]);
  });

  it('total_assignments breaks down over call and non-call codes alike', () => {
    const { breakdown } = tallyBurden(mixed);
    const codes = breakdown.total_assignments.map(r => r.code).sort();
    expect(codes).toEqual(['7-3', 'C1', 'C2', 'C3']);
  });
});

describe('formatBreakdown', () => {
  it('renders an empty bucket as an empty string', () => {
    expect(formatBreakdown([])).toBe('');
  });

  it('renders a single code', () => {
    expect(formatBreakdown([{ code: 'C1', count: 3 }])).toBe('3 C1');
  });

  it('joins multiple codes with a middot', () => {
    expect(formatBreakdown([
      { code: 'C2', count: 7 },
      { code: 'C1', count: 3 },
    ])).toBe('7 C2 · 3 C1');
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/callCodeBreakdown.test.ts`
Expected: FAIL — `Failed to resolve import "./callCodeBreakdown"`.

- [ ] **Step 3: Write the module**

Create `src/lib/callCodeBreakdown.ts`:

```ts
// Assignment-history call burden: the six category totals and, new in this
// change, the breakdown of each total by shift code (Gabriel 2026-09-09: "not
// just '10 Weekday Call' but 10 and then broken down into 3-C1, 7-C2 etc.").
//
// WHY THIS IS A MODULE AND NOT INLINE IN THE ROUTE. The bucketing rule below
// used to live inside the burden route's loop, and the obvious way to add a
// breakdown was to tally it on the client from the `history` array the route
// already returns. That would have been a SECOND implementation of this rule
// sitting directly beneath the first one's output -- and a worse-informed one,
// because history rows do not carry counts_toward_call_burden at all. One
// implementation, imported by the route, computed in the same pass.
//
// RAW COUNTS, NOT WEIGHTED. A code's count is how many assignments carry it.
// The totals here have always been raw assignment counts, and the ask was to
// decompose a number Gabriel is already reading; re-deriving under
// callBurdenWeight would change the totals and make the card disagree with its
// own heading. Note this is a different question from the one the Call Counts
// modal and the Block Prep board answer -- those weight a 12h segment at 0.5
// because they measure what a provider OWES, while this measures what they
// WORKED.
//
// NO PARENT FOLDING. A C2N12 segment stays C2N12 rather than folding into C2
// via parentCallCodeOf. A breakdown exists to show the actual codes, and not
// folding is what makes the sum invariant exact: every bucket's breakdown adds
// up to that bucket's total, with no float arithmetic anywhere in this file.

/** The six cards the Assignment History tab renders, in display order. */
export const BURDEN_BUCKETS = [
  'total_assignments',
  'total_call',
  'weekday_call',
  'friday_call',
  'weekend_call',
  'holiday_call',
] as const;

export type BurdenBucket = typeof BURDEN_BUCKETS[number];

/** One row of a breakdown: a shift code and how many assignments carried it. */
export interface BreakdownRow {
  code: string;
  count: number;
}

/** One assignment, reduced to just what the tally needs. */
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

/**
 * Does this assignment count as call?
 *
 * The `|| category === 'call'` half is not redundant with the flag: a site can
 * configure a call shift type without setting counts_toward_call_burden, and
 * the original route treated both as call. Preserved exactly.
 */
function isCall(r: TallyInput): boolean {
  return r.counts_toward_call_burden || r.shift_category === 'call';
}

/**
 * The day-type bucket a CALL assignment lands in, or null when its day type is
 * one the cards do not break out (or is missing).
 *
 * Returning null rather than defaulting to a bucket is deliberate: such a row
 * still counts toward total_call, so the four day-type buckets are allowed to
 * sum to LESS than total_call. Silently bucketing it as weekday would inflate a
 * number the chief plans against.
 */
function dayBucketOf(dayType: string | null): BurdenBucket | null {
  switch (dayType) {
    case 'weekday': return 'weekday_call';
    case 'friday': return 'friday_call';
    case 'saturday':
    case 'sunday': return 'weekend_call';
    case 'federal_holiday':
    case 'major_holiday': return 'holiday_call';
    default: return null;
  }
}

/** Count assignments into the six buckets, and each bucket down by shift code. */
export function tallyBurden(rows: readonly TallyInput[]): TallyResult {
  const burden = Object.fromEntries(
    BURDEN_BUCKETS.map(b => [b, 0]),
  ) as Record<BurdenBucket, number>;

  // bucket -> code -> count, collapsed to sorted arrays at the end.
  const counts = new Map<BurdenBucket, Map<string, number>>(
    BURDEN_BUCKETS.map(b => [b, new Map<string, number>()]),
  );

  const add = (bucket: BurdenBucket, code: string) => {
    burden[bucket]++;
    const m = counts.get(bucket)!;
    m.set(code, (m.get(code) ?? 0) + 1);
  };

  for (const r of rows) {
    add('total_assignments', r.shift_code);
    if (!isCall(r)) continue;
    add('total_call', r.shift_code);
    const bucket = dayBucketOf(r.day_type);
    if (bucket) add(bucket, r.shift_code);
  }

  const breakdown = Object.fromEntries(
    BURDEN_BUCKETS.map(b => [b, sortRows(counts.get(b)!)]),
  ) as Record<BurdenBucket, BreakdownRow[]>;

  return { burden, breakdown };
}

/** Commonest code first; ties broken by code so the output is deterministic. */
function sortRows(m: ReadonlyMap<string, number>): BreakdownRow[] {
  return [...m.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/** "7 C2 · 3 C1", or an empty string when there is nothing to show. */
export function formatBreakdown(rows: readonly BreakdownRow[]): string {
  return rows.map(r => `${r.count} ${r.code}`).join(' · ');
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/callCodeBreakdown.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/callCodeBreakdown.ts src/lib/callCodeBreakdown.test.ts
git commit -m "feat: pure call-code breakdown for assignment history"
```

---

## Task 3: Wire the burden route to the module

**Files:**
- Modify: `src/app/api/scheduling/providers/[id]/burden/route.ts`
- Test: `src/lib/callCodeBreakdown.test.ts` (append a parity block)

The route's `burden` output must stay **byte-identical**. This is a display addition, not a re-count.

- [ ] **Step 1: Write the failing parity test**

Append to `src/lib/callCodeBreakdown.test.ts`:

```ts
describe('parity with the pre-change route arithmetic', () => {
  // The route used to increment inline:
  //   burden.total_assignments++ for every row with a slot and a shift type;
  //   then, if (counts_toward_call_burden || category === 'call'):
  //     total_call++, and one of weekday/friday/weekend/holiday by day type.
  // This fixture exercises every branch of that; tallyBurden must reproduce it.
  const fixture: TallyInput[] = [
    { shift_code: 'C1', shift_category: 'call', day_type: 'weekday', counts_toward_call_burden: true },
    { shift_code: 'C1', shift_category: 'call', day_type: 'weekday', counts_toward_call_burden: true },
    { shift_code: 'C2', shift_category: 'call', day_type: 'friday', counts_toward_call_burden: true },
    { shift_code: 'C2', shift_category: 'call', day_type: 'saturday', counts_toward_call_burden: true },
    { shift_code: 'C1', shift_category: 'call', day_type: 'sunday', counts_toward_call_burden: true },
    { shift_code: 'C3', shift_category: 'call', day_type: 'major_holiday', counts_toward_call_burden: true },
    { shift_code: 'D1', shift_category: 'regular', day_type: 'weekday', counts_toward_call_burden: false },
    { shift_code: '7-3', shift_category: 'regular', day_type: 'weekday', counts_toward_call_burden: false },
  ];

  it('reproduces the hand-computed totals exactly', () => {
    const { burden } = tallyBurden(fixture);
    expect(burden).toEqual({
      total_assignments: 8,
      total_call: 6,
      weekday_call: 2,
      friday_call: 1,
      weekend_call: 2,
      holiday_call: 1,
    });
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/lib/callCodeBreakdown.test.ts -t 'reproduces the hand-computed'`
Expected: PASS already (the module from Task 2 satisfies it). This test is a **regression pin**, not a red-green driver — its job is to fail if anyone later changes the bucketing.

- [ ] **Step 3: Rewrite the route's loop to use the module**

In `src/app/api/scheduling/providers/[id]/burden/route.ts`, add the import at the top:

```ts
import { tallyBurden, type TallyInput } from '@/lib/callCodeBreakdown';
```

Replace everything from `// Compute burden categories` down to the `history.sort(...)` line with:

```ts
  // Bucketing lives in @/lib/callCodeBreakdown so the per-code breakdown below
  // is computed from the SAME predicate as the totals it decomposes, rather
  // than being re-tallied on the client from `history` rows that do not carry
  // counts_toward_call_burden.
  const tallyRows: TallyInput[] = [];

  const history: Array<{
    id: string;
    slot_date: string;
    shift_code: string;
    shift_name: string;
    shift_category: string;
    day_type: string | null;
    source_type: string;
    site_id: string;
  }> = [];

  for (const row of (assignments || []) as Array<Record<string, unknown>>) {
    const slot = row.schedule_slots as Record<string, unknown>;
    if (!slot) continue;
    const st = slot.shift_types as Record<string, unknown> | null;
    if (!st) continue;

    const dayType = (slot.derived_day_type as string) || null;
    const category = st.category as string;
    const code = st.code as string;

    tallyRows.push({
      shift_code: code,
      shift_category: category,
      day_type: dayType,
      counts_toward_call_burden: !!st.counts_toward_call_burden,
    });

    history.push({
      id: row.id as string,
      slot_date: slot.slot_date as string,
      shift_code: code,
      shift_name: st.name as string,
      shift_category: category,
      day_type: dayType,
      source_type: row.source_type as string,
      site_id: slot.site_id as string,
    });
  }

  const { burden, breakdown } = tallyBurden(tallyRows);

  // Newest-first (the helper does not order; the previous DB query did).
  history.sort((a, b) => b.slot_date.localeCompare(a.slot_date));
```

Then change the final return from:

```ts
  return NextResponse.json({ period: { from, to }, burden, history });
```

to:

```ts
  return NextResponse.json({ period: { from, to }, burden, breakdown, history });
```

Note the one behavioural tightening: `!!st.counts_toward_call_burden` where the old code did `st.counts_toward_call_burden as boolean`. A null column value was already falsy in the old `if`, so this is identical in effect and honest about the type.

- [ ] **Step 4: Typecheck and test**

Run: `npx tsc --noEmit && npx vitest run src/lib/callCodeBreakdown.test.ts`
Expected: no type errors; tests PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/scheduling/providers/[id]/burden/route.ts" src/lib/callCodeBreakdown.test.ts
git commit -m "refactor: burden route tallies through the shared module, returns breakdown"
```

---

## Task 4: Render the breakdown in Assignment History

**Files:**
- Modify: `src/app/(scheduling)/providers/[id]/page.tsx` (the `BurdenData` interface around line 3926, and `HistoryTab` around line 3958)

- [ ] **Step 1: Extend the response type**

Add the import near the other `@/lib` imports at the top of the file:

```ts
import { formatBreakdown, type BreakdownRow } from '@/lib/callCodeBreakdown';
```

Change the `BurdenData` interface to add one field:

```ts
interface BurdenData {
  period: { from: string; to: string };
  burden: Record<string, number>;
  breakdown: Record<string, BreakdownRow[]>;
  history: Array<{
    id: string;
    slot_date: string;
    shift_code: string;
    shift_name: string;
    shift_category: string;
    day_type: string | null;
    source_type: string;
  }>;
}
```

- [ ] **Step 2: Render it under each card**

In `HistoryTab`, replace the burden summary card body. The current block is:

```tsx
        {Object.entries(BURDEN_LABELS).map(([key, label]) => (
          <div key={key} style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10,
            padding: '14px 16px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: BURDEN_COLORS[key] || 'var(--text)' }}>
              {data.burden[key] ?? 0}
            </div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', marginTop: 4 }}>
              {label}
            </div>
          </div>
        ))}
```

Replace it with:

```tsx
        {Object.entries(BURDEN_LABELS).map(([key, label]) => {
          // Breakdown by shift code, e.g. "7 C2 · 3 C1" under a Weekday Call of
          // 10. Computed by the route from the same predicate as the total, so
          // these always sum to the number above them. Empty renders nothing,
          // which leaves an untouched category looking exactly as it did.
          const detail = formatBreakdown(data.breakdown?.[key] ?? []);
          return (
            <div key={key} style={{
              background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10,
              padding: '14px 16px', textAlign: 'center',
            }}>
              <div style={{ fontSize: 24, fontWeight: 800, color: BURDEN_COLORS[key] || 'var(--text)' }}>
                {data.burden[key] ?? 0}
              </div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', marginTop: 4 }}>
                {label}
              </div>
              {detail && (
                <div style={{
                  fontSize: 10, fontWeight: 600, color: 'var(--text-dim)',
                  marginTop: 5, lineHeight: 1.5, wordBreak: 'break-word',
                }}>
                  {detail}
                </div>
              )}
            </div>
          );
        })}
```

`data.breakdown?.[key] ?? []` is defensive on purpose: a browser holding a cached page from before Task 3 shipped would get a response with no `breakdown` key, and must render the totals rather than crash.

- [ ] **Step 3: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(scheduling)/providers/[id]/page.tsx"
git commit -m "feat: assignment history shows each call total broken down by code"
```

---

## Task 5: The pure form-logic module

**Files:**
- Create: `src/lib/providerEmploymentForm.ts`
- Test: `src/lib/providerEmploymentForm.test.ts`

This is the seam that makes Part 1's three interesting behaviours testable. Write it before touching the component, so the component edit in Task 6 is a mechanical substitution.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/providerEmploymentForm.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  employmentSavePayload,
  employmentStatusOptions,
  partnershipFlags,
  partnershipFromProfile,
  RETIRED_PROFILE_FIELDS,
  type EmploymentFormState,
} from './providerEmploymentForm';
import { EMPLOYMENT_STATUSES, PROFILE_COLUMNS } from './validation/providers';

function state(over: Partial<EmploymentFormState> = {}): EmploymentFormState {
  return {
    employmentStatus: 'full_time',
    fte: '1.0',
    workDaysFte: '',
    ptoWeeks: '',
    weeklyHours: '',
    partnership: null,
    isDayDoc: false,
    isIcuDoc: false,
    callTaker: true,
    partialCallTaker: false,
    homeSiteId: '',
    schedulingNotes: '',
    availableWeekdays: [true, true, true, true, true, true, true],
    preferredDayShiftTypes: [],
    daysPerWeek: '',
    ...over,
  };
}

describe('partnership — one value, three booleans', () => {
  it('maps each value to exactly one true flag', () => {
    expect(partnershipFlags('partner')).toEqual({
      is_shareholder: true, is_partner_track: false, is_employed_call_taker: false,
    });
    expect(partnershipFlags('partner_track')).toEqual({
      is_shareholder: false, is_partner_track: true, is_employed_call_taker: false,
    });
    expect(partnershipFlags('employed_call_taker')).toEqual({
      is_shareholder: false, is_partner_track: false, is_employed_call_taker: true,
    });
  });

  it('maps null to all three false', () => {
    expect(partnershipFlags(null)).toEqual({
      is_shareholder: false, is_partner_track: false, is_employed_call_taker: false,
    });
  });

  it('round-trips every value through the profile shape', () => {
    for (const v of ['partner', 'partner_track', 'employed_call_taker', null] as const) {
      expect(partnershipFromProfile(partnershipFlags(v))).toBe(v);
    }
  });

  it('resolves a profile with two flags set by fixed precedence', () => {
    // Should be unreachable, but a legacy row must display rather than crash.
    expect(partnershipFromProfile({
      is_shareholder: true, is_partner_track: true, is_employed_call_taker: true,
    })).toBe('partner');
    expect(partnershipFromProfile({
      is_shareholder: false, is_partner_track: true, is_employed_call_taker: true,
    })).toBe('partner_track');
  });

  it('cannot express two selections at once', () => {
    for (const v of ['partner', 'partner_track', 'employed_call_taker', null] as const) {
      const flags = partnershipFlags(v);
      const set = Object.values(flags).filter(Boolean).length;
      expect(set).toBeLessThanOrEqual(1);
    }
  });
});

describe('employmentSavePayload', () => {
  it('writes none of the retired fields', () => {
    const payload = employmentSavePayload(state());
    for (const key of RETIRED_PROFILE_FIELDS) {
      expect(payload, `retired field ${key} must not be written`).not.toHaveProperty(key);
    }
  });

  it('retires exactly the eighteen fields the cleanup removed', () => {
    expect([...RETIRED_PROFILE_FIELDS].sort()).toEqual([
      'backup_call_eligible', 'can_cover_offsite', 'can_supervise_crnas',
      'can_work_solo', 'cardiac_eligible', 'endo_eligible', 'ep_eligible',
      'friday_frequency_target', 'holiday_call_eligible',
      'holiday_frequency_target', 'late_shift_eligible', 'max_consecutive_calls',
      'max_monthly_calls', 'night_call_eligible', 'ob_eligible',
      'trauma_eligible', 'weekend_call_eligible', 'weekend_frequency_target',
    ]);
  });

  it('writes the three partnership booleans', () => {
    const payload = employmentSavePayload(state({ partnership: 'employed_call_taker' }));
    expect(payload.is_shareholder).toBe(false);
    expect(payload.is_partner_track).toBe(false);
    expect(payload.is_employed_call_taker).toBe(true);
  });

  it('sends every key it writes through the API allow-list', () => {
    // A key the validator drops is a field that silently never saves.
    const allowed = new Set<string>(PROFILE_COLUMNS as readonly string[]);
    for (const key of Object.keys(employmentSavePayload(state()))) {
      expect(allowed.has(key), `${key} is missing from PROFILE_COLUMNS`).toBe(true);
    }
  });

  it('blank numeric fields become null, never zero', () => {
    const payload = employmentSavePayload(state({
      workDaysFte: '', ptoWeeks: '', weeklyHours: '',
    }));
    expect(payload.work_days_fte).toBeNull();
    expect(payload.pto_weeks).toBeNull();
    expect(payload.max_weekly_hours).toBeNull();
  });

  it('keeps a stated zero as zero', () => {
    // Gabriel 2026-09-06: "0 is a real number for some of them".
    const payload = employmentSavePayload(state({ ptoWeeks: '0' }));
    expect(payload.pto_weeks).toBe(0);
  });

  it('resets day-doc-only fields when the role is not day doc', () => {
    const payload = employmentSavePayload(state({
      isDayDoc: false,
      availableWeekdays: [false, true, true, false, false, false, false],
      preferredDayShiftTypes: ['7-3'],
      daysPerWeek: '3',
    }));
    expect(payload.available_weekdays).toEqual([true, true, true, true, true, true, true]);
    expect(payload.preferred_day_shift_types).toEqual([]);
    expect(payload.days_per_week).toBeNull();
  });

  it('keeps day-doc fields when the role IS day doc', () => {
    const weekdays = [false, true, true, true, false, false, false];
    const payload = employmentSavePayload(state({
      isDayDoc: true,
      availableWeekdays: weekdays,
      preferredDayShiftTypes: ['7-3'],
      daysPerWeek: '3',
    }));
    expect(payload.available_weekdays).toEqual(weekdays);
    expect(payload.preferred_day_shift_types).toEqual(['7-3']);
    expect(payload.days_per_week).toBe(3);
  });

  it('trims scheduling notes to null when blank', () => {
    expect(employmentSavePayload(state({ schedulingNotes: '   ' })).scheduling_notes).toBeNull();
  });

  it('sends a blank home site as null, not an empty string', () => {
    expect(employmentSavePayload(state({ homeSiteId: '' })).home_site_id).toBeNull();
  });
});

describe('employmentStatusOptions', () => {
  it('offers every allowed status', () => {
    const values = employmentStatusOptions('full_time').map(o => o.value);
    expect(values).toEqual([...EMPLOYMENT_STATUSES]);
  });

  it('includes the new employed non-call status', () => {
    const opt = employmentStatusOptions('full_time')
      .find(o => o.value === 'employed_non_call_taker');
    expect(opt?.label).toBe('Employed (non-call)');
  });

  it('appends an off-list current value as legacy rather than dropping it', () => {
    // Without this the select shows no match, and saving the unchanged value is
    // REJECTED by the validator -- so no employment edit could ever persist.
    const opts = employmentStatusOptions('employed');
    const last = opts[opts.length - 1];
    expect(last.value).toBe('employed');
    expect(last.label).toContain('legacy');
  });

  it('does not duplicate a current value that is already on the list', () => {
    const opts = employmentStatusOptions('per_diem');
    expect(opts.filter(o => o.value === 'per_diem')).toHaveLength(1);
  });

  it('tolerates an empty current value', () => {
    expect(employmentStatusOptions('').map(o => o.value)).toEqual([...EMPLOYMENT_STATUSES]);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/lib/providerEmploymentForm.test.ts`
Expected: FAIL — `Failed to resolve import "./providerEmploymentForm"`.

- [ ] **Step 3: Write the module**

Create `src/lib/providerEmploymentForm.ts`:

```ts
// Pure form logic for the provider Employment & Scheduling tab.
//
// The tab lives in a ~4,000-line page component where nothing can reach the
// three behaviours actually worth pinning: what the save payload contains,
// which partnership toggles clear which, and how an off-list employment status
// is offered. They live here instead, following the blockPrepView.ts precedent
// -- view logic in a lib module, the component imports it.

import { EMPLOYMENT_STATUSES } from './validation/providers';

// ── Partnership standing ───────────────────────────────────────────────────

/**
 * Partner / Partner Track / Employed Call Taker are mutually exclusive, so the
 * form holds ONE value rather than three booleans. There is no state in which
 * two are true, which means no toggle handler can forget to clear a sibling --
 * the invariant holds by construction instead of by discipline. The booleans
 * are derived at the storage boundary only.
 */
export type Partnership = 'partner' | 'partner_track' | 'employed_call_taker' | null;

export interface PartnershipFlags {
  is_shareholder: boolean;
  is_partner_track: boolean;
  is_employed_call_taker: boolean;
}

export function partnershipFlags(v: Partnership): PartnershipFlags {
  return {
    is_shareholder: v === 'partner',
    is_partner_track: v === 'partner_track',
    is_employed_call_taker: v === 'employed_call_taker',
  };
}

/**
 * Fixed precedence: partner, then partner track, then employed call taker.
 *
 * A row with two flags set should be unreachable once the UI models the trio as
 * one value, but legacy rows are not this code's to trust -- resolving by
 * precedence displays such a profile instead of crashing on it, and the first
 * save normalizes it.
 */
export function partnershipFromProfile(p: PartnershipFlags): Partnership {
  if (p.is_shareholder) return 'partner';
  if (p.is_partner_track) return 'partner_track';
  if (p.is_employed_call_taker) return 'employed_call_taker';
  return null;
}

// ── Employment status ──────────────────────────────────────────────────────

export const EMPLOYMENT_LABELS: Record<string, string> = {
  full_time: 'Full Time',
  part_time: 'Part Time',
  per_diem: 'Per Diem',
  locums: 'Locums',
  contract: 'Contract',
  retired: 'Retired',
  terminated: 'Terminated',
  employed_non_call_taker: 'Employed (non-call)',
};

export function employmentStatusLabel(v: string): string {
  return EMPLOYMENT_LABELS[v] || v;
}

/**
 * The status options for the select, with any off-list CURRENT value appended
 * as "(legacy)".
 *
 * Without the escape hatch a profile carrying a status the allow-list rejects
 * -- the database enum has `employed`, which EMPLOYMENT_STATUSES does not --
 * renders a select with no matching option AND is rejected on save, so no
 * employment change could ever be persisted for that provider. Same idiom the
 * fellowship select already uses.
 */
export function employmentStatusOptions(
  current: string,
): Array<{ value: string; label: string }> {
  const opts = EMPLOYMENT_STATUSES.map(v => ({ value: v, label: employmentStatusLabel(v) }));
  if (current && !(EMPLOYMENT_STATUSES as readonly string[]).includes(current)) {
    opts.push({ value: current, label: `${employmentStatusLabel(current)} (legacy)` });
  }
  return opts;
}

// ── The save payload ───────────────────────────────────────────────────────

/**
 * Columns the Employment & Scheduling tab used to write and no longer does
 * (Gabriel 2026-09-09). The columns still EXIST and keep their stored values --
 * only the UI is gone.
 *
 * They must stay out of the payload. If the component still wrote them, the
 * value written would be whatever a removed toggle's state last defaulted to,
 * which would overwrite real data with invented data on every save. This list
 * is exported so a test can assert their absence rather than trusting a reader
 * to notice one creeping back.
 */
export const RETIRED_PROFILE_FIELDS: readonly string[] = [
  // Call eligibility, beyond Call Taker / Partial Call Taker
  'weekend_call_eligible', 'holiday_call_eligible', 'night_call_eligible',
  'backup_call_eligible', 'late_shift_eligible',
  // Capabilities
  'can_supervise_crnas', 'can_work_solo', 'can_cover_offsite',
  // Specialty eligibility
  'trauma_eligible', 'ob_eligible', 'cardiac_eligible', 'endo_eligible', 'ep_eligible',
  // Limits
  'max_monthly_calls', 'max_consecutive_calls',
  // Frequency targets
  'weekend_frequency_target', 'holiday_frequency_target', 'friday_frequency_target',
] as const;

export interface EmploymentFormState {
  employmentStatus: string;
  fte: string;
  workDaysFte: string;
  ptoWeeks: string;
  weeklyHours: string;
  partnership: Partnership;
  isDayDoc: boolean;
  isIcuDoc: boolean;
  callTaker: boolean;
  partialCallTaker: boolean;
  homeSiteId: string;
  schedulingNotes: string;
  availableWeekdays: boolean[];
  preferredDayShiftTypes: string[];
  daysPerWeek: string;
}

/** Blank means "not stated" (NULL); a typed 0 is a real zero. */
function intOrNull(s: string): number | null {
  return s.trim() === '' ? null : parseInt(s, 10);
}

function numOrNull(s: string): number | null {
  return s.trim() === '' ? null : Number(s);
}

const ALL_WEEKDAYS = [true, true, true, true, true, true, true];

export function employmentSavePayload(s: EmploymentFormState): Record<string, unknown> {
  return {
    employment_status: s.employmentStatus,
    fte_value: Number(s.fte),
    // Blank -> real NULL ("same as FTE"), never 0 (which would mean "owes no
    // working days at all").
    work_days_fte: numOrNull(s.workDaysFte),
    pto_weeks: intOrNull(s.ptoWeeks),
    max_weekly_hours: intOrNull(s.weeklyHours),
    ...partnershipFlags(s.partnership),
    is_day_doc: s.isDayDoc,
    is_icu_doc: s.isIcuDoc,
    call_taker: s.callTaker,
    partial_call_taker: s.partialCallTaker,
    home_site_id: s.homeSiteId || null,
    scheduling_notes: s.schedulingNotes.trim() || null,
    // Day-Doc-only fields, reset when the role is off so a former day doc
    // promoted to call does not carry stale Mon/Tue/Wed-only days or a cap.
    available_weekdays: s.isDayDoc ? s.availableWeekdays : ALL_WEEKDAYS,
    preferred_day_shift_types: s.isDayDoc ? s.preferredDayShiftTypes : [],
    days_per_week: s.isDayDoc ? intOrNull(s.daysPerWeek) : null,
  };
}
```

- [ ] **Step 4: Add the two new fields to the API allow-list**

In `src/lib/validation/providers.ts`, add `'employed_non_call_taker'` to `EMPLOYMENT_STATUSES` (line 11) so the new status is accepted:

```ts
export const EMPLOYMENT_STATUSES = ['full_time', 'part_time', 'per_diem', 'locums', 'contract', 'retired', 'terminated', 'employed_non_call_taker'] as const;
```

And add `'is_employed_call_taker'` to `PROFILE_COLUMNS`, next to its siblings:

```ts
  'employment_status', 'fte_value', 'work_days_fte', 'is_shareholder', 'is_partner_track',
  'is_employed_call_taker',
  'is_day_doc', 'is_icu_doc',
```

Leave everything else in `PROFILE_COLUMNS` alone — the retired columns stay writable through the API by design (they simply stop being written by the UI).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/providerEmploymentForm.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 6: Run the full suite for regressions**

Run: `npm test`
Expected: all pass except the 10 known `gridCalculator` "No test suite found" errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/providerEmploymentForm.ts src/lib/providerEmploymentForm.test.ts src/lib/validation/providers.ts
git commit -m "feat: pure employment-form logic, partnership as one value"
```

---

## Task 6: Rewrite the Employment & Scheduling tab

**Files:**
- Modify: `src/app/(scheduling)/providers/[id]/page.tsx` — `EmploymentProfile` (line ~74), `EMPTY_PROFILE` (line ~160), `EMPLOYMENT_LABELS` (line ~205), `SchedulingTab` (line ~659 to ~1058)

This is the largest edit. It is mechanical: the pure module from Task 5 already holds every decision.

- [ ] **Step 1: Update the profile type**

In `interface EmploymentProfile`, **add**:

```ts
  is_employed_call_taker: boolean;
```

directly after `is_partner_track: boolean;`, and **delete** these eighteen lines:

```ts
  max_monthly_calls: number | null;
  holiday_call_eligible: boolean;
  weekend_call_eligible: boolean;
  night_call_eligible: boolean;
  backup_call_eligible: boolean;
  late_shift_eligible: boolean;
  can_supervise_crnas: boolean;
  can_work_solo: boolean;
  can_cover_offsite: boolean;
  trauma_eligible: boolean;
  ob_eligible: boolean;
  cardiac_eligible: boolean;
  endo_eligible: boolean;
  ep_eligible: boolean;
  max_consecutive_calls: number | null;
  weekend_frequency_target: number | null;
  holiday_frequency_target: number | null;
  friday_frequency_target: number | null;
```

The API selects `*`, so these columns still arrive in the response — they are simply no longer typed, read, or written.

- [ ] **Step 2: Update `EMPTY_PROFILE`**

Delete the same eighteen keys from the `EMPTY_PROFILE` object literal and add:

```ts
  is_employed_call_taker: false,
```

after `is_partner_track: false,`.

- [ ] **Step 3: Replace the local `EMPLOYMENT_LABELS` with the shared one**

Delete the `const EMPLOYMENT_LABELS = { ... }` block at line ~205 and import from the module instead. Add to the imports:

```ts
import {
  employmentSavePayload,
  employmentStatusLabel,
  employmentStatusOptions,
  partnershipFromProfile,
  type EmploymentFormState,
  type Partnership,
} from '@/lib/providerEmploymentForm';
```

At the one other use site (line ~397, the header chip), change:

```tsx
{prof?.employment_status && <ChipPill text={EMPLOYMENT_LABELS[prof.employment_status] || prof.employment_status} fg="#0C447C" bg="rgba(14,165,233,0.10)" />}
```

to:

```tsx
{prof?.employment_status && <ChipPill text={employmentStatusLabel(prof.employment_status)} fg="#0C447C" bg="rgba(14,165,233,0.10)" />}
```

- [ ] **Step 4: Trim the component state**

In `SchedulingTab`, delete these `useState` declarations:

`weekendElig`, `holidayElig`, `nightElig`, `backupElig`, `lateElig`, `canSupervise`, `canSolo`, `canOffsite`, `traumaElig`, `obElig`, `cardiacElig`, `endoElig`, `epElig`, `maxCalls`, `maxConsec`, `weekendTarget`, `holidayTarget`, `fridayTarget`.

Rename `maxWeeklyHours`/`setMaxWeeklyHours` to `weeklyHours`/`setWeeklyHours`, keeping `profile.max_weekly_hours` as its source (the column name is unchanged):

```ts
  const [weeklyHours, setWeeklyHours] = useState(profile.max_weekly_hours == null ? '' : String(profile.max_weekly_hours));
```

Replace the two partner booleans:

```ts
  const [isPartner, setIsPartner] = useState(profile.is_shareholder);
  const [isPartnerTrack, setIsPartnerTrack] = useState(profile.is_partner_track);
```

with the single value:

```ts
  // Partner / Partner Track / Employed Call Taker are mutually exclusive, so
  // this is ONE value rather than three booleans — no handler can leave two set.
  const [partnership, setPartnership] = useState<Partnership>(partnershipFromProfile(profile));
```

- [ ] **Step 5: Trim the sync effect**

In the `useEffect(() => { ... }, [profile])`, delete the setter calls for every state you just removed, rename the weekly-hours line, and replace the two partner lines with one:

```ts
    setWeeklyHours(profile.max_weekly_hours == null ? '' : String(profile.max_weekly_hours));
    setPartnership(partnershipFromProfile(profile));
```

- [ ] **Step 6: Trim validation**

Delete these lines from the validation block:

```ts
  checkInt(maxCalls, 'maxCalls');
  checkInt(maxConsec, 'maxConsec');
  checkNum(weekendTarget, 'weekendTarget');
  checkNum(holidayTarget, 'holidayTarget');
  checkNum(fridayTarget, 'fridayTarget');
```

Rename the weekly-hours check:

```ts
  checkInt(weeklyHours, 'weeklyHours');
```

`checkNum` now has no callers — **delete the `checkNum` helper** as well. Note that `tsconfig.json` sets `strict` but **not** `noUnusedLocals`, so leaving it behind would compile silently; this one is on you to remember. `checkInt` stays — `ptoWeeks` and `weeklyHours` still use it.

- [ ] **Step 7: Delete `enableAllCallTypes`**

Delete the whole helper and its comment block. Its only job was switching on the five removed toggles.

- [ ] **Step 8: Replace `handleSave`**

Replace the entire `handleSave` function with:

```ts
  const formState: EmploymentFormState = {
    employmentStatus: empStatus,
    fte,
    workDaysFte,
    ptoWeeks,
    weeklyHours,
    partnership,
    isDayDoc,
    isIcuDoc,
    callTaker,
    partialCallTaker: partialCall,
    homeSiteId: homeSite,
    schedulingNotes,
    availableWeekdays,
    preferredDayShiftTypes: preferredDayShifts,
    daysPerWeek,
  };

  const handleSave = () => {
    if (!canSave) return;
    onSave(employmentSavePayload(formState));
  };
```

- [ ] **Step 9: Rewrite the JSX**

**9a.** Replace the employment-status `<select>` options so an off-list value survives:

```tsx
          <select value={empStatus} onChange={e => setEmpStatus(e.target.value)} style={fieldInputStyle}>
            {employmentStatusOptions(empStatus).map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
```

**9b.** Rename the weekly-hours field:

```tsx
        <Field label="Weekly Hours" value={weeklyHours} onChange={setWeeklyHours} error={errors.weeklyHours} />
```

**9c.** Replace the Partner / Partner Track toggles in the flex row. The row currently starts with two `Toggle`s for Partner and Partner Track; replace both with three that share one value:

```tsx
        {/* One value, three checkboxes: picking any clears the others, and
            picking the one already set clears it back to "none stated". */}
        <Toggle
          label="Partner"
          checked={partnership === 'partner'}
          onChange={(v) => setPartnership(v ? 'partner' : null)}
        />
        <Toggle
          label="Partner Track"
          checked={partnership === 'partner_track'}
          onChange={(v) => setPartnership(v ? 'partner_track' : null)}
        />
        <Toggle
          label="Employed Call Taker"
          checked={partnership === 'employed_call_taker'}
          onChange={(v) => setPartnership(v ? 'employed_call_taker' : null)}
        />
```

Leave the Day Doc and ICU Doc toggles that follow exactly as they are.

**9d.** Replace the Call Eligibility block. Delete the hint paragraph ("Checking Call Taker or Partial Call Taker auto-enables all call types below…") and the five removed toggles, and drop `enableAllCallTypes()` from both remaining handlers:

```tsx
      <SectionLabel>Call Eligibility</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        <Toggle
          label="Call Taker"
          checked={callTaker}
          onChange={(v) => { setCallTaker(v); if (v) setIsDayDoc(false); }}
        />
        <Toggle
          label="Partial Call Taker"
          checked={partialCall}
          onChange={(v) => { setPartialCall(v); if (v) setIsDayDoc(false); }}
        />
      </div>
```

**9e.** Delete four whole blocks — each `SectionLabel` together with the `div` that follows it:

- `<SectionLabel>Capabilities</SectionLabel>` and its 3-column grid
- `<SectionLabel>Specialty Eligibility</SectionLabel>` and its 3-column grid
- `<SectionLabel>Limits</SectionLabel>` and its 2-column grid
- `<SectionLabel>Frequency Targets</SectionLabel>`, its hint paragraph, and its 3-column grid

The Day Doc Settings block between them and the Scheduling Notes block after them are unchanged.

- [ ] **Step 10: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. Any error naming a deleted state variable means a use site was missed — fix it rather than restoring the variable.

- [ ] **Step 11: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 12: Commit**

```bash
git add "src/app/(scheduling)/providers/[id]/page.tsx"
git commit -m "feat: tighten the provider employment tab to the fields in use"
```

---

## Task 7: Clean up the two stale references

**Files:**
- Modify: `src/app/(scheduling)/providers/page.tsx`
- Modify: `src/lib/blockPrepView.ts`

- [ ] **Step 1: Drop the unused fields from the provider-list type**

In `src/app/(scheduling)/providers/page.tsx`, remove these two lines from the profile type at lines 27-28:

```ts
    weekend_call_eligible: boolean;
    holiday_call_eligible: boolean;
```

That is the whole edit. There is no query string to trim: the page fetches `/api/scheduling/providers`, and that route reads profiles with `select('*')` (`src/app/api/scheduling/providers/route.ts:72`), so these two were only ever *declared* here, never selected by name and never rendered.

Run `npx tsc --noEmit` after — if the fields are referenced anywhere else in the file, the compiler will say so.

- [ ] **Step 2: Reword the stale comment**

In `src/lib/blockPrepView.ts` around line 305, the comment reads:

```
 * several unrelated integer columns (pto_weeks, max_weekly_hours,
 * max_monthly_calls, max_consecutive_calls, years_with_group). Checked as
```

The columns still exist, so the comment is not wrong — but it cites two controls a reader can no longer find in the UI. Reword to:

```
 * several unrelated integer columns (pto_weeks, max_weekly_hours,
 * years_with_group, and the retired max_monthly_calls / max_consecutive_calls
 * — see providerEmploymentForm.RETIRED_PROFILE_FIELDS). Checked as
```

- [ ] **Step 3: Typecheck, test, build**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all clean, bar the 10 known `gridCalculator` file errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(scheduling)/providers/page.tsx" src/lib/blockPrepView.ts
git commit -m "chore: drop the last references to the retired profile fields"
```

---

## Task 8: Verify against production data and ship

- [ ] **Step 1: Confirm patch47 is applied**

Through the `supabase-floorrunner` MCP server (verify the ref is `qhwdbtixhzdsgwwtcfrm` first):

```sql
select count(*) as should_be_1
  from information_schema.columns
 where table_schema = 'scheduling'
   and table_name = 'provider_employment_profiles'
   and column_name = 'is_employed_call_taker';
```

Expected: 1. **If this is 0, do not push** — the code will break every save on the tab.

- [ ] **Step 2: Confirm no profile data was disturbed**

```sql
select employment_status::text as status, count(*),
       count(*) filter (where is_shareholder) as partners
  from scheduling.provider_employment_profiles
 group by 1 order by 2 desc;
```

Expected, unchanged from Task 1 step 3: `full_time` 42, `part_time` 26, `per_diem` 15, and 7 partners in total.

- [ ] **Step 3: Full green check**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: all clean, bar the 10 known `gridCalculator` file errors.

- [ ] **Step 4: Verify from a clean checkout**

A green local tree has been misleading in this repo before — an imported symbol existed only in an uncommitted working file, and a fresh checkout failed with 4 type errors and 13 test failures.

```bash
git status --porcelain    # must be empty
cd "$(mktemp -d)" && git clone --depth 1 file:///Users/gabrielfarkas/Desktop/FloorRunner fr && cd fr
npm ci && npm test && npx tsc --noEmit && npm run build
```

Expected: identical results to step 3. **Do not symlink `node_modules` into the clone** — a symlink named `node_modules` is not matched by the `node_modules/` gitignore rule, and one was committed and then overwrote the real directory during a merge.

- [ ] **Step 5: Push**

```bash
git push origin main
```

Vercel auto-deploys. Confirm the deployment succeeds and `/providers/<id>` loads with the Employment & Scheduling tab showing the trimmed field set and Assignment History showing per-code breakdowns.

---

## Out of scope — carried to later specs

- **Specialty Call Taker** (part 3). Open questions to settle in its spec: whether a contract line names a specific shift code or any shift of that duration (C2 and C3 are different jobs; D2/D3 are pre-call chain links the engine places itself), and how a per-week or per-month rate converts to the engine's 11-week block.
- **The visual redesign** (part 4).
- Dropping the eighteen retired columns.
- Resolving what the `employed` enum value means.
- Whether the Assignment History totals should be weighted like the Call Counts modal.
