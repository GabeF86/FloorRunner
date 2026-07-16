// scripts/emitNeuroOverlayPatch.ts — run: npx tsx scripts/emitNeuroOverlayPatch.ts
// Prints the patch25 SQL (neuro overlay) with the zod-validated
// WEEKEND_V2_PATTERN inlined — same emit convention as emitWeekendV2Patch.ts,
// so the live call_patterns definition stays in sync with the constant.
import { WEEKEND_V2_PATTERN } from '../src/lib/rulesEngine/patterns/weekendV2';

const SITE = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'; // Paoli
const doc = JSON.stringify(WEEKEND_V2_PATTERN).replace(/'/g, "''");

console.log(`-- supabase_scheduling_patch25_neuro_overlay.sql
-- Neuro overlay (spec docs/superpowers/specs/2026-07-15-neuro-overlay-design.md)
-- Doc C works a REGULAR DAY (D4) on Friday and carries neuro call (C3) that
-- evening + Sat + Sun. Makes C3 an is_overlay shift, materializes the Friday D4
-- slot (template for future schedules + backfill into existing drafts), and
-- updates the active weekend-v2 pattern with the Sat-C3 → Fri-D4 chain link.
-- Applies to site ${SITE} (Paoli).
--
-- IDEMPOTENT: every step is guarded (UPDATE is naturally idempotent; INSERTs use
-- NOT EXISTS) so this may be re-run safely against the live drafts.
BEGIN;

-- 1. C3 becomes an overlay call: its assignment does NOT consume the provider's
--    one-shift-per-day budget, so Fri D4 (day) + Fri C3 (evening) coexist.
UPDATE scheduling.shift_types
   SET is_overlay = true, updated_at = now()
 WHERE site_id = '${SITE}' AND code = 'C3' AND is_overlay IS DISTINCT FROM true;

-- 2. Friday D4 template so FUTURE schedules materialize the slot. Mirrors the
--    existing WEEKDAY D4 template row (site/layer/required_count/skills/priority),
--    day_type='friday'. NOT EXISTS guard: never add a second Friday D4 template.
INSERT INTO scheduling.shift_templates
  (site_id, schedule_layer, day_type, weekday_number, applies_on_holiday,
   shift_type_id, required_count, required_skills, generation_priority, is_active)
SELECT t.site_id, t.schedule_layer, 'friday', t.weekday_number, t.applies_on_holiday,
       t.shift_type_id, t.required_count, t.required_skills, t.generation_priority, true
  FROM scheduling.shift_templates t
 WHERE t.site_id = '${SITE}' AND t.day_type = 'weekday' AND t.is_active
   AND t.shift_type_id = (SELECT id FROM scheduling.shift_types
                           WHERE site_id = '${SITE}' AND code = 'D4')
   AND NOT EXISTS (
     SELECT 1 FROM scheduling.shift_templates fx
      WHERE fx.site_id = t.site_id AND fx.day_type = 'friday'
        AND fx.shift_type_id = t.shift_type_id)
 LIMIT 1;

-- 3. Backfill Friday D4 slots into EXISTING DRAFT versions. Slot creation only
--    runs at schedule-creation time (Auto-Generate only FILLS existing slots),
--    so drafts built before step 2 have no Friday D4 slot. Insert one per
--    (draft version, Friday date) that lacks it. One row per slot: slot_index 0,
--    required_count 1 (matches schedules/route.ts).
INSERT INTO scheduling.schedule_slots
  (schedule_version_id, site_id, slot_date, shift_type_id, slot_index,
   required_count, derived_day_type, locked)
SELECT fd.schedule_version_id, '${SITE}', fd.slot_date, d4.shift_type_id, 0,
       1, 'friday', false
  FROM (SELECT DISTINCT ss.schedule_version_id, ss.slot_date
          FROM scheduling.schedule_slots ss
          JOIN scheduling.schedule_versions sv ON sv.id = ss.schedule_version_id
         WHERE ss.site_id = '${SITE}'
           AND ss.derived_day_type = 'friday'
           AND sv.version_status = 'draft') fd
  CROSS JOIN (SELECT id AS shift_type_id FROM scheduling.shift_types
               WHERE site_id = '${SITE}' AND code = 'D4') d4
 WHERE NOT EXISTS (
   SELECT 1 FROM scheduling.schedule_slots ex
    WHERE ex.schedule_version_id = fd.schedule_version_id
      AND ex.slot_date = fd.slot_date
      AND ex.shift_type_id = d4.shift_type_id);

-- 4. One OPEN assignment row per Friday D4 slot that lacks one (one-row-per-slot
--    model; scheduling.assignments has UNIQUE(schedule_slot_id)). Covers the
--    slots inserted in step 3 and is a no-op on re-run.
INSERT INTO scheduling.assignments (schedule_slot_id, assignment_status, source_type)
SELECT ss.id, 'open', 'manual'
  FROM scheduling.schedule_slots ss
  JOIN scheduling.schedule_versions sv ON sv.id = ss.schedule_version_id
  JOIN scheduling.shift_types st ON st.id = ss.shift_type_id
 WHERE ss.site_id = '${SITE}'
   AND ss.derived_day_type = 'friday'
   AND st.code = 'D4'
   AND sv.version_status = 'draft'
   AND NOT EXISTS (
     SELECT 1 FROM scheduling.assignments a WHERE a.schedule_slot_id = ss.id);

-- 5. Update the active weekend-v2 pattern with the new Sat-C3 → {Fri C3, Fri D4,
--    Sun C3} chain (JSON validated by CallPatternDocSchema at emit time; emitted
--    from the WEEKEND_V2_PATTERN constant, patch19-style).
UPDATE scheduling.call_patterns
   SET definition = '${doc}'::jsonb, updated_at = now()
 WHERE site_id = '${SITE}' AND status = 'active';

COMMIT;

-- Verification (run after):
--   SELECT code, is_overlay FROM scheduling.shift_types
--    WHERE site_id = '${SITE}' AND code = 'C3';                        -- expect: C3, true
--   SELECT day_type, st.code FROM scheduling.shift_templates tt
--     JOIN scheduling.shift_types st ON st.id = tt.shift_type_id
--    WHERE tt.site_id = '${SITE}' AND st.code = 'D4' AND tt.is_active
--    ORDER BY day_type;                                               -- expect: friday, weekday
--   -- Every Friday in a draft now has a D4 slot with one open assignment:
--   SELECT sv.version_status, count(*) FROM scheduling.schedule_slots ss
--     JOIN scheduling.schedule_versions sv ON sv.id = ss.schedule_version_id
--     JOIN scheduling.shift_types st ON st.id = ss.shift_type_id
--    WHERE ss.site_id = '${SITE}' AND st.code = 'D4' AND ss.derived_day_type = 'friday'
--    GROUP BY 1;
--   SELECT definition->'blocks'->0->'chains'->0 FROM scheduling.call_patterns
--    WHERE site_id = '${SITE}' AND status = 'active';
--    -- expect the C3 chain to include a {"offset":-1,"code":"D4"} link
`);
