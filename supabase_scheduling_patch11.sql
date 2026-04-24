-- Patch 11: Per-schedule override pool
--
-- When set, the auto-generator uses exactly this list of providers as the
-- candidate pool, bypassing the default home_site + call_taker rules. Set
-- from the "Select Pool of Physicians" modal on the schedule detail page.
--
--   NULL         → use the default rule-based pool (existing behavior)
--   jsonb array  → use exactly these provider UUIDs as the pool
--
-- Eligibility checks (credentials, availability, weekday, same-day conflict,
-- cross-site, FTE quotas) still apply on top of the override — the list
-- determines *who* is a candidate, not *whether they can take this slot*.

ALTER TABLE scheduling.schedules
  ADD COLUMN IF NOT EXISTS included_provider_ids jsonb;

COMMENT ON COLUMN scheduling.schedules.included_provider_ids IS
  'Optional pool override. NULL = use default rule-based pool. jsonb array of provider UUIDs = use exactly these as candidates. Set via the "Select Pool of Physicians" modal on the schedule detail page.';

NOTIFY pgrst, 'reload schema';
