// Shared types for the call-schedule generation pipeline.
// Lifted from the interfaces formerly inline in autoGenerate.ts.
import type { CallPatternDoc } from './callPattern';

export interface SlotToFill {
  slot_id: string;
  slot_date: string;
  shift_type_id: string;
  shift_type_code: string;
  shift_type_category: string;
  derived_day_type: string;
  provider_group: 'physician' | 'crna' | 'both';
  required_count: number;
  existing_assignment_id: string | null;
}

export interface CandidateProvider {
  id: string;
  provider_type: string;
  short_display_name: string;
  fte_value: number;
  home_site_id: string | null;
  // 7 booleans indexed Sun..Sat (matches JS Date.getDay).
  available_weekdays: boolean[];
}

export interface SiteCredentials {
  is_active: boolean;
  credentialed: boolean;
  can_take_call: boolean;
  can_take_weekend_call: boolean;
  can_take_holiday_call: boolean;
  allowed_shift_types: string[];
  excluded_shift_types: string[];
  skill_tags: string[];
}

export interface AvailabilityEntry {
  availability_type: string;
  start_date: string;
  end_date: string;
  approval_status: string;
}

// Pre-existing assignment carried into solve to seed runtime state.
export interface SeedAssignment {
  slot_date: string;
  provider_id: string;
  shift_type_code: string;
  shift_type_category: string;
  derived_day_type: string;
}

// Per-code shift-type metadata that drives generation behavior. Loaded from
// scheduling.shift_types (call_rank/relief_rank/is_overlay/generation_engine +
// the post-call flag). Optional on GenerationContext: when absent, solve()
// falls back to code-derived defaults so pure fixtures stay small.
export interface ShiftTypeInfo {
  code: string;
  category: string;
  call_rank: number | null;
  relief_rank: number | null;
  is_overlay: boolean;
  generation_engine: 'call' | 'day_pool' | 'none';
  requires_post_call_rule: boolean;
  call_coverage_type: string | null;
}

// Immutable input to solve(). All reads have already happened.
export interface GenerationContext {
  scheduleVersionId: string;
  siteId: string;
  parLevel: number;
  // Call-category open slots to fill, pre-sorted in the structural order.
  slotsToFill: SlotToFill[];
  // Every OPEN slot indexed [date][code] — for weekend/D-chain lookups.
  slotIndex: Map<string, Map<string, SlotToFill>>;
  providers: CandidateProvider[];
  credByPid: Map<string, SiteCredentials>;
  availByPid: Map<string, AvailabilityEntry[]>;
  // pid -> set of dates the provider is already booked at ANOTHER site.
  crossSiteByDate: Map<string, Set<string>>;
  // pid -> "bucket|code" -> count, from past blocks at this site.
  historicalAssignedByPid: Map<string, Map<string, number>>;
  // "bucket|code" -> total historical count across all providers.
  historicalTotalByBucket: Map<string, number>;
  // "bucket|code" -> total slots in THIS block (open + already-assigned).
  bucketTotals: Map<string, number>;
  // "pid|bucket|code" -> FTE-weighted target (base + deficit).
  bucketTarget: Map<string, number>;
  // Assignments already present before generation (manual/prior runs).
  seedAssignments: SeedAssignment[];
  // ── v2 pattern-interpreter inputs (all optional; solve falls back to
  //    CLASSIC_PATTERN + code-derived shift info when absent) ──
  callPattern?: CallPatternDoc;
  shiftTypes?: Map<string, ShiftTypeInfo>;   // by code
  warnings?: string[];                        // load-time warnings (pattern codes, quota math)
}

export type GateSet = 'call' | 'derived';

export type RejectionReason =
  | 'group-mismatch'
  | 'same-date'
  | 'cross-site'
  | 'weekday-unavailable'
  | 'post-call-guard'
  | 'bucket-quota'
  | 'credential'
  | 'weekend-adjacent-pto'
  | 'availability-blocked';

export interface EligibilityResult {
  readonly eligible: boolean;
  readonly reason?: RejectionReason;
}

// Source of a planned assignment (for debugging / future explainability).
export type PlacementSource =
  | 'main-loop'
  | 'pre-pto-thursday'
  | 'd-chain'
  | 'weekend-chain'
  | 'relief-order'
  | 'quota-relaxed'   // v2: filled despite bucket quota (all candidates quota-blocked)
  | 'span';           // v2: multi-day same-provider obligation (CallPatternDoc spans)

// Richer "why this assignment" detail, captured at decision time. The
// PlacementSource (main-loop / d-chain / weekend-chain / …) stays on
// PlannedAssignment.source; this holds the numeric detail that only the
// main-loop scoring path has.
export interface AssignmentExplanation {
  ratioAtAssignment?: number;       // lifetime bucket-ratio of the chosen provider
  daysSinceLastCall?: number | null; // null when they had no prior call (was Infinity)
  competingCandidates?: number;      // how many providers were eligible for this slot
}

// One provider's reason for being ineligible for a slot that ended up unfilled.
export interface CandidateRejection {
  provider_id: string;
  provider_name: string;
  reason: RejectionReason;
}

// Quantified quality of a SolutionPlan. The objective Phase 2b minimizes.
export interface SolutionMetrics {
  filled: number;          // assignments made
  skipped: number;         // call slots left unfilled
  fairnessStdev: number;   // population stdev of per-provider call ratio (load / fte)
  burnout: number;         // count of too-tight call spacings (see metrics.ts)
  providersUsed: number;   // distinct providers who received >= 1 call this block
}

export interface PlannedAssignment {
  slot_id: string;
  slot_date: string;
  shift_type_code: string;
  shift_type_category: string;
  derived_day_type: string;
  provider_id: string;
  provider_name: string;
  existing_assignment_id: string | null;
  source: PlacementSource;
  explanation?: AssignmentExplanation;   // main-loop populates; structural omits
}

export interface UnfilledSlot {
  slot_id: string;
  slot_date: string;
  shift_type_code: string;
  reason: string;
  candidates?: CandidateRejection[];      // per-provider "why not"
}

// A derived (D-chain / span) placement that was suppressed, recorded so the
// mandated D1-skip tracking is never silently dropped (clinical invariant 4).
export interface SkippedDerived {
  date: string;
  code: string;
  provider_id: string;
  reason: 'pto' | 'cross-site' | 'occupied' | 'no-slot' | 'ineligible' | 'already-handled';
}

export interface SolutionPlan {
  assignments: PlannedAssignment[];
  unfilled: UnfilledSlot[];
  // OPTIONAL so the FROZEN solveLegacy.ts (and bare test-plan literals) keep
  // compiling; the v2 solve() always populates it.
  skippedDerived?: SkippedDerived[];
}

// Mutable in-memory bookkeeping during solve. Never touches I/O.
export interface SolveState {
  bucketAssigned: Map<string, number>;       // "pid|bucket|code" -> count
  assignedOnDate: Map<string, Set<string>>;  // date -> set of pids
  handledSlotIds: Set<string>;
  callDatesByProvider: Map<string, string[]>; // pid -> sorted call dates
}

export function emptySolveState(): SolveState {
  return {
    bucketAssigned: new Map(),
    assignedOnDate: new Map(),
    handledSlotIds: new Set(),
    callDatesByProvider: new Map(),
  };
}

// Options for solve(). callOverrides forces a provider onto a CALL slot (by
// slot_id -> provider_id) when that provider passes the canonical 'call' gate;
// used by the local-search optimizer to re-solve a perturbed call assignment.
export interface SolveOptions {
  callOverrides?: Map<string, string>;
}
