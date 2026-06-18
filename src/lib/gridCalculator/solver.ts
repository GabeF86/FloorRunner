// Deterministic single-day grid solver.
// Owned by agent A3 (Coverage Algorithm).
// Implements PRD §7-§9: coverage style + supervision ratio toggles, distance
// matrix-driven cross-site supervision. The solver emits ZERO floats — A6
// (Float Strategy) owns the entire float pool and consumes the solver's
// SolvedGrid + a separate surplus-provider list to compute float allocation.
// Pure functions only — no hidden state.
//
// Universality contract: this module must NOT import from FloorRunner-specific
// modules like staffingCalculator/paoli.ts. Patterns may be studied there but
// the algorithm here is hospital-agnostic.

import type {
  CoverageRuleSet,
  GridCalculatorConfig,
  GridRoom,
  GridSite,
  SiteRule,
  SupervisionRatioMode,
} from './types';

// ---------------------------------------------------------------------------
// Public input / output shapes
// ---------------------------------------------------------------------------

export type ProviderRole = 'anesthesiologist' | 'crna';

export interface RosterProvider {
  id: string;
  role: ProviderRole;
  fte: number;
  /** Optional home site hint — used to break ties when sorting. */
  homeSiteId?: string;
}

/**
 * Structural interface for the distance-matrix module owned by A1/A5.
 * We accept any object that implements `isSupervisable`. A default no-op
 * implementation is provided so the solver works before A1/A5 ship.
 */
export interface DistanceMatrixLike {
  isSupervisable(fromSiteId: string, toSiteId: string): boolean;
}

export interface SolverInput {
  config: GridCalculatorConfig;
  sites: GridSite[];
  rules: CoverageRuleSet;
  roster: RosterProvider[];
  /** Optional distance matrix. If absent, same-site supervision only. */
  distanceMatrix?: DistanceMatrixLike;
}

export interface RoomAssignment {
  roomId: string;
  siteId: string;
  /** Identifier of the assigned Anesthesiologist, or `null` if unstaffed. */
  anesthesiologistId: string | null;
  /** Zero-or-more CRNAs assigned to this room. */
  crnaIds: string[];
  /** Set when the supervising Anesthesiologist physically sits at another site. */
  crossSiteSupervisor?: { providerId: string; fromSiteId: string };
  /** Resolved staffing pattern for this room (audit trail). */
  staffingPattern: SiteRule['defaultStaffing'];
  /**
   * Auxiliary role flag propagated from the site rule when present. A6 (Float
   * Strategy) reads this to know that a site's primary Anesthesiologist is
   * also available to the float pool as a break_relief / add_on_relief
   * candidate. The solver does NOT change room staffing based on this field —
   * it's a hand-off marker only.
   */
  auxiliaryRole?: SiteRule['auxiliaryRole'];
  /** Free-form notes propagated from the site rule for UI display. */
  notes?: string;
  /**
   * True when the room landed on `supervised_md_crna` because no SiteRule
   * matched the room's site (the silent default path). A surrounding
   * `violations` entry is also emitted; this flag exists so consumers can
   * style/filter quickly without parsing strings.
   */
  defaultedFromRule?: boolean;
}

export interface FloatAssignment {
  providerId: string;
  role: ProviderRole;
  leansToSiteId: string | null;
}

export interface SolvedGrid {
  configId: string;
  assignments: RoomAssignment[];
  floats: FloatAssignment[];
  /** Human-readable, deterministic list of unresolved issues. */
  violations: string[];
}

// ---------------------------------------------------------------------------
// Default distance matrix — same-site supervision only.
// ---------------------------------------------------------------------------

const SAME_SITE_ONLY_MATRIX: DistanceMatrixLike = {
  isSupervisable: (from, to) => from === to,
};

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic single-day grid for the given config + rules + roster.
 * Never throws at runtime — unresolvable conflicts are appended to `violations`.
 */
export function solve(input: SolverInput): SolvedGrid {
  const { config, sites, rules, roster } = input;
  const distanceMatrix = input.distanceMatrix ?? SAME_SITE_ONLY_MATRIX;

  const violations: string[] = [];
  const assignments: RoomAssignment[] = [];

  // Deterministic ordering: sort sites by `position`, then `id` as tie-breaker.
  const orderedSites = [...sites].sort(stableSiteCompare);

  // Roster pools: keep deterministic ordering by id.
  const availableMDs = roster
    .filter((p) => p.role === 'anesthesiologist')
    .sort(stableProviderCompare);
  const availableCRNAs = roster
    .filter((p) => p.role === 'crna')
    .sort(stableProviderCompare);

  // Track per-supervisor load and the site they're currently sitting at.
  // (Single SupervisorState interface lives at module scope below.)
  const supervisors: SupervisorState[] = [];

  // Pull index for round-robin allocation of MDs/CRNAs from the pools.
  //
  // FTE-unaware assumption: takeMD() / takeCRNA() walk the pre-sorted roster
  // pools strictly in order, ignoring each provider's `fte` field. This is
  // intentional and safe in v1 because the FTE Simulator (A7) hands the solver
  // a synthetic 1.0-FTE roster — every provider it produces is either present
  // for the whole day or absent (PRD §10). When real partial-day rosters land,
  // this allocator will need an FTE-weighted pull strategy (PRD §17 open
  // question OQ-7).
  let mdCursor = 0;
  let crnaCursor = 0;

  const takeMD = (): RosterProvider | null => {
    if (mdCursor >= availableMDs.length) return null;
    return availableMDs[mdCursor++];
  };
  const takeCRNA = (): RosterProvider | null => {
    if (crnaCursor >= availableCRNAs.length) return null;
    return availableCRNAs[crnaCursor++];
  };

  const ratioCap = supervisionRatioCap(config.supervisionRatio);
  const ratioTarget = supervisionRatioTarget(config.supervisionRatio);

  // Build a quick lookup of site rules by site name (the normalizer contract
  // is that `SiteRule.site` is a human-readable site name matching `GridSite.name`).
  // We keep an id-keyed fallback to avoid hard-crashing on a normalizer
  // contract violation, but we surface the violation when the fallback hits
  // so the contract drift is visible in the audit trail.
  const ruleBySiteKey = new Map<string, SiteRule>();
  for (const rule of rules.siteRules) {
    ruleBySiteKey.set(rule.site, rule);
  }

  // Audit-flag any globalRules the solver doesn't know how to honor. Per A14's
  // Drift 2 fix, we surface a per-kind violation so the silent drop is visible
  // upstream (PRD §2.4 promise: "Rules added in plain English; no code change"
  // — the audit makes "no code change" honest even when a kind is unsupported).
  // The solver currently understands NO globalRule kinds; A4/A14 will expand
  // this allowlist as kinds are wired in.
  const HONORED_GLOBAL_RULE_KINDS = new Set<string>([
    // (intentionally empty in v1 — see A4 notes)
  ]);
  for (const grule of rules.globalRules) {
    if (!HONORED_GLOBAL_RULE_KINDS.has(grule.kind)) {
      violations.push(
        `GlobalRule kind=${grule.kind} round-tripped but unhonored — see A4 notes`,
      );
    }
  }

  for (const site of orderedSites) {
    const byName = ruleBySiteKey.get(site.name);
    const byId = byName ? undefined : ruleBySiteKey.get(site.id);
    if (!byName && byId) {
      violations.push(
        `Site rule resolved by id; normalizer should emit human-readable name for ${site.id}`,
      );
    }
    const rule = byName ?? byId;
    const orderedRooms = [...site.rooms].sort(stableRoomCompare);

    // Bug 5: surface the silent "no rule → supervised_md_crna" default so the
    // consumer can see why this pattern was chosen. Emit ONCE per site (not
    // per room) — the per-room `defaultedFromRule` flag is set below and is
    // the load-bearing signal for downstream consumers.
    if (!rule && site.rooms.length > 0) {
      violations.push(
        `No rule for site ${site.name} — defaulted to supervised_md_crna`,
      );
    }

    for (const room of orderedRooms) {
      const decision = decideStaffingPattern(rule, config.coverageStyle);

      const assignment: RoomAssignment = {
        roomId: room.id,
        siteId: site.id,
        anesthesiologistId: null,
        crnaIds: [],
        staffingPattern: decision.pattern,
      };

      // Bug 3 (A14 Drift 2): propagate the rule-shape fields the normalizer
      // emits so they're not silently dropped. `maxSupervisionRatio` is
      // consumed below by pickSupervisor (per-site cap takes precedence over
      // the global supervisionRatio cap). `auxiliaryRole` and `notes` are
      // pass-through markers for A6 / UI consumers respectively.
      if (rule?.auxiliaryRole) {
        assignment.auxiliaryRole = rule.auxiliaryRole;
      }
      if (rule?.notes) {
        assignment.notes = rule.notes;
      }

      // Per-room flag matches the per-site `No rule` violation pushed above.
      if (!rule) {
        assignment.defaultedFromRule = true;
      }

      switch (decision.pattern) {
        case 'solo_md': {
          const md = takeMD();
          if (!md) {
            violations.push(
              `Room ${qualify(site, room)}: no Anesthesiologist available for solo_md staffing.`,
            );
          } else {
            assignment.anesthesiologistId = md.id;
            // Solo MDs are tracked as a "supervisor" with zero CRNA capacity
            // already consumed — they sit at this site and may be a candidate
            // for cross-site supervision later if they have spare ratio room.
            // Per PRD, solo_md rooms imply the MD is dedicated; we do NOT add
            // them to the supervisor pool.
          }
          break;
        }

        case 'supervised_md_crna': {
          // Need a CRNA in the room; the supervising MD may sit here OR cross-site.
          const crna = takeCRNA();
          if (!crna) {
            violations.push(
              `Room ${qualify(site, room)}: no CRNA available for supervised_md_crna staffing.`,
            );
            break;
          }
          assignment.crnaIds.push(crna.id);

          const supervisor = pickSupervisor({
            roomSiteId: site.id,
            supervisors,
            ratioCap,
            ratioTarget,
            siteMaxRatio: rule?.maxSupervisionRatio,
            distanceMatrix,
            preferredSupervisorSiteName: rule?.supervisorFromSite,
            sites: orderedSites,
            mode: config.supervisionRatio,
          });

          if (supervisor) {
            assignment.anesthesiologistId = supervisor.providerId;
            supervisor.crnaSupervised += 1;
            if (supervisor.siteId !== site.id) {
              assignment.crossSiteSupervisor = {
                providerId: supervisor.providerId,
                fromSiteId: supervisor.siteId,
              };
            }
          } else {
            // Need to seat a new MD here as supervisor.
            const md = takeMD();
            if (!md) {
              violations.push(
                `Room ${qualify(site, room)}: no Anesthesiologist available to supervise CRNA.`,
              );
            } else {
              assignment.anesthesiologistId = md.id;
              supervisors.push({
                providerId: md.id,
                siteId: site.id,
                crnaSupervised: 1,
              });
            }
          }
          break;
        }

        case 'solo_crna_with_remote_md': {
          // CRNA staffs the room with a remote supervising MD per `supervisorFromSite`.
          const crna = takeCRNA();
          if (!crna) {
            violations.push(
              `Room ${qualify(site, room)}: no CRNA available for solo_crna_with_remote_md staffing.`,
            );
            break;
          }
          assignment.crnaIds.push(crna.id);

          const supervisor = pickSupervisor({
            roomSiteId: site.id,
            supervisors,
            ratioCap,
            ratioTarget,
            siteMaxRatio: rule?.maxSupervisionRatio,
            distanceMatrix,
            preferredSupervisorSiteName: rule?.supervisorFromSite,
            sites: orderedSites,
            mode: config.supervisionRatio,
          });

          if (supervisor) {
            assignment.anesthesiologistId = supervisor.providerId;
            supervisor.crnaSupervised += 1;
            if (supervisor.siteId !== site.id) {
              assignment.crossSiteSupervisor = {
                providerId: supervisor.providerId,
                fromSiteId: supervisor.siteId,
              };
            }
          } else {
            violations.push(
              `Room ${qualify(site, room)}: no remote Anesthesiologist supervisor reachable under supervision ratio ${config.supervisionRatio}.`,
            );
          }
          break;
        }
      }

      assignments.push(assignment);
    }
  }

  // -------------------------------------------------------------------------
  // Floats: emit ZERO. A6 (Float Strategy) owns the entire float pool and
  // post-processes the SolvedGrid + a separately-computed surplus list to
  // produce the actual float allocation (see `applyFloatStrategy` in
  // floatStrategy.ts). Emitting placeholder floats here confused A6's
  // strategy code (it would see solver-allocated floats AND its own surplus
  // candidates, with no way to tell them apart) — code-review WARN finding.
  // -------------------------------------------------------------------------
  const floats: FloatAssignment[] = [];

  return {
    configId: config.id,
    assignments,
    floats,
    violations,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface StaffingDecision {
  pattern: SiteRule['defaultStaffing'];
}

/**
 * Decide which staffing pattern to use for a room given the site rule and the
 * coverage-style toggle. Honors `fallbacks` when the style biases away from
 * the default pattern. When no rule exists, defaults to supervised_md_crna
 * (the most common pattern for general OR rooms).
 *
 * Escalation note: when `crna_heavy` + supervised ratio constraints conflict
 * (e.g. only `solo_md` available as fallback), we default to satisfying the
 * ratio toggle and surface the trade as a violation downstream.
 */
function decideStaffingPattern(
  rule: SiteRule | undefined,
  style: GridCalculatorConfig['coverageStyle'],
): StaffingDecision {
  if (!rule) {
    return { pattern: 'supervised_md_crna' };
  }

  const options: SiteRule['defaultStaffing'][] = [
    rule.defaultStaffing,
    ...(rule.fallbacks ?? []).filter(isStaffingPattern),
  ];

  // Score: lower wins. Style biases the score.
  const score = (p: SiteRule['defaultStaffing']): number => {
    const base = options.indexOf(p);
    let bias = 0;
    if (style === 'md_heavy') {
      bias = p === 'solo_md' ? -10 : p === 'supervised_md_crna' ? 0 : 2;
    } else if (style === 'crna_heavy') {
      bias = p === 'supervised_md_crna' ? -10
        : p === 'solo_crna_with_remote_md' ? -8
        : 2; // solo_md is least preferred under crna_heavy
    } else {
      // balanced: pick whichever consumes fewer scarce providers.
      // Heuristic: supervised_md_crna shares one MD across multiple CRNAs,
      // so it's typically cheaper than solo_md.
      bias = p === 'supervised_md_crna' ? -2 : p === 'solo_md' ? 0 : -1;
    }
    return base + bias;
  };

  const sorted = [...options].sort((a, b) => score(a) - score(b));
  return { pattern: sorted[0] };
}

function isStaffingPattern(s: string): s is SiteRule['defaultStaffing'] {
  return (
    s === 'solo_md' || s === 'supervised_md_crna' || s === 'solo_crna_with_remote_md'
  );
}

/** Maximum CRNAs per supervising MD for the given ratio mode. */
function supervisionRatioCap(mode: SupervisionRatioMode): number {
  switch (mode) {
    case 'mostly_1_3':
      return 3;
    case 'mostly_1_4':
      return 4;
    case 'mixed':
      return 4;
  }
}

/** Preferred ratio when the toggle has wiggle room (`mixed` prefers 1:3). */
function supervisionRatioTarget(mode: SupervisionRatioMode): number {
  switch (mode) {
    case 'mostly_1_3':
      return 3;
    case 'mostly_1_4':
      return 4;
    case 'mixed':
      return 3;
  }
}

/** Convert the "1:N" string from a SiteRule into an integer cap. */
function siteMaxRatioToInt(ratio: NonNullable<SiteRule['maxSupervisionRatio']>): number {
  switch (ratio) {
    case '1:1':
      return 1;
    case '1:2':
      return 2;
    case '1:3':
      return 3;
    case '1:4':
      return 4;
  }
}

interface SupervisorState {
  providerId: string;
  siteId: string;
  crnaSupervised: number;
}

function pickSupervisor(args: {
  roomSiteId: string;
  supervisors: SupervisorState[];
  ratioCap: number;
  ratioTarget: number;
  /**
   * Per-site cap from `SiteRule.maxSupervisionRatio`. Takes precedence over
   * the global `ratioCap` (use the tighter of the two — a per-site cap can
   * never relax a global limit, only tighten it). Undefined → no per-site cap.
   */
  siteMaxRatio?: SiteRule['maxSupervisionRatio'];
  distanceMatrix: DistanceMatrixLike;
  preferredSupervisorSiteName?: string;
  sites: GridSite[];
  mode: SupervisionRatioMode;
}): SupervisorState | null {
  const {
    roomSiteId,
    supervisors,
    ratioCap,
    ratioTarget,
    siteMaxRatio,
    distanceMatrix,
    preferredSupervisorSiteName,
    sites,
    mode,
  } = args;

  const preferredSiteId = preferredSupervisorSiteName
    ? sites.find((s) => s.name === preferredSupervisorSiteName)?.id ?? null
    : null;

  // Effective cap: the tighter of global ratioCap and the per-site
  // maxSupervisionRatio (Drift 2 fix — honors a normalizer-emitted field that
  // was previously silently dropped).
  const siteCap = siteMaxRatio ? siteMaxRatioToInt(siteMaxRatio) : Infinity;
  const effectiveCap = Math.min(ratioCap, siteCap);

  // Candidates: any supervisor with spare capacity who can reach this room.
  const candidates = supervisors
    .filter((sup) => sup.crnaSupervised < effectiveCap)
    .filter((sup) =>
      sup.siteId === roomSiteId
        ? true
        : distanceMatrix.isSupervisable(sup.siteId, roomSiteId),
    );

  if (candidates.length === 0) return null;

  // Deterministic ranking.
  candidates.sort((a, b) => {
    // 1. Honor preferred-site hint from the rule.
    if (preferredSiteId) {
      const aPref = a.siteId === preferredSiteId ? 0 : 1;
      const bPref = b.siteId === preferredSiteId ? 0 : 1;
      if (aPref !== bPref) return aPref - bPref;
    }

    // 2. Same-site supervisors before cross-site.
    const aSame = a.siteId === roomSiteId ? 0 : 1;
    const bSame = b.siteId === roomSiteId ? 0 : 1;
    if (aSame !== bSame) return aSame - bSame;

    // 3. Respect ratio target. Under `mixed`, prefer supervisors below the
    //    target (3) so the average stays near 3; allow climbing to 4 only when
    //    no lower-load candidate exists. Under `mostly_1_4` we still spread
    //    load fairly by sorting by load ascending.
    const aBelowTarget = a.crnaSupervised < ratioTarget ? 0 : 1;
    const bBelowTarget = b.crnaSupervised < ratioTarget ? 0 : 1;
    if (mode === 'mixed' && aBelowTarget !== bBelowTarget) {
      return aBelowTarget - bBelowTarget;
    }

    // 4. Spread load: lowest current count first.
    if (a.crnaSupervised !== b.crnaSupervised) {
      return a.crnaSupervised - b.crnaSupervised;
    }

    // 5. Deterministic tie-break by providerId.
    return a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0;
  });

  return candidates[0];
}

// ---------------------------------------------------------------------------
// Stable sort helpers
// ---------------------------------------------------------------------------

function stableSiteCompare(a: GridSite, b: GridSite): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function stableRoomCompare(a: GridRoom, b: GridRoom): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function stableProviderCompare(a: RosterProvider, b: RosterProvider): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function qualify(site: GridSite, room: GridRoom): string {
  return `${site.name} / ${room.name}`;
}
