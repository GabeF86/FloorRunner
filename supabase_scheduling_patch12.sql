-- Patch 12: Day Doc role flag
--
-- A "Day Doc" is an employed physician who does not take call and works a
-- scheduled number of shifts per week (7-3, 7-5, 7-7). Distinct from a
-- locums, a retired physician, or a CRNA who happens to not be a call-taker.
--
-- Mutually exclusive in the UI with call_taker and partial_call_taker (you
-- can't be both "in the call pool" and a "day doc"). Enforcement lives in
-- the form layer — we don't add a CHECK constraint here because a future
-- edge case (e.g. a day-doc covering an extra call) might want both set and
-- we'd rather that be a business decision than a DB constraint to migrate
-- away from.
--
-- Replaces the previous implicit "non-call-taker" pool in day-shift
-- auto-gen, which swept in every non-call-taker regardless of whether they
-- were actually a Day Doc (vs. locums, retired, etc.).

ALTER TABLE scheduling.provider_employment_profiles
  ADD COLUMN IF NOT EXISTS is_day_doc boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN scheduling.provider_employment_profiles.is_day_doc IS
  'True for employed physicians who do not take call and work scheduled weekday shifts. Used as the day-shift auto-gen pool. Mutually exclusive with call_taker / partial_call_taker in the UI.';

NOTIFY pgrst, 'reload schema';
