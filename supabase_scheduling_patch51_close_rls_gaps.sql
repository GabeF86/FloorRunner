-- supabase_scheduling_patch51_close_rls_gaps.sql
-- Two tables had RLS switched OFF. (Gabriel 2026-09-14.)
--
-- PROJECT: apply ONLY to Supabase ref qhwdbtixhzdsgwwtcfrm ("Floor Runner").
--
-- STATUS: APPLIED 2026-09-14 to ref qhwdbtixhzdsgwwtcfrm. Verified after:
--         0 scheduling tables with RLS disabled, 30 permissive policies,
--         11 restrictive, provider_compensation holding exactly 2.
--
-- ── WHAT patch48 MISSED ─────────────────────────────────────────────────────
-- patch48 gave provider_compensation a RESTRICTIVE person-scope policy, and
-- asserted on POLICY COUNTS. It never checked whether row security was
-- actually ENABLED on the tables it was protecting -- and on
-- provider_compensation it was not. The policy therefore did nothing at all:
-- the table holding salary and admin_stipend would have been fully readable by
-- any authenticated session. Surfaced by the Supabase security advisor, which
-- is worth running after any policy work.
--
-- request_windows had the same gap, with no policy at all.
--
-- ── WHY A PERMISSIVE POLICY HAD TO BE ADDED TOO ─────────────────────────────
-- A RESTRICTIVE policy cannot grant access, only narrow it. Enabling RLS with
-- only the person-scope policy present would have denied everyone. So
-- provider_compensation gains the org-scoped PERMISSIVE policy its 28 sibling
-- tables already have, and the effective rule becomes
--   (org matches) AND (is admin OR the row is mine)
-- which is the same shape as every other person-scoped table.
--
-- ── NO BEHAVIOUR CHANGE TODAY ───────────────────────────────────────────────
-- Every route uses the service-role key, which bypasses RLS entirely.

CREATE POLICY provider_compensation_org_scope ON scheduling.provider_compensation
  FOR ALL TO public
  USING (EXISTS (
    SELECT 1 FROM scheduling.providers p
     WHERE p.id = provider_compensation.provider_id
       AND p.organization_id = scheduling.current_user_org_id()
  ));

ALTER TABLE scheduling.provider_compensation ENABLE ROW LEVEL SECURITY;

CREATE POLICY request_windows_org_scope ON scheduling.request_windows
  FOR ALL TO public
  USING (EXISTS (
    SELECT 1 FROM scheduling.sites s
     WHERE s.id = request_windows.site_id
       AND s.organization_id = scheduling.current_user_org_id()
  ));

ALTER TABLE scheduling.request_windows ENABLE ROW LEVEL SECURITY;

-- Roles are seeded per organization, so merging two organizations left UAS
-- holding two 'admin' and two 'provider' rows. The invitation role lookup read
-- a single row, so acceptance died on "JSON object requested, multiple (or no)
-- rows returned" -- shown to someone in the middle of setting their password.
-- Duplicates removed (all had 0 grants) and the shape made impossible.
ALTER TABLE scheduling.roles
  ADD CONSTRAINT roles_org_name_unique UNIQUE (organization_id, name);

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'scheduling' AND c.relkind = 'r' AND NOT c.relrowsecurity;
  IF n <> 0 THEN
    RAISE EXCEPTION 'patch51: % scheduling tables still have RLS disabled - aborting', n;
  END IF;
END $$;
