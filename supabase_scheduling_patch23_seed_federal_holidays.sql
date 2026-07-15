-- supabase_scheduling_patch23_seed_federal_holidays.sql — seed US federal
-- holidays 2026–2027 (DATA-ONLY, 2026-07-15, Gabriel: "label any column/day
-- that is a federal holiday by making that whole column yellow").
--
-- STATUS: applied 2026-07-15 via Management API (ref qhwdbtixhzdsgwwtcfrm).
--
-- Context: the grid's yellow holiday-column treatment (headers, data cells,
-- virtual rows via gridTheme cellBackground + holidayMap) was already fully
-- built — but holiday_calendars was EMPTY, so nothing ever rendered. This
-- seeds the ACTUAL holiday dates (not federal "observed" dates — the hospital
-- runs on the real day). Org-wide rows (site_id NULL).
--
-- is_major_holiday = true for the "big six" (New Year's, Memorial, July 4,
-- Labor Day, Thanksgiving, Christmas) — feeds the major_holiday day-type
-- bucket for call burden on FUTURE schedules. NOTE: existing schedules'
-- slots keep the derived_day_type stamped at their creation (slot creation
-- reads this table); seeding does NOT restamp them — visual highlighting
-- works immediately for all schedules, burden buckets only for schedules
-- created after this patch.
--
-- Rollback: DELETE FROM scheduling.holiday_calendars
--           WHERE organization_id = '3d4621c3-340f-4a16-b3fc-8529a2ccb42e'
--             AND holiday_date BETWEEN '2026-01-01' AND '2027-12-25';

INSERT INTO scheduling.holiday_calendars
  (organization_id, holiday_name, holiday_date, holiday_type, is_major_holiday)
VALUES
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'New Year''s Day',        '2026-01-01', 'federal', true),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'MLK Jr. Day',            '2026-01-19', 'federal', false),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'Washington''s Birthday', '2026-02-16', 'federal', false),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'Memorial Day',           '2026-05-25', 'federal', true),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'Juneteenth',             '2026-06-19', 'federal', false),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'Independence Day',       '2026-07-04', 'federal', true),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'Labor Day',              '2026-09-07', 'federal', true),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'Columbus Day',           '2026-10-12', 'federal', false),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'Veterans Day',           '2026-11-11', 'federal', false),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'Thanksgiving',           '2026-11-26', 'federal', true),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'Christmas Day',          '2026-12-25', 'federal', true),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'New Year''s Day',        '2027-01-01', 'federal', true),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'MLK Jr. Day',            '2027-01-18', 'federal', false),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'Washington''s Birthday', '2027-02-15', 'federal', false),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'Memorial Day',           '2027-05-31', 'federal', true),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'Juneteenth',             '2027-06-19', 'federal', false),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'Independence Day',       '2027-07-04', 'federal', true),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'Labor Day',              '2027-09-06', 'federal', true),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'Columbus Day',           '2027-10-11', 'federal', false),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'Veterans Day',           '2027-11-11', 'federal', false),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'Thanksgiving',           '2027-11-25', 'federal', true),
  ('3d4621c3-340f-4a16-b3fc-8529a2ccb42e', 'Christmas Day',          '2027-12-25', 'federal', true);

-- Verify:
-- SELECT holiday_date, holiday_name, is_major_holiday
-- FROM scheduling.holiday_calendars ORDER BY holiday_date;  -- expect 22 rows (11 x 2 years)
