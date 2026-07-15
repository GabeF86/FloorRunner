-- supabase_scheduling_patch22_retire_d8_d9.sql — retire D8/D9 relief rows
-- (DATA-ONLY, 2026-07-15, Gabriel: "remove rows D8 and D9 because those are
-- rarely if ever assigned").
--
-- STATUS: applied 2026-07-15 via Management API (ref qhwdbtixhzdsgwwtcfrm).
--
-- What it does:
--   1. Deactivates the D8/D9 shift types (Paoli site; the only site with
--      D-codes). Slot creation filters is_active=true (schedules/route.ts:86),
--      so future schedules get no D8/D9 slots; the grid derives its rows from
--      slots, so no rows render.
--   2. Deletes existing D8/D9 slots + their assignment rows. At apply time ALL
--      such slots lived in the two DRAFT schedules (July 2026, August 2026;
--      nothing published): 144 slots, ~53 assignment rows — regenerable via
--      Auto-Generate at any time.
--
-- Rollback: UPDATE scheduling.shift_types SET is_active = true
--           WHERE code IN ('D8','D9');
--           then re-create slots by regenerating the affected draft schedules
--           (deleted draft rows are not restored — they were hypotheticals).
--
-- Engine note: the D4–D9 relief pass keys on relief_rank/slot existence; with
-- no D8/D9 slots it simply has nothing to fill. LEGACY_RELIEF_CODES in
-- solve.ts/solveLegacy.ts is a fallback list, not a slot generator (and
-- solveLegacy is frozen).

DELETE FROM scheduling.assignments a
USING scheduling.schedule_slots ss, scheduling.shift_types st
WHERE a.schedule_slot_id = ss.id
  AND ss.shift_type_id = st.id
  AND st.code IN ('D8','D9');

DELETE FROM scheduling.schedule_slots ss
USING scheduling.shift_types st
WHERE ss.shift_type_id = st.id
  AND st.code IN ('D8','D9');

UPDATE scheduling.shift_types SET is_active = false WHERE code IN ('D8','D9');

-- Verify:
-- SELECT st.code, st.is_active, count(ss.id) AS slots
-- FROM scheduling.shift_types st
-- LEFT JOIN scheduling.schedule_slots ss ON ss.shift_type_id = st.id
-- WHERE st.code IN ('D8','D9') GROUP BY 1,2;  -- expect false / 0 slots
