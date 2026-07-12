-- supabase_scheduling_patch19_weekend_v2_pattern.sql
-- Weekend call v2 (spec docs/superpowers/specs/2026-07-12-weekend-call-v2-and-callcounts-design.md)
-- Applies to site 2ddd2427-22fb-4290-9c4c-03a957e5af4e (Paoli). Idempotence guard: aborts if already applied.
BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM scheduling.call_patterns
             WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e' AND name = 'Weekend v2 (2026-07-12)') THEN
    RAISE EXCEPTION 'patch19 already applied';
  END IF;
END $$;

-- 1. Archive the current active pattern (kept for one-click restore).
UPDATE scheduling.call_patterns
   SET status = 'archived', updated_at = now()
 WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e' AND status = 'active';

-- 2. Insert the new active pattern (JSON validated by CallPatternDocSchema at emit time).
INSERT INTO scheduling.call_patterns (site_id, name, status, source, definition)
VALUES ('2ddd2427-22fb-4290-9c4c-03a957e5af4e', 'Weekend v2 (2026-07-12)', 'active', 'manual', '{"version":1,"blocks":[{"anchorDayType":"saturday","chains":[{"trigger":"C3","links":[{"offset":-1,"code":"C3"},{"offset":1,"code":"C3"}]},{"trigger":"C1","links":[{"offset":-1,"code":"D2"}]},{"trigger":"C2","links":[{"offset":-1,"code":"C2"},{"offset":1,"code":"C1"}]}]},{"anchorDayType":"sunday","chains":[{"trigger":"C2","links":[{"offset":-2,"code":"C1"}]}]}],"dayChains":[{"trigger":"C1","dayTypes":["weekday","friday","federal_holiday","major_holiday"],"links":[{"offset":-1,"code":"D2","unlessCallWithinDays":2}],"blocks":[{"offset":1}]},{"trigger":"C1","dayTypes":["saturday"],"blocks":[{"offset":1}]},{"trigger":"C1","dayTypes":["sunday"],"blocks":[{"offset":1}]},{"trigger":"C2","dayTypes":["weekday","friday","federal_holiday","major_holiday"],"links":[{"offset":-1,"code":"D3","unlessCallWithinDays":2},{"offset":1,"code":"D1"}]},{"trigger":"C2","dayTypes":["sunday"],"links":[{"offset":1,"code":"D1"}]}],"spans":[],"placementPasses":[{"kind":"pre_pto","relativeDay":"thursday_prior_week","codes":["C1","C2"],"maxProviders":2,"enabled":true}],"reliefPass":{"enabled":true,"dayTypes":["weekday","friday"]},"optimizerMovableDayTypes":["weekday","friday"],"callFillOrder":"call_rank"}'::jsonb);

-- 3. Friday C3 (Neuro) template so future schedules materialize the slot.
--    Copies every column from the existing saturday C3 template.
INSERT INTO scheduling.shift_templates
  (site_id, schedule_layer, day_type, weekday_number, applies_on_holiday,
   shift_type_id, required_count, required_skills, generation_priority, is_active)
SELECT site_id, schedule_layer, 'friday', weekday_number, applies_on_holiday,
       shift_type_id, required_count, required_skills, generation_priority, true
  FROM scheduling.shift_templates t
 WHERE t.site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e' AND t.day_type = 'saturday' AND t.is_active
   AND t.shift_type_id = (SELECT id FROM scheduling.shift_types
                           WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e' AND code = 'C3')
 LIMIT 1;

COMMIT;

-- Verification (run after):
--   SELECT name, status FROM scheduling.call_patterns WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e' ORDER BY created_at;
--   -- expect: Classic … archived, Weekend v2 (2026-07-12) active
--   SELECT day_type, st.code FROM scheduling.shift_templates tt
--     JOIN scheduling.shift_types st ON st.id = tt.shift_type_id
--    WHERE tt.site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e' AND st.code = 'C3' AND tt.is_active ORDER BY day_type;
--   -- expect: friday, saturday, sunday

