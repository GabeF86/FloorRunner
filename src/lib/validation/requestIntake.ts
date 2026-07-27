// Zod request-body schemas for the request-window feature (patch29):
// window management (internal UI) and the public tokenized intake route.
// Follows the Task-13 convention in validation/scheduling.ts — gate bodies
// BEFORE they reach Supabase; unknown columns / bad shapes become a 400.
import { z } from 'zod';
import { isValidDate } from './providers';

const DateStr = z.string().refine(isValidDate, 'must be YYYY-MM-DD');

const DateRange = z.object({
  start_date: DateStr,
  end_date: DateStr,
}).refine(r => r.end_date >= r.start_date, {
  message: 'end_date must be on or after start_date',
  path: ['end_date'],
});

// ── request_windows create (internal UI) ────────────────────────────────────
// max_call_requests (2026-07-22, patch36): the admin-set per-provider cap on
// call-SHIFT requests. NULL/omitted = the category is OFF for this window
// (mirror of how a 0 no-call cap disables that section); when set it must be
// ≥ 1 — "disable" is expressed by omitting, never by 0. One request = one
// requested DATE (a 3-day range counts as 3 — stated in the UI helper text).
export const RequestWindowCreateSchema = z.object({
  site_id: z.string().min(1),
  block_start: DateStr,
  block_end: DateStr,
  max_no_call_requests: z.number().int().min(0).optional(),
  max_call_requests: z.number().int().min(1).nullable().optional(),
}).refine(w => w.block_end >= w.block_start, {
  message: 'block_end must be on or after block_start',
  path: ['block_end'],
});

// PATCH only supports closing — reopening would resurrect a link providers
// may have been told is dead, and edits after providers have submitted would
// silently change the cap they were shown.
export const RequestWindowPatchSchema = z.object({
  status: z.literal('closed'),
});

// ── public intake submission ────────────────────────────────────────────────
// site_id is deliberately NOT accepted — it derives from the window row
// (never trust the client on the other side of a shared link).
export const IntakeSubmissionSchema = z.object({
  provider_id: z.string().min(1),
  pto: z.array(DateRange).max(50).optional().default([]),
  days_off: z.array(DateRange).max(50).optional().default([]),
  no_call_dates: z.array(DateStr).max(50).optional().default([]),
  // Call-shift request dates (2026-07-22) — the mirror category: accepted
  // only when the window enables it (max_call_requests ≥ 1, checked by the
  // route against the window row).
  call_dates: z.array(DateStr).max(50).optional().default([]),
});

export type IntakeSubmission = z.infer<typeof IntakeSubmissionSchema>;

/** notes marker linking a window-sourced request row to its window. */
export function windowNotesTag(windowId: string): string {
  return `request_window:${windowId}`;
}

/** Is the call-shift request category on for a window? (cap ≥ 1; NULL/absent = off). */
export function callRequestsEnabled(max: number | null | undefined): boolean {
  return typeof max === 'number' && max >= 1;
}

/** Count a provider's availability rows of `type` tagged to window `windowId`
 * — the used-count both request forms and the profile Availability tab show. */
export function countWindowRequestRows(
  rows: ReadonlyArray<{ availability_type: string; notes: string | null }>,
  windowId: string,
  type: 'no_call_request' | 'call_request',
): number {
  const tag = windowNotesTag(windowId);
  return rows.filter(r => r.availability_type === type && r.notes === tag).length;
}

/** The start_dates of a provider's availability rows of `type` tagged to
 * window `windowId` — the date list the NO-CALL unit counter needs (a bare
 * row count can't collapse a weekend into one request). */
export function windowRequestDates(
  rows: ReadonlyArray<{ availability_type: string; notes: string | null; start_date: string }>,
  windowId: string,
  type: 'no_call_request' | 'call_request',
): string[] {
  const tag = windowNotesTag(windowId);
  return rows.filter(r => r.availability_type === type && r.notes === tag).map(r => r.start_date);
}

// ── Weekend no-call unit counting (Gabriel 2026-07-22) ──────────────────────
// "A no weekend call (no Friday, no Saturday and no Sunday call) is considered
// one request not three." NO-CALL request dates count against
// max_no_call_requests in UNITS: a weekday (Mon–Thu) date = 1 unit; Fri/Sat/
// Sun dates of the SAME weekend group into 1 unit total (Fri 8/14 + Sat 8/15 +
// Sun 8/16 = ONE request; a lone Sat = one; two different weekends = two).
// The weekend key is that weekend's Saturday (Fri → +1 day, Sat → itself,
// Sun → −1 day) — pure UTC date math, single-homed HERE; every cap read
// (route enforcement, both request forms, the profile tab) goes through these.
// BOUNDARY: this is the NO-CALL category only — Gabriel's rule is about "no
// weekend call". CALL-shift requests stay one request per DATE.
// The engine is untouched: its soft-avoid / fair-denial logic reads DATES.

// The Fri/Sat/Sun grouping itself now lives in lib/weekendGroup.ts (pure,
// zod-free) so non-request surfaces — the Call Counts modal's Obligatory
// Weekends column — share this exact definition. Re-exported here because
// this module was its original home and callers import it from here.
export { weekendGroupKey, weekendGroupDates } from '../weekendGroup';
import { weekendGroupKey } from '../weekendGroup';

/** Cap unit for one no-call date: weekday → the date itself; Fri/Sat/Sun →
 * the weekend's Saturday key (so the three collapse into one unit). */
export function noCallUnitKey(date: string): string {
  return weekendGroupKey(date) ?? date;
}

/** Distinct no-call request UNITS across `dates` — duplicates and dates of
 * the same weekend collapse. This, not a date count, is what the
 * max_no_call_requests cap compares against. */
export function countNoCallRequestUnits(dates: Iterable<string>): number {
  const units = new Set<string>();
  for (const d of dates) units.add(noCallUnitKey(d));
  return units.size;
}
