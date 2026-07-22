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
