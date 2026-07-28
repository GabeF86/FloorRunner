-- supabase_scheduling_patch40_neuro_band_boundary.sql
-- Paoli neuro band boundary 0.75 -> 0.6, on BOTH the requirement band and the
-- Sat C3 -> Sun C3 chain gate (spec 2026-07-27, Gabriel).
--
-- PROJECT: apply ONLY to Supabase ref qhwdbtixhzdsgwwtcfrm ("Floor Runner").
-- Site: 2ddd2427-22fb-4290-9c4c-03a957e5af4e (Paoli).
--
-- STATUS: APPLIED 2026-07-27 to project qhwdbtixhzdsgwwtcfrm via the
--   project-scoped supabase-floorrunner MCP. Both in-transaction assertions
--   passed. Post-apply spot check on the live active row:
--     requirementBands = [{minFte 0.6, units 1}, {minFte 0, units 0.5}]
--     saturday C3 chain, +1 Sunday link = {offset 1, code C3, minFte 0.6}
--   Neither value still reads 0.75. The embedded doc was verified
--   BYTE-IDENTICAL to WEEKEND_V2_PATTERN before applying (1743 bytes).
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- Gabriel, verbatim: "Every call taker should be given a neuro weekend call,
-- except for horan it should only be one weekend day of neuro." Horan is the
-- site's only 0.5 FTE and is meant to be the ONLY exception.
--
-- patch38 shipped the boundary at 0.75, which quietly created a SECOND
-- exception nobody asked for: Hussain is 0.66 FTE (a third of his time is ICU),
-- so he fell into the bottom band and owed half a neuro weekend like Horan.
-- Moving the boundary to 0.6 puts every call taker except Horan in the full
-- band, which is what the rule actually says.
--
-- ── WHY BOTH VALUES MOVE ────────────────────────────────────────────────────
-- The band and the chain-link gate are ONE decision, not two:
--   * requirementBands says how many weekend UNITS a doc owes.
--   * the Sat C3 -> Sun C3 link's minFte says whether they may take the Sat+Sun
--     PAIR that discharges a whole unit in one weekend.
-- Move only the band and Hussain owes a full neuro weekend he is gated out of
-- ever taking as a pair — he could satisfy it only as two separate single days,
-- which is not the duty anyone described. callPattern.ts's neuroWeekendWarnings
-- exists to catch exactly that divergence (it warns when a link minFte is not a
-- band boundary), so leaving them split would also warn on every load.
--
-- ── DELTA vs what patch38 installed ─────────────────────────────────────────
--   blocks[saturday].chains[C3].links[+1 C3].minFte   0.75 -> 0.6
--   neuroWeekend.requirementBands[0].minFte           0.75 -> 0.6
-- Nothing else changes. The doc below was EMITTED from WEEKEND_V2_PATTERN
-- (src/lib/rulesEngine/patterns/weekendV2.ts), never hand-edited.
--
-- NOTE the EFFECTIVE floor is 0.59, not 0.6: owedUnitsFor clears a band when
-- fte + WEIGHT_EPSILON >= minFte, and the house epsilon is 0.01. Deliberate,
-- and harmless — real FTEs are quarters and thirds, nowhere near it.
--
-- ── ORDER ───────────────────────────────────────────────────────────────────
-- Order-independent, unlike patch38. This changes VALUES inside keys the
-- deployed code already understands (patch38 added the keys themselves), so
-- old and new code both parse this doc. It takes effect on the next generation.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- Safe to re-run: a bare UPDATE of the active row to a fixed doc, with a
-- post-assertion that passes on a re-run.

BEGIN;

-- Pre-flight: exactly one active pattern, and it must already be the patch38
-- doc (neuroWeekend present). If neuroWeekend is missing, patch38 never landed
-- and this patch is being applied out of order.
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n
    FROM scheduling.call_patterns
   WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
     AND status = 'active'
     AND definition->'neuroWeekend' IS NOT NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'patch40: expected 1 active Paoli pattern carrying neuroWeekend (patch38), found % — apply patch38 first. Aborting', n;
  END IF;
END $$;

-- Expect: UPDATE 1
UPDATE scheduling.call_patterns
   SET definition = '{"version":1,"blocks":[{"anchorDayType":"saturday","chains":[{"trigger":"C3","links":[{"offset":-1,"code":"D4"},{"offset":1,"code":"C3","minFte":0.6}]},{"trigger":"C1","links":[{"offset":-1,"code":"D2"}]},{"trigger":"C2","links":[{"offset":-1,"code":"C2"},{"offset":1,"code":"C1"}]}]},{"anchorDayType":"friday","chains":[{"trigger":"C1","links":[{"offset":2,"code":"C2"}]}]}],"dayChains":[{"trigger":"C1","dayTypes":["weekday","friday","federal_holiday","major_holiday"],"links":[{"offset":-1,"code":"D2"}],"blocks":[{"offset":1}]},{"trigger":"C1","dayTypes":["saturday"],"blocks":[{"offset":1}]},{"trigger":"C1","dayTypes":["sunday"],"blocks":[{"offset":1}]},{"trigger":"C2","dayTypes":["weekday","friday","federal_holiday","major_holiday"],"links":[{"offset":-1,"code":"D3"},{"offset":1,"code":"D1"}]},{"trigger":"C2","dayTypes":["sunday"],"links":[{"offset":1,"code":"D1"}]},{"trigger":"C2N12","dayTypes":["weekday","friday","federal_holiday","major_holiday"],"links":[{"offset":1,"code":"D1"}]},{"trigger":"C2N12","dayTypes":["sunday"],"links":[{"offset":1,"code":"D1"}]},{"trigger":"C2N8","dayTypes":["weekday","friday","federal_holiday","major_holiday"],"links":[{"offset":1,"code":"D1"}]},{"trigger":"C2N8","dayTypes":["sunday"],"links":[{"offset":1,"code":"D1"}]}],"spans":[],"placementPasses":[{"kind":"pre_pto","relativeDay":"thursday_prior_week","codes":["C1","C2"],"maxProviders":2,"enabled":true}],"reliefPass":{"enabled":true,"dayTypes":["weekday","friday"]},"optimizerMovableDayTypes":["weekday","friday"],"callFillOrder":"call_rank","dayTypeFillOrder":["saturday","friday","sunday","weekday","federal_holiday","major_holiday"],"neuroWeekend":{"code":"C3","requirementBands":[{"minFte":0.6,"units":1},{"minFte":0,"units":0.5}]}}'::jsonb,
       updated_at = now()
 WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
   AND status = 'active';

-- Both values must read 0.6, and NEITHER may still read 0.75. The negative
-- clauses are the decisive ones: a positive containment check would pass on a
-- doc that still carried the old value somewhere else in the array.
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n
    FROM scheduling.call_patterns
   WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
     AND status = 'active'
     AND definition->'neuroWeekend'->'requirementBands' @> '[{"minFte":0.6,"units":1}]'::jsonb
     AND NOT definition->'neuroWeekend'->'requirementBands' @> '[{"minFte":0.75}]'::jsonb
     AND definition->'blocks' @> '[{"anchorDayType":"saturday","chains":[{"trigger":"C3","links":[{"offset":1,"code":"C3","minFte":0.6}]}]}]'::jsonb
     AND NOT definition->'blocks' @> '[{"anchorDayType":"saturday","chains":[{"trigger":"C3","links":[{"minFte":0.75}]}]}]'::jsonb;
  IF n <> 1 THEN
    RAISE EXCEPTION 'patch40: active doc did not take the 0.6 boundary on BOTH the band and the chain gate (matched % rows) — aborting', n;
  END IF;
END $$;

COMMIT;
