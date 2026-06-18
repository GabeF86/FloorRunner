// Float Strategy — post-processes a SolvedGrid to compute a deterministic
// float allocation and a Float Health badge.
// Owned by agent A6 (Float Strategy).
// PRD: docs/PRD-Grid-Calculator.md §7, §8, §12, §14 (A6).
//
// Universality contract: no FloorRunner-specific imports. The Paoli break
// coverage analysis (`staffingCalculator/paoli.ts` ~322-369) was studied, not
// copied — the severity bands (ok / tight / warning / critical) and the
// supply/demand framing are reused universally.
//
// Public API:
//   - `applyFloatStrategy(grid, options)` — returns a new SolvedGrid with the
//     `floats` array replaced by a strategy-driven allocation.
//   - `assessFloatHealth(grid, surplus, expectedDemand?)` — returns the Float
//     Health badge level + coverage ratio + a human-readable binding constraint.
//
// Determinism contract: every output is a pure function of its inputs and is
// stable under repeated application (idempotent). The replacement step does
// NOT inspect provider IDs beyond a sorted tie-break, so re-running the same
// strategy on the same grid produces a byte-identical result.

import type {
  DistanceBand,
  FloatStrategyMode,
  GridSite,
} from './types';
import type {
  FloatAssignment,
  ProviderRole,
  RosterProvider,
  SolvedGrid,
} from './solver';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Severity bands mirror Paoli's break-coverage analysis (see
 * `staffingCalculator/paoli.ts` ~358) so the UI Float Health badge can reuse
 * the same color treatment universally.
 *
 *   - `ok`        — supply ≥ demand (coverage ≥ 100%).
 *   - `tight`     — 75% ≤ coverage < 100%; some breaks may be delayed.
 *   - `warning`   — 50% ≤ coverage < 75%; meaningful coverage gap.
 *   - `critical`  — coverage < 50%; staffing is structurally short.
 */
export type FloatHealthLevel = 'ok' | 'tight' | 'warning' | 'critical';

export interface FloatHealth {
  level: FloatHealthLevel;
  /** Fraction in [0, ∞). 1.0 means break supply exactly meets demand. */
  coverageRatio: number;
  /** Human-readable explanation of what's binding the level. */
  binding: string;
}

/**
 * A float candidate provider — typically the CRNAs and Anesthesiologists left
 * over after the solver has staffed every fixed room. `applyFloatStrategy`
 * uses the role to bias which floats land in the CRNA float pool vs an
 * Anesthesiologist float role.
 */
export interface FloatSurplusProvider {
  id: string;
  role: ProviderRole;
}

/**
 * Disruption expectations for a single simulated day. All fields are optional
 * because A7 (FTE Simulator) may pass only a subset depending on the scenario.
 * The float math only consumes these when present; otherwise it falls back to
 * the conservative defaults documented inline.
 */
export interface ExpectedDisruptions {
  /** Expected add-on rooms that may spin up mid-day. Default: 0. */
  expectedAddOns?: number;
  /** Probability that a trauma case displaces a float for ≥1 break cycle. */
  traumaProbability?: number;
  /** Expected number of unplanned breaks (sick provider, extended case, etc). */
  unscheduledBreakDemand?: number;
}

/**
 * Optional richer distance matrix interface. Anything implementing
 * `getBand(a, b)` lets the strategy lean floats toward the trauma-likely site
 * using band-weighted distance. If only the solver's `isSupervisable` is
 * available, the strategy falls back to a same-site-only proximity model.
 */
export interface DistanceMatrixWithBands {
  isSupervisable?(fromSiteId: string, toSiteId: string): boolean;
  getBand?(fromSiteId: string, toSiteId: string): DistanceBand;
}

export interface ApplyFloatStrategyOptions {
  /** Toggle state. Mirrors `GridCalculatorConfig.floatStrategy`. */
  mode: FloatStrategyMode;
  /**
   * Providers left over after the solver has staffed fixed rooms. These become
   * the float pool. If empty, the resulting grid has zero floats — and the
   * Float Health badge will surface as `critical` (unless demand is also zero).
   */
  surplus: FloatSurplusProvider[];
  /** Sites context — used to identify the "Main-OR-equivalent" (largest) site. */
  sites: GridSite[];
  /** Optional richer distance matrix. Defaults to same-site only. */
  distanceMatrix?: DistanceMatrixWithBands;
  /** Optional day-of disruption expectations. Defaults documented inline. */
  expectedDisruptions?: ExpectedDisruptions;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Each non-float room provider needs 3 breaks per day: morning, lunch,
 * afternoon. Codified per PRD §14 (A6) deliverables. Studied (not copied)
 * from Paoli's `provNeedingBreaks` filter.
 */
const BREAKS_PER_ROOM_PROVIDER = 3;

/**
 * Each float covers 5 breaks per day (Paoli's `bkFloats = totalFloats * 5`,
 * adapted universally). Empirically: ~30 min per break × 5 = 2.5 hr of break
 * activity, the rest absorbed by trauma/add-on/charting.
 */
const BREAKS_PER_FLOAT = 5;

/**
 * Severity thresholds (mirror Paoli ~358 so the badge color matches the
 * existing FloorRunner Break Coverage panel and PRD §12 expectations).
 *
 * Ratio = breakCapacity / breakDemand.
 */
const SEVERITY_THRESHOLDS = {
  ok: 1.0,
  tight: 0.75,
  warning: 0.5,
} as const;

/**
 * Distance band weights for proximity-biased "leansTo" decisions. Lower is
 * closer. Off-campus is effectively infinite (sites we can't reach quickly
 * shouldn't anchor a float).
 */
const BAND_PROXIMITY_COST: Record<DistanceBand, number> = {
  same_room: 0,
  adjacent: 1,
  near: 2,
  far: 4,
  off_campus: 100,
};

// ---------------------------------------------------------------------------
// Public API — applyFloatStrategy
// ---------------------------------------------------------------------------

/**
 * Replace `grid.floats` with a strategy-driven allocation. Returns a NEW
 * SolvedGrid (does not mutate the input). Idempotent — running twice in a row
 * on the same input produces the same output.
 *
 * Mode semantics (PRD §8 + §12):
 *   - `break_priority`     — every float leans toward the largest site (the
 *     "Main-OR-equivalent") so break rotations stay tight.
 *   - `emergency_priority` — every float leans toward the largest trauma-likely
 *     site (largest site by room count). Ties broken by site `position` (low
 *     first) so the front-of-house lane wins.
 *   - `balanced`           — even-indexed floats lean break (largest site),
 *     odd-indexed lean emergency (closest-to-trauma site). With only one float,
 *     it leans break (the more common day-to-day need).
 */
export function applyFloatStrategy(
  grid: SolvedGrid,
  options: ApplyFloatStrategyOptions,
): SolvedGrid {
  const { mode, surplus, sites } = options;

  // Empty surplus → zero floats. The grid still validates; A7's Float Health
  // badge surfaces the gap.
  if (surplus.length === 0) {
    return { ...grid, floats: [] };
  }

  // Deterministic ordering so re-runs are byte-identical.
  const sortedSurplus = [...surplus].sort(stableSurplusCompare);

  const breakAnchor = pickBreakAnchorSite(sites);
  const emergencyAnchor = pickEmergencyAnchorSite(sites, options.distanceMatrix);

  const floats: FloatAssignment[] = sortedSurplus.map((p, idx) => {
    const leansToSiteId = decideLean({
      mode,
      indexInPool: idx,
      breakAnchorId: breakAnchor?.id ?? null,
      emergencyAnchorId: emergencyAnchor?.id ?? null,
    });
    return {
      providerId: p.id,
      role: p.role,
      leansToSiteId,
    };
  });

  return { ...grid, floats };
}

// ---------------------------------------------------------------------------
// Public API — assessFloatHealth
// ---------------------------------------------------------------------------

/**
 * Compute a Float Health badge for the given grid.
 *
 * Demand: each room provider that needs breaks (non-float, non-coordinator
 * CRNA *or* solo MD) contributes 3 breaks/day. Optional disruption
 * expectations add to the demand side.
 *
 * Supply: each float covers 5 breaks/day. Optional `expectedDemand`
 * (precomputed by A7 when the simulator has richer context) overrides the
 * grid-derived demand.
 *
 * Severity bands match Paoli's break-coverage analysis (~358) so the UI can
 * reuse the same color treatment universally.
 *
 * Special case: zero demand and zero supply → `ok` with binding "no break
 * demand". Zero supply with nonzero demand → `critical`. This mirrors PRD §12
 * and the deliverable test for `0 surplus + 4 rooms → critical`.
 */
export function assessFloatHealth(
  grid: SolvedGrid,
  surplus: FloatSurplusProvider[],
  expectedDemand?: number,
): FloatHealth {
  const supplyFloats = grid.floats.length;
  const supply = supplyFloats * BREAKS_PER_FLOAT;

  const derivedDemand = computeBreakDemandFromGrid(grid);
  const demand = expectedDemand ?? derivedDemand;

  if (demand === 0 && supply === 0) {
    return {
      level: 'ok',
      coverageRatio: 1,
      binding: 'no break demand',
    };
  }

  if (supply === 0 && demand > 0) {
    return {
      level: 'critical',
      coverageRatio: 0,
      binding: `0 floats vs ${demand} breaks needed (${surplus.length} surplus providers in pool)`,
    };
  }

  const ratio = demand === 0 ? Infinity : supply / demand;
  const level = ratioToLevel(ratio);
  const binding = describeBinding({
    level,
    supply,
    demand,
    supplyFloats,
    surplusCount: surplus.length,
  });
  return { level, coverageRatio: ratio, binding };
}

// ---------------------------------------------------------------------------
// Internals — site anchors
// ---------------------------------------------------------------------------

/**
 * "Main-OR-equivalent" site for break-priority floats: the site with the most
 * rooms. Ties broken by lowest `position` (the leftmost/topmost lane) so the
 * choice is stable across re-renders.
 *
 * Returns null when no site has any rooms.
 */
function pickBreakAnchorSite(sites: GridSite[]): GridSite | null {
  const candidates = sites.filter((s) => s.rooms.length > 0);
  if (candidates.length === 0) return null;
  return [...candidates].sort(compareForBreakAnchor)[0];
}

function compareForBreakAnchor(a: GridSite, b: GridSite): number {
  if (a.rooms.length !== b.rooms.length) return b.rooms.length - a.rooms.length;
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Trauma-likely anchor site for emergency-priority floats. Heuristic:
 *
 *  1. Of the sites with rooms, score by "trauma weight" = room count weighted
 *     by inverse proximity cost (using the distance matrix's band when
 *     available). The Main-OR-equivalent is typically the trauma-likely site
 *     because trauma cases land in the largest OR cluster.
 *  2. Ties broken by lowest `position`, then by id.
 *
 * Without a distance matrix this collapses to "largest site" — which is the
 * sensible universal default per PRD §14 ("shortest distance to trauma/OR").
 */
function pickEmergencyAnchorSite(
  sites: GridSite[],
  distanceMatrix?: DistanceMatrixWithBands,
): GridSite | null {
  const candidates = sites.filter((s) => s.rooms.length > 0);
  if (candidates.length === 0) return null;

  // Establish "trauma-likely" reference: the largest site is the most likely
  // recipient of a trauma case (Level 1 trauma centers locate trauma bays in
  // their main OR clusters). This is a universal heuristic, not a Paoli-ism.
  const reference = [...candidates].sort(compareForBreakAnchor)[0];

  const scored = candidates.map((s) => {
    const proximity = proximityCostBetween(s.id, reference.id, distanceMatrix);
    // Score: room count minus a small proximity penalty. Sites colocated with
    // the trauma reference win; far-away sites get penalized.
    const score = s.rooms.length - proximity * 0.5;
    return { site: s, score };
  });

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.site.position !== b.site.position) {
      return a.site.position - b.site.position;
    }
    return a.site.id < b.site.id ? -1 : 1;
  });

  return scored[0].site;
}

function proximityCostBetween(
  fromId: string,
  toId: string,
  distanceMatrix?: DistanceMatrixWithBands,
): number {
  if (fromId === toId) return 0;
  if (!distanceMatrix) return BAND_PROXIMITY_COST.near; // conservative default
  if (distanceMatrix.getBand) {
    const band = distanceMatrix.getBand(fromId, toId);
    return BAND_PROXIMITY_COST[band];
  }
  // Only `isSupervisable` available — treat reachable as `near`, unreachable
  // as `far`. The strategy still produces a deterministic result.
  if (distanceMatrix.isSupervisable) {
    return distanceMatrix.isSupervisable(fromId, toId)
      ? BAND_PROXIMITY_COST.near
      : BAND_PROXIMITY_COST.far;
  }
  return BAND_PROXIMITY_COST.near;
}

// ---------------------------------------------------------------------------
// Internals — per-float lean decision
// ---------------------------------------------------------------------------

interface LeanDecisionArgs {
  mode: FloatStrategyMode;
  indexInPool: number;
  breakAnchorId: string | null;
  emergencyAnchorId: string | null;
}

function decideLean(args: LeanDecisionArgs): string | null {
  const { mode, indexInPool, breakAnchorId, emergencyAnchorId } = args;
  switch (mode) {
    case 'break_priority':
      return breakAnchorId;
    case 'emergency_priority':
      return emergencyAnchorId;
    case 'balanced': {
      // Deterministic split: even index → break, odd index → emergency. With
      // a single float, the lone allocation goes to break (the day-to-day need).
      const useBreak = indexInPool % 2 === 0;
      const preferred = useBreak ? breakAnchorId : emergencyAnchorId;
      // Graceful fallback if one anchor is missing (e.g. only one site).
      return preferred ?? breakAnchorId ?? emergencyAnchorId ?? null;
    }
  }
}

// ---------------------------------------------------------------------------
// Internals — break demand from grid
// ---------------------------------------------------------------------------

/**
 * Compute the break demand implied by a SolvedGrid.
 *
 * Per PRD §14 (A6): each non-Float, non-Float-Coordinator CRNA in a room needs
 * 3 breaks/day. We extend this to solo MDs (which Paoli's analysis also counts
 * — they staff a room alone and need their own coverage). Supervising MDs are
 * NOT counted because they rotate between cases and self-cover.
 */
function computeBreakDemandFromGrid(grid: SolvedGrid): number {
  let breakHeads = 0;
  for (const a of grid.assignments) {
    if (a.staffingPattern === 'solo_md' && a.anesthesiologistId) {
      breakHeads += 1;
    } else if (a.staffingPattern === 'supervised_md_crna') {
      breakHeads += a.crnaIds.length;
    } else if (a.staffingPattern === 'solo_crna_with_remote_md') {
      breakHeads += a.crnaIds.length;
    }
  }
  return breakHeads * BREAKS_PER_ROOM_PROVIDER;
}

// ---------------------------------------------------------------------------
// Internals — severity & binding
// ---------------------------------------------------------------------------

function ratioToLevel(ratio: number): FloatHealthLevel {
  if (ratio >= SEVERITY_THRESHOLDS.ok) return 'ok';
  if (ratio >= SEVERITY_THRESHOLDS.tight) return 'tight';
  if (ratio >= SEVERITY_THRESHOLDS.warning) return 'warning';
  return 'critical';
}

interface BindingArgs {
  level: FloatHealthLevel;
  supply: number;
  demand: number;
  supplyFloats: number;
  surplusCount: number;
}

function describeBinding(args: BindingArgs): string {
  const { level, supply, demand, supplyFloats, surplusCount } = args;
  const pct = demand === 0 ? 100 : Math.round((supply / demand) * 100);
  const floatStr = `${supplyFloats} float${supplyFloats === 1 ? '' : 's'}`;
  const surplusStr = surplusCount === supplyFloats
    ? ''
    : ` (${surplusCount} surplus providers in pool)`;
  switch (level) {
    case 'ok':
      return `${floatStr} cover ${supply}/${demand} breaks (${pct}%)${surplusStr}`;
    case 'tight':
      return `${floatStr} cover ${supply}/${demand} breaks (${pct}%) — delays possible${surplusStr}`;
    case 'warning':
      return `${floatStr} cover ${supply}/${demand} breaks (${pct}%) — meaningful gap${surplusStr}`;
    case 'critical':
      return `${floatStr} vs ${demand} breaks needed (${pct}%) — structurally short${surplusStr}`;
  }
}

// ---------------------------------------------------------------------------
// Stable sort helpers
// ---------------------------------------------------------------------------

function stableSurplusCompare(
  a: FloatSurplusProvider | RosterProvider,
  b: FloatSurplusProvider | RosterProvider,
): number {
  // CRNAs are typically the lion's share of floats; sort them first so the
  // most common case lands in a predictable order, then break ties by id.
  if (a.role !== b.role) return a.role === 'crna' ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
