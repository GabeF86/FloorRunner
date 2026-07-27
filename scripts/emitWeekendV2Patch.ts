// scripts/emitWeekendV2Patch.ts — run: npx tsx scripts/emitWeekendV2Patch.ts
// Prints the patch19 SQL with the zod-validated WEEKEND_V2_PATTERN inlined.
//
// HISTORICAL EMITTER — the doc it inlines has moved on three times since
// patch19 (patch25 neuro overlay, patch27 pre-call waiver removal, patch38
// neuro weekend), so this no longer reproduces the patch19 that was actually
// applied. The applied text is the committed
// supabase_scheduling_patch19_weekend_v2_pattern.sql; THAT file is the
// historical record, not this script.
//
// STEP 3 DELETED 2026-07-27. It INSERTed a friday/C3 shift_templates row —
// the row that materializes Friday neuro slots. patch38 deactivates exactly
// that row (Friday neuro is now cross-covered by the Friday C2 doc), so
// running the old step 3 afterwards would silently restore Friday neuro; a
// second run would leave two rows and abort patch38's "exactly 1 friday/C3
// row" pre-flight. Deleted rather than merely warned about because it
// reverses a clinical structure change. Steps 1-2 are untouched and still
// emit a coherent pattern-only rollout.
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

-- 3. (REMOVED 2026-07-27 — see the script header.) This step used to INSERT a
--    friday/C3 shift_templates row. Friday neuro no longer exists; patch38
--    deactivates that row, so re-creating it here would reverse patch38.

COMMIT;

-- Verification (run after):
--   SELECT name, status FROM scheduling.call_patterns WHERE site_id = '${SITE}' ORDER BY created_at;
--   -- expect: Classic … archived, Weekend v2 (2026-07-12) active
`);
