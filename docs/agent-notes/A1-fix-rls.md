# A1 fix pass — Grid Calculator RLS gap

**Date:** 2026-06-17
**Trigger:** CRITICAL finding in `docs/code-reviews/2026-06-17-initial.md`
("RLS enabled on all three new tables with ZERO policies").
**Scope:** additive only — patches 14/15/16 untouched.

## What landed

New migration: `supabase_scheduling_patch17_grid_calculator_rls.sql`.

### Columns added

| Table | Column | Type | Default | FK |
| --- | --- | --- | --- | --- |
| `scheduling.grid_calculator_configs` | `organization_id` | `uuid NOT NULL` | `'00000000-0000-0000-0000-000000000000'` | `scheduling.organizations(id) ON DELETE CASCADE` |
| `scheduling.grid_calculator_fte_runs` | `organization_id` | `uuid NOT NULL` | `'00000000-0000-0000-0000-000000000000'` | `scheduling.organizations(id) ON DELETE CASCADE` |

The zero-uuid DEFAULT is intentional and documented in both the migration body
and the column COMMENTs as "REMOVE IN FUTURE PATCH". It exists so that
`ADD COLUMN ... NOT NULL` can backfill any rows that pre-date patch 17 (e.g.
a dev DB where patch 14 already ran and inserted rows). A future patch should:

1. UPDATE any rows still holding the zero-uuid to their correct org.
2. `ALTER TABLE ... ALTER COLUMN organization_id DROP DEFAULT`.
3. Optionally add a `CHECK (organization_id <> '00000000-…')` guard.

`grid_calculator_distances` deliberately did **not** receive an
`organization_id` column. Its scope is fully derived from its parent
`grid_calculator_configs` row (a distance edge is meaningless outside the
config that owns it), so the policy uses an EXISTS join through `config_id`.
This mirrors `provider_employment_profiles → providers → organization_id`
in `supabase_scheduling_schema.sql` §18.

### Indexes added

- `grid_calculator_configs_org_idx` on `(organization_id)`
- `grid_calculator_fte_runs_org_idx` on `(organization_id)`

These keep org-filtered scans cheap; the distances table is already covered
by `grid_calculator_distances_config_idx` from patch 14.

### Policies created

All three policies are named `org_access` to match the canonical convention
used throughout `supabase_scheduling_schema.sql` §18.

| Table | Pattern | Body |
| --- | --- | --- |
| `grid_calculator_configs` | Direct (mirrors `sites` / `schedules`) | `FOR ALL USING (organization_id = scheduling.current_user_org_id())` |
| `grid_calculator_distances` | EXISTS join via `config_id` (mirrors `provider_employment_profiles → providers`) | `FOR ALL USING (EXISTS (SELECT 1 FROM scheduling.grid_calculator_configs c WHERE c.id = config_id AND c.organization_id = scheduling.current_user_org_id()))` |
| `grid_calculator_fte_runs` | Direct (mirrors `sites` / `schedules`) | `FOR ALL USING (organization_id = scheduling.current_user_org_id())` |

Each `CREATE POLICY` is preceded by `DROP POLICY IF EXISTS …` so the patch is
idempotent on every supported Postgres version (PG <15 lacks
`CREATE POLICY IF NOT EXISTS`). The patch also re-runs
`ALTER TABLE … ENABLE ROW LEVEL SECURITY` for defense in depth.

## Schema verification

Confirmed in `supabase_scheduling_schema.sql`:

- `scheduling.organizations` exists at line 35.
- `scheduling.current_user_org_id()` exists at line 59, returns `uuid`,
  `STABLE SECURITY DEFINER`, selects `organization_id` from
  `scheduling.users` where `id = auth.uid()`.
- The canonical org-access pattern is at lines 654–772 — both the direct
  form (`organizations`, `sites`, `schedules`, etc.) and the EXISTS-join form
  (`provider_employment_profiles`, `provider_site_credentials`, `assignments`,
  `rule_definitions`, etc.) are used as the templates for this patch.

No discrepancies found; the existing schema fully supports the pattern.

## Out of scope (per the brief)

- The `page.tsx` `onAddRoom` / `onChangeBand` / `onToggleSupervisable` typing
  ERROR is A9's territory — left untouched.
- Patches 14, 15, 16 were not modified — patch 17 is the only file added.
