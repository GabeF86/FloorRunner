// Mid-Sized Regional Hospital starter template.
// Owned by agent A17 (Universal Library).
//
// Shape (Paoli-shaped but generic):
//   - 12 Main OR rooms, 2 Endoscopy, 1 Neuro lab, 1 EP lab, 1 OB.
//   - Distance: Main OR `near` / `adjacent` to procedural cluster;
//     OB `far` from the procedural suite (a different wing).
//   - Coverage default: balanced + 1:3 + balanced floats + conservative.
//
// Generic vocabulary — references the "Coordinator" role concept in the
// guidelinesText rather than any hospital-specific job title. The shape
// matches Paoli's geometry so the wizard can demonstrate cross-site
// supervision out of the box.

import type { DistanceEdge, GridSite } from '../../types';
import type { GridTemplate } from './types';

const MID_SITE_IDS = {
  mainOR: 'site-mainor',
  endoscopy: 'site-endoscopy',
  neuro: 'site-neuro',
  epLab: 'site-ep-lab',
  ob: 'site-ob',
  float: 'site-float',
} as const;

function makeRooms(siteId: string, count: number, prefix: string): GridSite['rooms'] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${siteId}-r${i + 1}`,
    siteId,
    name: count === 1 ? prefix : `${prefix} ${i + 1}`,
    position: i,
  }));
}

const sites: GridSite[] = [
  {
    id: MID_SITE_IDS.mainOR,
    name: 'Main OR',
    shortName: 'OR',
    color: '#0ea5e9',
    icon: '🏥',
    position: 0,
    caption: 'Surgical suite',
    rooms: makeRooms(MID_SITE_IDS.mainOR, 12, 'OR'),
  },
  {
    id: MID_SITE_IDS.endoscopy,
    name: 'Endoscopy',
    shortName: 'Endo',
    color: '#10b981',
    icon: '🔬',
    position: 1,
    caption: 'GI suite',
    rooms: makeRooms(MID_SITE_IDS.endoscopy, 2, 'Endo'),
  },
  {
    id: MID_SITE_IDS.neuro,
    name: 'Neuro',
    shortName: 'Neuro',
    color: '#a78bfa',
    icon: '🧠',
    position: 2,
    caption: 'Neurointerventional',
    rooms: makeRooms(MID_SITE_IDS.neuro, 1, 'Neuro'),
  },
  {
    id: MID_SITE_IDS.epLab,
    name: 'EP Lab',
    shortName: 'EP',
    color: '#f59e0b',
    icon: '⚡',
    position: 3,
    caption: 'Electrophysiology',
    rooms: makeRooms(MID_SITE_IDS.epLab, 1, 'EP'),
  },
  {
    id: MID_SITE_IDS.ob,
    name: 'OB',
    shortName: 'OB',
    color: '#f472b6',
    icon: '👶',
    position: 4,
    caption: 'L&D / different wing',
    rooms: makeRooms(MID_SITE_IDS.ob, 1, 'OB'),
  },
  {
    id: MID_SITE_IDS.float,
    name: 'Float',
    shortName: 'Float',
    color: '#80cbc4',
    icon: '🔄',
    position: 99,
    caption: 'Break / emergency pool',
    rooms: [],
  },
];

/**
 * Mid-sized regional geometry:
 *   - Main OR <-> procedural cluster (Endo, Neuro, EP) → `near` (same floor wing).
 *   - Procedural pairs → `adjacent` (next-door labs).
 *   - OB → `far` from procedural cluster, but `near` from Main OR so the OB
 *     Anesthesiologist can still break-relieve into the main suite.
 */
const distanceEdges: DistanceEdge[] = [
  // Main OR ↔ everything else
  { siteA: MID_SITE_IDS.mainOR, siteB: MID_SITE_IDS.endoscopy, band: 'near', supervisable: true },
  { siteA: MID_SITE_IDS.mainOR, siteB: MID_SITE_IDS.neuro, band: 'near', supervisable: true },
  { siteA: MID_SITE_IDS.mainOR, siteB: MID_SITE_IDS.epLab, band: 'near', supervisable: true },
  { siteA: MID_SITE_IDS.mainOR, siteB: MID_SITE_IDS.ob, band: 'near', supervisable: true },

  // Procedural cluster — adjacent pairings
  { siteA: MID_SITE_IDS.endoscopy, siteB: MID_SITE_IDS.epLab, band: 'adjacent', supervisable: true },
  { siteA: MID_SITE_IDS.endoscopy, siteB: MID_SITE_IDS.neuro, band: 'adjacent', supervisable: true },
  { siteA: MID_SITE_IDS.epLab, siteB: MID_SITE_IDS.neuro, band: 'adjacent', supervisable: true },

  // OB ↔ procedural cluster — far (different wing)
  { siteA: MID_SITE_IDS.endoscopy, siteB: MID_SITE_IDS.ob, band: 'far', supervisable: false },
  { siteA: MID_SITE_IDS.epLab, siteB: MID_SITE_IDS.ob, band: 'far', supervisable: false },
  { siteA: MID_SITE_IDS.neuro, siteB: MID_SITE_IDS.ob, band: 'far', supervisable: false },
];

/**
 * Generic guidelines text. Vocabulary intentionally mirrors PRD §9's
 * example shape so A4's normalizer parses every sentence without expansion.
 * The "Coordinator" wording is a generic translation of the role concept —
 * not a verbatim copy of any hospital's job title.
 */
const guidelinesText: string =
  'We are a mid-sized regional hospital with a Main OR suite of about ' +
  'twelve anesthetizing rooms, an Endoscopy suite with two rooms on the ' +
  'same floor, a single Neuro interventional lab, a single EP lab, and a ' +
  'single OB / L&D unit one wing away from the Main OR. We staff ' +
  'Endoscopy as a solo Anesthesiologist who covers the GI list and can ' +
  'provide TEEs and cardioversions when the Main OR is quiet. OB is ' +
  'staffed by a solo Anesthesiologist dedicated to L&D, epidurals, and ' +
  'C-sections; when OB is not busy that Anesthesiologist helps with break ' +
  'relief in the Main OR. The EP Lab and Neuro Lab each run one CRNA ' +
  'supervised cross-site by an Anesthesiologist sitting in the Main OR; ' +
  'supervision at those off-sites is capped at 1:3 because of the walk ' +
  'distance. We never supervise more than 1:3 at OB. Inside the Main OR ' +
  'the default supervision target is mostly 1:3 with some 1:4 acceptable ' +
  'when distance is trivial. One Anesthesiologist on the Main OR floor ' +
  'each day plays a Coordinator role: they cap their supervision at 1:3, ' +
  'run schedule management, do intubations, place epidurals, and float to ' +
  'whichever room needs help.';

export const midRegionalTemplate: GridTemplate = {
  id: 'mid_regional',
  name: 'Mid-sized regional hospital',
  description:
    'Regional hospital with a 10–15 room Main OR, plus Endoscopy, Neuro, ' +
    'EP, and OB sites. Includes cross-site supervision from the Main OR.',
  sites,
  distanceEdges,
  guidelinesText,
  defaultConfig: {
    coverageStyle: 'balanced',
    supervisionRatio: 'mostly_1_3',
    floatStrategy: 'balanced',
    backupCallPosture: 'conservative',
  },
};
