-- Patch 6: Add call_par_level to sites
--
-- Auto-generation divides total slots in a bucket (day_type × shift_code)
-- by this par_level to compute each provider's fair-share target. Setting
-- this on the site rather than the org so multi-site groups can tune each
-- facility independently. Default 12 matches the Paoli/Lankenau typical
-- full-time call-taker count; other groups will override.

ALTER TABLE scheduling.sites
  ADD COLUMN IF NOT EXISTS call_par_level INTEGER NOT NULL DEFAULT 12;

COMMENT ON COLUMN scheduling.sites.call_par_level IS
  'Baseline number of full-time call-takers used by auto-generate to compute per-provider call quotas. Provider quota = (total_bucket_slots / call_par_level) × FTE.';
