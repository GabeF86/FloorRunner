// Shared types for the call-schedule generation pipeline.
// Lifted from the interfaces formerly inline in autoGenerate.ts.
import type { CallPatternDoc } from './callPattern';
import type { WorkDayBudget } from './workDays';
import type { ProviderLimits } from '@/lib/providerLimits';

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
  // ICU rotation rows are availability_type 'blocked' with a reason_code
  // ('icu_week' / 'icu_post_call'); the working-days model credits them as
  // worked (creditsAsWorkedAvailability). Optional so bare fixtures stay small.
  reason_code?: string | null;
}

// Pre-existing assignment carried into solve to seed runtime state.
export interface SeedAssignment {
  slot_date: string;
  provider_id: string;
  shift_type_code: string;
  shift_type_category: string;
  derived_day_type: string;
  // ── seed-eviction provenance (2026-07-21, the Hussain 9/30 bug) ──
  // The fields the eviction gates + commitPlan need to safely evict a STALE
  // auto-generated pre-fill seed (preFillEviction.ts). genContext stamps all
  // four; OPTIONAL so bare/parity fixtures stay small — a seed missing any of
  // them is conservatively NEVER evicted.
  slot_id?: string;
  assignment_id?: string;
  source_type?: string;
  schedule_version_id?: string;
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
  // ── call splits (2026-07-22, patch35) ──
  // manual_only: the engine NEVER places this type (segments live here —
  // genContext excludes manual-only call slots from slotsToFill).
  // call_burden_weight: fractional call credit (12h segment = 0.5, 8h =
  // 0.3333; whole calls 1). parent_call_code: segment → parent grouping key
  // (buckets/caps/obligations fold segments under it) — null for whole calls.
  // Loads degrade to (false, 1, null) pre-patch35 — byte-identical behavior.
  manual_only: boolean;
  call_burden_weight: number;
  parent_call_code: string | null;
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
  // OPEN call-category slots whose shift type is manual_only (call-split
  // segments, 2026-07-22): excluded from slotsToFill — the engine never
  // places them — but still call load the obligation census must count at
  // weight. Optional: absent (bare fixtures, pre-patch35) means none.
  manualCallSlots?: SlotToFill[];
  // ── v2 pattern-interpreter inputs (all optional; solve falls back to
  //    CLASSIC_PATTERN + code-derived shift info when absent) ──
  callPattern?: CallPatternDoc;
  shiftTypes?: Map<string, ShiftTypeInfo>;   // by code
  warnings?: string[];                        // load-time warnings (pattern codes, quota math)
  // ── precomputed invariants (all optional; solve computes locally when
  //    absent so bare fixtures keep working) ──
  providerById?: Map<string, CandidateProvider>;
  prePtoByThursday?: Map<string, Set<string>>; // Thursday-of-prior-week -> pids on blocking leave (pending included, §6.7)
  scheduleDates?: string[];                    // sorted slotIndex date keys
  // ── FTE working-days budget (2026-07-17; OPT-IN enforcement) ──
  // Present on production ctx (genContext always computes it); ABSENT on bare
  // fixtures, parity fixtures, and solveLegacy comparisons so the workdays cap
  // never fires there — the no-budget path is byte-identical to the pre-change
  // engine (fillAllPlan.golden.json pin). When present, every placement engine
  // enforces the per-provider `required` cap on WEEKDAY placements.
  workDayBudget?: WorkDayBudget;
  // ── Per-provider block limits (2026-07-22, patch34; OPT-IN like the budget) ──
  // Parsed schedules.provider_limits for the parent schedule. ABSENT (absent
  // column, no row, blank/{}) ⇒ zero behavior change — byte-identical plans
  // (blank-fallback pin in providerLimitCaps.test.ts). When present:
  //   • calls caps are hard per-code ceilings for auto-generation
  //     (solve/providerCaps; seeds count; whole-block admission at anchors);
  //   • workingDays/daysOff override the provider's workDayBudget.required
  //     (requiredWorkDaysWithLimit, workDays.ts — applied at genContext build).
  providerLimits?: ProviderLimits;
}

// WorkDayBudget / ProviderWorkDayBudget live beside their arithmetic in
// workDays.ts (2026-07-20 decomposition) and are RE-EXPORTED here so existing
// imports — test files included — stay unchanged.
export type { WorkDayBudget, ProviderWorkDayBudget } from './workDays';

// 'call' = the full set; 'call-no-quota' = every call gate EXCEPT the bucket
// quota — and it also WAIVES the FTE workdays cap (eligibility applies the cap
// on 'call' | 'derived' only; quota relaxation re-applies it manually in
// solve() so a cap-bound slot still stays open). FOUR consumers: IF-3 quota
// relaxation (solve's relaxSweep), block-chain call links (solve's
// applyBlockChains — a structural same-provider obligation whose anchor was
// already fairness-scored), the optimizer's eligibility pre-gate
// (optimize's gatePasses), and override pin re-validation (solve's
// overrideFor). Waiving may cover the quota + cap, never a safety gate.
// 'derived' = structural placements (drops quota + the post-call guard, keeps
// every safety gate and the workdays cap).
export type GateSet = 'call' | 'call-no-quota' | 'derived';

export type RejectionReason =
  | 'group-mismatch'
  | 'same-date'
  | 'cross-site'
  | 'weekday-unavailable'
  | 'post-call-guard'
  | 'bucket-quota'
  | 'credential'
  | 'weekend-adjacent-pto'
  | 'availability-blocked'
  // 2026-07-17, obligatory fill mode only: the provider passed every gate but
  // has no cap-room left under their rounded TOTAL obligation (or not enough
  // room for a whole chain block / span). Never emitted in fill-all mode.
  | 'obligation-cap'
  // 2026-07-17, FTE working-days cap: the provider passed every safety gate but
  // has already been credited their `required` working days for the block, so a
  // further WEEKDAY placement is refused. Additive; only emitted when ctx
  // carries a workDayBudget (production). Never overrides a safety gate.
  | 'workdays-cap'
  // 2026-07-22, provider_limits call caps: the provider passed every gate but
  // placing this slot (or its whole designed block, at a chain anchor) would
  // exceed their STATED per-code call maximum. Additive; only emitted when
  // ctx.providerLimits states call caps. A slot nobody can take under caps
  // stays OPEN with this reason — never silently reassigned past a stated max.
  | 'provider-cap';

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
  | 'span'            // v2: multi-day same-provider obligation (CallPatternDoc spans)
  | 'day-mop-up';     // 2026-07-16: orphaned call-engine day slot (trigger call unfilled/severed)

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
  // Optional so the FROZEN solveLegacy.ts (and bare test-plan literals) keep
  // compiling; the v2 solve() stamps it on every unfilled entry so consumers
  // (e.g. optimize's eviction move set) never need a call-code list.
  shift_type_category?: string;
  reason: string;
  candidates?: CandidateRejection[];      // per-provider "why not"
}

// A derived (D-chain / span) placement that was suppressed, recorded so the
// mandated D1-skip tracking is never silently dropped (clinical invariant 4).
export interface SkippedDerived {
  date: string;
  code: string;
  provider_id: string;
  // 'overridden' (2026-07-16): a callOverrides pin severed a chain pairing
  // whose designed partner had NO hard block — recorded so the severance
  // stays observable even when the pinned provider fills the slot.
  // 'obligation-cap' (2026-07-24): obligatory mode refused a CALL-category
  // link fill that would land past the provider's obligation (a nested call
  // link no admission gate could reserve, or an unreserved at-cap link pin)
  // — recorded, never silently placed past the cap.
  reason: 'pto' | 'cross-site' | 'occupied' | 'no-slot' | 'ineligible' | 'already-handled'
    | 'overridden' | 'obligation-cap';
}

// A stale auto-generated pre-fill SEED evicted in-plan by a positive-offset
// dayChain link fill for the same provider (2026-07-21, the Hussain 9/30 bug;
// Gabriel's D1-overrides-pre-call rule). Recorded on the plan — never silent
// (invariant-4 spirit) — and EXECUTED by commitPlan (seed row reverted to
// open BEFORE the fill writes land). The vacated slot has no valid person
// (its designated person is consumed by the post-call override): it stays
// OPEN — sequence ownership keeps it out of mop-up/relief inventory — and
// this record is its report.
export interface EvictedSeed {
  date: string;            // the seed's (and the incoming fill's) date
  code: string;            // the evicted pre-fill's shift code (e.g. D3)
  provider_id: string;
  provider_name: string;
  slot_id: string;         // the vacated slot — stays open
  assignment_id: string;   // the row commitPlan reverts to open
  trigger_date: string;    // the realized call that fired the +offset link
  trigger_code: string;
}

// A call slot the weekend-only main loop deliberately did NOT attempt (out of
// weekend scope: not saturday/sunday/friday). NOT a failure — the staged
// Continue run ('all') attempts it. See FillMode 'weekend-only'.
export interface AwaitingContinueSlot {
  slot_id: string;
  slot_date: string;
  shift_type_code: string;
  derived_day_type: string;
}

export interface SolutionPlan {
  assignments: PlannedAssignment[];
  unfilled: UnfilledSlot[];
  // OPTIONAL so the FROZEN solveLegacy.ts (and bare test-plan literals) keep
  // compiling; the v2 solve() always populates it.
  skippedDerived?: SkippedDerived[];
  // Slot ids whose placement triggered pattern block-chain links (the CHAIN
  // ANCHORS — e.g. weekend-v2's Friday C1 that chains Sun C2). Recorded by
  // applyBlockChains, pattern-data-driven. The optimizer must never move an
  // anchor: its chain partner is pinned separately, so moving the anchor
  // severs the designed same-provider pairing (2026-07-16 PROOF defect 2).
  // OPTIONAL for the same frozen-solveLegacy reason as skippedDerived.
  chainAnchorSlotIds?: string[];
  // Present ONLY in weekend-only mode (always, even when empty): out-of-scope
  // call slots the main loop skipped, in slotsToFill order. Kept absent in
  // 'all'/'obligatory' so the fillAllPlan.golden.json JSON pin is untouched.
  awaitingContinue?: AwaitingContinueSlot[];
  // Stale pre-fill seeds evicted in-plan (see EvictedSeed). LAZILY
  // materialized — absent unless an eviction actually happened, so seed-free
  // generations (the golden JSON pins included) are byte-identical.
  evictions?: EvictedSeed[];
  // Request advisories (2026-07-22): contradictory call+no-call requests on
  // one date (treated as neither). LAZILY materialized like evictions —
  // absent unless a contradiction exists, so request-free generations (the
  // golden JSON pins included) are byte-identical. Surfaced into
  // GenerationResult.warnings by autoGenerate.
  requestWarnings?: string[];
}

// SolveState + emptySolveState live in solveState.ts (2026-07-20 solve
// decomposition, alongside the pure state mutators) and are RE-EXPORTED here
// so existing imports — test files included — stay unchanged.
export type { SolveState } from './solveState';
export { emptySolveState } from './solveState';

// Generation fill mode (2026-07-17). 'all' (default) fills every fillable
// call slot — the pre-change engine byte for byte. 'obligatory' caps each
// provider at their rounded TOTAL obligation (computeObligations in
// obligation.ts): chain blocks are charged against the cap upfront, the
// quota-relaxation sweep never runs, and remaining call slots are left open
// with reason 'obligation-cap'. Non-call placements are never capped; the
// day-shift engine is unaffected.
//
// 'weekend-only' (2026-07-21, staged weekend fill): the main loop attempts
// ONLY call slots whose derived_day_type is saturday/sunday/friday (holiday
// day types are OUT — Continue handles them); block/day chains fire normally
// from those placements and land wherever the pattern points (Monday D1,
// Friday D2/D4, post-call blocks) — never scope-clipped. Skipped: the pre-PTO
// pass (weekday-targeted), relief, mop-up (autoGenerate also skips the
// optimizer, and the generate route skips the day-shift engine). Out-of-scope
// call slots are counted in plan.awaitingContinue, NOT reported unfilled.
// Quota/scoring semantics are the SAME as 'all' (relaxation enabled, no
// obligation caps — modes do not compose in v1). The staged Continue is just
// a second generation with fillMode 'all' over the committed weekend
// placements as seeds.
export type FillMode = 'all' | 'obligatory' | 'weekend-only';

// Options for solve(). callOverrides forces a provider onto a CALL slot (by
// slot_id -> provider_id) when that provider passes the 'call-no-quota' gate
// (a pin re-asserts an ALREADY-MADE placement — quota-relaxed ones included —
// so re-checking the quota would self-reject it; see solve's overrideFor);
// used by the local-search optimizer to re-solve a perturbed call assignment.
// fillMode: see FillMode. autoGenerate never optimizes obligatory plans, so
// callOverrides and 'obligatory' don't combine on the production path — but
// when a caller DOES combine them (optimize() invoked directly with
// fillMode 'obligatory'), the obligation cap wins over the pin (2026-07-24,
// Gabriel: the engine must never auto-place past the cap on ANY path; the
// refused slot stays open, reported 'obligation-cap').
export interface SolveOptions {
  callOverrides?: Map<string, string>;
  fillMode?: FillMode;
}
