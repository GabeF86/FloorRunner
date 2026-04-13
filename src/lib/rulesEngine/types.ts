// Types for the scheduling rules engine.
//
// An evaluator inspects a single (slot, provider) assignment and returns
// any violations of active rules. Each evaluator handles one rule category.

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
  | 'cross_site';

export type ProviderGroup = 'physician' | 'crna' | 'both';

export type DayType =
  | 'weekday'
  | 'friday'
  | 'saturday'
  | 'sunday'
  | 'federal_holiday'
  | 'major_holiday';

export interface RuleDefinition {
  id: string;
  rule_set_id: string;
  rule_name: string;
  rule_category: RuleCategory;
  hard_constraint: boolean;
  priority_rank: number;
  applies_to_provider_group: ProviderGroup;
  applies_to_shift_types: string[] | null;
  applies_to_day_types: string[] | null;
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
  explanation_text: string | null;
  is_active: boolean;
}

export interface ShiftTypeRow {
  id: string;
  site_id: string;
  code: string;
  name: string;
  category: 'call' | 'regular' | 'float' | 'admin' | 'unavailable' | 'leave';
  requires_credential: string | null;
  requires_specific_skills: string[];
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

  // Provider's other assignments in a ±14 day window around the slot
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

  // Active rules for this site
  rules: RuleDefinition[];

  // Lookup helpers built once per context
  shiftTypesByCode: Map<string, ShiftTypeRow>;
  shiftTypesById: Map<string, ShiftTypeRow>;
}

export type ViolationSeverity = 'hard' | 'soft';

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
