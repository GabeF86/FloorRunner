// Export utility — Anesthesia Coverage Grid Calculator.
// Owned by agent A16 (Export) per PRD §14.
//
// PURPOSE
// -------
// Pure-function transformation of a SolvedGrid + FTERecommendation +
// hospital metadata into a print-friendly snapshot the print route can
// consume. Keeping this module pure (no React, no DOM, no fetch) means:
//
//   - The print page can render it server-side OR client-side.
//   - Unit tests in `__tests__/export.test.ts` can assert the snapshot
//     shape without spinning up a JSDOM.
//   - Future PDF/PNG paths (server-side renderer, html-to-image, etc.)
//     can all consume the same snapshot — only the presentation layer
//     changes.
//
// PRIMARY EXPORT PATH (per PRD §14, A16):
//   - Browser print (Cmd+P / Ctrl+P on `/grid-calculator/print`).
//   - No new dependencies; the print route renders the snapshot with
//     `@media print` CSS that strips toggle bars / sidebars / hover
//     states and uses darker borders for paper.
//
// SECONDARY EXPORT PATH (documented fallback):
//   - Client-side PNG capture would call `html-to-image` against the
//     `<article id="grid-export-root">` wrapper. Not bundled here —
//     the install is gated on user demand per A16's escalation rule
//     ("if html-to-image install fails or adds >100KB, fall back to
//     the print-only path and document"). See `docs/agent-notes/A16-export.md`.
//
// UNIVERSALITY
// ------------
// No FloorRunner-specific imports. Only the universal Grid Calculator
// types from `./solver` and `./types` are consumed, plus a tiny
// hospital-metadata bag passed in by the caller. The print route is
// the ONLY consumer that knows about Paoli (via the seed default).

import type {
  FloatAssignment,
  RoomAssignment,
  SolvedGrid,
} from './solver';
import type {
  FTERecommendation,
  GridCalculatorConfig,
  GridSite,
} from './types';

// ---------------------------------------------------------------------------
// Public input / output shapes
// ---------------------------------------------------------------------------

/**
 * Page orientation. Letter-portrait is the default per A16's charter; the
 * print route exposes `?orient=landscape` to flip to landscape.
 */
export type PrintOrientation = 'portrait' | 'landscape';

/**
 * Minimal hospital metadata passed into the print snapshot. The print page
 * is responsible for sourcing this either from a persisted config (A11 will
 * wire that in) or from defaults baked into the seed (current demo path).
 */
export interface HospitalMetadata {
  /** Hospital display name — appears in the print header. */
  hospitalName: string;
  /** Optional configuration name (e.g. "Default Weekday"). */
  configName?: string;
  /** Optional configuration id, surfaced for traceability in the footer. */
  configId?: string;
}

/**
 * Provider display labels for the print snapshot. Keyed by provider id.
 * Falls back to the provider id when not present. Defensive: the snapshot
 * always exposes a stable, non-empty initials string for paper rendering.
 */
export interface PrintProviderLabel {
  /** Full display name (e.g. "Dr. Avery Chen"). */
  name: string;
  /** 2–3 letter monogram (e.g. "AC"). */
  initials: string;
}

/**
 * Input bundle for `buildPrintSnapshot`. Decoupling this from the print
 * page's component props means we can persist the snapshot later (A11+) or
 * regenerate it server-side for a static PDF without touching the renderer.
 */
export interface PrintSnapshotInput {
  /** Hospital metadata for the header. */
  hospital: HospitalMetadata;
  /** Sites in render order — usually `paoliSeed.sites` or a persisted config. */
  sites: GridSite[];
  /** The solver output to render. */
  grid: SolvedGrid;
  /** Optional FTE recommendation. If undefined, the FTE panel renders an explanation. */
  recommendation?: FTERecommendation;
  /** Provider labels. Missing entries fall back to provider id slugs. */
  providerLabels?: Record<string, PrintProviderLabel>;
  /** Active config — surfaced in the footer for traceability. */
  config?: GridCalculatorConfig;
  /** Optional timestamp override (testability). Defaults to `new Date()`. */
  generatedAt?: Date;
  /** Page orientation. Defaults to `'portrait'`. */
  orientation?: PrintOrientation;
}

/**
 * Print-friendly row for a single rendered room. The print page consumes
 * this verbatim; the order matches `roomCellsForSite` output (sorted by
 * room.position ascending).
 */
export interface PrintRoomRow {
  /** Stable room id. */
  roomId: string;
  /** Display name (e.g. "OR 1"). */
  roomName: string;
  /** Resolved staffing pattern from the solver. */
  staffingPattern: RoomAssignment['staffingPattern'];
  /** Display label for the supervising Anesthesiologist, or null if unstaffed. */
  anesthesiologist: PrintProviderLabel | null;
  /** CRNA labels assigned to this room (may be empty). */
  crnas: PrintProviderLabel[];
  /**
   * Cross-site supervision marker; populated only when the supervising
   * Anesthesiologist sits at a different site. Holds the supervisor's home
   * site short label for the print badge ("supervised from OR").
   */
  crossSite?: { fromSiteShortLabel: string; providerId: string };
  /** Optional notes propagated from the site rule. */
  notes?: string;
  /** Optional auxiliary role propagated from the site rule. */
  auxiliaryRole?: RoomAssignment['auxiliaryRole'];
}

/**
 * Print-friendly lane for a single site. The float lane is a top-level
 * `floatLane` field, not a regular site lane — it carries no rooms.
 */
export interface PrintSiteLane {
  /** Stable site id. */
  siteId: string;
  /** Display name (e.g. "Main OR"). */
  siteName: string;
  /** Short label used in cross-site badges (e.g. "OR"). */
  shortName: string;
  /** Lane accent color, valid `#rrggbb`. */
  color: string;
  /** Optional caption shown under the site name. */
  caption?: string;
  /** Room rows in render order. */
  rooms: PrintRoomRow[];
}

/**
 * Print-friendly entry for a single float provider. Renders as an outlined
 * card on paper per PRD §7.4.
 */
export interface PrintFloatEntry {
  /** Provider display label. */
  provider: PrintProviderLabel;
  /** Role badge — same convention as the live canvas. */
  role: FloatAssignment['role'];
  /**
   * Site the float "leans toward" — display label + short name. `null` when
   * the float strategy did not pick a target.
   */
  leansToSite: { siteId: string; siteName: string; shortName: string } | null;
}

/**
 * Print-friendly FTE panel content. Pre-formatted strings so the renderer
 * doesn't need to know about precision or binding-tag style.
 */
export interface PrintFTESummary {
  /** Set when no recommendation was provided. The renderer shows the placeholder. */
  pending: boolean;
  /** Recommended Anesthesiologist FTE (max of worst case and p95). */
  recommendedAnesthesiologist: number;
  /** Recommended CRNA FTE (max of worst case and p95). */
  recommendedCrna: number;
  /** Recommended backup-call FTE (best-effort field; may be 0). */
  recommendedBackupCall: number;
  /** Per-role tabular detail rows. Stable order: Anesthesiologist, CRNA, Backup call. */
  rows: PrintFTERow[];
  /** Optional backup-call distribution rows. Empty when the recommendation didn't include one. */
  backupCallDistribution: PrintBackupCallShare[];
  /** Human-readable rationale text. */
  rationale: string;
  /** Pre-formatted binding-constraint sentence ("Binding: Anesthesiologist worst case…"). */
  bindingSummary: string;
}

export interface PrintFTERow {
  /** Display label ("Anesthesiologists", "CRNAs", "Backup call FTE"). */
  label: string;
  /** Pre-formatted worst-case value or em-dash. */
  worstCase: string;
  /** Pre-formatted p50 value or em-dash. */
  p50: string;
  /** Pre-formatted p95 value or em-dash. */
  p95: string;
  /** Pre-formatted recommendation = max(worst, p95). */
  recommended: string;
  /** Binding tag — "Worst case" or "Monte Carlo p95" or empty. */
  binding: string;
}

export interface PrintBackupCallShare {
  providerId: string;
  /** Resolved display label — falls back to provider id. */
  displayName: string;
  /** Pre-formatted share fraction (e.g. "0.18"). */
  fteShare: string;
}

/**
 * The full snapshot ready for the print renderer. Pure data; safe to
 * serialize to JSON for testing or for an eventual server-side renderer.
 */
export interface PrintSnapshot {
  /** Page header — never empty; defaults to "Unknown Hospital" if the caller fails to provide. */
  header: {
    title: string;
    subtitle: string;
    dateStamp: string;
  };
  /** Lane content in PRD §7 render order. Float lane is separate. */
  siteLanes: PrintSiteLane[];
  floatLane: { providers: PrintFloatEntry[] };
  fte: PrintFTESummary;
  footer: {
    caption: string;
    bindingNote: string;
    configReference: string;
  };
  orientation: PrintOrientation;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EM_DASH = '—';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pure function — produces a print-ready snapshot from a SolvedGrid +
 * FTERecommendation + hospital metadata bag. Never throws; missing or
 * malformed inputs are coerced to safe defaults that render legibly.
 *
 * Why no React here:
 *   - The same snapshot can later feed a server-side PDF renderer.
 *   - Unit tests verify the snapshot shape with `node:assert`, no JSDOM.
 *   - The print page becomes a thin presentation layer that's easy to skim.
 *
 * Deterministic: passing the same inputs always yields byte-identical output
 * EXCEPT for the date stamp (controlled via `generatedAt` for testability).
 */
export function buildPrintSnapshot(input: PrintSnapshotInput): PrintSnapshot {
  const generatedAt = input.generatedAt ?? new Date();
  const orientation: PrintOrientation = input.orientation ?? 'portrait';
  const providerLabels = input.providerLabels ?? {};

  const hospitalName = (input.hospital.hospitalName ?? '').trim() || 'Unknown Hospital';
  const configName = input.hospital.configName?.trim();

  // ── Header ──────────────────────────────────────────────────────────────
  const header = {
    title: `Anesthesia Coverage Grid — ${hospitalName}`,
    subtitle: configName ? configName : 'Coverage configuration',
    dateStamp: formatDate(generatedAt),
  };

  // ── Lanes ───────────────────────────────────────────────────────────────
  // Group assignments by siteId for fast lookup. The solver returns a flat
  // list keyed by roomId; we re-bucket per site so the print lanes match
  // the same site-major order as the live canvas.
  const assignmentsBySite = new Map<string, RoomAssignment[]>();
  for (const a of input.grid.assignments) {
    const arr = assignmentsBySite.get(a.siteId) ?? [];
    arr.push(a);
    assignmentsBySite.set(a.siteId, arr);
  }

  // Build a site-id → site lookup for cross-site short labels.
  const siteLookup = new Map<string, GridSite>();
  for (const s of input.sites) siteLookup.set(s.id, s);

  // Sort sites by position ascending; reserves PRD §7.4 float-lane ordering.
  // We deliberately filter out sites with zero rooms here — those are float
  // lane stand-ins (e.g. the Paoli seed's `paoli-site-float` entry). The
  // float lane is rendered separately below.
  const siteLanes: PrintSiteLane[] = input.sites
    .filter((s) => s.rooms.length > 0)
    .slice()
    .sort((a, b) => a.position - b.position || compareString(a.id, b.id))
    .map((site) => toPrintSiteLane(site, assignmentsBySite.get(site.id) ?? [], providerLabels, siteLookup));

  // ── Float lane ─────────────────────────────────────────────────────────
  const floatLane = {
    providers: input.grid.floats.map((f) => toPrintFloatEntry(f, providerLabels, siteLookup)),
  };

  // ── FTE summary ────────────────────────────────────────────────────────
  const fte = toPrintFTESummary(input.recommendation, providerLabels);

  // ── Footer ─────────────────────────────────────────────────────────────
  const footer = {
    caption: `Generated by Grid Calculator — ${formatTimestamp(generatedAt)}`,
    bindingNote: fte.bindingSummary,
    configReference: formatConfigReference(input.config, input.hospital.configId),
  };

  return {
    header,
    siteLanes,
    floatLane,
    fte,
    footer,
    orientation,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPrintSiteLane(
  site: GridSite,
  assignments: RoomAssignment[],
  providerLabels: Record<string, PrintProviderLabel>,
  siteLookup: Map<string, GridSite>,
): PrintSiteLane {
  // Sort rooms by their position from the canonical site definition. The
  // solver guarantees one assignment per room when called with a valid
  // input, but defensively we tolerate missing rows by emitting an
  // empty-staffed entry. Print readers should still see the room name.
  const orderedRooms = site.rooms
    .slice()
    .sort((a, b) => a.position - b.position || compareString(a.id, b.id));

  const assignmentsByRoomId = new Map(assignments.map((a) => [a.roomId, a]));

  const rows: PrintRoomRow[] = orderedRooms.map((room) => {
    const assignment = assignmentsByRoomId.get(room.id);
    return toPrintRoomRow(room.id, room.name, assignment, providerLabels, siteLookup);
  });

  return {
    siteId: site.id,
    siteName: site.name,
    shortName: site.shortName ?? firstWord(site.name),
    color: site.color,
    caption: site.caption,
    rooms: rows,
  };
}

function toPrintRoomRow(
  roomId: string,
  roomName: string,
  assignment: RoomAssignment | undefined,
  providerLabels: Record<string, PrintProviderLabel>,
  siteLookup: Map<string, GridSite>,
): PrintRoomRow {
  if (!assignment) {
    return {
      roomId,
      roomName,
      // Default staffing pattern is supervised — matches the solver's silent
      // default path so the print snapshot is consistent with the live view.
      staffingPattern: 'supervised_md_crna',
      anesthesiologist: null,
      crnas: [],
    };
  }

  const anesthesiologist = assignment.anesthesiologistId
    ? resolveLabel(assignment.anesthesiologistId, providerLabels)
    : null;
  const crnas = assignment.crnaIds.map((id) => resolveLabel(id, providerLabels));

  const row: PrintRoomRow = {
    roomId: assignment.roomId,
    roomName,
    staffingPattern: assignment.staffingPattern,
    anesthesiologist,
    crnas,
  };

  if (assignment.crossSiteSupervisor) {
    const supSite = siteLookup.get(assignment.crossSiteSupervisor.fromSiteId);
    row.crossSite = {
      providerId: assignment.crossSiteSupervisor.providerId,
      fromSiteShortLabel: supSite
        ? supSite.shortName ?? firstWord(supSite.name)
        : 'elsewhere',
    };
  }
  if (assignment.notes) row.notes = assignment.notes;
  if (assignment.auxiliaryRole) row.auxiliaryRole = assignment.auxiliaryRole;

  return row;
}

function toPrintFloatEntry(
  f: FloatAssignment,
  providerLabels: Record<string, PrintProviderLabel>,
  siteLookup: Map<string, GridSite>,
): PrintFloatEntry {
  const leansToSite = f.leansToSiteId ? siteLookup.get(f.leansToSiteId) : null;
  return {
    provider: resolveLabel(f.providerId, providerLabels),
    role: f.role,
    leansToSite: leansToSite
      ? {
          siteId: leansToSite.id,
          siteName: leansToSite.name,
          shortName: leansToSite.shortName ?? firstWord(leansToSite.name),
        }
      : null,
  };
}

function toPrintFTESummary(
  recommendation: FTERecommendation | undefined,
  providerLabels: Record<string, PrintProviderLabel>,
): PrintFTESummary {
  if (!recommendation) {
    return {
      pending: true,
      recommendedAnesthesiologist: 0,
      recommendedCrna: 0,
      recommendedBackupCall: 0,
      rows: [
        emptyFTERow('Anesthesiologists'),
        emptyFTERow('CRNAs'),
        emptyFTERow('Backup call FTE'),
      ],
      backupCallDistribution: [],
      rationale: 'FTE recommendation pending — re-run the simulator before exporting for an admin presentation.',
      bindingSummary: 'Binding constraint: not yet computed.',
    };
  }

  const md = recommendation.anesthesiologist;
  const crna = recommendation.crna;
  const backupCallFte = recommendation.backupCall.fte;

  const recommendedAnesthesiologist = Math.max(md.worstCase, md.p95);
  const recommendedCrna = Math.max(crna.worstCase, crna.p95);

  const rows: PrintFTERow[] = [
    {
      label: 'Anesthesiologists',
      worstCase: formatFte(md.worstCase),
      p50: formatFte(md.p50),
      p95: formatFte(md.p95),
      recommended: formatFte(recommendedAnesthesiologist),
      binding: bindingTagLabel(md.binding),
    },
    {
      label: 'CRNAs',
      worstCase: formatFte(crna.worstCase),
      p50: formatFte(crna.p50),
      p95: formatFte(crna.p95),
      recommended: formatFte(recommendedCrna),
      binding: bindingTagLabel(crna.binding),
    },
    {
      label: 'Backup call FTE',
      worstCase: EM_DASH,
      p50: EM_DASH,
      p95: EM_DASH,
      recommended: formatFte(backupCallFte),
      binding: '',
    },
  ];

  const backupCallDistribution: PrintBackupCallShare[] = recommendation.backupCall.distribution.map(
    (d) => ({
      providerId: d.providerId,
      displayName: providerLabels[d.providerId]?.name ?? d.providerId,
      fteShare: d.fteShare.toFixed(2),
    }),
  );

  return {
    pending: false,
    recommendedAnesthesiologist,
    recommendedCrna,
    recommendedBackupCall: backupCallFte,
    rows,
    backupCallDistribution,
    rationale: recommendation.rationale.trim() || 'No rationale provided.',
    bindingSummary: buildBindingSummary(md.binding, crna.binding),
  };
}

function emptyFTERow(label: string): PrintFTERow {
  return {
    label,
    worstCase: EM_DASH,
    p50: EM_DASH,
    p95: EM_DASH,
    recommended: EM_DASH,
    binding: '',
  };
}

function resolveLabel(
  providerId: string,
  providerLabels: Record<string, PrintProviderLabel>,
): PrintProviderLabel {
  const hit = providerLabels[providerId];
  if (hit && hit.name && hit.initials) return hit;
  if (hit && hit.name) return { name: hit.name, initials: deriveInitials(hit.name) };
  return { name: providerId, initials: deriveInitials(providerId) };
}

function deriveInitials(name: string): string {
  // Strip role suffixes for nicer initials (matches the live canvas style).
  const cleaned = name.replace(/,\s*(crna|md|do)\s*$/i, '').trim();
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  const first = parts[0]?.[0] ?? '';
  const last = parts[parts.length - 1]?.[0] ?? '';
  return `${first}${last}`.toUpperCase() || '??';
}

function formatFte(n: number): string {
  if (!Number.isFinite(n)) return EM_DASH;
  // Whole numbers render without decimals; partial FTEs render with one decimal.
  return Number.isInteger(n) ? n.toString() : n.toFixed(1);
}

function bindingTagLabel(binding: 'worst_case' | 'monte_carlo'): string {
  return binding === 'worst_case' ? 'Worst case' : 'Monte Carlo p95';
}

function buildBindingSummary(
  mdBinding: 'worst_case' | 'monte_carlo',
  crnaBinding: 'worst_case' | 'monte_carlo',
): string {
  return `Binding: Anesthesiologist ${bindingTagLabel(mdBinding).toLowerCase()}, CRNA ${bindingTagLabel(crnaBinding).toLowerCase()}.`;
}

function formatConfigReference(
  config: GridCalculatorConfig | undefined,
  fallbackConfigId: string | undefined,
): string {
  if (config) {
    const parts = [
      `Coverage style: ${config.coverageStyle}`,
      `Supervision ratio: ${config.supervisionRatio}`,
      `Float strategy: ${config.floatStrategy}`,
      `Backup posture: ${config.backupCallPosture}`,
      `Config id: ${config.id}`,
    ];
    return parts.join(' · ');
  }
  if (fallbackConfigId) return `Config id: ${fallbackConfigId}`;
  return 'Config id: (unsaved)';
}

function formatDate(d: Date): string {
  // Stable yyyy-mm-dd ISO date for paper headers — easy to scan, doesn't
  // depend on locale, and matches the date stamps used in the session log /
  // PRD changelog conventions.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTimestamp(d: Date): string {
  const date = formatDate(d);
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${date} ${h}:${min}`;
}

function firstWord(s: string): string {
  return s.trim().split(/\s+/)[0] ?? s;
}

function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
