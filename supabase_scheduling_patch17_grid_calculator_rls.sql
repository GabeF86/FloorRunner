-- Patch 17: Grid Calculator — org scoping + RLS policies
--
-- Owned by agent A1 (Site Architect, fix pass). Closes the CRITICAL RLS gap
-- flagged by the 2026-06-17 code review on patches 14 and 16:
--
--   * Patch 14 enabled RLS on `scheduling.grid_calculator_configs` and
--     `scheduling.grid_calculator_distances` with **no** policies, so every
--     anon/authenticated SELECT/INSERT/UPDATE/DELETE failed closed.
--   * Patch 16 did the same on `scheduling.grid_calculator_fte_runs`.
--
-- Neither `grid_calculator_configs` nor `grid_calculator_fte_runs` had an
-- `organization_id` column, so the canonical FloorRunner `org_access` policy
-- (keyed on `organization_id = scheduling.current_user_org_id()`) could not
-- be retrofitted without a schema change. This patch:
--
--   1. Adds `organization_id` to `grid_calculator_configs` and
--      `grid_calculator_fte_runs` (NOT NULL, FK → scheduling.organizations).
--   2. Creates `org_access` policies on all three Grid Calculator tables that
--      mirror the canonical pattern in supabase_scheduling_schema.sql §18:
--        - configs   → direct  organization_id check
--        - fte_runs  → direct  organization_id check
--        - distances → EXISTS join through config_id (mirrors the
--                      provider_employment_profiles → providers pattern)
--
-- This patch is purely additive. Patches 14/15/16 are NOT modified.
-- All operations are idempotent: ADD COLUMN IF NOT EXISTS, DROP POLICY
-- IF EXISTS + CREATE POLICY (re-runnable on every supported Postgres version,
-- not just PG 15+ which added CREATE POLICY IF NOT EXISTS).
--
-- PRD: docs/PRD-Grid-Calculator.md §13.
-- Review: docs/code-reviews/2026-06-17-initial.md "[CRITICAL] RLS enabled…"

-- ============================================================================
-- UP
-- ============================================================================

-- ── 1. Add organization_id to grid_calculator_configs ──────────────────────
--
-- TEMPORARY DEFAULT — REMOVE IN FUTURE PATCH:
--   The zero-uuid default lets ADD COLUMN ... NOT NULL backfill any
--   pre-existing rows that were inserted before patch 17 ran. A follow-up
--   patch should:
--     (a) UPDATE any rows still holding the zero-uuid to their correct org,
--     (b) ALTER TABLE ... ALTER COLUMN organization_id DROP DEFAULT,
--     (c) optionally add a CHECK (organization_id <> '00000000-...') guard.
--   This avoids breaking existing rows on a fresh DB where patch 14 already
--   shipped configs without an org column.
ALTER TABLE scheduling.grid_calculator_configs
  ADD COLUMN IF NOT EXISTS organization_id uuid NOT NULL
    DEFAULT '00000000-0000-0000-0000-000000000000'
    REFERENCES scheduling.organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS grid_calculator_configs_org_idx
  ON scheduling.grid_calculator_configs (organization_id);

COMMENT ON COLUMN scheduling.grid_calculator_configs.organization_id IS
  'Owning organization. Added in patch 17 to enable org_access RLS. The zero-uuid DEFAULT is a temporary backfill aid — REMOVE IN FUTURE PATCH once existing rows are migrated.';

-- ── 2. Add organization_id to grid_calculator_fte_runs ─────────────────────
--
-- Same TEMPORARY DEFAULT rationale as configs above — REMOVE IN FUTURE PATCH.
-- The fte_runs table could derive its org via config_id, but persisting the
-- column directly keeps RLS policies cheap (no EXISTS join on every read of
-- a hot, append-only table) and lets the worst-case + Monte Carlo logging
-- path stamp the org explicitly at insert time.
ALTER TABLE scheduling.grid_calculator_fte_runs
  ADD COLUMN IF NOT EXISTS organization_id uuid NOT NULL
    DEFAULT '00000000-0000-0000-0000-000000000000'
    REFERENCES scheduling.organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS grid_calculator_fte_runs_org_idx
  ON scheduling.grid_calculator_fte_runs (organization_id);

COMMENT ON COLUMN scheduling.grid_calculator_fte_runs.organization_id IS
  'Owning organization. Added in patch 17 to enable org_access RLS. The zero-uuid DEFAULT is a temporary backfill aid — REMOVE IN FUTURE PATCH once existing rows are migrated.';

-- ── 3. RLS policies ────────────────────────────────────────────────────────
--
-- Patches 14 + 16 already ran ENABLE ROW LEVEL SECURITY on these tables, so
-- we only need to attach the missing policies here. We DROP POLICY IF EXISTS
-- first for cross-version re-runnability (PG <15 lacks CREATE POLICY IF NOT
-- EXISTS). The policy name `org_access` mirrors the convention used
-- throughout supabase_scheduling_schema.sql §18.
--
-- Defense-in-depth: we re-issue ENABLE ROW LEVEL SECURITY here too, so this
-- patch closes the gap even if patches 14/16 were partially applied in some
-- environment.
ALTER TABLE scheduling.grid_calculator_configs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.grid_calculator_distances ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.grid_calculator_fte_runs  ENABLE ROW LEVEL SECURITY;

-- grid_calculator_configs: direct organization_id check (matches
-- scheduling.sites / scheduling.schedules pattern).
DROP POLICY IF EXISTS org_access ON scheduling.grid_calculator_configs;
CREATE POLICY org_access ON scheduling.grid_calculator_configs
  FOR ALL USING (organization_id = scheduling.current_user_org_id());

-- grid_calculator_distances: EXISTS-join via config_id (matches the
-- scheduling.provider_employment_profiles → scheduling.providers pattern at
-- supabase_scheduling_schema.sql §18). The distances table has no
-- organization_id of its own — its scope is fully derived from its parent
-- config, which is the right model since a distance edge is meaningless
-- outside the config that owns it.
DROP POLICY IF EXISTS org_access ON scheduling.grid_calculator_distances;
CREATE POLICY org_access ON scheduling.grid_calculator_distances
  FOR ALL USING (EXISTS (
    SELECT 1
    FROM scheduling.grid_calculator_configs c
    WHERE c.id = config_id
      AND c.organization_id = scheduling.current_user_org_id()
  ));

-- grid_calculator_fte_runs: direct organization_id check (same as configs).
DROP POLICY IF EXISTS org_access ON scheduling.grid_calculator_fte_runs;
CREATE POLICY org_access ON scheduling.grid_calculator_fte_runs
  FOR ALL USING (organization_id = scheduling.current_user_org_id());

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- DOWN (manual rollback — run only if patch 17 must be reverted)
-- ============================================================================
--
-- DROP POLICY IF EXISTS org_access ON scheduling.grid_calculator_fte_runs;
-- DROP POLICY IF EXISTS org_access ON scheduling.grid_calculator_distances;
-- DROP POLICY IF EXISTS org_access ON scheduling.grid_calculator_configs;
--
-- DROP INDEX IF EXISTS scheduling.grid_calculator_fte_runs_org_idx;
-- DROP INDEX IF EXISTS scheduling.grid_calculator_configs_org_idx;
--
-- ALTER TABLE scheduling.grid_calculator_fte_runs  DROP COLUMN IF EXISTS organization_id;
-- ALTER TABLE scheduling.grid_calculator_configs   DROP COLUMN IF EXISTS organization_id;
--
-- NOTIFY pgrst, 'reload schema';
