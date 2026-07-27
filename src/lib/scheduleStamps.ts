// Created / last-edited stamps for the schedules list (Gabriel 2026-07-27).
//
// WHY: six drafts can share one date range ("v5", "…V4", "…V3", "…V2",
// "Paoli Hospital - Schedule - August 2026", "…(Workbook Scenario)") and the
// name alone doesn't say which is freshest. The list row carries
// `schedules.created_at` / `schedules.updated_at` (both already returned by
// GET /api/scheduling/schedules, which selects `*`).
//
// Two rules live here rather than in the page so they're vitest-coverable
// (the page is a client component and the suite runs in `environment: node`,
// no jsdom):
//   1. Unparseable / missing timestamps render NOTHING, never "Invalid Date".
//   2. `edited` is suppressed when it isn't meaningful — a draft never touched
//      since creation. Compared with a tolerance, not exact equality, because
//      a row can be written twice within the same second on insert.

/**
 * How far `updated_at` may sit after `created_at` while still counting as
 * "never edited". Insert-time double-writes land inside a second; a real edit
 * is a human coming back to the draft, which is never this fast.
 */
export const SAME_STAMP_TOLERANCE_MS = 2000;

export interface StampOptions {
  /** Overrides the viewer's local zone. Test-only — production omits it so
   *  stamps render in whatever zone the browser is in. */
  timeZone?: string;
}

export interface ScheduleStamps {
  /** e.g. "Jul 26, 4:38pm", or null when unset/unparseable. */
  created: string | null;
  /** Same shape, or null when unset/unparseable/not meaningfully later. */
  edited: string | null;
}

/**
 * "Jul 26, 4:38pm" in the viewer's local zone, or null if there's nothing
 * sane to show. Deliberately year-less and lowercase-meridiem to match the
 * agreed list presentation; the sibling `formatDate` on the page still owns
 * the (year-bearing) date-range column and is untouched.
 */
export function formatStamp(
  value: string | null | undefined,
  opts: StampOptions = {},
): string | null {
  const ms = parseStamp(value);
  if (ms === null) return null;
  const text = new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
  });
  // "Jul 26, 4:38 PM" → "Jul 26, 4:38pm". \s covers the narrow no-break space
  // (U+202F) newer ICU builds put before the meridiem.
  return text.replace(/\s*([AP])M$/i, (_m, p: string) => `${p.toLowerCase()}m`);
}

/** Both stamps for one list row, with `edited` suppressed when it's noise. */
export function scheduleStamps(
  createdAt: string | null | undefined,
  updatedAt: string | null | undefined,
  opts: StampOptions = {},
): ScheduleStamps {
  const createdMs = parseStamp(createdAt);
  const updatedMs = parseStamp(updatedAt);

  // Suppress "edited" when the row was never meaningfully touched. A negative
  // delta (updated BEFORE created — clock skew or a hand-written row) is
  // nonsense to surface, so it falls into the same suppression.
  const suppressEdited =
    updatedMs === null ||
    (createdMs !== null && updatedMs - createdMs <= SAME_STAMP_TOLERANCE_MS);

  return {
    created: createdMs === null ? null : formatStamp(createdAt, opts),
    edited: suppressEdited ? null : formatStamp(updatedAt, opts),
  };
}

/** Epoch ms, or null for missing/blank/unparseable input. */
function parseStamp(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}
