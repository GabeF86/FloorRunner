// Validation helpers for the provider / employment-profile / site-credential
// API surface. Keeping these centralized so the UI and server share one source
// of truth for enum values and numeric bounds.

export const PROVIDER_TYPES = ['physician', 'crna', 'aa', 'resident', 'fellow', 'locums', 'other'] as const;
export type ProviderType = typeof PROVIDER_TYPES[number];

export const PROVIDER_STATUSES = ['active', 'inactive', 'on_leave'] as const;
export type ProviderStatus = typeof PROVIDER_STATUSES[number];

export const EMPLOYMENT_STATUSES = ['full_time', 'part_time', 'per_diem', 'locums', 'contract', 'retired', 'terminated'] as const;
export type EmploymentStatus = typeof EMPLOYMENT_STATUSES[number];

export const AVAILABILITY_TYPES = [
  'available', 'unavailable', 'pto', 'sick', 'fmla', 'conference', 'admin',
  'cme', 'jury_duty', 'no_call_request', 'call_request', 'blocked',
  'parental_leave', 'military_leave',
  // pto_sellback (patch31, 2026-07-20): the chief bought PTO back — the
  // provider IS WORKING the covered dates. NOT a blocking type; it overrides
  // blocking coverage date-by-date (rulesEngine/shared.ts isDateBlocked) and
  // sold-back weekdays are owed again in the working-days budget.
  'pto_sellback',
] as const;
export type AvailabilityType = typeof AVAILABILITY_TYPES[number];

// Display labels for availability types — shared so the UI and any server
// copy render the same vocabulary.
export const AVAILABILITY_TYPE_LABELS: Record<AvailabilityType, string> = {
  available: 'Available',
  unavailable: 'Unavailable',
  pto: 'PTO',
  sick: 'Sick',
  fmla: 'FMLA',
  conference: 'Conference',
  admin: 'Admin',
  cme: 'CME',
  jury_duty: 'Jury Duty',
  no_call_request: 'No-Call Request',
  call_request: 'Call Request',
  blocked: 'Blocked',
  parental_leave: 'Parental Leave',
  military_leave: 'Military Leave',
  pto_sellback: 'PTO Sell-Back',
};

export const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'waitlisted', 'canceled'] as const;
export type ApprovalStatus = typeof APPROVAL_STATUSES[number];

// Display labels for provider_availability.reason_code values written by the
// app (free-text column — unknown codes fall back to the raw string).
// icu_week / icu_post_call come from the profile ICU Rotation section
// (src/lib/icuRotation.ts).
export const REASON_CODE_LABELS: Record<string, string> = {
  icu_week: 'ICU Week',
  icu_post_call: 'ICU Post-Call',
};
export function reasonCodeLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return REASON_CODE_LABELS[code] || code;
}

// DB column is numeric(3,2): max 9.99. Practical range is 0.01..1.5 (rare >1),
// but we allow up to 2.00 for the odd partner working two jobs at the group.
export const FTE_MIN = 0;
export const FTE_MAX = 2;

// work_days_fte (patch43) — the WORKING-DAYS FTE, a SEPARATE contract from the
// call FTE above: how many of a block's working days the provider owes, vs.
// how much call they owe. BLANK/NULL means "same as fte_value" (the state of
// every provider until someone states otherwise).
//
// Range is 0..1, deliberately NARROWER than FTE_MAX: nobody can be obligated
// for more working days than the block HAS, so a value above 1 is a typo, not
// a policy — and the DB CHECK says the same thing. (fte_value's headroom above
// 1 exists for the two-jobs case, which is a pay/call concept, not a
// days-in-the-block one.) Mirrored in supabase_scheduling_patch43.
export const WORK_DAYS_FTE_MIN = 0;
export const WORK_DAYS_FTE_MAX = 1;

// Columns that live on the `providers` table (vs. the employment profile).
// Used by PATCH to route updates to the right table.
export const PROVIDER_COLUMNS = [
  'first_name', 'last_name', 'preferred_display_name', 'short_display_name',
  'initials', 'provider_type', 'status', 'email', 'phone', 'home_address',
  'npi', 'employee_id', 'payroll_id', 'start_date', 'years_with_group',
  'notes_admin_only', 'color_tag', 'photo_url',
] as const;

// Columns that live on provider_employment_profiles. Anything submitted that
// isn't on this list (or PROVIDER_COLUMNS) is dropped on PATCH rather than
// silently INSERTed by Supabase — this prevents typos from quietly creating
// garbage columns via upsert.
export const PROFILE_COLUMNS = [
  'employment_status', 'fte_value', 'work_days_fte', 'is_shareholder', 'is_partner_track',
  'is_day_doc', 'is_icu_doc',
  'pto_weeks', 'max_weekly_hours', 'max_monthly_calls',
  'call_taker', 'partial_call_taker', 'holiday_call_eligible',
  'weekend_call_eligible', 'night_call_eligible', 'backup_call_eligible',
  'late_shift_eligible', 'can_supervise_crnas', 'can_work_solo',
  'can_cover_offsite', 'home_site_id', 'fellowship_primary', 'fellowships',
  'skills', 'preferred_assignments', 'undesired_assignments',
  'preferred_sites', 'undesired_sites', 'float_eligible', 'trauma_eligible',
  'ob_eligible', 'cardiac_eligible', 'endo_eligible',
  'ep_eligible', 'max_consecutive_calls', 'post_call_relief_rules',
  'weekend_frequency_target', 'holiday_frequency_target',
  'friday_frequency_target', 'blocked_dates', 'scheduling_notes',
  'available_weekdays', 'preferred_day_shift_types', 'days_per_week',
] as const;

// Simple RFC-5322-ish check — not trying to reject every exotic address, just
// catch the common typos ("jane@" or "not-an-email") before hitting the DB.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(s: string): boolean {
  return EMAIL_RE.test(s);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  // Round-trip guard: JS Date silently rolls impossible calendar days over
  // ('2026-02-30' parses as Mar 2, '2026-04-31' as May 1), so a format-valid
  // but nonexistent date would sail through here, then blow up as a Postgres
  // date-column error (500) instead of the promised 400. Only accept strings
  // the parsed date maps straight back to.
  return d.toISOString().slice(0, 10) === s;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

// Helpers for building short_display and initials safely — empty inputs used
// to produce "." and ".." respectively in the old code.
export function buildShortDisplay(first: string, last: string): string {
  const f = first.trim();
  const l = last.trim();
  if (!f) return l;
  if (!l) return f;
  return `${f.charAt(0)}.${l}`;
}

export function buildInitials(first: string, last: string): string {
  const f = first.trim().charAt(0);
  const l = last.trim().charAt(0);
  return `${f}${l}`.toUpperCase();
}

export interface ProviderCreateInput {
  organization_id?: unknown;
  provider_type?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  email?: unknown;
  start_date?: unknown;
  status?: unknown;
  employment_status?: unknown;
  fte_value?: unknown;
}

export function validateProviderCreate(body: ProviderCreateInput): ValidationResult {
  if (typeof body.organization_id !== 'string' || !body.organization_id) {
    return { ok: false, error: 'organization_id is required' };
  }
  if (typeof body.first_name !== 'string' || !body.first_name.trim()) {
    return { ok: false, error: 'first_name is required' };
  }
  if (typeof body.last_name !== 'string' || !body.last_name.trim()) {
    return { ok: false, error: 'last_name is required' };
  }
  if (typeof body.provider_type !== 'string' || !(PROVIDER_TYPES as readonly string[]).includes(body.provider_type)) {
    return { ok: false, error: `provider_type must be one of: ${PROVIDER_TYPES.join(', ')}` };
  }
  if (body.status !== undefined && body.status !== null) {
    if (typeof body.status !== 'string' || !(PROVIDER_STATUSES as readonly string[]).includes(body.status)) {
      return { ok: false, error: `status must be one of: ${PROVIDER_STATUSES.join(', ')}` };
    }
  }
  if (body.employment_status !== undefined && body.employment_status !== null) {
    if (typeof body.employment_status !== 'string' || !(EMPLOYMENT_STATUSES as readonly string[]).includes(body.employment_status)) {
      return { ok: false, error: `employment_status must be one of: ${EMPLOYMENT_STATUSES.join(', ')}` };
    }
  }
  if (body.email !== undefined && body.email !== null && body.email !== '') {
    if (typeof body.email !== 'string' || !isValidEmail(body.email)) {
      return { ok: false, error: 'email is not a valid address' };
    }
  }
  if (body.start_date !== undefined && body.start_date !== null && body.start_date !== '') {
    if (typeof body.start_date !== 'string' || !isValidDate(body.start_date)) {
      return { ok: false, error: 'start_date must be YYYY-MM-DD' };
    }
  }
  if (body.fte_value !== undefined && body.fte_value !== null) {
    const n = Number(body.fte_value);
    if (!Number.isFinite(n) || n < FTE_MIN || n > FTE_MAX) {
      return { ok: false, error: `fte_value must be between ${FTE_MIN} and ${FTE_MAX}` };
    }
  }
  return { ok: true };
}

// ── provider_availability PATCH validation (2026-07-20 hardening) ───────────
// The availability [id] route used to pass the raw request body straight into
// .update() — mass assignment (any column, e.g. provider_id or source, could
// be rewritten, and garbage values reached the DB). This validator is the
// single gate: a strict WHITELIST of updatable fields, enum membership for
// availability_type / approval_status, ISO-date shape for the endpoints, and
// a hard 400 on ANY unknown key (unlike validateAndSplitPatch's silent drop —
// an availability edit is small enough that a typo should fail loudly).
// end >= start is enforced by the route against the MERGED row (existing +
// patch), since a patch may move only one endpoint.
//
// ICU rows (reason_code 'icu_week' / 'icu_post_call') pair a week row with its
// post-ICU Monday row (src/lib/icuRotation.ts). This field-level validator
// cannot see the sibling row — keeping that pairing consistent is the ICU
// section's own edit flow (which re-derives the Monday); the generic edit UI
// routes ICU-week edits through it.

export const AVAILABILITY_PATCH_FIELDS = [
  'start_date', 'end_date', 'notes', 'availability_type', 'approval_status',
] as const;

export interface AvailabilityPatchResult {
  ok: boolean;
  error?: string;
  // Cleaned whitelist-only field map, safe to hand to .update().
  fields: Record<string, unknown>;
}

export function validateAvailabilityPatch(body: unknown): AvailabilityPatchResult {
  const fields: Record<string, unknown> = {};
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object', fields };
  }
  for (const [key, valRaw] of Object.entries(body as Record<string, unknown>)) {
    if (!(AVAILABILITY_PATCH_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown field: ${key}`, fields };
    }
    let val = valRaw;
    if (key === 'start_date' || key === 'end_date') {
      if (typeof val !== 'string' || !isValidDate(val)) {
        return { ok: false, error: `${key} must be YYYY-MM-DD`, fields };
      }
    } else if (key === 'availability_type') {
      if (typeof val !== 'string' || !(AVAILABILITY_TYPES as readonly string[]).includes(val)) {
        return { ok: false, error: `availability_type must be one of: ${AVAILABILITY_TYPES.join(', ')}`, fields };
      }
    } else if (key === 'approval_status') {
      if (typeof val !== 'string' || !(APPROVAL_STATUSES as readonly string[]).includes(val)) {
        return { ok: false, error: `approval_status must be one of: ${APPROVAL_STATUSES.join(', ')}`, fields };
      }
    } else if (key === 'notes') {
      if (val !== null && typeof val !== 'string') {
        return { ok: false, error: 'notes must be a string or null', fields };
      }
      if (val === '') val = null; // store NULL, not empty string
    }
    fields[key] = val;
  }
  if (Object.keys(fields).length === 0) {
    return { ok: false, error: 'no updatable fields in body', fields };
  }
  return { ok: true, fields };
}

// Partial validation for PATCH — only validates fields that are present.
// Returns the cleaned provider- and profile-field maps alongside any errors.
export interface PatchValidationResult {
  ok: boolean;
  error?: string;
  providerFields: Record<string, unknown>;
  profileFields: Record<string, unknown>;
}

export function validateAndSplitPatch(body: Record<string, unknown>): PatchValidationResult {
  const providerFields: Record<string, unknown> = {};
  const profileFields: Record<string, unknown> = {};

  for (const [key, valRaw] of Object.entries(body)) {
    if (key === 'id' || key === 'organization_id') continue;

    let val = valRaw;

    // Shared enum / format checks by field name. String '' is normalized to
    // null for optional text fields so the DB stores NULL rather than empty
    // string (matters for UNIQUE indexes that allow multiple NULLs).
    if (key === 'provider_type') {
      if (typeof val !== 'string' || !(PROVIDER_TYPES as readonly string[]).includes(val)) {
        return { ok: false, error: `provider_type must be one of: ${PROVIDER_TYPES.join(', ')}`, providerFields, profileFields };
      }
    } else if (key === 'status') {
      if (typeof val !== 'string' || !(PROVIDER_STATUSES as readonly string[]).includes(val)) {
        return { ok: false, error: `status must be one of: ${PROVIDER_STATUSES.join(', ')}`, providerFields, profileFields };
      }
    } else if (key === 'employment_status') {
      if (typeof val !== 'string' || !(EMPLOYMENT_STATUSES as readonly string[]).includes(val)) {
        return { ok: false, error: `employment_status must be one of: ${EMPLOYMENT_STATUSES.join(', ')}`, providerFields, profileFields };
      }
    } else if (key === 'email' && typeof val === 'string' && val.trim() !== '') {
      if (!isValidEmail(val)) {
        return { ok: false, error: 'email is not a valid address', providerFields, profileFields };
      }
    } else if (key === 'start_date' && typeof val === 'string' && val !== '') {
      if (!isValidDate(val)) {
        return { ok: false, error: 'start_date must be YYYY-MM-DD', providerFields, profileFields };
      }
    } else if (key === 'fte_value') {
      if (val === '' || val === null) {
        val = null;
      } else {
        const n = Number(val);
        if (!Number.isFinite(n) || n < FTE_MIN || n > FTE_MAX) {
          return { ok: false, error: `fte_value must be between ${FTE_MIN} and ${FTE_MAX}`, providerFields, profileFields };
        }
        val = n;
      }
    } else if (key === 'work_days_fte') {
      // BLANK IS MEANINGFUL and must reach the DB as a real NULL: it is the
      // "same as FTE" state, the same blank-means-formula convention the
      // Limits tab uses. Storing 0 instead would silently obligate the
      // provider to ZERO working days.
      if (val === '' || val === null) {
        val = null;
      } else {
        const n = Number(val);
        if (!Number.isFinite(n) || n < WORK_DAYS_FTE_MIN || n > WORK_DAYS_FTE_MAX) {
          return {
            ok: false,
            error: `work_days_fte must be between ${WORK_DAYS_FTE_MIN} and ${WORK_DAYS_FTE_MAX} (or blank for "same as FTE")`,
            providerFields, profileFields,
          };
        }
        val = n;
      }
    } else if (key === 'pto_weeks' || key === 'max_weekly_hours' || key === 'max_monthly_calls' || key === 'max_consecutive_calls' || key === 'years_with_group') {
      if (val === '' || val === null) {
        val = null;
      } else {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 0) {
          return { ok: false, error: `${key} must be a non-negative integer`, providerFields, profileFields };
        }
        val = n;
      }
    } else if (key === 'available_weekdays') {
      // Must be a 7-element boolean array indexed Sun..Sat. Anything else
      // is rejected — the DB default is `[true x7]` so there's no reason
      // to let a caller submit null or a partial array.
      if (!Array.isArray(val) || val.length !== 7 || !val.every(b => typeof b === 'boolean')) {
        return { ok: false, error: 'available_weekdays must be an array of exactly 7 booleans (Sun..Sat)', providerFields, profileFields };
      }
    } else if (key === 'preferred_day_shift_types') {
      // jsonb array of shift_type codes. An empty array means "no
      // restriction"; the DB default is [].
      if (!Array.isArray(val) || !val.every(s => typeof s === 'string')) {
        return { ok: false, error: 'preferred_day_shift_types must be an array of strings', providerFields, profileFields };
      }
    } else if (key === 'days_per_week') {
      if (val === '' || val === null) {
        val = null;
      } else {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1 || n > 7) {
          return { ok: false, error: 'days_per_week must be an integer between 1 and 7', providerFields, profileFields };
        }
        val = n;
      }
    } else if (key === 'weekend_frequency_target' || key === 'holiday_frequency_target' || key === 'friday_frequency_target') {
      if (val === '' || val === null) {
        val = null;
      } else {
        const n = Number(val);
        if (!Number.isFinite(n) || n < 0) {
          return { ok: false, error: `${key} must be a non-negative number`, providerFields, profileFields };
        }
        val = n;
      }
    } else if (key === 'first_name' || key === 'last_name') {
      if (typeof val !== 'string' || !val.trim()) {
        return { ok: false, error: `${key} cannot be empty`, providerFields, profileFields };
      }
      val = val.trim();
    } else if (typeof val === 'string' && val === '') {
      // Normalize empty strings on optional text columns to null.
      if (key === 'phone' || key === 'npi' || key === 'employee_id' || key === 'payroll_id' ||
          key === 'home_address' || key === 'color_tag' || key === 'photo_url' ||
          key === 'preferred_display_name' || key === 'short_display_name' || key === 'initials' ||
          key === 'notes_admin_only' || key === 'fellowship_primary' || key === 'scheduling_notes' ||
          key === 'email') {
        val = null;
      }
    }

    if ((PROVIDER_COLUMNS as readonly string[]).includes(key)) {
      providerFields[key] = val;
    } else if ((PROFILE_COLUMNS as readonly string[]).includes(key)) {
      profileFields[key] = val;
    }
    // Unknown keys are silently dropped — prevents typos from persisting.
  }

  return { ok: true, providerFields, profileFields };
}
