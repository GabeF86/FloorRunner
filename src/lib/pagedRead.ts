// The one place that knows PostgREST silently truncates.
//
// ── THE TRAP ───────────────────────────────────────────────────────────────
// An un-ranged PostgREST select returns at most 1000 rows and reports NO
// error. Verified against this project's live database: `schedule_slots`
// holds 1,225 rows and a bare `.select('id')` returns exactly 1,000 with
// `error: null`. Code that treats the result as complete is therefore wrong in
// a way nothing surfaces — no exception, no empty result, just a shorter
// answer that looks like the truth.
//
// This matters most in the rules engine. A truncated slot read there does not
// fail loudly; it produces a schedule that is short at the END (the reads are
// ordered by slot_date), obligations divided by a short census, and a
// validation pass that reports clean on assignments it never saw — which is
// clinical invariant 6 violated by omission.
//
// ── CURRENT EXPOSURE ───────────────────────────────────────────────────────
// As of 2026-09-15 the largest single schedule_version holds 717 slots, so the
// engine's per-version reads are under the cap and nothing is being truncated
// today. That is a fact about the current data, not a property of the code:
// Paoli's 11-week block is 717 slots, so a block past roughly 15 weeks — or a
// site with a denser slate — crosses 1000 and the engine starts silently
// dropping its tail. These helpers exist so that never becomes a discovery.
//
// ── TWO SHAPES, PICK DELIBERATELY ──────────────────────────────────────────
// `readAllRows` pages to completion — use it when every row is needed and the
// operation is correct only with all of them (the engine, validation, undo
// snapshots).
// `truncationOf` detects a short read and lets the caller fail — use it when
// failing loudly beats paging (a UI panel that would rather show an error than
// a wrong number).
//
// Never `.limit()` your way out of this. A limit makes the truncation
// intentional but no more visible.

/** The builder shape both helpers accept — kept loose so any PostgREST chain fits. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueryLike = any;

export interface ReadResult<T> {
  rows: T[];
  /** Non-null when the read could not be completed. Never partial data + null. */
  error: string | null;
}

/** PostgREST's cap, and therefore the page size. */
export const PAGE_SIZE = 1000;

/**
 * Runaway guard. 50 pages is 50,000 rows — far past any legitimate read here
 * (the whole slots table is 1,225) so hitting it means a filter was dropped,
 * not that the data grew.
 */
export const MAX_PAGES = 50;

/**
 * Detect a short read. Requires the query to have been made with
 * `{ count: 'exact' }`.
 *
 * A null count with no error is itself an anomaly — it means the count option
 * was dropped somewhere — so it is reported rather than trusted, because the
 * alternative is silently believing a possibly-truncated array.
 */
export function truncationOf(
  res: { data: unknown; count: number | null },
  label: string,
): string | null {
  const len = Array.isArray(res.data) ? res.data.length : 0;
  if (res.count == null) return `${label}: row count unavailable (possible truncation)`;
  if (len < res.count) return `${label}: read truncated (${len} of ${res.count} rows)`;
  return null;
}

/**
 * Page a select to completion.
 *
 * `build` is called once per page and must apply the SAME filters each time,
 * plus a stable `.order()` — without a deterministic order the pages overlap
 * and miss rows, which is a subtler version of the bug this helper exists to
 * prevent. It receives the range so the caller can apply `.range(from, to)`.
 *
 * Returns `{ rows, error }`. On any failure — a query error, a missing count,
 * a stalled page, the page budget — it returns `rows: []` AND an error, never
 * a partial array with a null error. A caller that checks `error` first can
 * never accidentally proceed on half the data.
 */
export async function readAllRows<T>(
  build: (from: number, to: number) => QueryLike,
  label: string,
): Promise<ReadResult<T>> {
  const rows: T[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const res = await build(from, from + PAGE_SIZE - 1);

    if (res.error) return { rows: [], error: `${label}: ${res.error.message ?? 'query failed'}` };
    if (res.count == null) {
      return { rows: [], error: `${label}: row count unavailable (possible truncation)` };
    }

    const batch = (res.data ?? []) as T[];
    rows.push(...batch);

    if (rows.length >= res.count) return { rows, error: null };
    if (batch.length === 0) {
      // Asked for more, got nothing, but the count says there are more. Either
      // the data changed under us or the order is unstable; both mean this
      // read cannot be trusted to be complete.
      return { rows: [], error: `${label}: pagination stalled at ${rows.length} of ${res.count} rows` };
    }
  }

  return { rows: [], error: `${label}: exceeded the ${MAX_PAGES}-page budget` };
}
