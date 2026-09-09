// Pure form logic for the provider Employment & Scheduling tab.
//
// The tab lives in a ~4,000-line page component where nothing can reach the
// three behaviours actually worth pinning: what the save payload contains,
// which partnership toggles clear which, and how an off-list employment status
// is offered. They live here instead, following the blockPrepView.ts precedent
// -- view logic in a lib module, the component imports it.

import { EMPLOYMENT_STATUSES } from './validation/providers';

// ── Partnership standing ───────────────────────────────────────────────────

/**
 * Partner / Partner Track / Employed Call Taker are mutually exclusive, so the
 * form holds ONE value rather than three booleans. There is no state in which
 * two are true, which means no toggle handler can forget to clear a sibling --
 * the invariant holds by construction instead of by discipline. The booleans
 * are derived at the storage boundary only.
 */
export type Partnership = 'partner' | 'partner_track' | 'employed_call_taker' | null;

export interface PartnershipFlags {
  is_shareholder: boolean;
  is_partner_track: boolean;
  is_employed_call_taker: boolean;
}

export function partnershipFlags(v: Partnership): PartnershipFlags {
  return {
    is_shareholder: v === 'partner',
    is_partner_track: v === 'partner_track',
    is_employed_call_taker: v === 'employed_call_taker',
  };
}

/**
 * Fixed precedence: partner, then partner track, then employed call taker.
 *
 * A row with two flags set should be unreachable once the UI models the trio as
 * one value, but legacy rows are not this code's to trust -- resolving by
 * precedence displays such a profile instead of crashing on it, and the first
 * save normalizes it.
 */
export function partnershipFromProfile(p: PartnershipFlags): Partnership {
  if (p.is_shareholder) return 'partner';
  if (p.is_partner_track) return 'partner_track';
  if (p.is_employed_call_taker) return 'employed_call_taker';
  return null;
}

// ── Employment status ──────────────────────────────────────────────────────

export const EMPLOYMENT_LABELS: Record<string, string> = {
  full_time: 'Full Time',
  part_time: 'Part Time',
  per_diem: 'Per Diem',
  locums: 'Locums',
  contract: 'Contract',
  retired: 'Retired',
  terminated: 'Terminated',
  employed_non_call_taker: 'Employed (non-call)',
};

export function employmentStatusLabel(v: string): string {
  return EMPLOYMENT_LABELS[v] || v;
}

/**
 * The status options for the select, with any off-list CURRENT value appended
 * as "(legacy)".
 *
 * Without the escape hatch a profile carrying a status the allow-list rejects
 * -- the database enum has `employed`, which EMPLOYMENT_STATUSES does not --
 * renders a select with no matching option AND is rejected on save, so no
 * employment change could ever be persisted for that provider. Same idiom the
 * fellowship select already uses.
 */
export function employmentStatusOptions(
  current: string,
): Array<{ value: string; label: string }> {
  // Annotated rather than inferred: mapping over the `as const` tuple would
  // narrow `value` to the eight literals, and the legacy push below is by
  // definition a value that is NOT one of them.
  const opts: Array<{ value: string; label: string }> =
    EMPLOYMENT_STATUSES.map(v => ({ value: v, label: employmentStatusLabel(v) }));
  if (current && !(EMPLOYMENT_STATUSES as readonly string[]).includes(current)) {
    opts.push({ value: current, label: `${employmentStatusLabel(current)} (legacy)` });
  }
  return opts;
}

// ── The save payload ───────────────────────────────────────────────────────

/**
 * Columns the Employment & Scheduling tab used to write and no longer does
 * (Gabriel 2026-09-09). The columns still EXIST and keep their stored values --
 * only the UI is gone.
 *
 * They must stay out of the payload. If the component still wrote them, the
 * value written would be whatever a removed toggle's state last defaulted to,
 * which would overwrite real data with invented data on every save. This list
 * is exported so a test can assert their absence rather than trusting a reader
 * to notice one creeping back.
 */
export const RETIRED_PROFILE_FIELDS: readonly string[] = [
  // Call eligibility, beyond Call Taker / Partial Call Taker
  'weekend_call_eligible', 'holiday_call_eligible', 'night_call_eligible',
  'backup_call_eligible', 'late_shift_eligible',
  // Capabilities
  'can_supervise_crnas', 'can_work_solo', 'can_cover_offsite',
  // Specialty eligibility
  'trauma_eligible', 'ob_eligible', 'cardiac_eligible', 'endo_eligible', 'ep_eligible',
  // Limits
  'max_monthly_calls', 'max_consecutive_calls',
  // Frequency targets
  'weekend_frequency_target', 'holiday_frequency_target', 'friday_frequency_target',
] as const;

export interface EmploymentFormState {
  employmentStatus: string;
  fte: string;
  workDaysFte: string;
  ptoWeeks: string;
  weeklyHours: string;
  partnership: Partnership;
  isDayDoc: boolean;
  isIcuDoc: boolean;
  callTaker: boolean;
  partialCallTaker: boolean;
  homeSiteId: string;
  schedulingNotes: string;
  availableWeekdays: boolean[];
  preferredDayShiftTypes: string[];
  daysPerWeek: string;
}

/** Blank means "not stated" (NULL); a typed 0 is a real zero. */
function intOrNull(s: string): number | null {
  return s.trim() === '' ? null : parseInt(s, 10);
}

function numOrNull(s: string): number | null {
  return s.trim() === '' ? null : Number(s);
}

const ALL_WEEKDAYS = [true, true, true, true, true, true, true];

export function employmentSavePayload(s: EmploymentFormState): Record<string, unknown> {
  return {
    employment_status: s.employmentStatus,
    fte_value: Number(s.fte),
    // Blank -> real NULL ("same as FTE"), never 0 (which would mean "owes no
    // working days at all").
    work_days_fte: numOrNull(s.workDaysFte),
    pto_weeks: intOrNull(s.ptoWeeks),
    max_weekly_hours: intOrNull(s.weeklyHours),
    ...partnershipFlags(s.partnership),
    is_day_doc: s.isDayDoc,
    is_icu_doc: s.isIcuDoc,
    call_taker: s.callTaker,
    partial_call_taker: s.partialCallTaker,
    home_site_id: s.homeSiteId || null,
    scheduling_notes: s.schedulingNotes.trim() || null,
    // Day-Doc-only fields, reset when the role is off so a former day doc
    // promoted to call does not carry stale Mon/Tue/Wed-only days or a cap.
    available_weekdays: s.isDayDoc ? s.availableWeekdays : ALL_WEEKDAYS,
    preferred_day_shift_types: s.isDayDoc ? s.preferredDayShiftTypes : [],
    days_per_week: s.isDayDoc ? intOrNull(s.daysPerWeek) : null,
  };
}
