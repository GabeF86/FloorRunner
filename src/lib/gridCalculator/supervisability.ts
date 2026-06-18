// Supervisability decision layer.
// Owned by agent A5 (Distance & Supervisability).
//
// Builds a richer decision layer on top of A1's `distanceMatrix.ts` primitives.
// Answers: "may Anesthesiologist X supervise CRNA Y given current site
// positions, distance bands, ASA/ACGME proximity guidance, and any rule hints
// parsed from the free-text guidelines (A4)?"
//
// The result implements `DistanceMatrixLike` so the solver (A3) can consume it
// unchanged; richer methods (`explain`, `safestSupervisor`) layer on top.
//
// Universality contract: no hospital-specific assumptions. Hospital seed data
// (e.g. Paoli) is created via `seeds/paoli.ts`.
//
// PRD: docs/PRD-Grid-Calculator.md §6, §7, §14 (A5 charter).
//
// Clinical reference (general — not a clinical claim):
//   ASA Statement on the Anesthesia Care Team requires the supervising
//   anesthesiologist to be "immediately available" for medically directed
//   CRNAs. See the current ASA Statement on the Anesthesia Care Team at
//   https://www.asahq.org/standards-and-practice-parameters
//   (intentionally NOT pulling a specific clinical quote — guidance evolves,
//   and the user should rely on the current published statement). The defaults
//   below treat `same_room` / `adjacent` as always-immediately-available,
//   `near` as allowed-with-warning (wing/floor topology supports prompt
//   response; an admin can downgrade individual pairs via the per-edge
//   `supervisable: false` flag, or enable stricter clinical mode via the
//   resolver-wide `strictNear` option), and `far` / `off_campus` as never
//   satisfying immediate availability.
//
// ACGME proximity guidance for anesthesiology residents likewise requires
// the supervising attending to be physically present or immediately available
// in the same anesthetizing location; we treat that as same_room/adjacent.

import {
  edgeKey,
  getBand,
  getSupervisabilityLevel,
  indexEdges,
  type SupervisabilityLevel,
} from './distanceMatrix';
import type { DistanceBand, DistanceEdge } from './types';
import type { DistanceMatrixLike } from './solver';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Structured explanation of a supervision-feasibility decision between two
 * sites. The `rationale` string is stable — same inputs always produce the
 * same characters — so it can be snapshotted in tests and displayed in the UI.
 */
export interface SupervisabilityExplanation {
  /** Final allowed/blocked decision. */
  allowed: boolean;
  /** Resolved distance band (after same-site short-circuit). */
  band: DistanceBand;
  /** Resolved warning level (safe / warning / blocked). */
  level: SupervisabilityLevel;
  /** Ordered, human-readable warnings. Empty when `allowed` is the band default. */
  warnings: string[];
  /** Deterministic single-line rationale suitable for UI tooltips and tests. */
  rationale: string;
}

/**
 * Optional rule hint parsed by A4 (rules normalizer) that influences supervisor
 * ranking. When provided, `safestSupervisor` defers to these hints with a
 * `warnings: ['overridden by rule']` annotation per A5's escalation contract.
 */
export interface SupervisorRuleHint {
  /** Room site to which the hint applies. */
  roomSiteId: string;
  /** Site that the rule says the supervisor must come from. */
  supervisorFromSiteId: string;
}

export interface SupervisabilityResolver extends DistanceMatrixLike {
  /**
   * Structured decision for a pair of sites. Same-site short-circuits to
   * `allowed: true`, level `safe`. Off-campus is a hard block — no override
   * can flip it to `true`.
   */
  explain(siteAId: string, siteBId: string): SupervisabilityExplanation;

  /**
   * Rank the given candidate MD sites by "safety" for supervising a CRNA at
   * `roomSiteId`. Returns site IDs sorted by:
   *   1. Rule hint (if `safestSupervisor` receives one via options).
   *   2. Same-site supervisor.
   *   3. Adjacent.
   *   4. Near (only if supervisable per edge/override).
   *   5. Anything farther is excluded.
   *
   * Ties broken by lexicographic siteId so the order is deterministic.
   */
  safestSupervisor(
    roomSiteId: string,
    candidateMDSites: string[],
    ruleHint?: SupervisorRuleHint,
  ): string[];
}

export interface SupervisabilityOptions {
  /**
   * Stricter clinical mode: when `true`, the resolver treats `near` pairs as
   * unsupervisable, even when `distanceMatrix.isSupervisable` would allow
   * them. Use for departments that require physically-co-located supervision
   * (e.g. residents in their first month) where the wing/floor topology
   * alone does not satisfy "immediately available".
   *
   * Defaults to `false` so the resolver matches `distanceMatrix.ts`'s
   * single-source-of-truth policy: `near` is allowed by default with a
   * structured warning.
   *
   * Note: this option was previously named `allowNearOverride` and inverted
   * the boolean's meaning ("allow `near` even without an edge override").
   * That layered policy contradicted `distanceMatrix.defaultBandSupervisability('near') === true`,
   * so it was repurposed as a stricter opt-in toggle that an admin must
   * explicitly enable. See `docs/code-reviews/2026-06-17-initial.md`.
   */
  strictNear?: boolean;
  /**
   * Optional collection of rule hints (e.g. from A4's normalized CoverageRuleSet)
   * keyed by room site ID. `safestSupervisor` consults this when no per-call
   * hint is passed.
   */
  ruleHints?: SupervisorRuleHint[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * `off_campus` is a HARD rule. Even if the admin override says
 * `supervisable: true`, the resolver returns `false` with an explicit
 * violation note. This encodes the ASA "immediately available" requirement —
 * a supervisor at a different building can never be immediately available.
 */
const HARD_BLOCKED_BANDS: ReadonlySet<DistanceBand> = new Set(['off_campus']);

/**
 * Bands considered "always safe" without any admin override.
 */
const ALWAYS_SAFE_BANDS: ReadonlySet<DistanceBand> = new Set(['same_room', 'adjacent']);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a supervisability resolver from a list of distance edges.
 *
 * The returned object:
 *   - Implements `DistanceMatrixLike` so the solver consumes it unchanged.
 *   - Exposes `explain` for structured decisions surfaced in the canvas
 *     tooltip / sidebar.
 *   - Exposes `safestSupervisor` for ranking candidate MD sites in the UI.
 *
 * Pure: no IO, no side effects. Cheap O(n) preprocessing for the edge index.
 */
export function makeSupervisabilityResolver(
  edges: DistanceEdge[],
  options: SupervisabilityOptions = {},
): SupervisabilityResolver {
  const idx = indexEdges(edges);
  const ruleHintBySite = new Map<string, SupervisorRuleHint>();
  for (const hint of options.ruleHints ?? []) {
    ruleHintBySite.set(hint.roomSiteId, hint);
  }
  const strictNear = options.strictNear === true;

  function explain(siteAId: string, siteBId: string): SupervisabilityExplanation {
    // Same-site short-circuit. Trivially safe.
    if (siteAId === siteBId) {
      return {
        allowed: true,
        band: 'same_room',
        level: 'safe',
        warnings: [],
        rationale: 'same site: supervision always allowed',
      };
    }

    const band = getBand(siteAId, siteBId, idx);
    const edgeLevel = getSupervisabilityLevel(siteAId, siteBId, idx);

    const warnings: string[] = [];

    // Hard rule: off_campus is never overridable.
    if (HARD_BLOCKED_BANDS.has(band)) {
      warnings.push('off-campus pair: ASA immediate-availability requirement cannot be met');
      return {
        allowed: false,
        band,
        level: 'blocked',
        warnings,
        rationale: `${band}: hard-blocked (ASA immediate availability)`,
      };
    }

    // Always-safe bands. No warnings.
    if (ALWAYS_SAFE_BANDS.has(band)) {
      return {
        allowed: true,
        band,
        level: 'safe',
        warnings: [],
        rationale: `${band}: supervision allowed`,
      };
    }

    // band === 'near' or 'far' below.
    if (band === 'near') {
      // POLICY: `distanceMatrix.ts` is the single source of truth for
      // band→allowed. `BAND_DEFAULTS['near'] === 'warning'` and
      // `defaultBandSupervisability('near') === true`, so the resolver mirrors
      // the matrix and ALLOWS `near` by default, always surfacing a structured
      // warning. Two ways to block a `near` pair:
      //
      //   1. The admin set `strictNear: true` on the resolver options (stricter
      //      clinical mode where wing/floor topology alone does not satisfy
      //      "immediately available").
      //   2. The per-edge `supervisable: false` override is present (admin
      //      explicitly says "this near pair cannot be supervised").
      //
      // See `docs/code-reviews/2026-06-17-initial.md` for the unification
      // rationale (previously `supervisability.ts` blocked `near` by default,
      // contradicting `distanceMatrix.ts`).
      const edge = idx.get(edgeKey(siteAId, siteBId));
      const explicitlyBlocked = edge?.supervisable === false;

      if (strictNear) {
        warnings.push('near pair: blocked by strictNear policy (supervisor must be physically co-located)');
        return {
          allowed: false,
          band,
          level: 'blocked',
          warnings,
          rationale: 'near: blocked (strictNear policy)',
        };
      }

      if (explicitlyBlocked) {
        warnings.push('near pair: admin marked this edge as non-supervisable');
        return {
          allowed: false,
          band,
          level: 'blocked',
          warnings,
          rationale: 'near: blocked (edge override)',
        };
      }

      // Default `near` path: allowed with a structured warning. The warning
      // is ALWAYS present so the canvas tooltip and rationale string flag the
      // pair even when no edge override is declared.
      warnings.push('near pair: allowed; supervisor must remain immediately available');
      return {
        allowed: true,
        band,
        level: edgeLevel === 'blocked' ? 'warning' : edgeLevel,
        warnings,
        rationale: 'near: allowed with warning',
      };
    }

    // band === 'far'. Blocked by default; admin override surfaces a warning
    // but does NOT allow the assignment — far cannot meet immediate
    // availability. This matches A1's defaults plus the A5 hard-rule policy
    // that proximity beyond `near` is unsupervisable.
    warnings.push('far pair: ASA immediate-availability requirement cannot be met');
    return {
      allowed: false,
      band,
      level: 'blocked',
      warnings,
      rationale: 'far: hard-blocked (ASA immediate availability)',
    };
  }

  function isSupervisable(fromSiteId: string, toSiteId: string): boolean {
    return explain(fromSiteId, toSiteId).allowed;
  }

  function safetyScore(
    roomSiteId: string,
    candidateSiteId: string,
  ): { allowed: boolean; rank: number } {
    if (roomSiteId === candidateSiteId) return { allowed: true, rank: 0 };
    const decision = explain(roomSiteId, candidateSiteId);
    if (!decision.allowed) return { allowed: false, rank: Number.POSITIVE_INFINITY };
    // Lower rank == safer.
    switch (decision.band) {
      case 'same_room':
        return { allowed: true, rank: 0 };
      case 'adjacent':
        return { allowed: true, rank: 1 };
      case 'near':
        return { allowed: true, rank: 2 };
      // far / off_campus would have been blocked above; keep the switch total.
      case 'far':
        return { allowed: false, rank: Number.POSITIVE_INFINITY };
      case 'off_campus':
        return { allowed: false, rank: Number.POSITIVE_INFINITY };
    }
  }

  function safestSupervisor(
    roomSiteId: string,
    candidateMDSites: string[],
    ruleHint?: SupervisorRuleHint,
  ): string[] {
    const hint = ruleHint ?? ruleHintBySite.get(roomSiteId);

    // Deduplicate while preserving the caller's order for tie-breaks.
    const seen = new Set<string>();
    const unique = candidateMDSites.filter((s) => {
      if (seen.has(s)) return false;
      seen.add(s);
      return true;
    });

    const scored = unique
      .map((siteId) => ({ siteId, ...safetyScore(roomSiteId, siteId) }))
      .filter((c) => c.allowed);

    scored.sort((a, b) => {
      // 1. Rule hint dominates (A5 escalation rule: defer to A4's parsed rule).
      if (hint) {
        const aHint = a.siteId === hint.supervisorFromSiteId ? 0 : 1;
        const bHint = b.siteId === hint.supervisorFromSiteId ? 0 : 1;
        if (aHint !== bHint) return aHint - bHint;
      }
      // 2. Safety rank.
      if (a.rank !== b.rank) return a.rank - b.rank;
      // 3. Deterministic tie-break by siteId.
      return a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0;
    });

    return scored.map((c) => c.siteId);
  }

  return {
    isSupervisable,
    explain,
    safestSupervisor,
  };
}

// ---------------------------------------------------------------------------
// Convenience: derive a UI-friendly "edge render spec" for `DistanceGraph`.
// Kept here so the graph stays a pure renderer with no decision logic of its
// own.
// ---------------------------------------------------------------------------

export type EdgeRenderStyle = 'safe' | 'override' | 'blocked';

export interface RenderedEdge {
  siteA: string;
  siteB: string;
  style: EdgeRenderStyle;
  band: DistanceBand;
  allowed: boolean;
}

/**
 * Compute the render style for every pair from a flat list of sites + edges.
 * Output is stable — pairs are emitted in `(min(id), max(id))` order — so the
 * SVG node order is deterministic across renders.
 */
export function renderEdgeStyles(
  siteIds: string[],
  edges: DistanceEdge[],
  options: SupervisabilityOptions = {},
): RenderedEdge[] {
  const resolver = makeSupervisabilityResolver(edges, options);
  const sorted = [...siteIds].sort();
  const out: RenderedEdge[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      const decision = resolver.explain(a, b);
      let style: EdgeRenderStyle;
      if (!decision.allowed) {
        style = 'blocked';
      } else if (decision.warnings.length > 0) {
        style = 'override';
      } else {
        style = 'safe';
      }
      out.push({
        siteA: a,
        siteB: b,
        style,
        band: decision.band,
        allowed: decision.allowed,
      });
    }
  }
  return out;
}
