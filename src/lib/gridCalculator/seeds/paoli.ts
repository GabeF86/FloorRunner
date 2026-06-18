// Paoli Hospital seed configuration for the Anesthesia Coverage Grid
// Calculator. Owned by agent A11 (Paoli Seed) per PRD §14.
//
// PURPOSE
// -------
// Single source of truth for Paoli's universe inside the universal Grid
// Calculator: sites, rooms, distance bands, default config, roster names from
// the public Paoli MD / CRNA roster photos, and per-provider leave profile
// overrides. The simulator (A7), solver (A3), float strategy (A6), and call
// burden (A8) all consume this seed verbatim when running Paoli analyses.
//
// UNIVERSALITY CONTRACT
// ---------------------
// Anything Paoli-specific lives here. The modules under `src/lib/gridCalculator/`
// stay hospital-agnostic (PRD §2, §17 risk: simulator overfitting to Paoli).
// Hospital baseline colors + icons mirror FloorRunner's
// `HOSPITAL_BASELINES['Paoli Hospital']` block in `BoardClient.tsx` so the
// rendered chips in the Grid Canvas read the same as the existing board.
//
// DISTANCE BANDS — PAOLI REALITY
// ------------------------------
// The "Main OR (4th Floor)" cluster, Endoscopy, Neuro Lab, EP Lab, and OB
// all share a single connected campus. Distances are best understood as:
//   - Main OR ↔ Endoscopy : `near`     (same floor wing, short corridor)
//   - Main OR ↔ EP Lab    : `near`     (across hall from Endo on the suite floor)
//   - Main OR ↔ Neuro Lab : `near`     (next door to EP, same floor wing)
//   - Main OR ↔ OB        : `near`     (one wing away, elevator hop — flagged
//                                       in supervision UI because of walk time)
//   - Endo ↔ EP / Neuro   : `adjacent` (same procedural-floor cluster)
//   - Endo ↔ OB           : `far`      (different floor wing, dedicated L&D
//                                       unit — supervising cross-site here is
//                                       allowed but discouraged in practice)
//   - EP ↔ Neuro          : `adjacent` (next-door labs)
//   - EP / Neuro ↔ OB     : `far`      (same constraint as Endo ↔ OB)
//
// Per `distanceMatrix.ts` defaults `near` is supervisable with a warning,
// `far` is blocked. Paoli's actual practice is to keep EP/Neuro CRNAs
// supervised from Main OR, which the seed encodes by leaving those edges
// `near` (supervisable=true) and OB at `near` so OB MD can break-relieve into
// Main OR when not busy.
//
// ROSTER — PAOLI MD / CRNA ROSTER PHOTOS
// --------------------------------------
// Names below are extracted from the public roster photos at
// `~/Desktop/Paoli MD's.png` and `~/Desktop/Paoli CRNA's.png`. These are the
// names that appear on the call/assignment board in the OR break room — used
// here only to seed test data. Stable provider IDs are derived as
// `paoli-md-<slug>` / `paoli-crna-<slug>` so the simulator output mentions
// recognizable names in the call distribution.
//
// FTE assumptions:
//   - All Anesthesiologists default to 1.0 FTE (the MD roster photo does not
//     break out partial FTE; Gabriel can override per-provider in the seed).
//   - Full-time CRNAs default to 1.0 FTE.
//   - Per Diem CRNAs default to 0.5 FTE (matches "as-needed" usage typical
//     of per diem appointments).
//
// LEAVE PROFILES
// --------------
// Defaults per role per PRD §10 and `providerProfile.ts`:
//   - 1.0 FTE Anesthesiologist:  4 weeks PTO, 5 sick, 5 CME.
//   - 1.0 FTE CRNA:              4 weeks PTO, 5 sick, 5 CME.
//   - 0.5 FTE per diem CRNA:     2 weeks PTO, 3 sick, 0 CME.
//   - One CRNA flagged maternity_eligible (per PRD §10 worst-case maternity
//     hold-out — picks the first alphabetical full-time CRNA).
//   - Two providers flagged fmla_eligible (one MD, one CRNA — distributed so
//     the worst-case path exercises both code paths in the simulator).

import { ORDERED_BANDS } from '../distanceMatrix';
import type { ProviderLeaveProfile } from '../providerProfile';
import type { RosterProvider } from '../solver';
import type {
  CoverageRuleSet,
  DistanceEdge,
  GridCalculatorConfig,
  GridSite,
} from '../types';

// ---------------------------------------------------------------------------
// Stable IDs — keep these top-level constants so distance edges and the
// distance matrix index can reference them unambiguously.
// ---------------------------------------------------------------------------

export const PAOLI_SITE_IDS = {
  mainOR: 'paoli-site-main-or',
  endoscopy: 'paoli-site-endoscopy',
  neuro: 'paoli-site-neuro',
  epLab: 'paoli-site-ep-lab',
  ob: 'paoli-site-ob',
  float: 'paoli-site-float',
} as const;

// ---------------------------------------------------------------------------
// Default config — sensible Paoli defaults per PRD §8 toggle semantics.
// ---------------------------------------------------------------------------

/**
 * Paoli default toggle state. `balanced` coverage + `mostly_1_3` supervision
 * + `balanced` float strategy + `conservative` backup-call posture match
 * Paoli's stated practice: 1:3 with occasional 1:4 only when distance is
 * trivial, two float CRNAs (one biased toward breaks, one toward emergency
 * coverage), and a small number of providers carrying backup call rather
 * than dribbling backup across the whole roster.
 */
export const paoliConfig: GridCalculatorConfig = {
  id: 'paoli-default',
  hospital: 'Paoli Hospital',
  name: 'Paoli — Default Weekday',
  coverageStyle: 'balanced',
  supervisionRatio: 'mostly_1_3',
  floatStrategy: 'balanced',
  backupCallPosture: 'conservative',
};

// ---------------------------------------------------------------------------
// Sites + rooms — colors / icons mirror FloorRunner's HOSPITAL_BASELINES.
// ---------------------------------------------------------------------------

function makeRooms(
  siteId: string,
  count: number,
  namePrefix: string,
): GridSite['rooms'] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${siteId}-r${i + 1}`,
    siteId,
    name: count === 1 ? namePrefix : `${namePrefix} ${i + 1}`,
    position: i,
  }));
}

/**
 * Paoli sites in canonical sidebar order. Main OR first (largest, leftmost
 * lane); off-sites by suite proximity; OB last among "fixed" sites because
 * it's the most remote; Float lane pinned absolute-last per PRD §7 visual
 * rule.
 */
export const paoliSites: GridSite[] = [
  {
    id: PAOLI_SITE_IDS.mainOR,
    name: 'Main OR',
    shortName: 'OR',
    color: '#0ea5e9',
    icon: '🏥',
    position: 0,
    caption: '4th Floor',
    rooms: makeRooms(PAOLI_SITE_IDS.mainOR, 15, 'OR'),
  },
  {
    id: PAOLI_SITE_IDS.endoscopy,
    name: 'Endoscopy',
    shortName: 'Endo',
    color: '#10b981',
    icon: '🔬',
    position: 1,
    caption: 'GI suite',
    rooms: makeRooms(PAOLI_SITE_IDS.endoscopy, 2, 'Endo'),
  },
  {
    id: PAOLI_SITE_IDS.neuro,
    name: 'Neuro',
    shortName: 'Neuro',
    color: '#a78bfa',
    icon: '🧠',
    position: 2,
    caption: 'Neurointerventional',
    rooms: makeRooms(PAOLI_SITE_IDS.neuro, 1, 'Neuro'),
  },
  {
    id: PAOLI_SITE_IDS.epLab,
    name: 'EP Lab',
    shortName: 'EP',
    color: '#f59e0b',
    icon: '⚡',
    position: 3,
    caption: 'Electrophysiology',
    rooms: makeRooms(PAOLI_SITE_IDS.epLab, 1, 'EP'),
  },
  {
    id: PAOLI_SITE_IDS.ob,
    name: 'OB',
    shortName: 'OB',
    color: '#f472b6',
    icon: '👶',
    position: 4,
    caption: 'L&D / one wing away',
    rooms: makeRooms(PAOLI_SITE_IDS.ob, 1, 'OB'),
  },
  // Float lane — pinned last per PRD §7 visual rule. Holds zero rooms; the
  // float strategy emits FloatAssignments under leansToSiteId, not rooms.
  {
    id: PAOLI_SITE_IDS.float,
    name: 'Float',
    shortName: 'Float',
    color: '#80cbc4',
    icon: '🔄',
    position: 99,
    caption: 'Break / emergency pool',
    rooms: [],
  },
];

// ---------------------------------------------------------------------------
// Distance edges — explicit bands for every meaningful pair.
// ---------------------------------------------------------------------------

/**
 * Build a single edge; honors the band default for supervisability unless
 * the caller overrides it. Same conventions as `defaultBandSupervisability`
 * in `distanceMatrix.ts`.
 */
function edge(
  siteA: string,
  siteB: string,
  band: DistanceEdge['band'],
  override?: boolean,
): DistanceEdge {
  const supervisable =
    override !== undefined
      ? override
      : band === 'same_room' || band === 'adjacent' || band === 'near';
  return { siteA, siteB, band, supervisable };
}

/**
 * Paoli's distance matrix.
 *
 * Encoded reality (paraphrasing the file header):
 *   - Main OR ↔ procedural suites (Endo, EP, Neuro) are all `near` — same
 *     floor, short corridors. Supervision is practiced.
 *   - Procedural suites are `adjacent` to each other (Endo↔EP, EP↔Neuro,
 *     Neuro↔Endo) — they cluster on the same floor.
 *   - OB is `near` to Main OR (one wing away, but the OB MD does break-
 *     relief in Main OR routinely). Supervisable=true so the OB lane can
 *     "lend" the MD when L&D is quiet.
 *   - OB ↔ Endoscopy / EP / Neuro is `far` — different floor wings, not a
 *     practiced supervision path.
 *   - Float lane intentionally has no edges; the float strategy uses
 *     `leansTo` which is independent of distance edges.
 */
export const paoliDistanceEdges: DistanceEdge[] = [
  // Main OR <-> everything else
  edge(PAOLI_SITE_IDS.mainOR, PAOLI_SITE_IDS.endoscopy, 'near'),
  edge(PAOLI_SITE_IDS.mainOR, PAOLI_SITE_IDS.epLab, 'near'),
  edge(PAOLI_SITE_IDS.mainOR, PAOLI_SITE_IDS.neuro, 'near'),
  edge(PAOLI_SITE_IDS.mainOR, PAOLI_SITE_IDS.ob, 'near'),

  // Procedural cluster — adjacent pairings
  edge(PAOLI_SITE_IDS.endoscopy, PAOLI_SITE_IDS.epLab, 'adjacent'),
  edge(PAOLI_SITE_IDS.endoscopy, PAOLI_SITE_IDS.neuro, 'adjacent'),
  edge(PAOLI_SITE_IDS.epLab, PAOLI_SITE_IDS.neuro, 'adjacent'),

  // OB out of suite — far from procedural cluster
  edge(PAOLI_SITE_IDS.endoscopy, PAOLI_SITE_IDS.ob, 'far'),
  edge(PAOLI_SITE_IDS.epLab, PAOLI_SITE_IDS.ob, 'far'),
  edge(PAOLI_SITE_IDS.neuro, PAOLI_SITE_IDS.ob, 'far'),
];

// Re-export the band list so downstream consumers can render the dropdown
// without re-importing from `distanceMatrix.ts`.
export const PAOLI_BANDS = ORDERED_BANDS;

// ---------------------------------------------------------------------------
// Coverage rules — pre-normalized seed for tests / first-render before the
// rules normalizer runs. The free-text source of truth is in
// `paoli.guidelines.md`. These structured rules MUST stay consistent with
// the free text — if the text changes, A4's normalizer should re-emit this
// shape with the same site references.
// ---------------------------------------------------------------------------

export const paoliRules: CoverageRuleSet = {
  siteRules: [
    {
      site: 'Main OR',
      defaultStaffing: 'supervised_md_crna',
      maxSupervisionRatio: '1:3',
      notes:
        'Mostly 1:3 with occasional 1:4 when distance is trivial. Floor Runner MD caps at 3.',
    },
    {
      site: 'Endoscopy',
      defaultStaffing: 'solo_md',
      fallbacks: ['supervised_md_crna'],
      auxiliaryRole: 'break_relief',
      notes: 'Endo MD covers GI solo; can run TEEs / cardioversions when quiet.',
    },
    {
      site: 'EP Lab',
      defaultStaffing: 'supervised_md_crna',
      supervisorFromSite: 'Main OR',
      maxSupervisionRatio: '1:3',
      notes: 'CRNA in room; supervising MD sits in Main OR.',
    },
    {
      site: 'Neuro',
      defaultStaffing: 'supervised_md_crna',
      supervisorFromSite: 'Main OR',
      maxSupervisionRatio: '1:3',
      notes: 'CRNA in room; supervising MD sits in Main OR. Neuro add-on common.',
    },
    {
      site: 'OB',
      defaultStaffing: 'solo_md',
      auxiliaryRole: 'break_relief',
      maxSupervisionRatio: '1:3',
      notes: 'Solo OB MD; floats to Main OR for break relief when L&D is quiet.',
    },
  ],
  globalRules: [
    {
      kind: 'floor_runner',
      payload: {
        site: 'Main OR',
        maxSupervisionRatio: '1:3',
        responsibilities: [
          'schedule_management',
          'intubations',
          'epidurals',
          'break_relief',
        ],
      },
    },
    {
      kind: 'trauma_contingency',
      payload: {
        site: 'Main OR',
        coveredBy: 'float_crna_under_least_loaded_main_or_md',
        traumaProbability: 0.2,
      },
    },
    {
      kind: 'weekend_pattern',
      payload: {
        mainOrRoomsStaffed: 4,
        obSolo: true,
        endoSolo: true,
        notes: 'Reduced room count; same role assignments as weekday call team.',
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Raw free-text guidelines string. Inlined so the seed module is fully self-
// contained — A4's normalizer can consume this directly without reading from
// disk. The single source of truth is still `paoli.guidelines.md`; both must
// stay in lockstep. If you edit one, edit the other.
// ---------------------------------------------------------------------------

export const paoliGuidelinesText: string =
  'Paoli Hospital is a community hospital with a Main OR cluster on the 4th ' +
  'floor that contains 15 anesthetizing rooms, an Endoscopy suite on the ' +
  'same campus with two rooms, a single Neuro interventional lab, a single ' +
  'EP Lab, and a single OB / L&D unit one wing away from the Main OR. We ' +
  'staff Endoscopy as a solo Anesthesiologist who covers the GI list ' +
  'independently and can also provide TEEs and cardioversions when the Main ' +
  'OR is quiet. OB is staffed by a solo Anesthesiologist dedicated to L&D, ' +
  'epidurals, and C-sections; when OB is not busy that Anesthesiologist ' +
  'becomes a break-relief auxiliary who helps cover the Main OR. The EP Lab ' +
  'and Neuro Lab each run one CRNA who is supervised cross-site by an ' +
  'Anesthesiologist sitting in the Main OR; supervision at those off-sites ' +
  'is capped at 1:3 because of the walk distance. We never supervise more ' +
  'than 1:3 at OB. Inside the Main OR, the default supervision target is ' +
  'mostly 1:3 with some 1:4 acceptable when distance is trivial. One ' +
  'Anesthesiologist on the Main OR floor each day is designated the Floor ' +
  'Runner: they hold a cap of 3 CRNAs, run schedule management, do ' +
  'intubations, place epidurals, and float to whichever room needs help; ' +
  'this role is mandatory every weekday. Weekends use the same OB solo + ' +
  'Endo solo + Main OR call team pattern but with reduced room count ' +
  '(roughly four Main OR rooms staffed plus call coverage). Trauma cases ' +
  'land in the Main OR cluster; if a trauma is called, a float CRNA covers ' +
  'the trauma room under the least-loaded Main OR supervising ' +
  'Anesthesiologist, with the Floor Runner backing up if TEEs are ' +
  'concurrently active. Neuro add-on cases that arrive after hours can be ' +
  'absorbed by an MD float when available; otherwise the off-site CRNA is ' +
  'the first responder. Break relief is provided by two float CRNAs in the ' +
  'standard staffing pattern; when an MD float is on the schedule instead, ' +
  'the MD float covers TEEs solo and provides one of the two break floats’ ' +
  'work, leaving a single CRNA float in the pool.';

// ---------------------------------------------------------------------------
// Roster — extracted from the Paoli MD / CRNA roster photos.
// ---------------------------------------------------------------------------

/** Convert a last-name (or "F. LastName") to a stable slug. */
function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+srna$/i, '-srna')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

interface RawProvider {
  /** Display name as it appears in the roster photo. */
  name: string;
  role: 'anesthesiologist' | 'crna';
  fte: number;
  homeSiteId?: string;
}

/**
 * Anesthesiologists from `Paoli MD's.png` — alphabetical as written on the
 * photo. 14 names; the "MD x 630" header text in the photo is a count/code
 * artifact, not a provider.
 */
const RAW_MDS: RawProvider[] = [
  { name: 'Amusa', role: 'anesthesiologist', fte: 1.0 },
  { name: 'Chamchad', role: 'anesthesiologist', fte: 1.0 },
  { name: 'Farkas', role: 'anesthesiologist', fte: 1.0 },
  { name: 'Havildar', role: 'anesthesiologist', fte: 1.0 },
  { name: 'Horan', role: 'anesthesiologist', fte: 1.0 },
  { name: 'Jones', role: 'anesthesiologist', fte: 1.0 },
  { name: 'Kalawadia', role: 'anesthesiologist', fte: 1.0 },
  { name: 'Lin', role: 'anesthesiologist', fte: 1.0 },
  { name: 'Mojica', role: 'anesthesiologist', fte: 1.0 },
  { name: 'Nagar', role: 'anesthesiologist', fte: 1.0 },
  { name: 'Orji', role: 'anesthesiologist', fte: 1.0 },
  { name: 'Simon', role: 'anesthesiologist', fte: 1.0 },
  { name: 'Vu', role: 'anesthesiologist', fte: 1.0 },
  { name: 'Wadhwani', role: 'anesthesiologist', fte: 1.0 },
];

/**
 * Full-time CRNAs from `Paoli CRNA's.png`. Names with first-initial
 * disambiguators (e.g. "C. Brenneman", "R. Brenneman") preserved verbatim.
 * "M. Corbett SRNA" / "S. Peckman SRNA" are student CRNAs working toward
 * full credentials — modeled as 1.0 FTE CRNAs for staffing math purposes
 * (Gabriel can lower them in a refined seed if SRNAs only count partial).
 */
const RAW_CRNAS: RawProvider[] = [
  { name: 'C. Brenneman', role: 'crna', fte: 1.0 },
  { name: 'R. Brenneman', role: 'crna', fte: 1.0 },
  { name: 'C. Caffes', role: 'crna', fte: 1.0 },
  { name: 'K. Comstock', role: 'crna', fte: 1.0 },
  { name: 'H. Ford', role: 'crna', fte: 1.0 },
  { name: 'V. Geraci', role: 'crna', fte: 1.0 },
  { name: 'J. Glickman', role: 'crna', fte: 1.0 },
  { name: 'R. Hartman', role: 'crna', fte: 1.0 },
  { name: 'J. Hessel', role: 'crna', fte: 1.0 },
  { name: 'D. Kamensky', role: 'crna', fte: 1.0 },
  { name: 'S. Marburger', role: 'crna', fte: 1.0 },
  { name: 'D. Murphy', role: 'crna', fte: 1.0 },
  { name: 'R. O\'Donnell', role: 'crna', fte: 1.0 },
  { name: 'M. Olivio', role: 'crna', fte: 1.0 },
  { name: 'J. Pisciella', role: 'crna', fte: 1.0 },
  { name: 'M. Roy', role: 'crna', fte: 1.0 },
  { name: 'M. Segrin', role: 'crna', fte: 1.0 },
  { name: 'P. Swift', role: 'crna', fte: 1.0 },
  { name: 'L. Ujobai', role: 'crna', fte: 1.0 },
  { name: 'A. Williamson', role: 'crna', fte: 1.0 },
  { name: 'A. Zolnowski', role: 'crna', fte: 1.0 },
  { name: 'M. Corbett SRNA', role: 'crna', fte: 1.0 },
  { name: 'S. Peckman SRNA', role: 'crna', fte: 1.0 },
  { name: 'Jackson', role: 'crna', fte: 1.0 },
];

/**
 * Per Diem CRNAs from the same photo. Defaulted to 0.5 FTE per the file
 * header — "as needed" appointments are typically half-time effective.
 */
const RAW_PER_DIEM_CRNAS: RawProvider[] = [
  { name: 'L. Brice', role: 'crna', fte: 0.5 },
  { name: 'C. Dabagian', role: 'crna', fte: 0.5 },
  { name: 'V. Dinh', role: 'crna', fte: 0.5 },
  { name: 'L. Discher', role: 'crna', fte: 0.5 },
  { name: 'M. Huggins', role: 'crna', fte: 0.5 },
  { name: 'Y. Salsabil', role: 'crna', fte: 0.5 },
];

/**
 * Project a roster-photo entry to a stable `RosterProvider`. IDs are
 * deterministic so re-running the simulator with the same seed produces
 * byte-identical assignment outputs.
 */
function toRosterProvider(raw: RawProvider, prefix: string): RosterProvider {
  return {
    id: `paoli-${prefix}-${slug(raw.name)}`,
    role: raw.role,
    fte: raw.fte,
    homeSiteId: raw.homeSiteId,
  };
}

/**
 * The full Paoli roster — 14 Anesthesiologists + 24 full-time CRNAs +
 * 6 per-diem CRNAs (1.0 FTE × 38, plus 6 × 0.5 = effective FTE ~41 across
 * 44 people). Order matches the photo so debugging the simulator output is
 * mappable back to the source documents.
 */
export const paoliRoster: RosterProvider[] = [
  ...RAW_MDS.map((r) => toRosterProvider(r, 'md')),
  ...RAW_CRNAS.map((r) => toRosterProvider(r, 'crna')),
  ...RAW_PER_DIEM_CRNAS.map((r) => toRosterProvider(r, 'crna-pd')),
];

/** Resolve a roster entry by display name — handy in test assertions. */
export function paoliProviderId(displayName: string, prefix = 'crna'): string {
  return `paoli-${prefix}-${slug(displayName)}`;
}

// ---------------------------------------------------------------------------
// Leave profiles — per-provider overrides feeding the simulator.
// ---------------------------------------------------------------------------

/**
 * Build a default leave profile for a Paoli provider.
 *
 * Conventions:
 *   - 1.0 FTE: 4 weeks PTO, 5 sick days, 5 CME days.
 *   - 0.5 FTE (per diem): 2 weeks PTO, 3 sick days, 0 CME days
 *     (per diem appointments rarely come with CME allowance).
 */
function defaultProfileFor(p: RosterProvider): Partial<ProviderLeaveProfile> {
  const isPartTime = p.fte < 1.0;
  return {
    provider_id: p.id,
    pto_weeks: isPartTime ? 2 : 4,
    sick_days_per_year: isPartTime ? 3 : 5,
    cme_days_per_year: isPartTime ? 0 : 5,
    maternity_eligible: false,
    fmla_eligible: false,
    backup_call_share_target: null,
    max_consecutive_post_call_days: 1,
  };
}

/**
 * Per-provider leave profile overrides. Keyed by provider id (same id as
 * `paoliRoster`). Every roster member is included so the simulator never
 * falls back to silent defaults — when the photo doesn't tell us anything
 * special, we still record an explicit `defaultProfileFor` entry to make
 * Paoli's assumptions auditable.
 *
 * Special flags applied:
 *   - First alphabetical full-time CRNA marked maternity_eligible.
 *   - Second alphabetical full-time CRNA marked fmla_eligible.
 *   - First alphabetical Anesthesiologist marked fmla_eligible.
 *
 * These selections are arbitrary but deterministic — any provider's flags
 * should be explicitly overridden once Paoli's actual leave profile is
 * known. The escalation rule in the test header captures this.
 */
export const paoliLeaveProfiles: Record<string, Partial<ProviderLeaveProfile>> = (() => {
  const out: Record<string, Partial<ProviderLeaveProfile>> = {};

  for (const p of paoliRoster) {
    out[p.id] = defaultProfileFor(p);
  }

  // Apply special flags — deterministic picks for PRD §10 worst-case path.
  const firstFullTimeCrna = paoliRoster.find(
    (p) => p.role === 'crna' && p.fte >= 1.0,
  );
  if (firstFullTimeCrna) {
    out[firstFullTimeCrna.id] = {
      ...out[firstFullTimeCrna.id],
      maternity_eligible: true,
    };
  }

  const fullTimeCrnas = paoliRoster.filter(
    (p) => p.role === 'crna' && p.fte >= 1.0,
  );
  if (fullTimeCrnas[1]) {
    out[fullTimeCrnas[1].id] = {
      ...out[fullTimeCrnas[1].id],
      fmla_eligible: true,
    };
  }

  const firstMd = paoliRoster.find((p) => p.role === 'anesthesiologist');
  if (firstMd) {
    out[firstMd.id] = {
      ...out[firstMd.id],
      fmla_eligible: true,
    };
  }

  return out;
})();

// ---------------------------------------------------------------------------
// Convenience: a single bundle the simulator entry point can read in one go.
// ---------------------------------------------------------------------------

/**
 * One-stop import for tests / docs / the upcoming `/grid-calculator` page.
 * Wraps every seed export above so callers don't have to thread 6 imports.
 */
export const paoliSeed = {
  config: paoliConfig,
  sites: paoliSites,
  distanceEdges: paoliDistanceEdges,
  rules: paoliRules,
  guidelinesText: paoliGuidelinesText,
  roster: paoliRoster,
  leaveProfiles: paoliLeaveProfiles,
} as const;
