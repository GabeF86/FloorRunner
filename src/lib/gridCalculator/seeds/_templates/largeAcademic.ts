// Large Academic Medical Center starter template.
// Owned by agent A17 (Universal Library).
//
// Shape:
//   - 25 Main OR rooms, 4 Endoscopy, 2 Neuro, 2 EP, 2 OB, 2 Cath, 2 IR,
//     2 offsite Radiology — multi-building campus.
//   - Distance: a "main campus" cluster (Main OR + procedural cluster +
//     OB) and an "offsite tower" cluster (Cath, IR, Radiology). Tower
//     edges are `off_campus` from Main OR.
//   - Coverage default: balanced + mixed (mostly 1:3, some 1:4) +
//     emergency_priority floats + aggressive backup-call.
//
// Generic vocabulary throughout — references the "Coordinator" role
// concept rather than any hospital-specific job title.

import type { DistanceEdge, GridSite } from '../../types';
import type { GridTemplate } from './types';

const LARGE_SITE_IDS = {
  mainOR: 'site-mainor',
  endoscopy: 'site-endoscopy',
  neuro: 'site-neuro',
  epLab: 'site-ep-lab',
  ob: 'site-ob',
  cath: 'site-cath',
  ir: 'site-ir',
  radiology: 'site-radiology',
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
    id: LARGE_SITE_IDS.mainOR,
    name: 'Main OR',
    shortName: 'OR',
    color: '#0ea5e9',
    icon: '🏥',
    position: 0,
    caption: 'Main hospital tower',
    rooms: makeRooms(LARGE_SITE_IDS.mainOR, 25, 'OR'),
  },
  {
    id: LARGE_SITE_IDS.endoscopy,
    name: 'Endoscopy',
    shortName: 'Endo',
    color: '#10b981',
    icon: '🔬',
    position: 1,
    caption: 'GI suite',
    rooms: makeRooms(LARGE_SITE_IDS.endoscopy, 4, 'Endo'),
  },
  {
    id: LARGE_SITE_IDS.neuro,
    name: 'Neuro',
    shortName: 'Neuro',
    color: '#a78bfa',
    icon: '🧠',
    position: 2,
    caption: 'Neurointerventional',
    rooms: makeRooms(LARGE_SITE_IDS.neuro, 2, 'Neuro'),
  },
  {
    id: LARGE_SITE_IDS.epLab,
    name: 'EP Lab',
    shortName: 'EP',
    color: '#f59e0b',
    icon: '⚡',
    position: 3,
    caption: 'Electrophysiology',
    rooms: makeRooms(LARGE_SITE_IDS.epLab, 2, 'EP'),
  },
  {
    id: LARGE_SITE_IDS.ob,
    name: 'OB',
    shortName: 'OB',
    color: '#f472b6',
    icon: '👶',
    position: 4,
    caption: 'L&D / different wing',
    rooms: makeRooms(LARGE_SITE_IDS.ob, 2, 'OB'),
  },
  {
    id: LARGE_SITE_IDS.cath,
    name: 'Cath Lab',
    shortName: 'Cath',
    color: '#ef4444',
    icon: '🫀',
    position: 5,
    caption: 'Cardiac tower (offsite)',
    rooms: makeRooms(LARGE_SITE_IDS.cath, 2, 'Cath'),
  },
  {
    id: LARGE_SITE_IDS.ir,
    name: 'IR',
    shortName: 'IR',
    color: '#fb923c',
    icon: '🩻',
    position: 6,
    caption: 'Interventional radiology (offsite)',
    rooms: makeRooms(LARGE_SITE_IDS.ir, 2, 'IR'),
  },
  {
    id: LARGE_SITE_IDS.radiology,
    name: 'Radiology',
    shortName: 'Rads',
    color: '#94a3b8',
    icon: '📷',
    position: 7,
    caption: 'Imaging center (offsite)',
    rooms: makeRooms(LARGE_SITE_IDS.radiology, 2, 'Rads'),
  },
  {
    id: LARGE_SITE_IDS.float,
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
 * Large academic geometry:
 *   - Main OR <-> procedural cluster (Endo, Neuro, EP) → `near`.
 *   - Procedural pairs → `adjacent`.
 *   - OB → `far` from procedural cluster (different wing), `near` from
 *     Main OR for break-relief loops.
 *   - Cath, IR, Radiology → `off_campus` from the main hospital tower
 *     (a separate tower). They form their own offsite cluster where
 *     Cath ↔ IR ↔ Radiology are `adjacent`.
 *
 * Per `distanceMatrix.ts` defaults, `off_campus` is blocked from
 * supervision — these offsites need their own MD physically present.
 */
const distanceEdges: DistanceEdge[] = [
  // Main OR ↔ on-campus procedural cluster
  { siteA: LARGE_SITE_IDS.mainOR, siteB: LARGE_SITE_IDS.endoscopy, band: 'near', supervisable: true },
  { siteA: LARGE_SITE_IDS.mainOR, siteB: LARGE_SITE_IDS.neuro, band: 'near', supervisable: true },
  { siteA: LARGE_SITE_IDS.mainOR, siteB: LARGE_SITE_IDS.epLab, band: 'near', supervisable: true },
  { siteA: LARGE_SITE_IDS.mainOR, siteB: LARGE_SITE_IDS.ob, band: 'near', supervisable: true },

  // Procedural cluster — adjacent pairings
  { siteA: LARGE_SITE_IDS.endoscopy, siteB: LARGE_SITE_IDS.epLab, band: 'adjacent', supervisable: true },
  { siteA: LARGE_SITE_IDS.endoscopy, siteB: LARGE_SITE_IDS.neuro, band: 'adjacent', supervisable: true },
  { siteA: LARGE_SITE_IDS.epLab, siteB: LARGE_SITE_IDS.neuro, band: 'adjacent', supervisable: true },

  // OB ↔ procedural cluster — far
  { siteA: LARGE_SITE_IDS.endoscopy, siteB: LARGE_SITE_IDS.ob, band: 'far', supervisable: false },
  { siteA: LARGE_SITE_IDS.epLab, siteB: LARGE_SITE_IDS.ob, band: 'far', supervisable: false },
  { siteA: LARGE_SITE_IDS.neuro, siteB: LARGE_SITE_IDS.ob, band: 'far', supervisable: false },

  // Offsite tower (Cath, IR, Radiology) → off_campus from Main OR & cluster
  { siteA: LARGE_SITE_IDS.mainOR, siteB: LARGE_SITE_IDS.cath, band: 'off_campus', supervisable: false },
  { siteA: LARGE_SITE_IDS.mainOR, siteB: LARGE_SITE_IDS.ir, band: 'off_campus', supervisable: false },
  { siteA: LARGE_SITE_IDS.mainOR, siteB: LARGE_SITE_IDS.radiology, band: 'off_campus', supervisable: false },
  { siteA: LARGE_SITE_IDS.endoscopy, siteB: LARGE_SITE_IDS.cath, band: 'off_campus', supervisable: false },
  { siteA: LARGE_SITE_IDS.endoscopy, siteB: LARGE_SITE_IDS.ir, band: 'off_campus', supervisable: false },
  { siteA: LARGE_SITE_IDS.endoscopy, siteB: LARGE_SITE_IDS.radiology, band: 'off_campus', supervisable: false },
  { siteA: LARGE_SITE_IDS.neuro, siteB: LARGE_SITE_IDS.cath, band: 'off_campus', supervisable: false },
  { siteA: LARGE_SITE_IDS.neuro, siteB: LARGE_SITE_IDS.ir, band: 'off_campus', supervisable: false },
  { siteA: LARGE_SITE_IDS.neuro, siteB: LARGE_SITE_IDS.radiology, band: 'off_campus', supervisable: false },
  { siteA: LARGE_SITE_IDS.epLab, siteB: LARGE_SITE_IDS.cath, band: 'off_campus', supervisable: false },
  { siteA: LARGE_SITE_IDS.epLab, siteB: LARGE_SITE_IDS.ir, band: 'off_campus', supervisable: false },
  { siteA: LARGE_SITE_IDS.epLab, siteB: LARGE_SITE_IDS.radiology, band: 'off_campus', supervisable: false },
  { siteA: LARGE_SITE_IDS.ob, siteB: LARGE_SITE_IDS.cath, band: 'off_campus', supervisable: false },
  { siteA: LARGE_SITE_IDS.ob, siteB: LARGE_SITE_IDS.ir, band: 'off_campus', supervisable: false },
  { siteA: LARGE_SITE_IDS.ob, siteB: LARGE_SITE_IDS.radiology, band: 'off_campus', supervisable: false },

  // Offsite tower internal — adjacent inside the tower
  { siteA: LARGE_SITE_IDS.cath, siteB: LARGE_SITE_IDS.ir, band: 'adjacent', supervisable: true },
  { siteA: LARGE_SITE_IDS.cath, siteB: LARGE_SITE_IDS.radiology, band: 'adjacent', supervisable: true },
  { siteA: LARGE_SITE_IDS.ir, siteB: LARGE_SITE_IDS.radiology, band: 'adjacent', supervisable: true },
];

/**
 * Generic guidelines text. The wording references "Coordinator" as a role
 * concept rather than any hospital-specific job title. Stays inside the
 * vocabulary A4's normalizer parses out of the box (PRD §9 example shape).
 */
const guidelinesText: string =
  'We are a large academic medical center with a main hospital tower and ' +
  'an offsite procedural tower. The main tower contains a Main OR suite ' +
  'of about twenty-five anesthetizing rooms, an Endoscopy suite with four ' +
  'rooms, two Neuro interventional labs, two EP labs, and a two-room OB / ' +
  'L&D unit one wing away from the Main OR. The offsite tower contains a ' +
  'two-room Cath Lab, a two-room Interventional Radiology suite, and a ' +
  'two-room offsite Radiology unit; the offsite tower is across the campus ' +
  'and providers assigned there cannot supervise back to the main tower. ' +
  'Endoscopy is staffed as a solo Anesthesiologist who covers the GI list ' +
  'and can run TEEs and cardioversions when the Main OR is quiet. OB is ' +
  'staffed by a solo Anesthesiologist dedicated to L&D, epidurals, and ' +
  'C-sections; when OB is not busy that Anesthesiologist helps with break ' +
  'relief in the Main OR. The EP Labs and Neuro Labs each run one CRNA ' +
  'supervised cross-site by an Anesthesiologist sitting in the Main OR; ' +
  'supervision at those off-sites is capped at 1:3 because of the walk ' +
  'distance. We never supervise more than 1:3 at OB. Inside the Main OR ' +
  'the default supervision target is mostly 1:3 with some 1:4 acceptable ' +
  'when distance is trivial. One Anesthesiologist on the Main OR floor ' +
  'each day plays a Coordinator role: they cap their supervision at 1:3, ' +
  'run schedule management, do intubations, place epidurals, and float to ' +
  'whichever room needs help. Cath Lab, IR, and offsite Radiology each ' +
  'run a solo Anesthesiologist or a CRNA with a dedicated supervising ' +
  'Anesthesiologist physically present in the offsite tower.';

export const largeAcademicTemplate: GridTemplate = {
  id: 'large_academic',
  name: 'Large academic medical center',
  description:
    'Multi-tower campus with a 25-room Main OR, large procedural cluster, ' +
    'and an offsite tower for Cath, IR, and Radiology. Includes off-campus ' +
    'distance bands for offsite procedural rooms.',
  sites,
  distanceEdges,
  guidelinesText,
  defaultConfig: {
    coverageStyle: 'balanced',
    supervisionRatio: 'mixed',
    floatStrategy: 'emergency_priority',
    backupCallPosture: 'aggressive',
  },
};
