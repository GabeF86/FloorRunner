-- Add UNIQUE constraints to both assignment tables to close the
-- read-then-write / check-then-insert races that allow duplicate rows
-- and lost writes when two clients edit concurrently. Verified 2026-05-24
-- that no existing rows violate either constraint.

-- ── scheduling.assignments ──────────────────────────────────────────────────
-- The app keeps exactly ONE assignment row per schedule slot (the row flips
-- between assignment_status 'open' and 'assigned'); the POST handler does
-- update-by-slot-else-insert. Two concurrent inserts can both miss the
-- existing row. Enforce one row per slot so the second insert conflicts.
ALTER TABLE scheduling.assignments
  ADD CONSTRAINT assignments_schedule_slot_id_key UNIQUE (schedule_slot_id);

-- ── public.assignments (OR board) ────────────────────────────────────────────
-- A provider may cover multiple rooms simultaneously (physicians), but must
-- not appear in the SAME room twice on the same board date. The board POST
-- does check-then-insert, which races. Enforce uniqueness on the triple.
ALTER TABLE public.assignments
  ADD CONSTRAINT assignments_staff_room_date_key UNIQUE (staff_id, room_id, board_date);
