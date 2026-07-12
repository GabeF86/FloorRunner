// scripts/emitWeekendV2Patch.ts — run: npx tsx scripts/emitWeekendV2Patch.ts
// Prints the patch19 SQL with the zod-validated WEEKEND_V2_PATTERN inlined.
import { WEEKEND_V2_PATTERN } from '../src/lib/rulesEngine/patterns/weekendV2';

const SITE = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'; // Paoli
const doc = JSON.stringify(WEEKEND_V2_PATTERN).replace(/'/g, "''");

console.log(`-- supabase_scheduling_patch19_weekend_v2_pattern.sql
-- Weekend call v2 (spec docs/superpowers/specs/2026-07-12-weekend-call-v2-and-callcounts-design.md)
-- Applies to site ${SITE} (Paoli). Idempotence guard: aborts if already applied.
BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM scheduling.call_patterns
             WHERE site_id = '${SITE}' AND name = 'Weekend v2 (2026-07-12)') THEN
    RAISE EXCEPTION 'patch19 already applied';
  END IF;
END $$;

-- 1. Archive the current active pattern (kept for one-click restore).
UPDATE scheduling.call_patterns
   SET status = 'archived', updated_at = now()
 WHERE site_id = '${SITE}' AND status = 'active';

-- 2. Insert the new active pattern (JSON validated by CallPatternDocSchema at emit time).
INSERT INTO scheduling.call_patterns (site_id, name, status, source, definition)
VALUES ('${SITE}', 'Weekend v2 (2026-07-12)', 'active', 'manual', '${doc}'::jsonb);

-- 3. Friday C3 (Neuro) template so future schedules materialize the slot.
--    Copies every column from the existing saturday C3 template.
INSERT INTO scheduling.shift_templates
  (site_id, schedule_layer, day_type, weekday_number, applies_on_holiday,
   shift_type_id, required_count, required_skills, generation_priority, is_active)
SELECT site_id, schedule_layer, 'friday', weekday_number, applies_on_holiday,
       shift_type_id, required_count, required_skills, generation_priority, true
  FROM scheduling.shift_templates t
 WHERE t.site_id = '${SITE}' AND t.day_type = 'saturday' AND t.is_active
   AND t.shift_type_id = (SELECT id FROM scheduling.shift_types
                           WHERE site_id = '${SITE}' AND code = 'C3')
 LIMIT 1;

COMMIT;

-- Verification (run after):
--   SELECT name, status FROM scheduling.call_patterns WHERE site_id = '${SITE}' ORDER BY created_at;
--   -- expect: Classic … archived, Weekend v2 (2026-07-12) active
--   SELECT day_type, st.code FROM scheduling.shift_templates tt
--     JOIN scheduling.shift_types st ON st.id = tt.shift_type_id
--    WHERE tt.site_id = '${SITE}' AND st.code = 'C3' AND tt.is_active ORDER BY day_type;
--   -- expect: friday, saturday, sunday
`);
