-- supabase_scheduling_patch22_retire_d8_d9.sql — retire D8/D9 relief rows
-- (DATA-ONLY, 2026-07-15, Gabriel: "remove rows D8 and D9 because those are
-- rarely if ever assigned").
--
-- STATUS: applied 2026-07-15 via Management API (ref qhwdbtixhzdsgwwtcfrm),
-- in two steps (the shift_templates UPDATE was added after review caught that
-- slot creation keys on shift_TEMPLATES.is_active, not shift_types.is_active).
--
-- What it does:
--   1. Deactivates the D8/D9 SHIFT TEMPLATES — this is what actually prevents
--      future slots: new-schedule creation fetches active templates
--      (schedules/route.ts ~86, `.from('shift_templates').eq('is_active',true)`).
--   2. Deactivates the D8/D9 shift TYPES for consistency (settings UI, any
--      future is_active consumers).
--   3. Deletes existing D8/D9 slots + assignment rows. At apply time all such
--      slots lived in the two DRAFT schedules (July 2026, August 2026; nothing
--      published): 144 slots, 53 assignment rows. The grid derives its rows
--      from slots, so the D8/D9 rows disappear from existing drafts too.
--      (The explicit assignments DELETE is redundant with the ON DELETE CASCADE
--      from schedule_slots — kept for clarity/explicitness.)
--
-- Rollback: UPDATE scheduling.shift_templates t SET is_active = true
--             FROM scheduling.shift_types st
--             WHERE st.id = t.shift_type_id AND st.code IN ('D8','D9');
--           UPDATE scheduling.shift_types SET is_active = true
--             WHERE code IN ('D8','D9');
--           Deleted DRAFT slots are NOT restorable and are only re-created when
--           a NEW schedule is created (slot creation happens at schedule
--           creation from templates; Auto-Generate only FILLS existing open
--           slots, it never creates slots).
--
-- Engine note: the D4–D9 relief pass keys on relief_rank/slot existence; with
-- no D8/D9 slots it has nothing to fill. The relief code lists
-- (LEGACY_RELIEF_CODES in solve.ts; RELIEF_CODES in frozen solveLegacy.ts) are
-- lookup fallbacks, not slot generators.

UPDATE scheduling.shift_templates t SET is_active = false
FROM scheduling.shift_types st
WHERE st.id = t.shift_type_id AND st.code IN ('D8','D9');

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
-- SELECT st.code, st.is_active AS type_active, t.is_active AS template_active,
--        count(ss.id) AS slots
-- FROM scheduling.shift_types st
-- LEFT JOIN scheduling.shift_templates t ON t.shift_type_id = st.id
-- LEFT JOIN scheduling.schedule_slots ss ON ss.shift_type_id = st.id
-- WHERE st.code IN ('D8','D9') GROUP BY 1,2,3;  -- expect false/false/0
