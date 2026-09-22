// Provider-profile DATA MODEL — the three row shapes the /providers/[id] route
// reads back from /api/scheduling/providers/[id].
//
// They live here rather than in page.tsx for one hard reason: a Next.js page
// module may only export `default`, `dynamic`, `revalidate`, `metadata` and
// friends. Adding `export interface ProviderDetail` to page.tsx type-checks and
// passes vitest, then fails `next build`. Since the tabs are now separate
// modules that need these types, this is where they have to be — and it stays
// the SINGLE definition of each, never a per-tab copy.
//
// Types only, so this module contributes nothing to any JS chunk.

export interface ProviderDetail {
  id: string;
  organization_id: string;
  first_name: string;
  last_name: string;
  preferred_display_name: string;
  short_display_name: string;
  initials: string;
  provider_type: string;
  status: string;
  email: string | null;
  phone: string | null;
  home_address: string | null;
  npi: string | null;
  employee_id: string | null;
  payroll_id: string | null;
  start_date: string | null;
  years_with_group: number | null;
  notes_admin_only: string | null;
  color_tag: string | null;
  photo_url: string | null;
  provider_employment_profiles: EmploymentProfile[] | null;
  provider_site_credentials: SiteCredential[] | null;
}

export interface EmploymentProfile {
  employment_status: string;
  fte_value: number;
  // WORKING-DAYS FTE (patch43) — a SEPARATE contract from fte_value: fte_value
  // pro-rates CALL, this pro-rates the days the provider must be in a D slot.
  // NULL = "same as FTE" (every provider until one is stated).
  work_days_fte: number | null;
  is_shareholder: boolean;
  is_partner_track: boolean;
  // Third partnership standing (patch47), mutually exclusive with the two
  // above. The form holds one value and derives all three — see
  // providerEmploymentForm.Partnership.
  is_employed_call_taker: boolean;
  is_day_doc: boolean;
  is_icu_doc: boolean;
  pto_weeks: number | null;
  // Column name unchanged; the field is labelled "Weekly Hours" in the UI
  // (Gabriel 2026-09-09).
  max_weekly_hours: number | null;
  /** Per-diem contracted minimum. NULL = none stated, never flagged. */
  min_monthly_shifts: number | null;
  call_taker: boolean;
  partial_call_taker: boolean;
  /** May build and edit draft schedules, and delete schedules. Assigned by an
   *  admin or a site chief; can be anyone (patch62). */
  schedule_maker: boolean;
  home_site_id: string | null;
  fellowship_primary: string | null;
  fellowships: string[];
  skills: string[];
  preferred_assignments: string[];
  undesired_assignments: string[];
  preferred_sites: string[];
  undesired_sites: string[];
  blocked_dates: string[];
  scheduling_notes: string | null;
  // 7-element boolean array indexed Sun..Sat (matches JS Date.getDay).
  // Editable in the UI only for non-call-takers. Null on legacy rows —
  // treated as all-true.
  available_weekdays: boolean[] | null;
  // Day-doc only: which day-shift codes they'll work (e.g. ['7-3']).
  // Empty = no restriction.
  preferred_day_shift_types: string[];
  // Day-doc only: how many days per week they want scheduled. NULL = no cap.
  days_per_week: number | null;
}

export interface SiteCredential {
  id: string;
  site_id: string;
  is_active: boolean;
  credentialed: boolean;
  can_take_call: boolean;
  can_take_weekend_call: boolean;
  can_take_holiday_call: boolean;
  can_take_backup_call: boolean;
  effective_start_date: string | null;
  effective_end_date: string | null;
  allowed_shift_types: string[];
  excluded_shift_types: string[];
  skill_tags: string[];
  notes: string | null;
  sites?: { id: string; name: string; short_name: string | null };
}
