# A17 — Universal Library Agent Notes

**Owner:** Agent A17 (Universal Library)
**Scope:** Extract patterns common across hypothetical hospitals and surface
them as starter templates the Onboarding Wizard (A15) can offer.
**Charter:** PRD §14 (A17).

## Files owned

- `src/lib/gridCalculator/seeds/_templates/index.ts` — registry + helpers
- `src/lib/gridCalculator/seeds/_templates/types.ts` — shared types
- `src/lib/gridCalculator/seeds/_templates/smallCommunity.ts`
- `src/lib/gridCalculator/seeds/_templates/midRegional.ts`
- `src/lib/gridCalculator/seeds/_templates/largeAcademic.ts`
- `src/lib/gridCalculator/seeds/_templates/__tests__/templates.test.ts`

## Architecture

Each template ships a `GridTemplate`:

```ts
{
  id: 'small_community' | 'mid_regional' | 'large_academic',
  name: string,
  description: string,
  sites: GridSite[],
  distanceEdges: DistanceEdge[],
  guidelinesText: string,
  defaultConfig: Pick<GridCalculatorConfig,
    'coverageStyle' | 'supervisionRatio' | 'floatStrategy' | 'backupCallPosture'
  >,
}
```

Templates are pure data — no hospital-specific imports. They live under
`seeds/_templates/` so they sit beside `seeds/paoli.ts` but are
namespace-separated.

### Site ID scheme

Every template uses the same `site-<concept>` prefix scheme (e.g.
`site-mainor`, `site-ob`, `site-ep-lab`). This lets the wizard either:

1. Keep the template IDs as-is (the simplest path), or
2. Remap to UUIDs at persist time without touching template logic.

The Float lane is always `site-float` and pinned at `position: 99` per
PRD §7 visual rule.

### Generic vocabulary

Templates intentionally translate role concepts into generic vocabulary.
The Paoli-specific "Floor Runner" role is rendered in the guidelinesText
as a "Coordinator" role — same shape (cap at 1:3, manages schedule, does
intubations / epidurals, floats between rooms) but not a verbatim copy
of Paoli's job title. PRD §17 still flags whether "Floor Runner /
Coordinator" should become a universal concept as an open question to
Gabriel; for now we keep it inside the guidelinesText so A4's normalizer
absorbs it as a per-site `notes`/`auxiliaryRole` shape.

## Templates shipped

| Template | Sites | Total rooms | Distance shape | Default config |
|---|---|---|---|---|
| `small_community` | 3 (Main OR, Endo, OB) | 6 | All `near` (single building) | balanced / 1:3 / balanced / conservative |
| `mid_regional` | 5 (Main OR, Endo, Neuro, EP, OB) | 17 | Cluster `near`/`adjacent`, OB `far` | balanced / 1:3 / balanced / conservative |
| `large_academic` | 8 (Main OR, Endo, Neuro, EP, OB, Cath, IR, Rads) | 40 | Multi-tower; offsite sites `off_campus` | balanced / mixed / emergency_priority / aggressive |

(Site counts exclude the float lane. Room counts likewise.)

The mid-regional shape is the Paoli geometry generalized — Main OR-centric
with a procedural cluster and OB in a different wing — so the wizard
demonstrates cross-site supervision out of the box without leaking any
Paoli names.

## Registry

`index.ts` exports:

- `ALL_TEMPLATES: readonly GridTemplate[]` — the full canonical list, ordered
  smallest → largest.
- `LISTED_TEMPLATES: readonly TemplateMeta[]` — the lightweight metadata
  the wizard renders (id, name, description, siteCount, roomCount).
- `getTemplate(id)` — resolver. Throws on unknown id.
- Direct named exports of each template (`smallCommunityTemplate`,
  `midRegionalTemplate`, `largeAcademicTemplate`).
- Type re-exports: `GridTemplate`, `TemplateConfigDefaults`, `TemplateMeta`.

### Wizard integration (for A15)

```ts
import {
  LISTED_TEMPLATES,
  getTemplate,
} from '@/lib/gridCalculator/seeds/_templates';

// Step 1 — render the picker grid:
for (const meta of LISTED_TEMPLATES) {
  // <Card title={meta.name} subtitle={`${meta.siteCount} sites · ${meta.roomCount} rooms`}>
  //   {meta.description}
  // </Card>
}

// Step 2 — on selection:
const tmpl = getTemplate(meta.id);
wizardState.sites = tmpl.sites;
wizardState.distanceEdges = tmpl.distanceEdges;
wizardState.guidelinesText = tmpl.guidelinesText;
wizardState.config = { ...wizardState.config, ...tmpl.defaultConfig };

// Next step (rules normalize) runs A4 on `wizardState.guidelinesText`.
```

## Tests

Run with:

```sh
npx tsx src/lib/gridCalculator/seeds/_templates/__tests__/templates.test.ts
```

6/6 cases pass:

1. `smallCommunity` shape sanity (loads, positive site/room count, default
   rule kw present in guidelinesText, all 4 toggle defaults populated,
   float lane pinned last).
2. `midRegional` shape sanity (>= 5 fixed sites; OB↔EP edge is `far` /
   not supervisable; guidelinesText mentions cross-site supervision; no
   "Floor Runner" verbatim leak).
3. `largeAcademic` shape sanity (>= 8 fixed sites; Main OR↔Cath is
   `off_campus`; Main OR has >= 25 rooms; defaultConfig uses `mixed` +
   `aggressive` as appropriate for size).
4. Registry sanity (`LISTED_TEMPLATES` matches `ALL_TEMPLATES`,
   `getTemplate` resolves all + throws on unknown id, siteCount excludes
   float lane).
5. **Universality smoke test** — every template runs through `solve()`
   with a minimal synthetic roster (2 MDs + 4 CRNAs) without throwing.
   Larger templates produce violations (expected — the roster is
   intentionally small) but the contract is "no exceptions". This is the
   PRD §16 criterion 1 smoke test in test form.
6. `smallCommunity` + synthetic roster — Main OR rooms are all staffed
   (anesthesiologistId + 1 CRNA each); excess-rooms-vs-roster surface as
   deterministic violation strings.

`npx tsc --noEmit` is clean.

## Escalation log

Per the A17 charter: "If a template's guidelinesText hits a rule shape
A4's normalizer doesn't yet parse, simplify the text. Don't expand the
normalizer." All three templates' guidelinesText stays within the
vocabulary used by Paoli's own free-text guidelines (`paoli.guidelines.md`)
plus PRD §9's worked example, so no normalizer expansion is required.

## Open items

- **`large_academic` per-site rules.** The shipped guidelinesText
  describes Cath / IR / Radiology in one sentence per the PRD example
  shape. If A4 surfaces an unmapped sentence here in practice, the fix is
  to split it into per-site sentences (NOT to expand the normalizer).
- **Template count.** v1 ships three. Adding a fourth (e.g. "pediatric
  specialty hospital") is straightforward — add the file, import + add
  it to `ALL_TEMPLATES`. The wizard renders the new card automatically.
- **Default config coupling.** Each template hardcodes a `defaultConfig`.
  If user telemetry shows admins flip a particular toggle right after
  picking a template, surface that as a hint to update the template's
  default rather than expanding the wizard.
