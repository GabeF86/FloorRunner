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
export const RequestWindowCreateSchema = z.object({
  site_id: z.string().min(1),
  block_start: DateStr,
  block_end: DateStr,
  max_no_call_requests: z.number().int().min(0).optional(),
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
});

export type IntakeSubmission = z.infer<typeof IntakeSubmissionSchema>;

/** notes marker linking a window-sourced no_call_request row to its window. */
export function windowNotesTag(windowId: string): string {
  return `request_window:${windowId}`;
}
