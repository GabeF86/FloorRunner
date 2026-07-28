-- supabase_scheduling_patch42_assignment_highlight.sql
-- One nullable, CHECK-constrained colour column on assignments: the
-- scheduler's HAND-SET "this call is billable extra" mark on the schedule grid.
--
-- PROJECT: apply ONLY to Supabase ref qhwdbtixhzdsgwwtcfrm ("Floor Runner" —
-- the ref in .env.local). Two OTHER Supabase projects are connected to this
-- machine for DIFFERENT apps (atlas-staging, ChiefOS); running FloorRunner DDL
-- through those is a known foot-gun. VERIFY THE REF BEFORE APPLYING.
--
-- STATUS: APPLIED 2026-07-28 to project qhwdbtixhzdsgwwtcfrm via the
--   project-scoped supabase-floorrunner MCP (apply_migration
--   "patch42_assignment_highlight"), BEFORE deploying the code, per the
--   ordering reasoned out below.
--   Post-apply spot check:
--     column  -> text, nullable=YES
--     CHECK   -> ((highlight_color IS NULL) OR (highlight_color = ANY
--                 (ARRAY['blue','red','yellow'])))
--     data    -> 653 existing assignment rows, 0 with a highlight (all NULL).
--                Nothing disturbed; the column is purely additive.

ALTER TABLE scheduling.assignments
  ADD COLUMN IF NOT EXISTS highlight_color text;

COMMENT ON COLUMN scheduling.assignments.highlight_color IS
  'Manual grid highlight set by the scheduler (patch42): blue | red | yellow, '
  'or NULL for no mark. Presentation only — an annotation marking a call as '
  'billable extra. No engine reads it and no rule validates against it. '
  'Vocabulary is single-homed in src/lib/highlightColor.ts.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'assignments_highlight_color_check'
       AND conrelid = 'scheduling.assignments'::regclass
  ) THEN
    ALTER TABLE scheduling.assignments
      ADD CONSTRAINT assignments_highlight_color_check
      CHECK (highlight_color IS NULL OR highlight_color IN ('blue', 'red', 'yellow'));
  END IF;
END $$;

-- PostgREST serves reads and writes from a CACHED schema. Until it reloads, a
-- select naming the new column is answered 42703 and an insert/update naming it
-- is answered PGRST204 ("Could not find the 'highlight_color' column of
-- 'assignments' in the schema cache") — which the app classifies as "this DB
-- predates patch42" and silently degrades on. That would look exactly like a
-- failed apply. Supabase's DDL event trigger normally reloads by itself; this is
-- belt-and-braces. If the app still reports highlighting unavailable a minute
-- after applying, run this again (or restart the API from the dashboard) BEFORE
-- suspecting the column.
NOTIFY pgrst, 'reload schema';

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ VERIFICATION — run these AFTER applying. Query 3 is the one that matters:║
-- ║ it proves a typo cannot become an invisible colour.                      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── (1) the column exists, is nullable, has no default ──────────────────────
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_schema = 'scheduling' AND table_name = 'assignments'
--      AND column_name = 'highlight_color';
--   -- expect: exactly one row — text / YES / NULL. A non-null default would
--   -- mean every existing call silently acquired a mark.
--
-- ── (2) every pre-existing row is unmarked ──────────────────────────────────
--   SELECT count(*) AS total,
--          count(highlight_color) AS marked
--     FROM scheduling.assignments;
--   -- expect: marked = 0 immediately after applying (count() skips NULLs).
--   -- Anything else means this patch was not the first thing to touch the
--   -- column.
--
-- ── (3) THE PROOF: the CHECK actually refuses a bad value ───────────────────
-- Do not take the constraint's existence in the catalog as evidence that it
-- works. Run it against a real row and watch it fail.
--   BEGIN;
--     -- pick any assignment; nothing is kept
--     UPDATE scheduling.assignments
--        SET highlight_color = 'blue'
--      WHERE id = (SELECT id FROM scheduling.assignments LIMIT 1);
--     -- expect: UPDATE 1
--     UPDATE scheduling.assignments
--        SET highlight_color = 'bleu'
--      WHERE id = (SELECT id FROM scheduling.assignments LIMIT 1);
--     -- expect: ERROR 23514 new row for relation "assignments" violates
--     --         check constraint "assignments_highlight_color_check"
--     -- If this SUCCEEDS, the constraint did not apply — stop and fix it.
--     UPDATE scheduling.assignments
--        SET highlight_color = 'Blue'   -- case matters
--      WHERE id = (SELECT id FROM scheduling.assignments LIMIT 1);
--     -- expect: the same 23514.
--     UPDATE scheduling.assignments
--        SET highlight_color = NULL
--      WHERE id = (SELECT id FROM scheduling.assignments LIMIT 1);
--     -- expect: UPDATE 1 — NULL is always allowed (it is "no mark").
--   ROLLBACK;
--
-- ── (4) the constraint is where it should be ────────────────────────────────
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conrelid = 'scheduling.assignments'::regclass
--      AND conname = 'assignments_highlight_color_check';
--   -- expect: CHECK (highlight_color IS NULL OR highlight_color = ANY
--   --         (ARRAY['blue'::text, 'red'::text, 'yellow'::text]))
--
-- ── (5) end to end through the deployed app ─────────────────────────────────
--   In the UI: open a schedule grid, RIGHT-CLICK an assigned cell, pick Blue.
--   The cell paints immediately (strong blue + a dark inset ring — distinctly
--   heavier than the pale automatic extra-call blue). Then:
--     a. Reload the page — the mark is still there (it is stored, not local).
--     b. Confirm it in the DB:
--          SELECT a.id, p.short_display_name, ss.slot_date, a.highlight_color
--            FROM scheduling.assignments a
--            JOIN scheduling.schedule_slots ss ON ss.id = a.schedule_slot_id
--            LEFT JOIN scheduling.providers p ON p.id = a.provider_id
--           WHERE a.highlight_color IS NOT NULL
--           ORDER BY ss.slot_date;
--     c. REASSIGN that same cell to a different provider, then re-run (b) —
--        the row must come back with highlight_color NULL. The mark belongs to
--        the provider whose call it described; it must not follow the cell.
--     d. Right-click again → Clear. The cell returns to its normal computed
--        background (weekend gray / holiday amber / over-par red as applicable
--        — the automatic states were only out-ranked, never overwritten).
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ ROLLBACK                                                                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
--   ALTER TABLE scheduling.assignments
--     DROP CONSTRAINT IF EXISTS assignments_highlight_color_check;
--   ALTER TABLE scheduling.assignments
--     DROP COLUMN IF EXISTS highlight_color;
--   NOTIFY pgrst, 'reload schema';
--
-- DESTRUCTIVE: dropping the column discards every mark the scheduler has made,
-- and there is no other copy of them. Deployed code keeps working — it falls
-- back onto the PRE42 read rung and the 501 write branch, i.e. the same
-- degraded-but-functional state as before the patch — but the marks themselves
-- are gone for good. Export first if any exist:
--   SELECT a.id, a.highlight_color FROM scheduling.assignments a
--    WHERE a.highlight_color IS NOT NULL;
