// Call Counts modal COLUMN SHAPE (2026-07-28) — which (day bucket, call code)
// columns a block actually has, and which day bucket each EXTRA call belongs
// to. Extracted from CallCountsModal (schedules/[id]/page.tsx) because vitest
// runs `environment: 'node'` with no jsdom: page components are not unit
// testable, so anything with a rule in it lives here and the component renders
// only what this module returns (the gridTheme.ts / blockTargets.ts pattern).
//
// ── WHY THE COLUMNS ARE DERIVED, NOT HARDCODED (Gabriel 2026-07-28) ─────────
// The modal used to render a fixed 4 buckets × 3 codes = 12-column grid.
// Two of those columns are permanently empty at Paoli — weekday C3 never
// existed and patch38 (applied 2026-07-27) deactivated the friday/C3
// shift_templates row — so every new block renders two dead columns. But
// simply DELETING the two columns would be a data-loss bug: patch38 left the
// Friday C3 slots ALREADY materialized in existing drafts untouched (its own
// note: "Friday C3 slots ALREADY materialized in EXISTING draft schedules are
// left untouched"), and Gabriel chose not to clean them up. Those drafts still
// carry real, assigned Friday C3 calls, and a hardcoded removal would hide
// them.
//
// So the rule is SLOT EXISTENCE: a (bucket, code) column renders iff this
// block has at least one slot for that pair. A retired pair disappears from
// new blocks and stays visible on the old ones, and a thinner site (one that
// only stands C1) simply renders fewer columns — no per-site config, no
// structure hardcoded in the UI.
//
// A pair with slots but ZERO assignments still renders. An empty column is
// information: the slots exist and nobody took them. Only the ABSENCE of the
// slot removes the column.
//
// ── THE CODE UNIVERSE STAYS C1–C3 ──────────────────────────────────────────
// Presence PRUNES this list, it never extends it. The modal's bucket columns
// have always been C1/C2/C3 only (display grouping — a call code outside them,
// a beeper/CB, counts in the obligation census and the Call Total but has no
// column), and widening the universe here would change what the Expected row
// and the column totals mean. That is obligation math, which this module does
// not touch.
//
// ── BUCKETS COME FROM THE ENGINE ───────────────────────────────────────────
// dayTypeBucketOn (rulesEngine/shared.ts) is the single home of the DATE-aware
// fairness bucket: a holiday-dated slot belongs to the bucket for the day of
// the week it falls on (Gabriel 2026-07-27 — there is no holiday bucket
// because there is no holiday obligation). Labor Day is a Monday, so its call
// is an M–Th call. That rule is NEVER re-implemented here.

import { dayTypeBucketOn } from './rulesEngine/shared';
import { callBurdenWeight, parentCallCodeOf } from './callBurden';
import { BUCKET_DAY_TYPES, type BucketDayType } from './callCountDays';

/** Candidate call codes for the bucket columns, in display order. Presence in
 * the block prunes this list; nothing extends it (see the header). */
export const CALL_COUNT_CODES = ['C1', 'C2', 'C3'] as const;
export type CallCountCode = (typeof CALL_COUNT_CODES)[number];

/** Column header text per bucket — the modal's long-standing labels. */
export const BUCKET_LABELS: Record<BucketDayType, string> = {
  weekday: 'M–Th',
  friday: 'Fri',
  saturday: 'Sat',
  sunday: 'Sun',
};

/** One rendered (bucket, code) column. `key` is the `bucket|code` key the
 * counts and block totals are stored under; `label` is the standalone header
 * ("Sat C1") for the Extra Calls section, where no bucket group header sits
 * above the column to supply the day. */
export interface CallCountColumn {
  bucket: BucketDayType;
  code: CallCountCode;
  key: string;
  label: string;
}

/** A bucket's column group — the top header cell ("Sat", colSpan = codes.length). */
export interface CallCountBucketGroup {
  bucket: BucketDayType;
  label: string;
  codes: CallCountCode[];
}

/** A grid slot row as this module reads it. Structurally satisfied by the
 * schedule grid's Slot (and by the census's CensusSlot plus a day type). */
export interface CallCountSlotRow {
  slot_date: string;
  derived_day_type: string;
  shift_types?: {
    code: string;
    // patch35 call-split columns; absent = whole call (weight 1, own code).
    call_burden_weight?: number | null;
    parent_call_code?: string | null;
  } | null;
  assignments?: ReadonlyArray<{ id?: string | null; provider_id?: string | null }> | null;
}

export interface CallCountColumns {
  /** Every rendered column, bucket-major then code order. */
  columns: CallCountColumn[];
  /** The same columns grouped for the two-row header; empty buckets omitted. */
  groups: CallCountBucketGroup[];
  /** key -> weighted slot total for the block (drives the Expected row). */
  blockTotals: Record<string, number>;
  /** providerId -> key -> weighted calls held. */
  counts: Record<string, Record<string, number>>;
}

function isBucketDayType(b: string): b is BucketDayType {
  return (BUCKET_DAY_TYPES as readonly string[]).includes(b);
}

const isCallCountCode = (c: string): c is CallCountCode =>
  (CALL_COUNT_CODES as readonly string[]).includes(c);

/** Slot census for the modal's bucket columns: which columns exist, the
 * block's weighted slot total per column, and each provider's weighted calls
 * per column.
 *
 * Call splits (patch35) aggregate under their PARENT code by weight, so a
 * split Sat C1 with both halves filled contributes 0.5 + 0.5 across its takers
 * and the column totals still sum to the slot-weight total. Presence, though,
 * is counted per SLOT ROW, never by weight — a column exists because the block
 * stands that slot, whatever it is worth. */
export function computeCallCountColumns(
  slots: ReadonlyArray<CallCountSlotRow>,
): CallCountColumns {
  const blockTotals: Record<string, number> = {};
  const counts: Record<string, Record<string, number>> = {};
  const present = new Set<string>();

  for (const slot of slots) {
    const st = slot.shift_types;
    if (!st?.code) continue;
    const code = parentCallCodeOf(st.code, st);
    if (!isCallCountCode(code)) continue;
    const bucket = dayTypeBucketOn(slot.derived_day_type, slot.slot_date);
    // A day type the engine does not fold into one of the four buckets has no
    // column (the shared obligation census still counts the slot).
    if (!isBucketDayType(bucket)) continue;

    const key = `${bucket}|${code}`;
    present.add(key);
    const weight = callBurdenWeight(st);
    blockTotals[key] = (blockTotals[key] || 0) + weight;
    for (const a of slot.assignments || []) {
      if (!a.provider_id) continue;
      let row = counts[a.provider_id];
      if (!row) { row = {}; counts[a.provider_id] = row; }
      row[key] = (row[key] || 0) + weight;
    }
  }

  const columns: CallCountColumn[] = [];
  const groups: CallCountBucketGroup[] = [];
  for (const bucket of BUCKET_DAY_TYPES) {
    const codes = CALL_COUNT_CODES.filter(code => present.has(`${bucket}|${code}`));
    if (codes.length === 0) continue;
    groups.push({ bucket, label: BUCKET_LABELS[bucket], codes: [...codes] });
    for (const code of codes) {
      columns.push({
        bucket,
        code,
        key: `${bucket}|${code}`,
        label: `${BUCKET_LABELS[bucket]} ${code}`,
      });
    }
  }
  return { columns, groups, blockTotals, counts };
}

/* ── Extra calls by day type (Gabriel 2026-07-28) ─────────────────────────── */

// "add which type of extra call in the extra call column, becuase i need to
// know if the extra C1 was on a Weekday, Friday or Saturday or Sunday etc...
// bc each one has a different price". An extra call is a paid pickup and the
// RATE DEPENDS ON THE DAY TYPE, so a code-only tally is unbillable as shown.
//
// WHAT IS "EXTRA" IS NOT REINTERPRETED HERE. The over-par selection is
// single-homed in the shared obligation census (fteTarget.ts —
// selectOverParAssignmentIds, the same set that paints the grid's red OVER
// cells); this function only GROUPS the ids it is handed. Change nothing about
// which assignments are in `overIds`.

/** One call assignment as the shared census reports it (fteTarget.OverParCall).
 * NOTE it carries no day type — only the date — which is why the bucket is
 * resolved against the slots below rather than read off the record. */
export interface ExtraCallRecord {
  id: string;
  provider_id: string;
  slot_date: string;
  shift_type_code: string;
  weight?: number;
  parent_code?: string;
}

/** Tally of the over-obligation calls, keyed `providerId|bucket|code`.
 *
 * The bucket comes from the SLOT the assignment sits on — census records carry
 * `slot_date` but not `derived_day_type`, and dayTypeBucketOn needs both (the
 * day type collapses every holiday to federal_holiday/major_holiday and so
 * cannot say which weekday it was; the date alone cannot say a plain Monday
 * from a Monday holiday, though both bucket the same). Joining on the
 * assignment id makes the bucket exactly the one its own slot renders under.
 * The by-date fallback covers a payload whose assignment rows carry no id, so
 * a billable pickup can never silently vanish from the table.
 *
 * Codes are grouped by PARENT code at weight, as the code-only version was, so
 * an over 0.5 segment shows as 0.5 under its parent. Codes outside C1–C3 are
 * tallied too but have no column — the pre-existing display gap, unchanged. */
export function extraCallsByBucketCode(
  slots: ReadonlyArray<CallCountSlotRow>,
  records: ReadonlyArray<ExtraCallRecord>,
  overIds: ReadonlySet<string>,
): Record<string, number> {
  const bucketByAssignmentId = new Map<string, string>();
  const bucketByDate = new Map<string, string>();
  for (const slot of slots) {
    const bucket = dayTypeBucketOn(slot.derived_day_type, slot.slot_date);
    if (!bucketByDate.has(slot.slot_date)) bucketByDate.set(slot.slot_date, bucket);
    for (const a of slot.assignments || []) {
      if (a.id) bucketByAssignmentId.set(a.id, bucket);
    }
  }

  const out: Record<string, number> = {};
  for (const rec of records) {
    if (!overIds.has(rec.id)) continue;
    const bucket = bucketByAssignmentId.get(rec.id) ?? bucketByDate.get(rec.slot_date);
    if (!bucket) continue;
    const code = rec.parent_code ?? rec.shift_type_code;
    const key = `${rec.provider_id}|${bucket}|${code}`;
    out[key] = (out[key] || 0) + callBurdenWeight({ call_burden_weight: rec.weight });
  }
  return out;
}

/** Key for reading `extraCallsByBucketCode`'s tally. */
export const extraKey = (providerId: string, bucket: string, code: string): string =>
  `${providerId}|${bucket}|${code}`;
