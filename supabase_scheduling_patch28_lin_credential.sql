-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ STATUS: APPLIED 2026-07-16 (idempotent INSERT..WHERE NOT EXISTS; V.Lin 36800add verified as the 1.0-FTE Paoli call taker with zero credential rows; row 1acd0ff9 created) — USER-GATED (touches provider credentials; low risk). ║
-- ║ Apply to project qhwdbtixhzdsgwwtcfrm ("Floor Runner"), ref verified,      ║
-- ║ via the project-scoped supabase-floorrunner MCP server (or the dashboard   ║
-- ║ SQL editor). Never run through the atlas-staging / chiefos MCP servers.    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Patch 28: give Victor Lin an explicit credential row at the live Paoli site.
--
-- Why:
--   Victor Lin (36800add-7add-4709-8ce4-6feb253691e3, 1.0 FTE, call_taker,
--   home-sited at Paoli 2ddd2427-…) is the only member of the 13-provider
--   Paoli roster with NO provider_site_credentials row at the live site
--   (verified 2026-07-16: 12 rows for 13 call-pool/roster providers, Lin's
--   join is NULL). eligibility.ts currently treats a MISSING row as passing
--   ("not yet configured"), so he generates normally today — this is LATENT:
--   if that policy ever tightens to require an explicit row, he silently
--   vanishes from every pool. Mirror the shape of the other 12 Paoli
--   call-taker rows (all-true flags, empty jsonb lists).
--
-- APPLY-TIME VERIFICATION (run BEFORE applying; STOP if a row already exists):
--   SELECT count(*) FROM scheduling.provider_site_credentials
--    WHERE provider_id = '36800add-7add-4709-8ce4-6feb253691e3'
--      AND site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e';
--   -- expect: 0

INSERT INTO scheduling.provider_site_credentials
  (provider_id, site_id, is_active, credentialed,
   can_take_call, can_take_weekend_call, can_take_holiday_call, can_take_backup_call,
   allowed_shift_types, excluded_shift_types, skill_tags, notes)
SELECT '36800add-7add-4709-8ce4-6feb253691e3',            -- Victor Lin
       '2ddd2427-22fb-4290-9c4c-03a957e5af4e',            -- Paoli (live row)
       true, true,
       true, true, true, true,
       '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
       'patch28: explicit row added 2026-07-16 (was missing; missing row = implicit pass)'
 WHERE NOT EXISTS (
   SELECT 1 FROM scheduling.provider_site_credentials
    WHERE provider_id = '36800add-7add-4709-8ce4-6feb253691e3'
      AND site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e');

-- VERIFY AFTER:
--   SELECT provider_id, is_active, credentialed, can_take_call,
--          can_take_weekend_call, can_take_holiday_call
--     FROM scheduling.provider_site_credentials
--    WHERE provider_id = '36800add-7add-4709-8ce4-6feb253691e3'
--      AND site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e';
--   -- expect: 1 all-true row.
--
-- ROLLBACK:
--   DELETE FROM scheduling.provider_site_credentials
--    WHERE provider_id = '36800add-7add-4709-8ce4-6feb253691e3'
--      AND site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
--      AND notes LIKE 'patch28:%';
--
-- Deferred roster hygiene (NOT in this patch, bundle later, user-gated):
--   Ganiyu partial_call_taker flag cleanup, Orji 0-FTE-active reconciliation,
--   Chamchad credential-vs-profile contradiction, and whether C3 "Neuro Call"
--   needs a required_skills/skill_tags gate before optimizer swaps treat all
--   10 pool docs as neuro-interchangeable.
