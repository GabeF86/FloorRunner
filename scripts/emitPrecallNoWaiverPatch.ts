// scripts/emitPrecallNoWaiverPatch.ts — run: npx tsx scripts/emitPrecallNoWaiverPatch.ts
// Prints the patch33 SQL (pre-call fills unconditional) with the zod-validated
// WEEKEND_V2_PATTERN inlined — same emit convention as emitNeuroOverlayPatch.ts
// / emitWeekendV2Patch.ts, so the live call_patterns definition stays in sync
// with the constant.
import { WEEKEND_V2_PATTERN } from '../src/lib/rulesEngine/patterns/weekendV2';

const SITE = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'; // Paoli
const doc = JSON.stringify(WEEKEND_V2_PATTERN).replace(/'/g, "''");

console.log(`-- supabase_scheduling_patch33_precall_no_waiver.sql
-- Pre-call fills unconditional (Gabriel 2026-07-20, verbatim intent):
--   "Pre-call status should be given to anyone on call the following day.
--    D1 status is only dependent on the Call status from the day before, and
--    D2 and D3 Status is only for the call status on the following day.
--    Jones should have been given D2 regardless of what her call status was
--    the day before, unless it was a C2, in which case her D1 status would
--    override the D2 status."
-- The unlessCallWithinDays:2 conditions on Weekend v2's C1 -> -1 D2 and
-- C2 -> -1 D3 pre-call dayChain links were ported from legacy engine behavior
-- on 2026-07-12 (never requested): they waived the pre-call fill after ANY
-- call within 2 days — which is how neuro-weekend Jones (Sun C3, Tue C1) lost
-- her Monday D2. This patch updates the LIVE active Weekend v2 pattern from
-- the WEEKEND_V2_PATTERN constant with both conditions removed. Everything
-- else in the doc is unchanged. The schema FEATURE stays supported (classic
-- docs still carry the condition); only this pattern's DATA drops it.
-- D1-overrides-D2 needs no waiver: the C2's +1 D1 lands first in date order
-- and the next day's C1's -1 D2 pre-fill severs on the same-date gate
-- (recorded 'occupied') — pinned in weekendV2Pattern.test.ts.
-- Applies to site ${SITE} (Paoli).
--
-- IDEMPOTENT: a bare UPDATE of the active row — safe to re-run.
--
-- APPLY-TIME VERIFICATION (run BEFORE applying):
--   Confirm the active row is the Weekend v2 doc this patch expects to
--   replace (both pre-call links still carrying the waiver). STOP if not:
--     SELECT name,
--            definition->'dayChains'->0->'links'->0->>'unlessCallWithinDays' AS c1_d2_waiver,
--            definition->'dayChains'->3->'links'->0->>'unlessCallWithinDays' AS c2_d3_waiver
--       FROM scheduling.call_patterns
--      WHERE site_id = '${SITE}' AND status = 'active';
--     -- expect: 1 row, c1_d2_waiver = 2, c2_d3_waiver = 2
BEGIN;

UPDATE scheduling.call_patterns
   SET definition = '${doc}'::jsonb, updated_at = now()
 WHERE site_id = '${SITE}' AND status = 'active';

COMMIT;

-- Verification (run after):
--   SELECT definition->'dayChains' FROM scheduling.call_patterns
--    WHERE site_id = '${SITE}' AND status = 'active';
--   -- expect: NO occurrence of "unlessCallWithinDays" anywhere in dayChains;
--   --         the C1 weekday chain links = [{"offset":-1,"code":"D2"}];
--   --         the C2 weekday chain links = [{"offset":-1,"code":"D3"},
--   --                                       {"offset":1,"code":"D1"}];
--   -- everything else (blocks, dayTypeFillOrder, callFillOrder, spans,
--   -- placementPasses, reliefPass, optimizerMovableDayTypes) unchanged
--   -- from patch25.
--   SELECT position('unlessCallWithinDays' in definition::text) AS waiver_pos
--     FROM scheduling.call_patterns
--    WHERE site_id = '${SITE}' AND status = 'active';
--   -- expect: waiver_pos = 0
`);
