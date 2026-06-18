// Provider leave-bucket + backup-call profile for the Anesthesia Coverage
// Grid Calculator. Owned by agent A2 (Provider Profile).
//
// Mirrors the columns added in
// supabase_scheduling_patch15_provider_leave_buckets.sql plus the pre-existing
// `pto_weeks` field on scheduling.provider_employment_profiles.
//
// Consumed by:
//   - A7 FTE simulator (worst-case + Monte Carlo) — needs availability per provider.
//   - A8 Call burden agent — needs backup-call share target + post-call cap.
//
// Pure module: no FloorRunner imports, no I/O, no side effects. Defaults are
// centralized at the top of the file so any tuning happens in one place.

// ---------------------------------------------------------------------------
// Defaults — single source of truth, mirror SQL defaults in patch 15.
// ---------------------------------------------------------------------------

/**
 * Industry-median annual sick-day budget. Used both as a SQL default and as the
 * fallback when a profile arrives with a missing/undefined sick value (e.g.
 * legacy rows pre-patch-15 that bypassed the migration).
 */
export const DEFAULT_SICK_DAYS_PER_YEAR = 5;

/** Typical CME contract allowance. */
export const DEFAULT_CME_DAYS_PER_YEAR = 5;

/** PTO weeks default when `pto_weeks` is null on a legacy profile. */
export const DEFAULT_PTO_WEEKS = 0;

/** One rest day per 24h call — matches standard house rules. */
export const DEFAULT_MAX_CONSECUTIVE_POST_CALL_DAYS = 1;

/** Working days per PTO week (anesthesia groups typically use 5). */
export const WORK_DAYS_PER_PTO_WEEK = 5;

/**
 * Per-cohort probability that an FMLA-eligible provider triggers an FMLA event
 * in a given calendar year. Used as the Monte Carlo prior in A7. Tunable.
 *
 * 0.04 ~ 4% of FMLA-eligible providers per year. Conservative national
 * baseline; A7 will recalibrate from telemetry once we have a year of data.
 */
export const DEFAULT_ANNUAL_FMLA_PROBABILITY = 0.04;

/** Expected FMLA absence length (working days) when an event triggers. */
export const DEFAULT_FMLA_EVENT_DAYS = 60; // 12 weeks × 5 working days

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Leave + backup-call profile for one provider. Field names match the SQL
 * columns 1:1 so callers can pass DB rows through with minimal mapping.
 *
 * Fields that the SQL allows to be NULL (`backup_call_share_target`) are typed
 * as `number | null` so consumers handle the "engine decides" case explicitly.
 */
export interface ProviderLeaveProfile {
  /** FK to scheduling.providers(id). Optional in this layer; callers add it. */
  provider_id?: string;

  /** Vacation weeks per year. Existing column on provider_employment_profiles. */
  pto_weeks: number;

  /** Expected sick/personal call-out days per year (Poisson lambda for A7). */
  sick_days_per_year: number;

  /** Cohort flag for the worst-case maternity hold-out (PRD §10). */
  maternity_eligible: boolean;

  /** Cohort flag for Monte Carlo FMLA sampling. */
  fmla_eligible: boolean;

  /** CME days per year — counted against availability. */
  cme_days_per_year: number;

  /**
   * Fractional share (0..1) of total backup-call demand this provider should
   * carry. `null` means the call burden engine (A8) decides via FTE-weighted
   * greedy.
   */
  backup_call_share_target: number | null;

  /**
   * Cap on consecutive post-call rest days when this provider takes back-to-back
   * 24h calls. Default 1.
   */
  max_consecutive_post_call_days: number;
}

/**
 * Calendar shape consumed by `deriveAnnualAvailability`. Kept minimal so it can
 * be satisfied by either a pre-built calendar from the simulator (A7) or an
 * ad-hoc count from the UI.
 */
export interface AnnualCalendar {
  /** Total working days in the simulated year (typically ~250 for weekdays). */
  totalWorkingDays: number;
}

/**
 * Output of `deriveAnnualAvailability` — used directly by A7 to seed the
 * worst-case deterministic hold-outs and the Monte Carlo per-trial draws.
 */
export interface AnnualAvailabilitySummary {
  /** Working days this provider is expected to be available. */
  availableDays: number;
  /** Expected sick/personal call-out days drawn against this provider. */
  expectedSickDays: number;
  /** Expected PTO days (pto_weeks × WORK_DAYS_PER_PTO_WEEK). */
  expectedPTODays: number;
  /** Expected FMLA absence days (probability × event length, 0 if ineligible). */
  expectedFMLADays: number;
  /** CME days subtracted from availability. */
  expectedCMEDays: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-partial profile (e.g. a legacy DB row pre-patch-15, or a
 * UI-side form-state object with missing fields) into a fully-defaulted
 * `ProviderLeaveProfile`. Centralizes default application so callers can rely
 * on every field being defined.
 */
export function withProfileDefaults(
  profile: Partial<ProviderLeaveProfile>,
): ProviderLeaveProfile {
  return {
    provider_id: profile.provider_id,
    pto_weeks: profile.pto_weeks ?? DEFAULT_PTO_WEEKS,
    sick_days_per_year: profile.sick_days_per_year ?? DEFAULT_SICK_DAYS_PER_YEAR,
    maternity_eligible: profile.maternity_eligible ?? false,
    fmla_eligible: profile.fmla_eligible ?? false,
    cme_days_per_year: profile.cme_days_per_year ?? DEFAULT_CME_DAYS_PER_YEAR,
    backup_call_share_target: profile.backup_call_share_target ?? null,
    max_consecutive_post_call_days:
      profile.max_consecutive_post_call_days ?? DEFAULT_MAX_CONSECUTIVE_POST_CALL_DAYS,
  };
}

/**
 * Derive an annual-availability summary from a leave profile + working-day
 * calendar. Pure function; no randomness — used as the deterministic baseline
 * (expected values). The Monte Carlo simulator (A7) is expected to draw around
 * these means; the worst-case path (PRD §10) is expected to inflate them.
 *
 * Math:
 *   - PTO days     = pto_weeks × 5 working days/week
 *   - Sick days    = sick_days_per_year (already expressed in working days)
 *   - FMLA days    = fmla_eligible
 *                      ? DEFAULT_ANNUAL_FMLA_PROBABILITY × DEFAULT_FMLA_EVENT_DAYS
 *                      : 0
 *   - CME days     = cme_days_per_year
 *   - Available    = max(0, totalWorkingDays − PTO − sick − FMLA − CME)
 *
 * Maternity is intentionally NOT subtracted here — it is a worst-case hold-out
 * applied to exactly ONE provider per year (PRD §10), not a per-provider
 * expectation. A7 handles that selection.
 */
export function deriveAnnualAvailability(
  profile: Partial<ProviderLeaveProfile>,
  calendar: AnnualCalendar,
): AnnualAvailabilitySummary {
  const p = withProfileDefaults(profile);

  const expectedPTODays = p.pto_weeks * WORK_DAYS_PER_PTO_WEEK;
  const expectedSickDays = p.sick_days_per_year;
  const expectedFMLADays = p.fmla_eligible
    ? DEFAULT_ANNUAL_FMLA_PROBABILITY * DEFAULT_FMLA_EVENT_DAYS
    : 0;
  const expectedCMEDays = p.cme_days_per_year;

  const consumed =
    expectedPTODays + expectedSickDays + expectedFMLADays + expectedCMEDays;
  const availableDays = Math.max(0, calendar.totalWorkingDays - consumed);

  return {
    availableDays,
    expectedSickDays,
    expectedPTODays,
    expectedFMLADays,
    expectedCMEDays,
  };
}
