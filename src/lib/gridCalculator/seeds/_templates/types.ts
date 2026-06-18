// Shared types for the Universal Library starter templates.
// Owned by agent A17 (Universal Library) per PRD §14, §15.
//
// PURPOSE
// -------
// The Onboarding Wizard (A15) lets a new hospital pick a starter template
// rather than typing every site/room from scratch. A template is a generic,
// hospital-agnostic seed bundle:
//   - sites + rooms (named with role concepts, NOT hospital-specific names)
//   - a distance edge matrix matching the template's geometry
//   - a free-text guidelinesText paragraph A4's normalizer can parse
//   - a small `defaultConfig` Pick<> covering the four PRD §8 toggles
//
// UNIVERSALITY CONTRACT
// ---------------------
// Templates MUST stay generic. No "Paoli" / hospital names anywhere.
// Site IDs use the `site-<concept>` shape (e.g. `site-mainor`, `site-ob`)
// so wizard-created configs can either keep them or remap to UUIDs without
// touching template logic.

import type {
  DistanceEdge,
  GridCalculatorConfig,
  GridSite,
} from '../../types';

/**
 * Template-level config defaults. The wizard pre-fills the toggle bar from
 * this when the user picks a template — they can still flip toggles before
 * the first solve. PRD §8.
 */
export type TemplateConfigDefaults = Pick<
  GridCalculatorConfig,
  'coverageStyle' | 'supervisionRatio' | 'floatStrategy' | 'backupCallPosture'
>;

/**
 * One starter template. The wizard's "Pick a template" step renders one
 * card per `LISTED_TEMPLATES` entry (see `index.ts`) and, on selection,
 * hands the full `GridTemplate` to the next step (sites + rules confirm).
 */
export interface GridTemplate {
  /** Stable identifier — used in URLs and the wizard's query params. */
  id: 'small_community' | 'mid_regional' | 'large_academic';
  /** Display name shown on the wizard card. */
  name: string;
  /** 1-2 sentences shown under the name in the wizard. */
  description: string;
  /** Sites + rooms in canonical sidebar order (Float lane last). */
  sites: GridSite[];
  /** Symmetric distance edges between every meaningful site pair. */
  distanceEdges: DistanceEdge[];
  /** Free-text guidelines paragraph the wizard pre-fills into the textarea. */
  guidelinesText: string;
  /** Default toggle state — wizard pre-selects these on the toggle bar. */
  defaultConfig: TemplateConfigDefaults;
}

/**
 * Lightweight metadata shape exposed to the wizard. Lets the "Pick a
 * template" step render its card grid without importing every template
 * file (each template ships separately so tree-shaking stays clean).
 */
export interface TemplateMeta {
  id: GridTemplate['id'];
  name: string;
  description: string;
  /** Approximate site count for the card subtitle (e.g. "5 sites · 6 rooms"). */
  siteCount: number;
  /** Approximate total room count for the card subtitle. */
  roomCount: number;
}
