// Zod request-body schemas for scheduling mutation routes (Task 13).
// These mirror the writable columns of scheduling.shift_types
// (supabase_scheduling_schema.sql + patches 2/3/18) and gate POST/PATCH bodies
// BEFORE they reach Supabase: unknown columns and bad enums become a 400
// {error, issues} instead of an opaque DB error. Keep in sync with the UI
// sender (sites/[id] ShiftTypeModal) — its exact payload is pinned in
// scheduling.test.ts.
import { z } from 'zod';

// Enums mirror the Postgres enum types / CHECK constraints.
const ShiftCategory = z.enum(['call', 'regular', 'float', 'admin', 'unavailable', 'leave']);
const ProviderGroup = z.enum(['physician', 'crna', 'both']);
const GenerationEngine = z.enum(['call', 'day_pool', 'none']); // patch18 CHECK

// ── shift_types ──────────────────────────────────────────────────────────────

export const ShiftTypeUpsertSchema = z.object({
  // NOT NULL without defaults — required on create.
  site_id: z.string().min(1),
  name: z.string().min(1),
  code: z.string().min(1),
  // Columns with DB defaults — optional on create.
  category: ShiftCategory.optional(),
  provider_group: ProviderGroup.optional(),
  call_type: z.string().nullable().optional(),           // patch2 (text, no CHECK)
  call_coverage_type: z.string().nullable().optional(),  // patch3 (text, no CHECK)
  early_out_post_call: z.boolean().optional(),           // patch3
  start_time: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
  crosses_midnight: z.boolean().optional(),
  duration_hours: z.number().nullable().optional(),
  color_hex: z.string().nullable().optional(),
  display_order: z.number().int().optional(),
  counts_toward_hours: z.boolean().optional(),
  counts_toward_call_burden: z.boolean().optional(),
  counts_as_weekend_burden: z.boolean().optional(),
  counts_as_holiday_burden: z.boolean().optional(),
  requires_post_call_rule: z.boolean().optional(),
  requires_specific_skills: z.array(z.string()).optional(),
  requires_backup_pairing: z.boolean().optional(),
  requires_credential: z.string().nullable().optional(),
  can_auto_assign: z.boolean().optional(),
  manual_only: z.boolean().optional(),
  is_active: z.boolean().optional(),
  // patch18 engine columns.
  call_rank: z.number().int().nullable().optional(),
  relief_rank: z.number().int().nullable().optional(),
  is_overlay: z.boolean().optional(),
  generation_engine: GenerationEngine.optional(),
}).strict();

export const ShiftTypePatchSchema = ShiftTypeUpsertSchema.partial();

export type ShiftTypeUpsert = z.infer<typeof ShiftTypeUpsertSchema>;
export type ShiftTypePatch = z.infer<typeof ShiftTypePatchSchema>;

// ── 400 envelope ─────────────────────────────────────────────────────────────

// Matches the API's 400 convention (top-level `error` string, cf. the
// grid-calculator normalize-rules route) plus the structured zod issues.
export function formatZodIssues(err: z.ZodError): {
  error: string;
  issues: { path: string; message: string; code: string }[];
} {
  return {
    error: 'Invalid request body.',
    issues: err.issues.map(i => ({
      path: i.path.map(p => String(p)).join('.'),
      message: i.message,
      code: i.code,
    })),
  };
}
