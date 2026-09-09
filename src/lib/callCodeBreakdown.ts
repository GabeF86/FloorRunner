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
