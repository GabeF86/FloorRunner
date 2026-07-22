// Pure helpers + column lists extracted from route.ts so they can be
// unit-tested and shared (the schedule-assignments route re-selects rows in
// the same shape) without triggering Next.js's route-export type constraint.
//
// The column lists are EXPLICIT — no '*'. They select exactly what the grid
// page (src/app/(scheduling)/schedules/[id]/page.tsx) reads via its Schedule /
// Slot / AssignmentInfo interfaces. If the page grows a new field, add it here
// (route.test.ts pins the mapping). Each constant stays a single literal so
// supabase-js can type-parse the select string (`+` concatenation widens to
// `string` and breaks its parser; a template literal interpolating another
// literal-typed constant is fine — the result stays literal-typed).

export const GRID_SCHEDULE_COLUMNS =
  'id, organization_id, site_id, schedule_name, schedule_type, provider_group, date_start, date_end, status, included_provider_ids, provider_limits, sites(name, short_name, timezone, call_par_level)';

// schedule_slot_id rides along even when nested under its slot so the client
// can patch edited cells by slot id from the schedule-assignments response.
export const GRID_ASSIGNMENT_COLUMNS =
  'id, schedule_slot_id, provider_id, assignment_status, is_open_call, manually_overridden, validation_flags, providers(id, last_name, short_display_name, initials, provider_type)';

// requires_post_call_rule rides on the shift_types join for the Call Counts
// modal's Working Days credit (post-call rest days credit as worked —
// plannerMath.computeScheduleActuals via lib/callCountDays.ts).
export const GRID_SLOT_COLUMNS =
  `id, slot_date, shift_type_id, slot_index, locked, derived_day_type, shift_types(id, code, name, color_hex, category, call_type, display_order, provider_group, requires_post_call_rule), assignments(${GRID_ASSIGNMENT_COLUMNS})` as const;

// Per-assignment severity counts, computed server-side so the page doesn't
// re-walk every flags array per render. `warning` counts sentinel flags
// ('validation unavailable — needs re-validation') and any unknown severity —
// warnings must NEVER inflate the soft count (carried Task 8 finding).
export interface ValidationSummary {
  hard: number;
  soft: number;
  warning: number;
}

// null/undefined flags column = never validated → summary null (distinct from
// "checked and clean", which is all zeros).
export function validationSummaryFor(flags: unknown): ValidationSummary | null {
  if (!Array.isArray(flags)) return null;
  const summary: ValidationSummary = { hard: 0, soft: 0, warning: 0 };
  for (const f of flags) {
    const severity = (f as { severity?: unknown } | null)?.severity;
    if (severity === 'hard') summary.hard++;
    else if (severity === 'soft') summary.soft++;
    else summary.warning++;
  }
  return summary;
}

export function withValidationSummary<T extends { validation_flags?: unknown }>(
  assignment: T,
): T & { validation_summary: ValidationSummary | null } {
  return { ...assignment, validation_summary: validationSummaryFor(assignment.validation_flags) };
}
