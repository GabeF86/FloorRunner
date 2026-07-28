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
//
// ── THE NEURO TIER GETS ITS OWN GROUP, TRANSPOSED (Gabriel 2026-07-28) ──────
// "i want to break out the C3 (Neuro) Call into its own column with Sat and
// Sun under it and place that column next to the Sat and Sun C1 C2 columns".
// So the table is day-major EXCEPT for the neuro tier, which is code-major:
//
//   | M–Th  | Fri   | Sat   | Sun   | Neuro Call (C3) |
//   | C1 C2 | C1 C2 | C1 C2 | C1 C2 | Sat   Sun       |
//
// WHICH CODE IS NEURO IS NOT HARDCODED. It comes from the site's active
// CallPatternDoc — `neuroWeekend.code`, the same field the Obligatory Weekends
// column reads off grid.callPattern. A site that states no neuroWeekend (or
// whose pattern failed to parse, so the grid route ships null) lifts nothing
// and renders exactly the shape it did before this existed. Bryn Mawr and
// Lankenau go through the no-option path untouched.
//
// The DAY sub-columns are derived the same way every other column is — by slot
// presence. Paoli stands neuro on Sat and Sun only (patch38 retired Friday
// neuro), so the group holds two; a block that still carries Friday neuro
// slots grows a Fri sub-column automatically, and so would a site that stood
// weekday neuro. Nothing about the lift is pair-shaped.
//
// The lift is PURELY where a column is DRAWN. Each column keeps its
// `bucket|code` key, so the counts, the block totals, the Expected row and the
// extras tally are byte-identical to the day-major layout — the same numbers,
// regrouped. Both halves of the table (counts and Extra Calls) render from the
// one `columns` array, so the regrouping reaches both and a column-count
// mismatch between the header, the totals row and the Expected row stays
// structurally impossible.

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

/** The neuro group's stable identity. Not a bucket, so it can never collide
 * with a `day:<bucket>` group key. */
export const NEURO_GROUP_KEY = 'neuro';

/** One rendered (bucket, code) column.
 *
 * `key` is the `bucket|code` key the counts and block totals are stored under
 * — the grouping never touches it. `label` is the standalone day+code name
 * ("Sat C1"), used by tooltips and always day-then-code whichever group the
 * column is drawn in, so a hovered cell names the pair unambiguously.
 *
 * The three `group*`/`sub*` fields are HEADER LAYOUT: the column sits under
 * `groupLabel` with `subLabel` beneath it. In a day group that reads Sat / C1;
 * in the neuro group it reads C3 / Sat — the same two facts, transposed. */
export interface CallCountColumn {
  bucket: BucketDayType;
  code: CallCountCode;
  key: string;
  label: string;
  /** Which group this column is drawn in — `day:saturday` or `neuro`. THE
   * thing group dividers key on: with the neuro tier lifted out, consecutive
   * columns in one group no longer share a bucket (the neuro group's are
   * saturday then sunday) and consecutive buckets no longer mean a new group. */
  groupKey: string;
  /** Compact group header for the Extra Calls half, which has no group row
   * above its columns and stacks the two labels in one cell instead. */
  groupLabel: string;
  /** Second-row header under the group: the CODE in a day group, the DAY in
   * the neuro group. */
  subLabel: string;
}

/** A column group — the top header cell (colSpan = columns.length). */
export interface CallCountGroup {
  /** `day:<bucket>` or NEURO_GROUP_KEY. */
  key: string;
  /** Header text: a day label ("Sat"), or the neuro tier's name and code
   * ("Neuro Call (C3)"). */
  label: string;
  /** The day bucket this group IS, for the days-in-block annotation beside its
   * header. null for the neuro group, which spans days rather than being one. */
  bucket: BucketDayType | null;
  columns: CallCountColumn[];
}

/** A grid slot row as this module reads it. Structurally satisfied by the
 * schedule grid's Slot (and by the census's CensusSlot plus a day type). */
export interface CallCountSlotRow {
  slot_date: string;
  derived_day_type: string;
  shift_types?: {
    code: string;
    /** shift_types.name — on the grid payload (all three narrow-retry rungs
     * select it). Only used to title the neuro group with the tier's real name
     * instead of the bare code; optional so a thinner caller still type-checks
     * and simply falls back to the code. */
    name?: string | null;
    // patch35 call-split columns; absent = whole call (weight 1, own code).
    call_burden_weight?: number | null;
    parent_call_code?: string | null;
  } | null;
  assignments?: ReadonlyArray<{ id?: string | null; provider_id?: string | null }> | null;
}

/** Caller-stated layout inputs. Everything else is derived from the slots. */
export interface CallCountColumnOptions {
  /** The site's stated neuro call code — `CallPatternDoc.neuroWeekend.code`,
   * the same field the Obligatory Weekends column reads. Absent, null, or a
   * code outside the C1–C3 column universe leaves every code in its day group:
   * the shape is exactly what it was before this option existed. */
  neuroCode?: string | null;
}

export interface CallCountColumns {
  /** Every rendered column, in header order: the day groups, then neuro. */
  columns: CallCountColumn[];
  /** The same columns grouped for the two-row header; empty groups omitted.
   * `groups.flatMap(g => g.columns)` IS `columns` — they are built from one
   * pass, so the header colSpans and the body can never disagree. */
  groups: CallCountGroup[];
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

/** Header text for the lifted neuro group: the shift type's real NAME plus the
 * code — "Neuro Call (C3)" at Paoli — because "C3" alone does not say neuro to
 * someone reading the printed sheet, and Gabriel wrote the tier as
 * "C3 (Neuro)". Falls back to the bare code when the payload carries no usable
 * name.
 *
 * The name is read off a slot whose OWN code is the neuro code, never off a
 * split segment that merely parents to it: a segment's name describes the
 * segment ("Neuro Call Night 12h"), so borrowing it would mislabel the whole
 * tier. A block whose neuro exists only as segments therefore titles the group
 * with the code — right, if terse. */
function neuroGroupLabel(slots: ReadonlyArray<CallCountSlotRow>, code: string): string {
  for (const slot of slots) {
    const st = slot.shift_types;
    if (!st || st.code !== code) continue;
    const name = st.name?.trim();
    if (name && name !== code) return `${name} (${code})`;
  }
  return code;
}

/** Slot census for the modal's bucket columns: which columns exist, the
 * block's weighted slot total per column, and each provider's weighted calls
 * per column.
 *
 * Call splits (patch35) aggregate under their PARENT code by weight, so a
 * split Sat C1 with both halves filled contributes 0.5 + 0.5 across its takers
 * and the column totals still sum to the slot-weight total. Presence, though,
 * is counted per SLOT ROW, never by weight — a column exists because the block
 * stands that slot, whatever it is worth.
 *
 * `options.neuroCode` only regroups: the stated neuro tier is drawn as one
 * group with a sub-column per day it is stood, after the day groups. No key,
 * total or count changes, and omitting the option reproduces the day-major
 * layout exactly. */
export function computeCallCountColumns(
  slots: ReadonlyArray<CallCountSlotRow>,
  options: CallCountColumnOptions = {},
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

  // The neuro tier is lifted only when the site STATES one and it is one of
  // the columned codes: a stated code outside C1–C3 has no columns to lift, so
  // the day groups stay exactly as they were (the same silent no-op as a site
  // with no neuroWeekend at all).
  const stated = options.neuroCode ?? null;
  const neuro: CallCountCode | null =
    stated && isCallCountCode(stated) ? stated : null;

  const groups: CallCountGroup[] = [];
  const neuroColumns: CallCountColumn[] = [];
  for (const bucket of BUCKET_DAY_TYPES) {
    const codes = CALL_COUNT_CODES.filter(code => present.has(`${bucket}|${code}`));
    const dayLabel = BUCKET_LABELS[bucket];
    const dayCodes = codes.filter(code => code !== neuro);
    if (dayCodes.length > 0) {
      const key = `day:${bucket}`;
      groups.push({
        key,
        label: dayLabel,
        bucket,
        columns: dayCodes.map(code => ({
          bucket, code,
          key: `${bucket}|${code}`,
          label: `${dayLabel} ${code}`,
          groupKey: key, groupLabel: dayLabel, subLabel: code,
        })),
      });
    }
    // One neuro sub-column per day the block actually stands neuro on — the
    // same slot-presence rule, so Paoli yields Sat + Sun and a draft still
    // holding Friday neuro slots yields Fri + Sat + Sun without a code change.
    if (neuro && codes.includes(neuro)) {
      neuroColumns.push({
        bucket, code: neuro,
        key: `${bucket}|${neuro}`,
        label: `${dayLabel} ${neuro}`,
        // The compact half shows the CODE over the day — the exact transpose
        // of a day group's day-over-code, and the shortest text that still
        // names the billed tier at 7pt print.
        groupKey: NEURO_GROUP_KEY, groupLabel: neuro, subLabel: dayLabel,
      });
    }
  }
  if (neuroColumns.length > 0) {
    groups.push({
      key: NEURO_GROUP_KEY,
      label: neuroGroupLabel(slots, neuroColumns[0].code),
      bucket: null,
      columns: neuroColumns,
    });
  }

  // Derived from the groups rather than accumulated alongside them: the header
  // and the body CANNOT drift out of sync when there is only one list.
  const columns = groups.flatMap(g => g.columns);
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
