-- Patch 10: Day-doc specific scheduling prefs
--
-- Two new fields on provider_employment_profiles, both intended for use by
-- non-call-takers ("Day Docs"):
--
--   1. preferred_day_shift_types — which day-shift codes this provider is
--      willing to work (e.g. ['7-3'] or ['7-5'] or ['7-3','7-5']). Empty
--      array = no restriction. Hard filter once day-shift auto-gen lands.
--
--   2. days_per_week — how many days per week this provider wants to be
--      scheduled. Independent from available_weekdays: e.g. "available Mon
--      through Fri, but only wants 3 days/week". The scheduler picks 3 of
--      the 5 based on fairness/demand. NULL = no cap, which is the old
--      behavior for call-takers and anyone who doesn't set it.
--
-- We considered deriving days_per_week from max_weekly_hours but rejected
-- that: it would require assuming a uniform shift duration, which varies
-- across sites (7-3 vs 7-5 vs 10-hour rooms).

ALTER TABLE scheduling.provider_employment_profiles
  ADD COLUMN IF NOT EXISTS preferred_day_shift_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS days_per_week integer;

-- Sanity-check the range. 0 and >7 would indicate data corruption.
ALTER TABLE scheduling.provider_employment_profiles
  DROP CONSTRAINT IF EXISTS provider_employment_profiles_days_per_week_check;
ALTER TABLE scheduling.provider_employment_profiles
  ADD CONSTRAINT provider_employment_profiles_days_per_week_check
  CHECK (days_per_week IS NULL OR (days_per_week BETWEEN 1 AND 7));

COMMENT ON COLUMN scheduling.provider_employment_profiles.preferred_day_shift_types IS
  'Array of shift_type codes this provider is willing to work on day shifts. Empty = no restriction. Hard filter once day-shift auto-gen is implemented.';

COMMENT ON COLUMN scheduling.provider_employment_profiles.days_per_week IS
  'How many days per week this Day Doc wants to be scheduled. NULL = no cap. Independent of available_weekdays — a provider can be available 5 days but only want 3.';
