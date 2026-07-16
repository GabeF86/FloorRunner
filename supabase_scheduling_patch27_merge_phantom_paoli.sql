-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ STATUS: NOT APPLIED — USER-GATED. Gabriel must confirm the site-row merge  ║
-- ║ (it repoints 14 provider credentials and deactivates a site row).          ║
-- ║ Apply to project qhwdbtixhzdsgwwtcfrm ("Floor Runner"), ref verified,      ║
-- ║ via the project-scoped supabase-floorrunner MCP server (or the dashboard   ║
-- ║ SQL editor). Never run through the atlas-staging / chiefos MCP servers.    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Patch 27: merge the phantom "Paoli Hospital" site row into the live one.
--
-- Live facts (verified 2026-07-16, read-only):
--   • TWO active "Paoli Hospital" rows, in DIFFERENT organizations:
--       live    2ddd2427-22fb-4290-9c4c-03a957e5af4e (org 3d4621c3-…)
--               13 profiles home-sited, 21+ templates, active Weekend v2 pattern
--       phantom d479756c-7d02-4b2d-8c65-ab70016982b2 (org c4d9b24a-…)
--               0 schedules, 0 shift_types, 0 templates, 0 home profiles,
--               1 active CLASSIC call pattern, 14 provider_site_credentials
--   • The 14 phantom credentials: 5 can_take_call=true (a cross-site visiting
--     pool) + 8 can_take_call=false + 1 other — ALL invisible at the live site
--     id because eligibility treats a MISSING credential row as passing.
--     Repointing preserves the 8 restrictions (they become enforceable) AND
--     the 5-doc cross-site pool.
--   • Zero provider overlap between the two sites' credential rows (verified),
--     so the repoint cannot violate UNIQUE (provider_id, site_id).
--
-- NOT bundled here (same pattern, SEPARATE user-gated patch after Gabriel
-- picks canonical rows): Bryn Mawr / Lankenau / Riddle are split-brain across
-- the same two organizations (3d4621c3 vs c4d9b24a).
--
-- APPLY-TIME VERIFICATION (run BEFORE applying; STOP on any mismatch):
--   SELECT site_id, count(*), count(*) FILTER (WHERE can_take_call) AS takers
--     FROM scheduling.provider_site_credentials
--    WHERE site_id IN ('d479756c-7d02-4b2d-8c65-ab70016982b2',
--                      '2ddd2427-22fb-4290-9c4c-03a957e5af4e')
--    GROUP BY site_id;
--   -- expect: phantom 14 rows (5 takers); live ~12 rows.
--   SELECT count(*) FROM scheduling.provider_site_credentials a
--     JOIN scheduling.provider_site_credentials b ON a.provider_id = b.provider_id
--    WHERE a.site_id = 'd479756c-7d02-4b2d-8c65-ab70016982b2'
--      AND b.site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e';
--   -- expect: 0 (repoint is collision-free).

BEGIN;

-- 1) Repoint the 14 stranded credentials to the live Paoli row. Preserves the
--    8 can_take_call=false restrictions (now enforceable at the live site) and
--    the 5-doc cross-site visiting pool.
UPDATE scheduling.provider_site_credentials
   SET site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e', updated_at = now()
 WHERE site_id = 'd479756c-7d02-4b2d-8c65-ab70016982b2';

-- 2) Deactivate the phantom's active Classic call pattern (one-active-per-site
--    hygiene; the live row's Weekend v2 pattern is untouched).
UPDATE scheduling.call_patterns
   SET status = 'archived', updated_at = now()
 WHERE site_id = 'd479756c-7d02-4b2d-8c65-ab70016982b2'
   AND status = 'active';

-- 3) Deactivate the phantom site row itself (kept for FK/history — never
--    deleted).
UPDATE scheduling.sites
   SET is_active = false, updated_at = now()
 WHERE id = 'd479756c-7d02-4b2d-8c65-ab70016982b2';

-- 4) Guard against recurrence WITHIN an organization. NOTE: this duplicate was
--    CROSS-org (two organizations each carrying a "Paoli Hospital"), which no
--    per-org index can prevent — the index still closes the same-org door.
--    Verified 2026-07-16: no active same-org duplicate names exist, so the
--    index creates cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS sites_org_name_active_uniq
    ON scheduling.sites (organization_id, name)
 WHERE is_active;

COMMIT;

-- VERIFY AFTER:
--   SELECT count(*) FROM scheduling.sites WHERE name = 'Paoli Hospital' AND is_active;
--   -- expect: 1 (the live row 2ddd2427-…)
--   SELECT count(*) FROM scheduling.provider_site_credentials
--    WHERE site_id = 'd479756c-7d02-4b2d-8c65-ab70016982b2';
--   -- expect: 0
--   SELECT count(*), count(*) FILTER (WHERE NOT can_take_call)
--     FROM scheduling.provider_site_credentials
--    WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e';
--   -- expect: ~26 rows total, 8+ with can_take_call=false now enforceable.
--
-- ROLLBACK (restores the pre-patch shape; the repointed rows are identifiable
-- by their provider_ids — capture them BEFORE applying):
--   -- BEFORE applying, snapshot:
--   --   CREATE TABLE scheduling._patch27_backup AS
--   --     SELECT id FROM scheduling.provider_site_credentials
--   --      WHERE site_id = 'd479756c-7d02-4b2d-8c65-ab70016982b2';
--   UPDATE scheduling.provider_site_credentials
--      SET site_id = 'd479756c-7d02-4b2d-8c65-ab70016982b2', updated_at = now()
--    WHERE id IN (SELECT id FROM scheduling._patch27_backup);
--   UPDATE scheduling.call_patterns SET status = 'active', updated_at = now()
--    WHERE site_id = 'd479756c-7d02-4b2d-8c65-ab70016982b2' AND status = 'archived';
--   UPDATE scheduling.sites SET is_active = true, updated_at = now()
--    WHERE id = 'd479756c-7d02-4b2d-8c65-ab70016982b2';
--   DROP INDEX IF EXISTS scheduling.sites_org_name_active_uniq;
--   DROP TABLE IF EXISTS scheduling._patch27_backup;
