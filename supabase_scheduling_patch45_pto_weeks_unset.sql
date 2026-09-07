-- supabase_scheduling_patch45_pto_weeks_unset.sql
-- Make a blank PTO allotment distinguishable from a stated zero.
-- (Gabriel 2026-09-06.)
--
-- PROJECT: apply ONLY to Supabase ref qhwdbtixhzdsgwwtcfrm ("Floor Runner").
--
-- STATUS: NOT YET APPLIED.
--
-- ── ORDER: CODE FIRST ───────────────────────────────────────────────────────
-- Not for a strict-schema reason (this is a plain nullable integer column with
-- no parser behind it). The reason is simpler: the provider profile editor
-- currently writes 0 whenever the PTO Weeks field is blank, so running this
-- first would let the very next profile save manufacture a fresh crop of
-- meaningless zeros. Ship the editor fix, confirm the build is live, then run
-- this.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- pto_weeks is nullable but DEFAULTs to 0, so "gets no vacation" and "nobody
-- filled this in" have always been the same value. As of 2026-09-06 the live
-- roster is 78 rows at 0, 5 rows stated (Farkas 9, Amusa 7, Hussain 7,
-- Chamchad 6, Vu 6), and 0 rows null. The Block Prep board needs the
-- distinction: it must be able to say "no allotment stated" without saying
-- "this person gets none", because Gabriel confirmed real zeros exist (per
-- diem call takers).
--
-- Nothing deliberately entered is lost. Every row this touches holds the
-- column default and carries no information; the five stated values are
-- untouched by the WHERE clause.
--
-- ── EFFECT ──────────────────────────────────────────────────────────────────
-- No assignment, schedule or obligation changes. gridCalculator's simulator
-- already reads `profile.pto_weeks ?? DEFAULT_PTO_WEEKS` and DEFAULT_PTO_WEEKS
-- is 0, so it treats unset exactly as it treats today's zeros — byte-identical
-- behaviour there. The Block Prep board renders an em-dash and no remaining
-- figure for a null allotment.

BEGIN;

-- Sanity: expect 78 / 5 / 0 at authoring time. A wildly different split means
-- someone has been editing allotments — stop and re-read before committing.
SELECT
  count(*) FILTER (WHERE pto_weeks = 0)    AS will_be_cleared,
  count(*) FILTER (WHERE pto_weeks > 0)    AS stated_untouched,
  count(*) FILTER (WHERE pto_weeks IS NULL) AS already_null
FROM scheduling.provider_employment_profiles;

UPDATE scheduling.provider_employment_profiles
SET pto_weeks = NULL
WHERE pto_weeks = 0;

COMMIT;

-- Drop the default so future INSERTs leave the allotment unstated rather than
-- silently claiming a real zero.
ALTER TABLE scheduling.provider_employment_profiles
  ALTER COLUMN pto_weeks DROP DEFAULT;
