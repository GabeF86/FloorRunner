// Universal Library template registry.
// Owned by agent A17 (Universal Library) per PRD §14, §15.
//
// PURPOSE
// -------
// One-stop import for the Onboarding Wizard (A15). The wizard's "Pick a
// template" step reads `LISTED_TEMPLATES` to render a card grid, then
// calls `getTemplate(id)` once the user selects one to hand the full
// `GridTemplate` to the next step.
//
// USAGE — for A15 (Onboarding Wizard)
// ----------------------------------
//   import { LISTED_TEMPLATES, getTemplate } from
//     '@/lib/gridCalculator/seeds/_templates';
//
//   // Render the picker grid:
//   for (const meta of LISTED_TEMPLATES) {
//     // <Card title={meta.name} subtitle={`${meta.siteCount} sites · …`}>
//     //   {meta.description}
//     // </Card>
//   }
//
//   // On selection:
//   const tmpl = getTemplate(meta.id);
//   wizardState.sites = tmpl.sites;
//   wizardState.distanceEdges = tmpl.distanceEdges;
//   wizardState.guidelinesText = tmpl.guidelinesText;
//   wizardState.config = { ...wizardState.config, ...tmpl.defaultConfig };

import { largeAcademicTemplate } from './largeAcademic';
import { midRegionalTemplate } from './midRegional';
import { smallCommunityTemplate } from './smallCommunity';
import type { GridTemplate, TemplateMeta } from './types';

/**
 * Internal canonical list. Order matches the wizard's intended card grid:
 * smallest to largest so users with simple needs see the right pick first.
 */
export const ALL_TEMPLATES: readonly GridTemplate[] = [
  smallCommunityTemplate,
  midRegionalTemplate,
  largeAcademicTemplate,
] as const;

/**
 * Lightweight metadata list for the wizard's picker. Each entry holds just
 * enough to render a card — full templates load lazily via `getTemplate`.
 *
 * Counts exclude the always-present Float lane (which has zero rooms) so
 * the displayed numbers match user intuition.
 */
export const LISTED_TEMPLATES: readonly TemplateMeta[] = ALL_TEMPLATES.map(
  (tmpl): TemplateMeta => {
    const nonFloatSites = tmpl.sites.filter((s) => s.id !== 'site-float');
    return {
      id: tmpl.id,
      name: tmpl.name,
      description: tmpl.description,
      siteCount: nonFloatSites.length,
      roomCount: nonFloatSites.reduce((sum, s) => sum + s.rooms.length, 0),
    };
  },
);

/**
 * Resolve a template by id. Throws if the id is unknown — callers should
 * always come from `LISTED_TEMPLATES`, so an unknown id is a programmer
 * error.
 */
export function getTemplate(id: GridTemplate['id']): GridTemplate {
  const tmpl = ALL_TEMPLATES.find((t) => t.id === id);
  if (!tmpl) {
    throw new Error(`Unknown template id: ${id}`);
  }
  return tmpl;
}

// Re-export the public types so the wizard can import everything from
// one place.
export type { GridTemplate, TemplateConfigDefaults, TemplateMeta } from './types';
export { smallCommunityTemplate } from './smallCommunity';
export { midRegionalTemplate } from './midRegional';
export { largeAcademicTemplate } from './largeAcademic';
