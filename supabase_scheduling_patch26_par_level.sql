-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ STATUS: APPLIED 2026-07-16 (value 11 per Gabriel: "you can set the par level at 11 for now but not less" — engine self-clamps quota math to pool ΣFTE, so the stored value is a target, not a fill constraint) — USER-GATED. Gabriel must confirm the par semantics   ║
-- ║ before this runs: call_par_level 12 may be an intentional recruiting       ║
-- ║ target, but for fill math the stored value should reflect the actual pool. ║
-- ║ Apply to project qhwdbtixhzdsgwwtcfrm ("Floor Runner"), ref verified,      ║
-- ║ via the project-scoped supabase-floorrunner MCP server (or the dashboard   ║
-- ║ SQL editor). Never run through the atlas-staging / chiefos MCP servers.    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Patch 26: honest call_par_level for Paoli.
--
-- Why:
--   Paoli's call pool is 10 physicians summing 8.82 FTE (verified live
--   2026-07-16), but sites.call_par_level = 12. FTE-weighted quota targets are
--   (bucket_total / par) × fte, so Σ targets = bucket_total × 8.82/12 ≈ 73% of
--   every bucket — the schedule was structurally under-quota'd before a single
--   slot was placed.
--
--   The engine now self-defends (scheduler-fill branch, 2026-07-16):
--   effectiveParLevel clamps the quota denominator to min(par, Σ pool FTE) and
--   floorBucketTargets guarantees ≥ 1 per bucket per positive-FTE provider —
--   so this patch is belt-and-suspenders for fill math. It still matters:
--   the stored value should be honest, it feeds the coverage-vs-par UI math,
--   and a stale value keeps firing the load-time clamp warning on every
--   generation.
--
-- Why 8, not 9:
--   Σ targets = bucket_total × 8.82/par. par 8 → 110% coverage (headroom for
--   PTO-absent weeks); par 9 → 98% (under-covers by construction). If the
--   group later recruits toward a true par of 12, raise this alongside the
--   roster — the clamp keeps fill math correct either way.
--
-- APPLY-TIME VERIFICATION (run BEFORE applying; STOP if it doesn't match):
--   SELECT sum(e.fte_value) AS pool_fte, count(*) AS docs
--     FROM scheduling.provider_employment_profiles e
--     JOIN scheduling.providers p ON p.id = e.provider_id
--    WHERE e.home_site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
--      AND (e.call_taker OR e.partial_call_taker)
--      AND p.status = 'active' AND p.provider_type = 'physician';
--   -- expect: pool_fte ≈ 8.82, docs = 10 (2026-07-16 snapshot). If the pool
--   -- has changed, recompute: pick the largest integer par with
--   -- pool_fte / par >= 1.05 (i.e. ≥ 105% coverage).

UPDATE scheduling.sites
   SET call_par_level = 8, updated_at = now()
 WHERE id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'   -- Paoli (live row)
   AND call_par_level = 12;                          -- no-op if already changed

-- VERIFY AFTER:
--   SELECT id, name, call_par_level FROM scheduling.sites
--    WHERE id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e';
--   -- expect: call_par_level = 8. Then regenerate the diagnostic schedule and
--   -- confirm the "cannot cover ... clamped" warnings no longer fire.
--
-- ROLLBACK:
--   UPDATE scheduling.sites SET call_par_level = 11, updated_at = now()
--    WHERE id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e';
