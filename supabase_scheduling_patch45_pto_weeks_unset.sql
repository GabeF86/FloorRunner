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
-- Nothing deliberately entered AS OF AUTHORING is lost: the 78 rows this
-- touches hold nothing but the column default, and the five stated values are
-- untouched by the WHERE clause. But be plain about the window this patch's
-- own ordering rule opens: CODE-FIRST means the fixed editor is live for some
-- span of time before this runs, and the UPDATE below cannot tell a genuine
-- zero typed during that span apart from the 78 pre-existing defaults — it
-- will wipe that zero too. That is the exact class of data this patch exists
-- to protect, and the pre-flight check further down only catches a GROSS
-- change (someone losing a stated value entirely), not one new deliberate
-- zero arriving alongside the 78 meaningless ones. Practical consequence:
-- anyone who needs to record a real zero during the deploy window should wait
-- and enter it AFTER this patch has run, not before.
--
-- ── EFFECT ──────────────────────────────────────────────────────────────────
-- No assignment, schedule or obligation changes. gridCalculator's simulator
-- already reads `profile.pto_weeks ?? DEFAULT_PTO_WEEKS` and DEFAULT_PTO_WEEKS
-- is 0, so it treats unset exactly as it treats today's zeros — byte-identical
-- behaviour there. The Block Prep board renders an em-dash and no remaining
-- figure for a null allotment.

BEGIN;

-- Pre-flight: refuse to run unless at least the 5 known stated (pto_weeks > 0)
-- rows are still present. Fewer than that means someone has been editing
-- allotments since this was authored, and the "these zeros carry no
-- information" premise the UPDATE below relies on no longer holds — stop and
-- re-read rather than trusting the comment above blindly.
--
-- Deliberately NOT asserting already_null = 0: CODE-FIRST legitimately lets
-- genuine nulls appear before this runs (a provider saved through the fixed
-- editor with a truly blank field), and that is expected, not a reason to
-- abort.
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n
    FROM scheduling.provider_employment_profiles
   WHERE pto_weeks > 0;
  IF n < 5 THEN
    RAISE EXCEPTION 'patch45: expected at least 5 stated (pto_weeks > 0) rows, found % — allotments may have changed since authoring; re-verify before running. Aborting', n;
  END IF;
END $$;

-- Expect: UPDATE 78 (at authoring time; may be fewer if some providers had
-- already been given a genuine blank through the fixed editor before this ran).
UPDATE scheduling.provider_employment_profiles
SET pto_weeks = NULL
WHERE pto_weeks = 0;

-- Drop the default so future INSERTs leave the allotment unstated rather than
-- silently claiming a real zero. Inside the same transaction as the UPDATE:
-- Postgres DDL is transactional, and if this ALTER fails for any reason we
-- want the whole patch to roll back rather than leave 78 freshly-nulled rows
-- still fed by a live `DEFAULT 0`, which would silently regenerate the exact
-- ambiguity this patch exists to remove the next time a row is inserted.
ALTER TABLE scheduling.provider_employment_profiles
  ALTER COLUMN pto_weeks DROP DEFAULT;

COMMIT;

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ VERIFICATION — run these AFTER applying                                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- (1) the five known stated values survived untouched:
--   SELECT count(*) FROM scheduling.provider_employment_profiles WHERE pto_weeks > 0;
--   -- expect: 5 (or more, if someone stated a fresh one during the deploy
--   -- window described above).
--
-- (2) the old meaningless zeros are gone:
--   SELECT count(*) FROM scheduling.provider_employment_profiles WHERE pto_weeks = 0;
--   -- expect: 0, UNLESS a provider was deliberately set to a real zero
--   -- through the (now-live) editor — that is legitimate and expected to
--   -- persist.
--
-- (3) the default is gone, so future inserts don't regenerate the ambiguity:
--   SELECT column_default FROM information_schema.columns
--    WHERE table_schema = 'scheduling' AND table_name = 'provider_employment_profiles'
--      AND column_name = 'pto_weeks';
--   -- expect: NULL (no default).
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ ROLLBACK                                                                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
--   UPDATE scheduling.provider_employment_profiles SET pto_weeks = 0 WHERE pto_weeks IS NULL;
--   ALTER TABLE scheduling.provider_employment_profiles ALTER COLUMN pto_weeks SET DEFAULT 0;
--
-- Two caveats. The second is the highest-consequence failure mode of this
-- whole change and currently appears nowhere else — read it before touching
-- either rollback path.
--
-- (a) The UPDATE above is only faithful if run BEFORE anyone has stated a
--     genuine blank through the fixed editor. Once a provider's allotment has
--     been deliberately left unset post-patch, this rollback overwrites that
--     NULL with a fake 0 — reintroducing, for that provider, the exact
--     "nobody filled this in" vs. "gets none" collision the whole patch exists
--     to undo. Check how many rows are NULL against the ~78 expected-unstated
--     count before running it; if the count has moved for a reason other than
--     newly-stated genuine zeros, this rollback will do damage, not repair it.
--
-- (b) THE ONE THAT MATTERS: a Vercel code rollback WITHOUT also running the DB
--     rollback above is SILENTLY DESTRUCTIVE. Pre-change code renders the PTO
--     Weeks field via `String(profile.pto_weeks ?? 0)`, so every one of the 78
--     newly-NULL rows displays as "0" again in the editor, indistinguishable
--     from a stated zero. The very next time ANY of those 78 profiles is
--     saved on the Scheduling tab — for any reason, since the tab's Save
--     button writes every field on it together, not just the one the user
--     touched — that displayed "0" round-trips straight back into the
--     database as a real value. This re-collapses the distinction one
--     provider at a time, with nothing anywhere reporting it. A code-only
--     rollback is therefore not safe to leave in place for any length of
--     time: either run the DB rollback in the same window, or don't roll the
--     code back at all.
