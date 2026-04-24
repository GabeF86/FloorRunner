-- Patch 9: Per-provider weekday availability
--
-- Used by non-call-taker "Day Docs" who only work certain weekdays (e.g. a
-- part-timer who does 7-5 shifts only Mon/Tue/Wed). Call-takers don't set
-- this — the scheduler picks their days via pool rotation.
--
-- Storage: jsonb array of 7 booleans indexed Sun..Sat to match
-- JavaScript Date.getDay() — no index math needed at the call site:
--   available_weekdays[date.getDay()] === true
--
-- Default is all-true so existing rows (and call-takers who never set this)
-- keep behaving exactly as they do today.

ALTER TABLE scheduling.provider_employment_profiles
  ADD COLUMN IF NOT EXISTS available_weekdays jsonb
  NOT NULL DEFAULT '[true, true, true, true, true, true, true]'::jsonb;

COMMENT ON COLUMN scheduling.provider_employment_profiles.available_weekdays IS
  'Which weekdays this provider is available to work. 7-element boolean array indexed Sun..Sat (matches JS Date.getDay). Editable in the UI only for non-call-takers; call-takers default to all-true and the scheduler picks their days by rotation.';
