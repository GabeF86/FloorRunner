// Call Counts modal CHAIN CONNECTORS (2026-07-28) — which call columns belong
// to the SAME provider by design, so the printed table reminds you instead of
// making you hold it in your head.
//
// Gabriel, verbatim: "Is it possible to create a small line connector on top of
// the C1 C2 etc that connects the call shifts that are linked, so that when im
// using the call count box to help manually fill the schedule, its a good
// reminder of which calls are connected". A "weekend" at Paoli is not one
// shift — it is a designed SET (the Saturday C2 doc also holds Friday C2 and
// Sunday C1), and the table showed those as three unrelated columns.
//
// ── THE CHAINS ARE THE SITE'S PATTERN, NEVER A HARDCODED LIST ───────────────
// They come from the active CallPatternDoc's `blocks[]` — the same doc the
// engine builds from and the same payload field (`grid.callPattern`) the neuro
// column group and the Obligatory Weekends column already read. A block chain
// says: when `trigger` is placed on a slot of `anchorDayType`, the SAME
// provider also takes each linked `code` at `offset` days away. That IS the
// thing being drawn, so a site with a different structure draws its own, and a
// site with no pattern (or one that failed to parse — the grid route ships
// null) draws nothing at all.
//
// Only `blocks[]` is drawn, not `dayChains[]`: a day chain is the post/pre-call
// D-fill vocabulary (C2 → next-day D1), which is about a provider's OTHER days,
// not about which CALLS ride together. Its links are day-shift codes with no
// column here anyway.
//
// ── OFFSETS RESOLVE TO DAY TYPES THROUGH THE ENGINE'S DATE HELPERS ──────────
// A link is stored as a day OFFSET, and the table's columns are day TYPES, so
// "+1 from a saturday anchor" has to become "sunday". That is derived by
// walking a real date with rulesEngine/shared's addDays + dayOfWeekUTC +
// dayTypeFromDow — the single-homed DOW→day-type mapping — never by a
// day-arithmetic table written out here.
//
// An anchor day type does not always pin ONE day of the week: 'weekday' is
// Mon–Thu, and a holiday can fall on any day at all. So every candidate day of
// the week for the anchor is walked, and the offset resolves only when they all
// agree. From a saturday anchor −1 is friday for the one candidate; from a
// weekday anchor +1 is friday from Thursday but weekday from Monday, so it does
// not resolve and that LINK is dropped (offset 0 still resolves — every Mon–Thu
// candidate lands on 'weekday'). Holiday anchors never resolve, which is right:
// there is no honest column to point at.
//
// ── A MEMBER IS A (bucket, code) PAIR, MATCHED TO WHATEVER COLUMN DRAWS IT ──
// Resolution is by the column's own `bucket|code` key against the derived
// `columns` array (callCountColumns.ts), so it follows the layout wherever the
// layout puts a pair. That is what makes the NEURO group work without a special
// case: Sat C3 and Sun C3 are drawn under "Neuro Call (C3)" rather than under
// Sat and Sun, but their keys are still `saturday|C3` and `sunday|C3`, so the
// Sat C3 ↔ Sun C3 chain connects the two columns inside that group. Match on
// bucket+code instead and the neuro chain would point at columns that are not
// there.
//
// ── PARTIAL CHAINS DRAW; ONE-MEMBER CHAINS DO NOT ──────────────────────────
// Chain members are routinely NOT call columns. Paoli's Saturday C3 anchor also
// links Friday D4, and its Saturday C1 anchor links Friday D2 — day shifts,
// which this table has no column for. A member with no column is DROPPED from
// the drawing and NAMED IN THE TOOLTIP (it is still true that the same doc
// works that shift), and the rest of the chain still draws. Below two columned
// members there is nothing to connect, so the chain yields nothing — which is
// why Paoli's Sat C1 + Fri D2 chain draws no line. The same drop covers a
// member whose column does not exist in THIS block (a legacy pattern still
// naming Friday C3 after patch38 retired it): that member disappears, the chain
// does not.
//
// Members are NOT adjacent in general — Fri C2 … Sun C1 spans the Saturday
// columns — so the line crossing intermediate columns is expected and correct.
// The ticks are what identify membership; `columnIndices` is the tick list and
// first/last are the span.

import { addDays, dayOfWeekUTC, dayTypeFromDow } from './rulesEngine/shared';
import type { CallPatternDoc } from './rulesEngine/callPattern';
import { BUCKET_LABELS, type CallCountColumn } from './callCountColumns';
import { BUCKET_DAY_TYPES, type BucketDayType } from './callCountDays';

/** One call column a chain touches. */
export interface CallChainMember {
  bucket: BucketDayType;
  code: string;
  /** The `bucket|code` column key — the join with the rendered columns. */
  key: string;
  /** Standalone day+code name, e.g. "Sat C2" — always day-then-code, whichever
   * group the column is drawn in (callCountColumns' `label` convention). */
  label: string;
  /** Index into the `columns` array passed in — i.e. where it is DRAWN. */
  columnIndex: number;
  /** The chain's anchor placement, as opposed to a link that rides along. */
  isTrigger: boolean;
  /** The link's FTE gate when it has one — Paoli's Sun C3 rides along only for
   * 0.6+ FTE docs, so the connector must not promise it for everybody. */
  minFte?: number;
}

/** One drawable chain: a line from `firstIndex` to `lastIndex` with a tick at
 * each of `columnIndices`. */
export interface CallChainConnector {
  /** Stable React key. */
  key: string;
  /** The anchor's name, e.g. "Sat C2" — the row's label. */
  triggerLabel: string;
  /** The anchor's call code, for colouring off the table's existing per-code
   * palette (the component owns the palette; this module owns the facts). */
  triggerCode: string;
  /** Members with a column, in DOC order (trigger first, then links in the
   * order the pattern states them) — the order the tooltip reads in. */
  members: CallChainMember[];
  /** Member column indices, ascending and deduped — the tick positions. */
  columnIndices: number[];
  firstIndex: number;
  lastIndex: number;
  /** Chain members with no column in this table ("Fri D4"), named in the
   * tooltip so the connector never under-states the designed set. */
  omitted: string[];
  /** Plain-language tooltip: "Sat C2 · Fri C2 · Sun C1 — one provider". */
  description: string;
}

const isBucketDayType = (b: string): b is BucketDayType =>
  (BUCKET_DAY_TYPES as readonly string[]).includes(b);

// Every day of the week, as `dayOfWeekUTC` numbers them (0 = Sun … 6 = Sat).
const ALL_DOWS = [0, 1, 2, 3, 4, 5, 6];

// A concrete date for a given day of the week, FOUND with the same helpers
// rather than asserted: scan a week from a fixed seed until the DOW matches, so
// no line here claims what day any particular date was.
const DOW_SEED = '2026-01-01';
function dateForDow(dow: number): string {
  for (let i = 0; i < 7; i++) {
    const iso = addDays(DOW_SEED, i);
    if (dayOfWeekUTC(iso) === dow) return iso;
  }
  /* istanbul ignore next — seven consecutive days cover every day of the week */
  return DOW_SEED;
}

/** Days of the week an anchor day type can fall on. Derived by INVERTING
 * dayTypeFromDow (the engine's single home for the mapping) rather than
 * restating it: 'saturday' → [6], 'weekday' → [1,2,3,4]. A day type that
 * mapping never emits is a holiday — unknowable from the day type alone, so
 * every day is a candidate and no offset will resolve. */
function candidateDows(anchorDayType: string): number[] {
  const matched = ALL_DOWS.filter(dow => dayTypeFromDow(dow) === anchorDayType);
  return matched.length > 0 ? matched : ALL_DOWS;
}

/** The bucket an `offset` from `anchorDayType` lands on, or null when the
 * anchor's candidate days disagree (so there is no one column to point at). */
export function bucketAtOffset(anchorDayType: string, offset: number): BucketDayType | null {
  const landed = new Set(
    candidateDows(anchorDayType)
      .map(dow => dayTypeFromDow(dayOfWeekUTC(addDays(dateForDow(dow), offset)))),
  );
  if (landed.size !== 1) return null;
  const [only] = landed;
  return isBucketDayType(only) ? only : null;
}

/** Resolve a site's block chains onto the rendered columns.
 *
 * `columns` is `computeCallCountColumns(...).columns` — the array the whole
 * table maps, in render order — so an index here is exactly the column the
 * connector must sit above, neuro group included. A null/absent doc yields no
 * connectors and the band disappears entirely. */
export function computeCallChainConnectors(
  doc: CallPatternDoc | null | undefined,
  columns: ReadonlyArray<CallCountColumn>,
): CallChainConnector[] {
  if (!doc || columns.length === 0) return [];

  const indexByKey = new Map<string, number>();
  columns.forEach((col, i) => { if (!indexByKey.has(col.key)) indexByKey.set(col.key, i); });

  const out: CallChainConnector[] = [];
  const seen = new Set<string>();

  for (const block of doc.blocks ?? []) {
    for (const chain of block.chains ?? []) {
      // The trigger is the chain's own placement: offset 0 on the anchor day.
      const parts: Array<{ offset: number; code: string; minFte?: number; isTrigger: boolean }> = [
        { offset: 0, code: chain.trigger, isTrigger: true },
        ...(chain.links ?? []).map(l => ({ ...l, isTrigger: false })),
      ];

      const members: CallChainMember[] = [];
      const omitted: string[] = [];
      const takenKeys = new Set<string>();

      for (const part of parts) {
        const bucket = bucketAtOffset(block.anchorDayType, part.offset);
        // An offset whose day type is ambiguous (a weekday or holiday anchor)
        // names no column and cannot be honestly labelled either — it is left
        // out of the tooltip rather than guessed at.
        if (!bucket) continue;
        const key = `${bucket}|${part.code}`;
        const label = `${BUCKET_LABELS[bucket]} ${part.code}`;
        const columnIndex = indexByKey.get(key);
        if (columnIndex === undefined) {
          // No column for this pair — a day shift (D2/D4), or a call tier this
          // block does not stand. Named, not drawn; the chain survives.
          if (!omitted.includes(label)) omitted.push(label);
          continue;
        }
        // A pair named twice in one chain is one column and one tick.
        if (takenKeys.has(key)) continue;
        takenKeys.add(key);
        members.push({
          bucket, code: part.code, key, label, columnIndex,
          isTrigger: part.isTrigger,
          ...(part.minFte != null ? { minFte: part.minFte } : {}),
        });
      }

      // Nothing to connect: one column (Paoli's Sat C1 + Fri D2) or none.
      if (members.length < 2) continue;

      const columnIndices = members.map(m => m.columnIndex).sort((a, b) => a - b);
      const triggerLabel = `${BUCKET_LABELS[bucketAtOffset(block.anchorDayType, 0)!]} ${chain.trigger}`;
      const signature = `${triggerLabel}::${members.map(m => m.key).join(',')}`;
      if (seen.has(signature)) continue;   // two identical chains draw one line
      seen.add(signature);

      const named = members
        .map(m => (m.minFte != null ? `${m.label} (FTE ≥ ${m.minFte})` : m.label))
        .join(' · ');
      const also = omitted.length > 0
        ? ` Also on this chain: ${omitted.join(' · ')} — no column in this table.`
        : '';
      out.push({
        key: signature,
        triggerLabel,
        triggerCode: chain.trigger,
        members,
        columnIndices,
        firstIndex: columnIndices[0],
        lastIndex: columnIndices[columnIndices.length - 1],
        omitted,
        description: `${named} — one provider.${also}`,
      });
    }
  }

  // Left to right, widest first on a tie: the band reads in the same direction
  // as the columns, and a chain that CONTAINS another (Fri C1 … Sun C2 spans
  // the Sat C2 chain at Paoli) sits above it rather than inside it.
  return out.sort((a, b) =>
    a.firstIndex - b.firstIndex
    || b.lastIndex - a.lastIndex
    || a.triggerLabel.localeCompare(b.triggerLabel));
}
