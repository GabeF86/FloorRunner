// Small Community Hospital starter template.
// Owned by agent A17 (Universal Library).
//
// Shape:
//   - 4 Main OR rooms + 1 Endoscopy room + 1 OB room (all in one building).
//   - Distance: every pair is `near` — a single connected campus.
//   - Coverage default: balanced + 1:3 + balanced floats + conservative
//     backup-call. Small groups prefer fewer dedicated backups.
//
// Generic by design — no hospital names, just role concepts ("Main OR",
// "Endoscopy", "OB"). The free-text guidelines reference the wizard-facing
// concept of a "Coordinator" rather than any Paoli-specific role name.

import type { DistanceEdge, GridSite } from '../../types';
import type { GridTemplate } from './types';

const SMALL_SITE_IDS = {
  mainOR: 'site-mainor',
  endoscopy: 'site-endoscopy',
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
    id: SMALL_SITE_IDS.mainOR,
    name: 'Main OR',
    shortName: 'OR',
    color: '#0ea5e9',
    icon: '🏥',
    position: 0,
    caption: 'Surgical suite',
    rooms: makeRooms(SMALL_SITE_IDS.mainOR, 4, 'OR'),
  },
  {
    id: SMALL_SITE_IDS.endoscopy,
    name: 'Endoscopy',
    shortName: 'Endo',
    color: '#10b981',
    icon: '🔬',
    position: 1,
    caption: 'GI suite',
    rooms: makeRooms(SMALL_SITE_IDS.endoscopy, 1, 'Endo'),
  },
  {
    id: SMALL_SITE_IDS.ob,
    name: 'OB',
    shortName: 'OB',
    color: '#f472b6',
    icon: '👶',
    position: 2,
    caption: 'L&D',
    rooms: makeRooms(SMALL_SITE_IDS.ob, 1, 'OB'),
  },
  {
    id: SMALL_SITE_IDS.float,
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
 * All sites `near` — small community hospitals live in one building, so
 * supervision is straightforward and break-relief swaps are easy.
 */
const distanceEdges: DistanceEdge[] = [
  { siteA: SMALL_SITE_IDS.mainOR, siteB: SMALL_SITE_IDS.endoscopy, band: 'near', supervisable: true },
  { siteA: SMALL_SITE_IDS.mainOR, siteB: SMALL_SITE_IDS.ob, band: 'near', supervisable: true },
  { siteA: SMALL_SITE_IDS.endoscopy, siteB: SMALL_SITE_IDS.ob, band: 'near', supervisable: true },
];

/**
 * Generic guidelines text. Vocabulary intentionally mirrors PRD §9's example
 * shape so A4's normalizer parses every sentence without expansion.
 */
const guidelinesText: string =
  'We are a community hospital with a small surgical suite of about four ' +
  'anesthetizing rooms, a single Endoscopy suite, and a single OB / L&D ' +
  'unit. Endoscopy is usually solo coverage by an Anesthesiologist who ' +
  'covers the GI list and can run TEEs or cardioversions when the Main OR ' +
  'is quiet. OB is staffed by a solo Anesthesiologist dedicated to L&D, ' +
  'epidurals, and C-sections; when OB is not busy that Anesthesiologist ' +
  'helps with break relief in the Main OR. The Main OR runs supervised ' +
  'staffing with CRNAs in each room, with the default supervision target ' +
  'mostly 1:3. One Anesthesiologist on the Main OR floor each day plays a ' +
  'Coordinator role: they cap their supervision at 1:3, manage the ' +
  'schedule, do intubations, place epidurals, and float between rooms.';

export const smallCommunityTemplate: GridTemplate = {
  id: 'small_community',
  name: 'Small community hospital',
  description:
    'Single-building community hospital with a small Main OR, one Endoscopy ' +
    'suite, and one OB / L&D unit. Fits ~4–6 ORs total.',
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
