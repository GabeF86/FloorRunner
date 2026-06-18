// Distance Matrix — universal proximity + supervisability helpers.
// Owned by agent A1 (Site Architect).
// Used by:
//   - A3 (solver.ts) to filter candidate cross-site supervision links
//   - A5 (distance & supervisability) for graph visualization
//   - A6 (floatStrategy.ts) to bias float "leansTo" decisions
//
// Universality contract: no hospital-specific assumptions live here. Paoli's
// actual distances belong in `seeds/paoli.ts`.
//
// PRD: docs/PRD-Grid-Calculator.md §6, §13, §17.

import type { DistanceBand, DistanceEdge, GridSite } from './types';

/**
 * Supervisability warning level for a band. Surfaced in the grid canvas as
 * a colored connector and in the sidebar's distance matrix dropdown.
 *
 *   - `safe`     — green, no warning.
 *   - `warning`  — amber, allowed but the solver should prefer alternatives.
 *   - `blocked`  — red, not a supervision candidate.
 */
export type SupervisabilityLevel = 'safe' | 'warning' | 'blocked';

/**
 * Default supervisability mapping per PRD §17 + ACGME proximity intuition:
 *
 *   - `same_room`  -> safe   (co-located; trivially supervisable)
 *   - `adjacent`   -> safe   (next door / single corridor; standard practice)
 *   - `near`       -> warning(within wing/floor; allowed but flagged so the
 *                     solver biases away unless distance bands force it)
 *   - `far`        -> blocked (different wing/floor; generally not supervisable)
 *   - `off_campus` -> blocked (different building; never supervisable)
 *
 * Admins can override per-edge via the `supervisable` flag on `DistanceEdge`.
 */
const BAND_DEFAULTS: Record<DistanceBand, SupervisabilityLevel> = {
  same_room: 'safe',
  adjacent: 'safe',
  near: 'warning',
  far: 'blocked',
  off_campus: 'blocked',
};

/**
 * Human-readable label for each band. Used by the sidebar dropdown and the
 * lane-edge distance indicator (PRD §7).
 */
export const BAND_LABELS: Record<DistanceBand, string> = {
  same_room: 'Same room',
  adjacent: 'Adjacent',
  near: 'Near',
  far: 'Far',
  off_campus: 'Off-campus',
};

/**
 * Ordered list of all bands, closest -> farthest. Used to render the dropdown
 * in a sensible order and as the iteration order for graph rendering.
 */
export const ORDERED_BANDS: readonly DistanceBand[] = [
  'same_room',
  'adjacent',
  'near',
  'far',
  'off_campus',
];

/**
 * Default band assumed when no edge has been declared between two sites in
 * the same config. We assume `near` (warning) so users are nudged to declare
 * the relationship explicitly without blocking the solver outright.
 */
const DEFAULT_INTRA_CONFIG_BAND: DistanceBand = 'near';

/**
 * Canonical key for an unordered site pair. Sorts the IDs so `(A,B)` and
 * `(B,A)` map to the same key. Exported so the supervisability layer can
 * reuse the same key shape against a pre-built `indexEdges` map.
 */
export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/**
 * Build an index from a list of edges keyed by canonical pair string. Cheap
 * O(n) preprocessing; callers should hoist this out of hot loops.
 */
export function indexEdges(edges: DistanceEdge[]): Map<string, DistanceEdge> {
  const idx = new Map<string, DistanceEdge>();
  for (const e of edges) {
    idx.set(edgeKey(e.siteA, e.siteB), e);
  }
  return idx;
}

/**
 * Resolve the distance band between two sites. Same-site returns `same_room`.
 * Unknown pair (no declared edge) returns `DEFAULT_INTRA_CONFIG_BAND`.
 *
 * Accepts either a raw edge list (re-indexes each call) or a pre-built index
 * via `indexEdges` for hot paths.
 */
export function getBand(
  siteAId: string,
  siteBId: string,
  edgesOrIndex: DistanceEdge[] | Map<string, DistanceEdge>,
): DistanceBand {
  if (siteAId === siteBId) return 'same_room';
  const idx = Array.isArray(edgesOrIndex) ? indexEdges(edgesOrIndex) : edgesOrIndex;
  const edge = idx.get(edgeKey(siteAId, siteBId));
  return edge?.band ?? DEFAULT_INTRA_CONFIG_BAND;
}

/**
 * Default supervisability (boolean) for a given band, before any admin
 * override is applied. `near` defaults to true with a warning surfaced via
 * `getSupervisabilityLevel`.
 */
export function defaultBandSupervisability(band: DistanceBand): boolean {
  return BAND_DEFAULTS[band] !== 'blocked';
}

/**
 * Returns the warning level (safe / warning / blocked) for a band ignoring
 * any per-edge override. Used by the grid canvas to color supervision arrows.
 */
export function defaultBandLevel(band: DistanceBand): SupervisabilityLevel {
  return BAND_DEFAULTS[band];
}

/**
 * Decide whether an Anesthesiologist at `siteAId` may supervise a CRNA at
 * `siteBId`. Order of resolution:
 *
 *   1. Same site -> always supervisable.
 *   2. Explicit edge present -> honor its `supervisable` override.
 *   3. No edge -> fall back to `DEFAULT_INTRA_CONFIG_BAND` defaults.
 *
 * Accepts either raw edges or a pre-built index. Pure, no side effects.
 */
export function isSupervisable(
  siteAId: string,
  siteBId: string,
  edgesOrIndex: DistanceEdge[] | Map<string, DistanceEdge>,
): boolean {
  if (siteAId === siteBId) return true;
  const idx = Array.isArray(edgesOrIndex) ? indexEdges(edgesOrIndex) : edgesOrIndex;
  const edge = idx.get(edgeKey(siteAId, siteBId));
  if (edge) return edge.supervisable;
  return defaultBandSupervisability(DEFAULT_INTRA_CONFIG_BAND);
}

/**
 * Returns the supervisability level for a specific edge, taking the
 * admin override into account:
 *
 *   - If override forces `supervisable: false` on a default-safe band,
 *     returns `blocked`.
 *   - If override forces `supervisable: true` on a default-blocked band,
 *     returns `warning` (we surface the override but never silently upgrade
 *     a blocked default to safe).
 *   - Otherwise returns the band's default level.
 */
export function getSupervisabilityLevel(
  siteAId: string,
  siteBId: string,
  edgesOrIndex: DistanceEdge[] | Map<string, DistanceEdge>,
): SupervisabilityLevel {
  if (siteAId === siteBId) return 'safe';
  const idx = Array.isArray(edgesOrIndex) ? indexEdges(edgesOrIndex) : edgesOrIndex;
  const edge = idx.get(edgeKey(siteAId, siteBId));
  const band = edge?.band ?? DEFAULT_INTRA_CONFIG_BAND;
  const defaultLevel = BAND_DEFAULTS[band];
  if (!edge) return defaultLevel;
  // Apply override semantics.
  if (defaultLevel === 'blocked' && edge.supervisable) return 'warning';
  if (defaultLevel !== 'blocked' && !edge.supervisable) return 'blocked';
  return defaultLevel;
}

/**
 * Enumerate the upper triangle of site pairs ordered by sidebar `position`.
 * Used by the sidebar's distance matrix renderer so each unordered pair is
 * presented exactly once.
 */
export function upperTrianglePairs(sites: GridSite[]): Array<[GridSite, GridSite]> {
  const ordered = [...sites].sort((a, b) => a.position - b.position);
  const pairs: Array<[GridSite, GridSite]> = [];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      pairs.push([ordered[i], ordered[j]]);
    }
  }
  return pairs;
}

/**
 * Convenience helper: look up an existing edge for a pair, returning
 * `undefined` if absent. The sidebar uses this to populate the band dropdown.
 */
export function findEdge(
  siteAId: string,
  siteBId: string,
  edges: DistanceEdge[],
): DistanceEdge | undefined {
  if (siteAId === siteBId) return undefined;
  const key = edgeKey(siteAId, siteBId);
  return edges.find((e) => edgeKey(e.siteA, e.siteB) === key);
}
