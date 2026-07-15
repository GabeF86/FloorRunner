-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ STATUS: NOT APPLIED. User-gated — apply during the draft-isolation         ║
-- ║ rollout to project qhwdbtixhzdsgwwtcfrm ("Floor Runner"), ref verified,    ║
-- ║ via the project-scoped supabase-floorrunner MCP server (or the dashboard   ║
-- ║ SQL editor). Never run through the atlas-staging / chiefos MCP servers.    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Patch 21: historical fairness counts COMMITTED call only.
-- Spec: docs/superpowers/specs/2026-07-15-draft-isolation-design.md §2.
--
-- Purpose:
--   Draft isolation (clinical invariant 3): an assignment is a *committed*
--   booking iff its schedule version is published. Past-schedule call burden
--   (cross-block fairness memory) must therefore count only PUBLISHED versions —
--   an unpublished draft (or a superseded sibling draft) with past-dated slots
--   would otherwise skew every provider's lifetime call count and distort the
--   fairness targets of the next generation.
--
--   This CREATE OR REPLACE keeps the exact patch18 signature and behavior
--   (scheduling.historical_call_counts(uuid, date) → provider_id, bucket, code,
--   n) and only adds a JOIN to scheduling.schedule_versions filtered
--   version_status = 'published'. Same signature ⇒ ZERO code-call changes; the
--   genContext RPC call is unchanged. Safe to apply before OR after the app
--   deploy: pre-deploy it simply narrows the aggregate the current code already
--   consumes; the in-code legacy fallback scan carries the same predicate.
--
-- Idempotent: CREATE OR REPLACE FUNCTION is safe to re-run. No data changes.

CREATE OR REPLACE FUNCTION scheduling.historical_call_counts(p_site_id uuid, p_before date)
RETURNS TABLE (provider_id uuid, bucket text, code text, n bigint)
LANGUAGE sql STABLE AS $$
  SELECT a.provider_id,
         CASE
           WHEN ss.derived_day_type IN ('saturday','sunday') THEN 'weekend'
           WHEN ss.derived_day_type IN ('federal_holiday','major_holiday') THEN 'holiday'
           ELSE ss.derived_day_type::text
         END AS bucket,
         st.code,
         count(*) AS n
  FROM scheduling.assignments a
  JOIN scheduling.schedule_slots ss ON ss.id = a.schedule_slot_id
  -- Draft isolation: committed = published version only.
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
--   -- expect: rows only for providers whose past call sits in PUBLISHED versions;
--   -- a draft schedule with past-dated call slots contributes nothing.
