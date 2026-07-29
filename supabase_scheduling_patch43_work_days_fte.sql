-- supabase_scheduling_patch43_work_days_fte.sql
-- One nullable, CHECK-constrained numeric on provider_employment_profiles:
-- the WORKING-DAYS FTE, split out from the call FTE.
--
-- PROJECT: apply ONLY to Supabase ref qhwdbtixhzdsgwwtcfrm ("Floor Runner" —
-- the ref in .env.local). Two OTHER Supabase projects are connected to this
-- machine for DIFFERENT apps (atlas-staging, ChiefOS); running FloorRunner DDL
-- through those is a known foot-gun. VERIFY THE REF BEFORE APPLYING.
--
-- STATUS: APPLIED 2026-07-29 to project qhwdbtixhzdsgwwtcfrm via the
--   project-scoped supabase-floorrunner MCP (apply_migration
--   "patch43_work_days_fte").
--   Post-apply: set O.Hussain work_days_fte = 1.00 (call_fte 0.70). He spends
--   a third of his time in the ICU, which is why his CALL share is prorated —
--   but he is obligated to work every day he is not on call, on PTO or off.
--   Gabriel, verbatim: "that only applies to pro rating the call shifts, and
--   does not apply to the actual days he's obligated to work."
--   Every other provider remains NULL = unchanged.

ALTER TABLE scheduling.provider_employment_profiles
  ADD COLUMN IF NOT EXISTS work_days_fte numeric(3,2);

COMMENT ON COLUMN scheduling.provider_employment_profiles.work_days_fte IS
  'WORKING-DAYS FTE (patch43): the share of a block''s working days this '
  'provider must be scheduled to work. NULL means "same as fte_value", which '
  'is the state of every provider unless a chief states otherwise. DISTINCT '
  'FROM fte_value, which pro-rates CALL only (quotas, bucket targets, the '
  'obligation census, over-par selection, neuro bands) and is never affected '
  'by this column. Read only by the working-days contract, '
  'src/lib/rulesEngine/workDays.ts. Range 0..1 — nobody can owe more working '
  'days than the block has. A per-schedule Limits-tab workingDays/daysOff '
  'entry (schedules.provider_limits, patch34) still outranks this.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'provider_employment_profiles_work_days_fte_check'
       AND conrelid = 'scheduling.provider_employment_profiles'::regclass
  ) THEN
    ALTER TABLE scheduling.provider_employment_profiles
      ADD CONSTRAINT provider_employment_profiles_work_days_fte_check
      CHECK (work_days_fte IS NULL OR (work_days_fte >= 0 AND work_days_fte <= 1));
  END IF;
END $$;

-- PostgREST serves reads and writes from a CACHED schema. Until it reloads, a
-- select naming the new column is answered 42703 and an update naming it is
-- answered PGRST204 ("Could not find the 'work_days_fte' column of
-- 'provider_employment_profiles' in the schema cache") — which the app
-- classifies as "this DB predates patch43" and silently degrades on (reads) or
-- surfaces as a failed save (writes). That would look exactly like a failed
-- apply. Supabase's DDL event trigger normally reloads by itself; this is
-- belt-and-braces. If the provider page still refuses to save a Working-Days
-- FTE a minute after applying, run this again (or restart the API from the
-- dashboard) BEFORE suspecting the column.
NOTIFY pgrst, 'reload schema';

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ VERIFICATION — run these AFTER applying. Query 3 is the one that matters: ║
-- ║ it proves a typo cannot become a silent obligation.                      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── (1) the column exists, is nullable, has NO default ──────────────────────
--   SELECT column_name, data_type, numeric_precision, numeric_scale,
--          is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_schema = 'scheduling'
--      AND table_name = 'provider_employment_profiles'
--      AND column_name = 'work_days_fte';
--   -- expect: exactly one row — numeric / 3 / 2 / YES / NULL.
--   -- A non-null DEFAULT would be a bug: it would silently give every
--   -- provider a stated working-days contract, which is precisely the
--   -- "unchanged for everyone else" property this patch promises.
--
-- ── (2) every pre-existing row is NULL (= "same as FTE") ────────────────────
--   SELECT count(*) AS profiles, count(work_days_fte) AS stated
--     FROM scheduling.provider_employment_profiles;
--   -- expect: stated = 0 immediately after applying (count() skips NULLs).
--   -- Anything else means this patch was not the first thing to touch it.
--
-- ── (3) THE PROOF: the CHECK actually refuses a bad value ───────────────────
-- Do not take the constraint's existence in the catalog as evidence that it
-- works. Run it against a real row and watch it fail.
--   BEGIN;
--     -- pick any profile; nothing is kept
--     UPDATE scheduling.provider_employment_profiles
--        SET work_days_fte = 1.00
--      WHERE id = (SELECT id FROM scheduling.provider_employment_profiles LIMIT 1);
--     -- expect: UPDATE 1
--     UPDATE scheduling.provider_employment_profiles
--        SET work_days_fte = 1.50
--      WHERE id = (SELECT id FROM scheduling.provider_employment_profiles LIMIT 1);
--     -- expect: ERROR 23514 new row for relation
--     --         "provider_employment_profiles" violates check constraint
--     --         "provider_employment_profiles_work_days_fte_check"
--     -- If this SUCCEEDS the constraint did not apply — stop and fix it.
--     -- 1.50 is the deliberate case: it is a LEGAL fte_value, so this is what
--     -- distinguishes the narrower working-days range from the call range.
--     UPDATE scheduling.provider_employment_profiles
--        SET work_days_fte = -0.25
--      WHERE id = (SELECT id FROM scheduling.provider_employment_profiles LIMIT 1);
--     -- expect: the same 23514.
--     UPDATE scheduling.provider_employment_profiles
--        SET work_days_fte = NULL
--      WHERE id = (SELECT id FROM scheduling.provider_employment_profiles LIMIT 1);
--     -- expect: UPDATE 1 — NULL is always allowed (it is "same as FTE").
--   ROLLBACK;
--
-- ── (4) the constraint is where it should be ────────────────────────────────
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conrelid = 'scheduling.provider_employment_profiles'::regclass
--      AND conname = 'provider_employment_profiles_work_days_fte_check';
--   -- expect: CHECK (work_days_fte IS NULL OR (work_days_fte >= 0 AND
--   --                work_days_fte <= 1))
--
-- ── (5) SET HUSSAIN — the case this patch exists for ────────────────────────
-- His call FTE stays 0.66. Confirm BOTH numbers afterwards; if fte_value moved,
-- something wrote the wrong column and his call quota is now wrong.
--   -- look him up first (never guess the id):
--   SELECT p.id, p.last_name, e.fte_value, e.work_days_fte
--     FROM scheduling.providers p
--     JOIN scheduling.provider_employment_profiles e ON e.provider_id = p.id
--    WHERE p.last_name ILIKE 'hussain%';
--   -- expect: one row, fte_value 0.66, work_days_fte NULL.
--
--   UPDATE scheduling.provider_employment_profiles
--      SET work_days_fte = 1.00
--    WHERE provider_id = '<the id from above>';
--   -- expect: UPDATE 1
--
--   -- re-run the SELECT: fte_value STILL 0.66, work_days_fte now 1.00.
--   -- Nobody else may have acquired one:
--   SELECT count(*) FROM scheduling.provider_employment_profiles
--    WHERE work_days_fte IS NOT NULL;
--   -- expect: 1
--
-- Preferred alternative: set it through the UI instead (Providers → Hussain →
-- Scheduling tab → Employment → "Working-Days FTE"), which exercises the write
-- path end to end. Blank in that field means "same as FTE" and stores NULL.
--
-- ── (6) end to end through the deployed app ─────────────────────────────────
--   a. Open the current Paoli block's Call Counts modal. Hussain's WORKING
--      DAYS required jumps to the block's working-day count minus his PTO
--      weekdays, and his DAYS OFF column drops to "—". Every OTHER physician's
--      two columns are unchanged — check two or three, including a partial.
--   b. His CALL columns must not move at all: Call Total, every bucket, the
--      Expected footer row, Obligatory Weekends, and which cells are painted
--      over-par. If any of those changed, stop: fte_value semantics leaked.
--   c. Dashboard → Physician Planner → Hussain: "Required days" matches (a),
--      "Entitled off" is 0, and the Required-days tooltip names BOTH FTEs.
--   d. Regenerate the block. The generation banner's working-days line shows
--      him as "worked N of <required>" with "work-days FTE 1" beside his call
--      FTE, and he is now placed on the D slots the 0.66 cap used to refuse.
--      Confirm the engine did not give him extra CALL to get there — his call
--      count against the obligation should be what it was.
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ ROLLBACK                                                                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
--   ALTER TABLE scheduling.provider_employment_profiles
--     DROP CONSTRAINT IF EXISTS provider_employment_profiles_work_days_fte_check;
--   ALTER TABLE scheduling.provider_employment_profiles
--     DROP COLUMN IF EXISTS work_days_fte;
--   NOTIFY pgrst, 'reload schema';
--
-- Low-risk as rollbacks go: deployed code keeps working — every reader falls
-- to its pre-43 rung and every provider's working-days budget goes back to
-- deriving from fte_value, i.e. the behaviour of the day before this shipped.
-- What is LOST is the stated contracts themselves (Hussain's 1.00), and there
-- is no other copy. Export first if any exist:
--   SELECT e.provider_id, p.last_name, e.fte_value, e.work_days_fte
--     FROM scheduling.provider_employment_profiles e
--     LEFT JOIN scheduling.providers p ON p.id = e.provider_id
--    WHERE e.work_days_fte IS NOT NULL;
--
-- NOTE: rolling back mid-block changes who the engine will place on a
-- REGENERATE. Already-committed assignments are untouched (they are rows in
-- `assignments`, not derived), but a regenerate after the rollback will hand
-- Hussain his ~18 days off back.
