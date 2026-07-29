// Available Call List (2026-07-29) — every UNFILLED call slot in a block, as
// the chief works it: "which calls i need to list up for grabs" (Gabriel).
// Unfilled call is offered to the group as a paid pickup, so this is both the
// grid's red-cell predicate and the printable/copyable worklist behind it.
//
// Lives here rather than in the page because vitest runs `environment: 'node'`
// with no jsdom — page components are not unit testable, so anything with a
// rule in it lives in a module and the component renders only what it returns
// (the gridTheme.ts / callCountColumns.ts / slotCandidates.ts convention).
//
// ── "UNFILLED" IS NOT "HAS NO ASSIGNMENT ROW" ───────────────────────────────
// THE trap on this data. Clearing a cell DELETES the assignment and RE-INSERTS
// one with assignment_status 'open' and a null provider_id (the DELETE branch
// of api/scheduling/schedule-assignments/route.ts). So a slot nobody is
// working still carries an assignment row, and `slot.assignments.length > 0`
// reports it as covered — measured on live data as 42 slots that looked filled
// while 19 were empty.
//
// The predicate is therefore ROW-LEVEL, and it is NOT a new one: it is
// plannerMath.assignmentFills — the single home for "this assignment fills its
// slot" (provider_id present AND status not canceled/declined), already shared
// by the dashboard rollup and the planner's actuals. The dashboard's unfilled-
// call counter is literally the same two clauses this module applies:
//
//     if (row.shift_types?.category === 'call' && !assignments.some(fills))
//                                                    -- dashboard/queries.ts
//
// so the schedule page's list and the dashboard's "needs attention" count can
// never disagree about what an open call is.
//
// STATUS VOCABULARY. assignmentFills excludes 'canceled' and 'declined' as
// well as null providers, so a canceled row leaves its slot OPEN here. The app
// only ever writes 'assigned' and 'open' today (see the CROSS-LINK note on
// assignmentFills), so this is a forward-compatibility position, not a live
// behaviour difference — but it is the one the rest of the app already takes.
//
// ── SCOPED ON CATEGORY, NEVER ON A CODE LIST ────────────────────────────────
// A slot is "call" exactly when its shift type's category is 'call' — the same
// gate the engine (eligibility.ts, evaluators.ts), the dashboard and the
// grid's own extra-call detection use. Day/float/admin slots sitting open is
// normal scheduler workflow, not something to post for pickup, so they are not
// here and they keep their quiet em-dash on the grid.
//
// SPLIT SEGMENTS COUNT. A patch35 segment (C1N12) is a call slot in its own
// right — its own row, its own assignment, its own burden weight — so an
// unfilled segment is an unfilled call and appears under its own code. This
// falls out of the category scope for free; nothing keys on parent_call_code.
//
// ── WHY IT IS NOT A FLAT DUMP ───────────────────────────────────────────────
// Two things change what an open call is WORTH, and both are already
// single-homed elsewhere, so this module assembles rather than re-derives:
//   • DAY TYPE — the price of a pickup depends on the day. The bucket is the
//     engine's dayTypeBucketOn (rulesEngine/shared.ts), the DATE-aware
//     fairness bucket: a holiday-dated call belongs to the bucket for the day
//     of the week it lands on, because there is no holiday obligation. Labor
//     Day is a Monday. The holiday NAME still rides on the row as a pricing
//     note — annotation only, it moves no slot between buckets.
//   • CLUSTERING — a whole weekend standing open reads completely differently
//     from a scattered Tuesday, and is a different conversation with the
//     group. Rows are therefore grouped BY WEEKEND: Fri/Sat/Sun of one weekend
//     form one cluster (weekendGroup.ts — THE definition of one weekend in
//     this app, keyed by its Saturday, and the unit the engine's own block
//     chains hand to a single provider), and every Mon–Thu date stands alone.
//     A cluster holding all three days of its weekend is flagged.
//
//     NOT maximal runs of consecutive dates, which was the first cut and is
//     wrong at the density that matters most: a freshly created draft has
//     EVERY call slot open, so every date is adjacent to the next and the
//     whole block collapses into one 11-week "cluster" — the exact case where
//     he most needs the list to be readable. Weekend grouping is stable at any
//     density, and it is also how the calls are actually sold: a weekend goes
//     as a unit, a weekday goes on its own.
//
// Ordering inside all of that is plain chronological — it is a worklist he
// reads top to bottom — and fully deterministic: date, then the shift type's
// display_order, then the code compared numerically (C2 before C10), then slot
// index and id as final tiebreaks so the same block always renders the same
// list.

import { assignmentFills } from './plannerMath';
import { dayOfWeekUTC, dayTypeBucketOn, dayTypeFromDow } from './rulesEngine/shared';
import { BUCKET_DAY_TYPES, type BucketDayType } from './callCountDays';
import { BUCKET_LABELS } from './callCountColumns';
import { weekendGroupDates, weekendGroupKey } from './weekendGroup';

/* ── Inputs (structurally the grid payload's own rows) ────────────────────── */

export interface AvailableCallAssignment {
  provider_id: string | null;
  assignment_status: string;
  /** Already posted to the group through open_call_offers. */
  is_open_call?: boolean | null;
}

export interface AvailableCallShiftType {
  code: string;
  name?: string | null;
  category: string;
  display_order?: number | null;
}

export interface AvailableCallSlot {
  id?: string | null;
  slot_date: string;
  derived_day_type: string;
  slot_index?: number | null;
  locked?: boolean | null;
  shift_types: AvailableCallShiftType | null;
  assignments?: ReadonlyArray<AvailableCallAssignment> | null;
}

export interface AvailableCallHoliday {
  holiday_date: string;
  holiday_name: string;
}

/* ── THE predicate ───────────────────────────────────────────────────────── */

/** No assignment row FILLS this slot — the open-placeholder-safe emptiness
 *  test. Routed through plannerMath.assignmentFills so an open placeholder
 *  (provider_id null, status 'open') and a canceled row both read as empty,
 *  and so this can never drift from the dashboard's unfilled counter. */
export function slotIsUnfilled(
  slot: Pick<AvailableCallSlot, 'assignments'>,
): boolean {
  return !(slot.assignments ?? []).some(assignmentFills);
}

/** An unfilled slot whose shift type is CALL-category — the grid's red-cell
 *  state and this list's membership test, one function so the cell and the
 *  list cannot disagree about which slots are on offer. */
export function isUnfilledCallSlot(
  slot: Pick<AvailableCallSlot, 'assignments' | 'shift_types'>,
): boolean {
  return slot.shift_types?.category === 'call' && slotIsUnfilled(slot);
}

/* ── Output shape ────────────────────────────────────────────────────────── */

export interface AvailableCallRow {
  slotId: string;
  /** YYYY-MM-DD. */
  date: string;
  /** 0=Sun..6=Sat, parsed UTC — never the local timezone. */
  dow: number;
  /** 'Sat' */
  dayName: string;
  /** '10/17' */
  dateShort: string;
  /** 'Sat 10/17' — the label the list and the copied text both use. */
  dateLabel: string;
  code: string;
  /** Shift type name, falling back to the code. */
  name: string;
  /** Engine fairness bucket for the DATE (holidays fold onto their weekday). */
  bucket: BucketDayType;
  /** 'M–Th' | 'Fri' | 'Sat' | 'Sun' */
  bucketLabel: string;
  /** Holiday name when the date is one — a pricing note, never a bucket. */
  holidayName: string | null;
  /** Already listed up for grabs (assignments.is_open_call). */
  posted: boolean;
  locked: boolean;
}

export interface AvailableCallCluster {
  /** A weekend cluster is keyed by its SATURDAY (weekendGroupKey); a weekday
   *  cluster by its own date. Stable across rebuilds. */
  key: string;
  /** 'weekend' = the Fri/Sat/Sun unit; 'day' = a single Mon–Thu date. */
  kind: 'weekend' | 'day';
  startDate: string;
  endDate: string;
  /** The dates in this cluster that actually hold open call, ascending. */
  dates: string[];
  rows: AvailableCallRow[];
  /** 'Sat 10/17' for one date, 'Fri 10/16 – Sun 10/18' for a span. */
  label: string;
  /** All three days of this weekend are open — a different offer from one
   *  loose Saturday, and the thing he most needs to see at a glance. */
  wholeWeekend: boolean;
}

export interface AvailableCallBucketCount {
  bucket: BucketDayType;
  label: string;
  count: number;
}

export interface AvailableCallCodeCount {
  code: string;
  count: number;
}

export interface AvailableCallList {
  /** Every open call, chronological. */
  rows: AvailableCallRow[];
  /** The same rows, grouped into consecutive-date runs. */
  clusters: AvailableCallCluster[];
  /** All four buckets, in engine order; zero-count buckets included so the
   *  summary line has a stable shape (callers drop the zeros). */
  byBucket: AvailableCallBucketCount[];
  /** Per call code, most open first then code order. */
  byCode: AvailableCallCodeCount[];
  total: number;
  /** How many of `total` are already listed up for grabs. */
  postedCount: number;
}

/* ── Derivation ──────────────────────────────────────────────────────────── */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

// Natural-order code compare so C2 sorts before C10 (the dashboard's collator).
const codeCompare = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

const isBucketDayType = (v: string): v is BucketDayType =>
  (BUCKET_DAY_TYPES as readonly string[]).includes(v);

/** M/DD straight off the ISO string — no Date construction, so no timezone can
 *  shift the label off the date the row actually belongs to. */
export function shortDate(iso: string): string {
  return `${Number(iso.slice(5, 7))}/${iso.slice(8, 10)}`;
}

/** The list's canonical row label: 'Sat 10/17'. */
export function dateLabelOf(iso: string): string {
  return `${DAY_NAMES[dayOfWeekUTC(iso)]} ${shortDate(iso)}`;
}

// The row's pricing bucket. dayTypeBucketOn is THE date-aware fairness bucket
// and is never re-implemented here; the fallback exists only because it
// returns unknown day types unchanged (nothing in the schema produces one) and
// a display grouping has to be total. dayTypeFromDow is the same single-homed
// DOW→day-type map the engine's own holiday folding uses.
function bucketOf(slot: AvailableCallSlot): BucketDayType {
  const bucket = dayTypeBucketOn(slot.derived_day_type, slot.slot_date);
  if (isBucketDayType(bucket)) return bucket;
  const fallback = dayTypeFromDow(dayOfWeekUTC(slot.slot_date));
  return isBucketDayType(fallback) ? fallback : 'weekday';
}

/**
 * Every unfilled call slot in the block, chronologically, plus the groupings
 * that decide what a pickup is worth (day-type counts) and how it reads
 * (consecutive-date clusters, whole weekends flagged).
 */
export function buildAvailableCallList(
  slots: ReadonlyArray<AvailableCallSlot>,
  holidays?: ReadonlyArray<AvailableCallHoliday> | null,
): AvailableCallList {
  const holidayName = new Map<string, string>();
  for (const h of holidays ?? []) holidayName.set(h.holiday_date, h.holiday_name);

  const open: Array<{ slot: AvailableCallSlot; row: AvailableCallRow }> = [];
  for (const slot of slots) {
    if (!isUnfilledCallSlot(slot)) continue;
    const st = slot.shift_types!;
    const dow = dayOfWeekUTC(slot.slot_date);
    const bucket = bucketOf(slot);
    open.push({
      slot,
      row: {
        slotId: slot.id ?? `${st.code}|${slot.slot_date}|${slot.slot_index ?? 0}`,
        date: slot.slot_date,
        dow,
        dayName: DAY_NAMES[dow],
        dateShort: shortDate(slot.slot_date),
        dateLabel: dateLabelOf(slot.slot_date),
        code: st.code,
        name: st.name || st.code,
        bucket,
        bucketLabel: BUCKET_LABELS[bucket],
        holidayName: holidayName.get(slot.slot_date) ?? null,
        // An offer can only have been posted onto a row of THIS slot; none of
        // them fills it (that is why we are here), so any is_open_call flag on
        // the slot means this open call is already up for grabs.
        posted: (slot.assignments ?? []).some(a => a.is_open_call === true),
        locked: slot.locked === true,
      },
    });
  }

  open.sort((a, b) =>
    a.row.date.localeCompare(b.row.date)
    || ((a.slot.shift_types?.display_order ?? 999) - (b.slot.shift_types?.display_order ?? 999))
    || codeCompare.compare(a.row.code, b.row.code)
    || ((a.slot.slot_index ?? 0) - (b.slot.slot_index ?? 0))
    || a.row.slotId.localeCompare(b.row.slotId));

  const rows = open.map(o => o.row);

  // Clusters: one per WEEKEND (Fri/Sat/Sun, keyed by its Saturday), one per
  // Mon–Thu date. Rows are already chronological and a weekend's three dates
  // are consecutive with no weekday between them, so appending in row order
  // yields clusters that are themselves in order and internally contiguous —
  // no second sort, and no way for the list to jump around in time.
  const clusters: AvailableCallCluster[] = [];
  const byKey = new Map<string, AvailableCallCluster>();
  for (const row of rows) {
    const saturday = weekendGroupKey(row.date);
    const key = saturday ?? row.date;
    let cluster = byKey.get(key);
    if (!cluster) {
      cluster = {
        key,
        kind: saturday ? 'weekend' : 'day',
        startDate: row.date,
        endDate: row.date,
        dates: [row.date],
        rows: [],
        label: '',
        wholeWeekend: false,
      };
      byKey.set(key, cluster);
      clusters.push(cluster);
    } else if (row.date !== cluster.endDate) {
      cluster.dates.push(row.date);
      cluster.endDate = row.date;
    }
    cluster.rows.push(row);
  }
  for (const c of clusters) {
    c.label = c.startDate === c.endDate
      ? dateLabelOf(c.startDate)
      : `${dateLabelOf(c.startDate)} – ${dateLabelOf(c.endDate)}`;
    // The whole weekend is open when all three of its days carry open call.
    // weekendGroupDates is THE app's definition of one weekend; it returns []
    // for a Mon–Thu date, so a weekday cluster can never satisfy this.
    const dates = new Set(c.dates);
    const group = weekendGroupDates(c.startDate);
    c.wholeWeekend = group.length === 3 && group.every(g => dates.has(g));
  }

  const bucketCounts = new Map<BucketDayType, number>(BUCKET_DAY_TYPES.map(b => [b, 0]));
  const codeCounts = new Map<string, number>();
  let postedCount = 0;
  for (const row of rows) {
    bucketCounts.set(row.bucket, (bucketCounts.get(row.bucket) ?? 0) + 1);
    codeCounts.set(row.code, (codeCounts.get(row.code) ?? 0) + 1);
    if (row.posted) postedCount++;
  }

  return {
    rows,
    clusters,
    byBucket: BUCKET_DAY_TYPES.map(bucket => ({
      bucket,
      label: BUCKET_LABELS[bucket],
      count: bucketCounts.get(bucket) ?? 0,
    })),
    byCode: [...codeCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || codeCompare.compare(a.code, b.code)),
    total: rows.length,
    postedCount,
  };
}

/* ── Plain text (the thing he actually posts) ────────────────────────────── */

/** The summary line: 'M–Th 6 · Fri 3 · Sat 5 · Sun 5'. Empty buckets are
 *  dropped — a block with no open Friday call should not advertise "Fri 0". */
export function bucketSummaryText(list: AvailableCallList): string {
  return list.byBucket.filter(b => b.count > 0).map(b => `${b.label} ${b.count}`).join(' · ');
}

/**
 * The list as plain text for the clipboard — what gets pasted into the group
 * email or text thread. Same grouping and order as the rendered list, so what
 * he reads on screen and what the group receives are the same document.
 */
export function formatAvailableCallText(list: AvailableCallList, title: string): string {
  const lines: string[] = [`Available Call — ${title}`];
  if (list.total === 0) {
    lines.push('No unfilled call slots — every call in this block is covered.');
    return lines.join('\n');
  }
  lines.push(
    `${list.total} open call slot${list.total === 1 ? '' : 's'}`
    + (list.postedCount > 0 ? ` (${list.postedCount} already posted)` : ''),
  );
  const summary = bucketSummaryText(list);
  if (summary) lines.push(summary);
  for (const c of list.clusters) {
    lines.push('');
    lines.push(
      `${c.label} — ${c.rows.length} open${c.wholeWeekend ? ' — WHOLE WEEKEND' : ''}`,
    );
    for (const row of c.rows) {
      lines.push(
        `  ${row.dateLabel}  ${row.code}  ${row.name}`
        + (row.holidayName ? `  (${row.holidayName})` : '')
        + (row.posted ? '  [posted]' : ''),
      );
    }
  }
  return lines.join('\n');
}
