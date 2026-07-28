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
//
// highlight_color (2026-07-28, patch42) is the scheduler's HAND-SET billing
// mark on this assignment — see src/lib/highlightColor.ts. It is a plain
// nullable text column with a CHECK, so on a pre-patch42 DB selecting it is a
// 42703 / PGRST204. GRID_ASSIGNMENT_COLUMNS_PRE42 is the narrow retry: an
// absent column can hold no mark, so dropping it is EXACT — the grid renders
// with every cell unmarked, which is precisely the state of a DB that has no
// marks to render.
export const GRID_ASSIGNMENT_COLUMNS =
  'id, schedule_slot_id, provider_id, assignment_status, is_open_call, manually_overridden, validation_flags, highlight_color, providers(id, last_name, short_display_name, initials, provider_type)';

export const GRID_ASSIGNMENT_COLUMNS_PRE42 =
  'id, schedule_slot_id, provider_id, assignment_status, is_open_call, manually_overridden, validation_flags, providers(id, last_name, short_display_name, initials, provider_type)';

// requires_post_call_rule rides on the shift_types join for the Call Counts
// modal's Working Days credit (post-call rest days credit as worked —
// plannerMath.computeScheduleActuals via lib/callCountDays.ts).
// call_rank (patch18) identifies the PRIMARY call code (rank 0 = first call)
// for the modal's Obligatory Weekends column — the column counts primary-call
// weekend days, and must never key that off a code-name literal. It rides on
// BOTH selects: it is a patch18 column, so the patch35 narrow retry can still
// serve it.
// parent_call_code + call_burden_weight (2026-07-22, patch35) drive the
// split-call stacked cell and the weighted obligation census; the route
// retries with GRID_SLOT_COLUMNS_PRE35 on a pre-patch35 DB (missing-column
// error) — an absent column can hold no segments, so the fallback is exact.
//
// ── THE RETRY LADDER (route.ts step 3), widest first ────────────────────────
//   GRID_SLOT_COLUMNS        patch35 split columns + patch42 highlight_color
//   GRID_SLOT_COLUMNS_PRE42  patch35 split columns, no highlight_color
//   GRID_SLOT_COLUMNS_PRE35  neither (a pre-patch35 DB is necessarily pre-42
//                            under the documented patch order, so this rung
//                            drops both)
// Each rung is EXACT for the DB it serves: a column that does not exist can
// hold no data, so what it drops is data that cannot exist. The one shape the
// ladder does not serve precisely is a DB with patch42 but NOT patch35, which
// lands on rung 3 and loses the highlight — impossible in practice (patch35
// has been live since 2026-07-22) and degraded rather than broken if it ever
// happened.
export const GRID_SLOT_COLUMNS =
  `id, slot_date, shift_type_id, slot_index, locked, derived_day_type, shift_types(id, code, name, color_hex, category, call_type, display_order, provider_group, requires_post_call_rule, call_rank, parent_call_code, call_burden_weight), assignments(${GRID_ASSIGNMENT_COLUMNS})` as const;

export const GRID_SLOT_COLUMNS_PRE42 =
  `id, slot_date, shift_type_id, slot_index, locked, derived_day_type, shift_types(id, code, name, color_hex, category, call_type, display_order, provider_group, requires_post_call_rule, call_rank, parent_call_code, call_burden_weight), assignments(${GRID_ASSIGNMENT_COLUMNS_PRE42})` as const;

export const GRID_SLOT_COLUMNS_PRE35 =
  `id, slot_date, shift_type_id, slot_index, locked, derived_day_type, shift_types(id, code, name, color_hex, category, call_type, display_order, provider_group, requires_post_call_rule, call_rank), assignments(${GRID_ASSIGNMENT_COLUMNS_PRE42})` as const;

// Missing-column detection for the pre-patch35 / pre-patch42 retries (42703 or
// a message naming a column) — mirrors the engine's posture. PostgREST answers
// a write to an unknown column from its own schema cache as PGRST204 ("Could
// not find the 'highlight_color' column of 'assignments' in the schema cache"),
// which the /column/i test also catches.
export function isMissingColumnErr(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  return err?.code === '42703' || /column/i.test(err?.message || '');
}

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
