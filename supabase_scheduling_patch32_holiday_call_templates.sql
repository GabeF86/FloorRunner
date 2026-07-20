-- supabase_scheduling_patch32_holiday_call_templates.sql — call slots on
-- federal/major holidays (DATA-ONLY, 2026-07-20, Gabriel: "The scheduler
-- doesn't allow me to place people on call on the federal holidays, like
-- labor day. I need to be able to input call people on those days.")
--
-- STATUS: applied 2026-07-20 via Management API (ref qhwdbtixhzdsgwwtcfrm).
--
-- Context: slot creation matches templates strictly by day_type (schedules/
-- route.ts ~139; applies_on_holiday is not consulted on that path). patch23's
-- holiday seeding (2026-07-15) made holiday dates stamp day_type
-- major_holiday/federal_holiday — for which NO templates existed, so those
-- dates materialize ZERO call slots (before the seeding they were plain
-- weekdays with full slates; this gap is the seeding's side effect).
--
-- What it does (Paoli site 2ddd2427-22fb-4290-9c4c-03a957e5af4e):
--   1. Adds shift_templates for C1 and C2 on BOTH holiday day types
--      (required_count 1, layer 'call' — mirrors the weekday call slate).
--      C3/neuro deliberately NOT added: the C3 block is Fri-Sun anchored;
--      holiday neuro coverage is a separate structural decision if wanted.
--      Day-shift codes deliberately NOT added (ORs closed on holidays).
--   2. Backfills the missing C1/C2 slots (+ their open assignment rows,
--      one-row-per-slot model) into EXISTING draft schedule versions for
--      holiday dates in range. Idempotent (NOT EXISTS guards).
--
-- Engine notes: weekend-v2 dayChains already treat federal/major_holiday
-- C1/C2 weekday-like (D2 pre-link with recent-call waiver; C2 -> next-day D1;
-- post-call blocks); dayTypeFillOrder places holidays after weekday; the
-- credentials gate can_take_holiday_call applies; fairness accrues to the
-- merged 'holiday' bucket. Manual placement works the moment slots exist.
--
-- Rollback: DELETE the two template rows (by day_type + site + shift codes)
-- and the backfilled slots (their assignments cascade); draft-only data.

INSERT INTO scheduling.shift_templates
  (site_id, schedule_layer, day_type, shift_type_id, required_count, is_active)
SELECT '2ddd2427-22fb-4290-9c4c-03a957e5af4e', 'call', dt.day_type::scheduling.day_type, st.id, 1, true
FROM (VALUES ('major_holiday'), ('federal_holiday')) AS dt(day_type)
CROSS JOIN scheduling.shift_types st
WHERE st.code IN ('C1','C2') AND st.site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
  AND st.is_active
  AND NOT EXISTS (
    SELECT 1 FROM scheduling.shift_templates t
    WHERE t.site_id = st.site_id AND t.shift_type_id = st.id
      AND t.day_type = dt.day_type::scheduling.day_type
  );

-- Backfill slots into existing draft versions (holiday dates in each
-- version's range that lack a slot for these codes).
INSERT INTO scheduling.schedule_slots
  (schedule_version_id, site_id, slot_date, shift_type_id, slot_index,
   required_count, derived_day_type, locked)
SELECT sv.id, s.site_id, h.holiday_date, st.id, 0, 1,
       (CASE WHEN h.is_major_holiday THEN 'major_holiday' ELSE 'federal_holiday' END)::scheduling.day_type,
       false
FROM scheduling.schedule_versions sv
JOIN scheduling.schedules s ON s.id = sv.schedule_id
JOIN scheduling.holiday_calendars h
  ON h.organization_id = s.organization_id
 AND h.holiday_date BETWEEN s.date_start AND s.date_end
JOIN scheduling.shift_types st
  ON st.site_id = s.site_id AND st.code IN ('C1','C2') AND st.is_active
WHERE sv.version_status = 'draft'
  AND s.site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
  AND NOT EXISTS (
    SELECT 1 FROM scheduling.schedule_slots ss
    WHERE ss.schedule_version_id = sv.id AND ss.slot_date = h.holiday_date
      AND ss.shift_type_id = st.id
  );

-- One open assignment row per new slot (UNIQUE(schedule_slot_id) model).
INSERT INTO scheduling.assignments (schedule_slot_id, assignment_status, source_type)
SELECT ss.id, 'open', 'auto_generated'
FROM scheduling.schedule_slots ss
WHERE NOT EXISTS (SELECT 1 FROM scheduling.assignments a WHERE a.schedule_slot_id = ss.id);

-- Verify:
-- SELECT t.day_type, st.code FROM scheduling.shift_templates t
--   JOIN scheduling.shift_types st ON st.id=t.shift_type_id
--   WHERE t.day_type IN ('major_holiday','federal_holiday') AND t.is_active;
-- SELECT ss.slot_date, st.code FROM scheduling.schedule_slots ss
--   JOIN scheduling.shift_types st ON st.id=ss.shift_type_id
--   WHERE ss.derived_day_type IN ('major_holiday','federal_holiday');
