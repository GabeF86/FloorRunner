-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ STATUS: NOT APPLIED. User-gated — apply during the split-weekend-buckets   ║
-- ║ rollout to project qhwdbtixhzdsgwwtcfrm ("Floor Runner"), ref verified,    ║
-- ║ via the project-scoped supabase-floorrunner MCP server (or the dashboard   ║
-- ║ SQL editor). Never run through the atlas-staging / chiefos MCP servers.    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Patch 24: split Saturday/Sunday into separate call-fairness buckets.
-- Spec: docs/superpowers/specs/2026-07-15-split-weekend-buckets-design.md §2.
--
-- Purpose:
--   Call fairness is now tracked per-weekend-day. The historical_call_counts
--   aggregate that feeds cross-block fairness memory must emit `saturday` and
--   `sunday` buckets (matching the engine's dayTypeBucket) instead of collapsing
--   both into one `weekend` bucket — otherwise a provider's Saturday history
--   would offset their Sunday deficit and the split targets in genContext would
--   read zero for the day-specific keys they now expect.
--
--   This CREATE OR REPLACE starts from the patch21 definition and changes ONLY
--   the bucket CASE: `saturday`/`sunday` derived_day_types map to their own
--   text values via ss.derived_day_type::text; the holiday merge
--   (federal_holiday/major_holiday → 'holiday') and the patch21 published-only
--   JOIN (draft isolation, clinical invariant 3) are PRESERVED verbatim. The
--   signature is unchanged (scheduling.historical_call_counts(uuid, date) →
--   provider_id, bucket, code, n), so the genContext RPC call needs no code
--   change; genContext keys the returned bucket straight into its maps. History
--   recomputes from raw assignments on every call — there are no stored
--   aggregates to migrate.
--
--   Reverse window (same as patch21): until this patch is applied, the live RPC
--   still returns `weekend` rows whose bucket keys no longer match anything the
--   deployed split-target math reads — so past weekend call contributes NOTHING
--   to fairness (addHistorical keys `weekend|C1` into a bucket no target looks
--   up) rather than contributing WRONG data. Deploy the app + apply this patch
--   as one rollout step, then regenerate when ready.
--
-- Idempotent: CREATE OR REPLACE FUNCTION is safe to re-run. No data changes.

CREATE OR REPLACE FUNCTION scheduling.historical_call_counts(p_site_id uuid, p_before date)
RETURNS TABLE (provider_id uuid, bucket text, code text, n bigint)
LANGUAGE sql STABLE AS $$
  SELECT a.provider_id,
         CASE
           WHEN ss.derived_day_type IN ('saturday','sunday') THEN ss.derived_day_type::text
           WHEN ss.derived_day_type IN ('federal_holiday','major_holiday') THEN 'holiday'
           ELSE ss.derived_day_type::text
         END AS bucket,
         st.code,
         count(*) AS n
  FROM scheduling.assignments a
  JOIN scheduling.schedule_slots ss ON ss.id = a.schedule_slot_id
  -- Draft isolation: committed = published version only (patch21, preserved).
  JOIN scheduling.schedule_versions sv
    ON sv.id = ss.schedule_version_id AND sv.version_status = 'published'
  JOIN scheduling.shift_types st ON st.id = ss.shift_type_id
  WHERE ss.site_id = p_site_id
    AND ss.slot_date < p_before
    AND a.assignment_status = 'assigned'
    AND a.provider_id IS NOT NULL
    AND st.category = 'call'
  GROUP BY 1, 2, 3
$$;
GRANT EXECUTE ON FUNCTION scheduling.historical_call_counts(uuid, date) TO anon, authenticated, service_role;

-- Verification (run after):
--   SELECT * FROM scheduling.historical_call_counts(
--     (SELECT id FROM scheduling.sites LIMIT 1), '2026-01-01');
--   -- expect: weekend call now returns separate `saturday` and `sunday` bucket
--   -- rows (no `weekend` rows); holiday call still returns a single `holiday`
--   -- bucket; only PUBLISHED past call contributes (a draft schedule's past
--   -- call rows contribute nothing).
