// Types for the scheduling validation engine.
//
// An evaluator inspects a single (slot, provider) assignment and returns any
// violations it finds. Each evaluator handles one category. Every evaluator is
// always-on: the configurable rule_definitions/rule_sets feature was removed
// (all definitions were inactive and nothing loaded them), so there is no
// longer any per-site rule data threaded through this context.

import type { ProviderLimits } from '@/lib/providerLimits';
import type { ScenarioProvider } from './scenario';

// The category stamped on a stored violation. 'sequence', 'rest', 'pairing'
// and 'fairness' are LEGACY-ONLY: no evaluator produces them any more, but
// assignments.validation_flags rows written before the rule feature was
// removed still carry them, so they stay in the union that those rows parse
// against.
export type RuleCategory =
  | 'coverage'
  | 'sequence'
  | 'eligibility'
  | 'frequency'
  | 'rest'
  | 'pairing'
  | 'fairness'
  | 'open_slot'
  | 'time_off'
  | 'cross_site'
  // Sentinel-only category for engine-generated flags (e.g. the
  // 'validation unavailable' marker).
  | 'system';

export type ProviderGroup = 'physician' | 'crna' | 'both';

export type DayType =
  | 'weekday'
  | 'friday'
  | 'saturday'
  | 'sunday'
  | 'federal_holiday'
  | 'major_holiday';

export interface ShiftTypeRow {
  id: string;
  site_id: string;
  code: string;
  name: string;
  category: 'call' | 'regular' | 'float' | 'admin' | 'unavailable' | 'leave';
  requires_credential: string | null;
  requires_specific_skills: string[];
  /**
   * Ordering within a day's call: 0 is first call, 1 second, and so on. The
   * backup check reads it to find "the next call down" without naming codes.
   */
  call_rank?: number | null;
  /** True when this call must have the next-ranked call filled beside it. */
  requires_backup_pairing?: boolean | null;
  // Which generation engine owns this shift type: 'call' (chains/relief D-codes),
  // 'day_pool' (7-3/7-5 day-doc slots), 'none', or null when unknown/pre-patch18.
  // Read-only for validation — the poolEligibility evaluator keys on it.
  generation_engine: string | null;
  // Call-split columns (2026-07-22, patch35), optional — absent pre-patch35 /
  // on older loads means weight 1 / parent = own code (callBurden.ts
  // defaults). The providerLimits evaluator folds segment assignments under
  // the PARENT code at their fractional weight.
  call_burden_weight?: number | null;
  parent_call_code?: string | null;
}

export interface SlotRow {
  id: string;
  site_id: string;
  slot_date: string; // ISO date
  shift_type_id: string;
  provider_group: ProviderGroup;
  derived_day_type: DayType | null;
}

export interface AssignmentRow {
  id: string;
  schedule_slot_id: string;
  provider_id: string | null;
  assignment_status: string;
  // joined slot fields:
  slot?: SlotRow;
}

export interface ProviderSiteCredentials {
  provider_id: string;
  site_id: string;
  is_active: boolean;
  credentialed: boolean;
  can_take_call: boolean;
  can_take_weekend_call: boolean;
  can_take_holiday_call: boolean;
  can_take_backup_call: boolean;
  allowed_shift_types: string[];
  excluded_shift_types: string[];
  skill_tags: string[];
}

export interface AvailabilityRow {
  id: string;
  provider_id: string;
  availability_type: string;
  start_date: string;
  end_date: string;
  approval_status: string;
}

/**
 * Snapshot of all data an evaluator might need to validate one assignment.
 * Loaded once per evaluation by loadContext().
 */
export interface EvaluationContext {
  // The slot under evaluation
  slot: SlotRow;
  shiftType: ShiftTypeRow;

  // The provider being assigned (null = open slot, skip provider-specific checks)
  providerId: string | null;
  providerGroup: ProviderGroup | null;
  credentials: ProviderSiteCredentials | null;
  // Provider FTE (provider_employment_profiles.fte_value); null when unknown.
  // Fairness thresholds scale by this so part-timers flag at a lower burden.
  fte_value: number | null;

  // Employment-profile pool flags (null = no profile row — treat as
  // ineligible for both pools, never silently pass; invariant 6 spirit).
  poolFlags: { call_taker: boolean; partial_call_taker: boolean; is_day_doc: boolean } | null;

  // Provider's other assignments in a ±NEIGHBOR_WINDOW_DAYS (31d) window
  // around the slot, scoped to the slot's schedule version + site
  // (each row carries its joined slot+shift_type for date/code lookups)
  neighborAssignments: Array<{
    assignment_id: string;
    slot_date: string;
    shift_type_code: string;
    shift_type_category: string;
    day_type: DayType | null;
  }>;

  // PTO / unavailability rows overlapping the window
  availability: AvailabilityRow[];

  // All assignments for the same slot_date in the same schedule version
  // (needed for coverage and pairing evaluators — how many providers are
  // filling each shift type on this day?)
  sameDayAssignments: Array<{
    slot_id: string;
    slot_date: string;
    shift_type_code: string;
    shift_type_category: string;
    provider_id: string | null;
    required_count: number;
  }>;

  // Assignments for this provider across ALL sites on the same day
  // (needed for cross-site evaluator — detect double-booking across sites)
  crossSiteAssignments: Array<{
    assignment_id: string;
    site_id: string;
    slot_date: string;
    shift_type_code: string;
  }>;

  // Schedule version ID (for looking up related slots)
  scheduleVersionId: string | null;

  // Provider-limits validation context (2026-07-22, patch34) — resolved at
  // LOAD time by loadProviderLimitsValidationCtx (loadContext.ts) and threaded
  // by BOTH the serial path and batchValidate (kept in parity). Absent/null =
  // feature off (pre-patch34 column, no limits stated, or a degraded load) —
  // the providerLimits evaluator is then inert. Soft flags ONLY.
  providerLimitsCtx?: {
    limits: ProviderLimits;                       // parent schedule's stated limits
    blockStart: string;                           // schedules.date_start
    blockEnd: string;                             // schedules.date_end
    workingDaySet: ReadonlySet<string>;           // block weekdays minus major holidays
    // Resolved stated working-days caps (workingDays as entered; daysOff
    // re-derived as WD − ptoWeekdays − daysOff at load time). Only providers
    // with a stated day limit appear.
    workingDaysCapByProvider: ReadonlyMap<string, number>;
  } | null;

  // Scenario-manifest validation context (2026-07-26, patch37) — resolved at
  // LOAD time by loadScenarioValidationCtx (loadContext.ts) and threaded by
  // BOTH the serial path and batchValidate (kept in parity). Absent/null =
  // feature off (pre-patch37 column, no manifest, or a degraded load) — the
  // scenarioProhibition evaluator is then inert. SOFT flags only: a
  // seeded/manual fixed assignment standing against a manifest prohibition
  // is the import's documented mandatory-retained resolution, flagged so the
  // conflict stays visible, never blocked.
  scenarioCtx?: {
    providers: ReadonlyMap<string, ScenarioProvider>;
    neuroCode: string;
  } | null;

  // Lookup helpers built once per context
  shiftTypesByCode: Map<string, ShiftTypeRow>;
  shiftTypesById: Map<string, ShiftTypeRow>;
}

// 'warning' = advisory only (e.g. unknown rule vocabulary) — surfaces in the
// flag list but is counted in neither hardCount nor softCount.
export type ViolationSeverity = 'hard' | 'soft' | 'warning';

export interface RuleViolation {
  rule_id: string | null; // null for implicit checks (e.g. credentialing)
  rule_name: string;
  category: RuleCategory;
  severity: ViolationSeverity;
  message: string;
  // Optional details for UI / debugging
  details?: Record<string, unknown>;
}

export type Evaluator = (ctx: EvaluationContext) => RuleViolation[];
