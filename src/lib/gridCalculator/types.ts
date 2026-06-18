// Shared types for the Anesthesia Coverage Grid Calculator.
// Owned by agent A1 (Site Architect) and A2 (Provider Profile).
// Do not import from FloorRunner-specific modules to preserve universality.

export type CoverageStyle = 'md_heavy' | 'balanced' | 'crna_heavy';
export type SupervisionRatioMode = 'mostly_1_3' | 'mostly_1_4' | 'mixed';
export type FloatStrategyMode = 'break_priority' | 'emergency_priority' | 'balanced';
export type BackupCallPosture = 'aggressive' | 'conservative';

/**
 * Distance bands used to describe inter-site proximity for supervision
 * feasibility decisions.
 *
 * PRD §17 flags this as an open question: 5 bands vs fewer. Per the escalation
 * rule, A1 ships 5 bands. Rationale:
 *  - `same_room`     — physically co-located (rare but explicit; useful in OB).
 *  - `adjacent`      — next door or across a single corridor; always safe.
 *  - `near`          — within the same wing/floor; usually safe but flagged.
 *  - `far`           — same building, different wing/floor; generally not OK.
 *  - `off_campus`    — different building / detached unit; never OK.
 *
 * TODO(A1): collapse to 3 bands if usage telemetry shows admins only ever
 * pick same/near/far. Re-evaluate at end of Tier 3.
 */
export type DistanceBand = 'same_room' | 'adjacent' | 'near' | 'far' | 'off_campus';

export interface GridCalculatorConfig {
  id: string;
  hospital: string;
  name: string;
  coverageStyle: CoverageStyle;
  supervisionRatio: SupervisionRatioMode;
  floatStrategy: FloatStrategyMode;
  backupCallPosture: BackupCallPosture;
}

/**
 * A logical anesthetizing location (Main OR, Endo, Neuro Lab, EP, OB, etc.).
 *
 * Universal — no hospital-specific assumptions live in this type. Hospital
 * seed data (e.g. Paoli) is created via `seeds/paoli.ts`.
 */
export interface GridSite {
  /** Stable UUID. Matches `scheduling.sites.id` when imported from FloorRunner. */
  id: string;
  /** Display name (e.g. "Main OR"). Always shown verbatim in the sidebar and lane headers. */
  name: string;
  /** Short display label used in compact badges (e.g. "OR", "Endo"). Optional; falls back to first word of `name`. */
  shortName?: string;
  /** Hex color used as the lane accent and color chip. Must be a valid `#rrggbb` string. */
  color: string;
  /**
   * A lucide-react icon name OR an emoji glyph. The sidebar treats anything
   * length 1–3 as a glyph and anything longer as an icon component lookup.
   */
  icon: string;
  /** Sort order — lower numbers appear first (top of sidebar, leftmost lane). */
  position: number;
  /** Optional short caption shown under the site name (e.g. "ground floor", "tower-3"). */
  caption?: string;
  /** Rooms belonging to this site. Order matters; mirrors lane row order. */
  rooms: GridRoom[];
}

/**
 * A single anesthetizing room within a site. The unit of assignment for the
 * grid solver — every grid cell maps to exactly one `GridRoom`.
 */
export interface GridRoom {
  /** Stable UUID. */
  id: string;
  /** UUID of the parent `GridSite`. */
  siteId: string;
  /** Display name (e.g. "OR 1", "Endo A"). */
  name: string;
  /** Sort order within the parent site. */
  position: number;
  /**
   * Optional acuity hint. The solver may use this to bias 1:3 vs 1:4
   * supervision decisions. Free-form so the rules normalizer (A4) can map
   * arbitrary descriptors like "high_acuity" or "trauma_bay".
   */
  acuityHint?: string;
}

/**
 * Symmetric edge in the distance matrix. The matrix is stored sparsely as a
 * list of edges; absent pairs fall back to the band assumption documented in
 * `distanceMatrix.ts` (default: `near` for intra-config pairs, `off_campus`
 * for cross-config pairs).
 *
 * Edges are direction-agnostic — `(A,B)` and `(B,A)` refer to the same edge.
 * The distance matrix helpers normalize lookup order.
 */
export interface DistanceEdge {
  /** UUID of one endpoint site. */
  siteA: string;
  /** UUID of the other endpoint site. */
  siteB: string;
  /** Categorical distance band. See `DistanceBand` for definitions. */
  band: DistanceBand;
  /**
   * Override flag. Defaults derived from `band` via
   * `defaultBandSupervisability`. Admins can override (e.g. mark a `near`
   * pair as not supervisable due to a closed connecting corridor).
   */
  supervisable: boolean;
}

export interface CoverageRuleSet {
  siteRules: SiteRule[];
  globalRules: GlobalRule[];
}

export interface SiteRule {
  site: string;
  defaultStaffing: 'solo_md' | 'supervised_md_crna' | 'solo_crna_with_remote_md';
  fallbacks?: string[];
  supervisorFromSite?: string;
  maxSupervisionRatio?: '1:1' | '1:2' | '1:3' | '1:4';
  auxiliaryRole?: 'break_relief' | 'add_on_relief';
  notes?: string;
}

export interface GlobalRule {
  kind: string;
  payload: Record<string, unknown>;
}

export interface FTERecommendation {
  anesthesiologist: FTEBlock;
  crna: FTEBlock;
  backupCall: {
    fte: number;
    distribution: Array<{ providerId: string; fteShare: number }>;
  };
  rationale: string;
}

export interface FTEBlock {
  worstCase: number;
  p50: number;
  p95: number;
  binding: 'worst_case' | 'monte_carlo';
}
