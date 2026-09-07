-- supabase_scheduling_patch46_stated_call_obligations.sql
-- (Renumbered from patch44 on 2026-09-07: patch44 was taken by
--  supabase_scheduling_patch44_holiday_call.sql, which landed on main
--  while this sat uncommitted. patch45 is the pto_weeks one. Nothing
--  about this patch changed -- only its number.)
-- Paoli: STATED per-FTE call obligations, and a universal neuro weekend.
-- (Gabriel 2026-08-03.)
--
-- PROJECT: apply ONLY to Supabase ref qhwdbtixhzdsgwwtcfrm ("Floor Runner").
-- Site: 2ddd2427-22fb-4290-9c4c-03a957e5af4e (Paoli).
--
-- STATUS: NOT YET APPLIED.
--
-- ── ORDER: CODE FIRST, AND THIS ONE REALLY MEANS IT ─────────────────────────
-- This patch adds a KEY the deployed schema must already know: CallPatternDocSchema
-- is `.strict()`, so a doc carrying `obligations` fails safeParse on any build
-- that predates it — and genContext then falls back to CLASSIC_PATTERN, silently
-- discarding the WHOLE weekend v2 structure (chains, fill order, neuro), not just
-- the new key. Apply this before the code ships and the next generation is built
-- on the classic pattern with nothing anywhere saying so.
--
-- So: merge + deploy the `obligations` code to production, confirm the build is
-- live, THEN run this. Same rule as patch38 and for the same reason.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────
-- 1. obligations.bands ADDED — his stated table, four bands:
--      1.0  → 4 M-Th C1, 4 M-Th C2, one of each Fri/Sat/Sun C1 and C2   (16)
--      0.75 → 3 + 3, the Fri C1 chain, the Sat C2 chain                 (13)
--      0.7  → 3 + 3, the Fri C1 chain, one Sat C1                       (11)
--      0    → 2 + 2, 1.5 Sat C1, one Fri C2, one Sun C2                 (9.5)
--    Totals include the neuro pair (2 calls). Verified against the live
--    8/10-10/25 block, where the three part-FTE call takers hold EXACTLY their
--    band: Simon 13/13, Havildar 13.5/13.5 (incl. the shared 12h Saturday),
--    Hussain 11/11.
--
--    These are NOT the FTE formula. Only the 1.0 tier matches slots / par x FTE;
--    the 0.75 tier is stated 13 where the formula derives 12, because his model
--    is whole CHAINS and the formula's is fractional shares. The bottom band is
--    minFte 0 so the table is TOTAL — no roster FTE falls through to the formula
--    and runs a second obligation model alongside everyone else.
--
-- 2. neuroWeekend.requirementBands  [{0.6,1},{0,0.5}] -> [{0,1}]
-- 3. blocks[saturday].chains[C3].links[+1 C3].minFte  0.6 -> REMOVED
--
--    (2) and (3) are ONE decision and must move together — the band says how
--    much a doc owes, the link gate says whether they may take the Sat+Sun PAIR
--    that discharges it. neuroWeekendWarnings warns on every load if they split.
--
--    This REVERSES the "except for horan" exception (patch38/patch40): his
--    stated 0.5 tier owes "1 Neuro Weekend" like every other tier. Horan already
--    holds a full Sat+Sun pair on the live block, so this ratifies the board.
--    Feasibility: 10 call takers x 1.0 = 10 units against 11 weekends. Still
--    under, comfortably; the spare weekend is the paid-pickup layer.
--
-- ── EFFECT ON EXISTING SCHEDULES ────────────────────────────────────────────
-- No assignment is written or moved. Obligations are computed at read time, so
-- the published 8/10-10/25 block is untouched on disk; what changes is what the
-- Call Counts modal, the grid's red OVER cells and the print sheet REPORT, and
-- what the next generation builds to. Measured against the live block, the
-- flagged-extra count moves 12 -> 15, entirely where his no-netting rule bites:
--   Farkas     1 -> 2   5 M-Th C1 and 5 M-Th C2 (owes 4 each), short a Sun C2
--   V.Lin      0 -> 1   dead on 16 calls, but a weekday C2 for his Sunday C2
--   Kalawadia  0 -> 1   5 M-Th C2 against 3 M-Th C1 — over one, short one
--   Hussain    0 -> 1   4 M-Th C1 against 2 M-Th C2 — the mirror image
--   Havildar   2 -> 1   her Sun C3 stops being extra: the universal neuro band
--                       raises her owed neuro from half a weekend to one
-- Every one of these is a provider who holds their total but not their MIX,
-- which is exactly the case the old netted rule could not report.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- Safe to re-run: a bare UPDATE of the active row to a fixed doc, with a
-- post-assertion that passes on a re-run.
--
-- The doc below was EMITTED from WEEKEND_V2_PATTERN
-- (src/lib/rulesEngine/patterns/weekendV2.ts), never hand-edited.

BEGIN;

-- Pre-flight: exactly one active Paoli pattern, and it must be the post-patch40
-- doc (neuroWeekend present). If neuroWeekend is missing, patch38/40 never
-- landed and this is being applied out of order.
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n
    FROM scheduling.call_patterns
   WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
     AND status = 'active'
     AND definition->'neuroWeekend' IS NOT NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'patch46: expected 1 active Paoli pattern carrying neuroWeekend, found % — apply patch38/40 first. Aborting', n;
  END IF;
END $$;

-- Expect: UPDATE 1
UPDATE scheduling.call_patterns
   SET definition = '{"version":1,"blocks":[{"anchorDayType":"saturday","chains":[{"trigger":"C3","links":[{"offset":-1,"code":"D4"},{"offset":1,"code":"C3"}]},{"trigger":"C1","links":[{"offset":-1,"code":"D2"}]},{"trigger":"C2","links":[{"offset":-1,"code":"C2"},{"offset":1,"code":"C1"}]}]},{"anchorDayType":"friday","chains":[{"trigger":"C1","links":[{"offset":2,"code":"C2"}]}]}],"dayChains":[{"trigger":"C1","dayTypes":["weekday","friday","federal_holiday","major_holiday"],"links":[{"offset":-1,"code":"D2"}],"blocks":[{"offset":1}]},{"trigger":"C1","dayTypes":["saturday"],"blocks":[{"offset":1}]},{"trigger":"C1","dayTypes":["sunday"],"blocks":[{"offset":1}]},{"trigger":"C2","dayTypes":["weekday","friday","federal_holiday","major_holiday"],"links":[{"offset":-1,"code":"D3"},{"offset":1,"code":"D1"}]},{"trigger":"C2","dayTypes":["sunday"],"links":[{"offset":1,"code":"D1"}]},{"trigger":"C2N12","dayTypes":["weekday","friday","federal_holiday","major_holiday"],"links":[{"offset":1,"code":"D1"}]},{"trigger":"C2N12","dayTypes":["sunday"],"links":[{"offset":1,"code":"D1"}]},{"trigger":"C2N8","dayTypes":["weekday","friday","federal_holiday","major_holiday"],"links":[{"offset":1,"code":"D1"}]},{"trigger":"C2N8","dayTypes":["sunday"],"links":[{"offset":1,"code":"D1"}]}],"spans":[],"placementPasses":[{"kind":"pre_pto","relativeDay":"thursday_prior_week","codes":["C1","C2"],"maxProviders":2,"enabled":true}],"reliefPass":{"enabled":true,"dayTypes":["weekday","friday"]},"optimizerMovableDayTypes":["weekday","friday"],"callFillOrder":"call_rank","dayTypeFillOrder":["saturday","friday","sunday","weekday","federal_holiday","major_holiday"],"neuroWeekend":{"code":"C3","requirementBands":[{"minFte":0,"units":1}]},"obligations":{"bands":[{"minFte":1,"calls":[{"dayType":"weekday","code":"C1","count":4},{"dayType":"weekday","code":"C2","count":4},{"dayType":"friday","code":"C1","count":1},{"dayType":"friday","code":"C2","count":1},{"dayType":"saturday","code":"C1","count":1},{"dayType":"saturday","code":"C2","count":1},{"dayType":"sunday","code":"C1","count":1},{"dayType":"sunday","code":"C2","count":1}]},{"minFte":0.75,"calls":[{"dayType":"weekday","code":"C1","count":3},{"dayType":"weekday","code":"C2","count":3},{"dayType":"friday","code":"C1","count":1},{"dayType":"sunday","code":"C2","count":1},{"dayType":"friday","code":"C2","count":1},{"dayType":"saturday","code":"C2","count":1},{"dayType":"sunday","code":"C1","count":1}]},{"minFte":0.7,"calls":[{"dayType":"weekday","code":"C1","count":3},{"dayType":"weekday","code":"C2","count":3},{"dayType":"friday","code":"C1","count":1},{"dayType":"sunday","code":"C2","count":1},{"dayType":"saturday","code":"C1","count":1}]},{"minFte":0,"calls":[{"dayType":"weekday","code":"C1","count":2},{"dayType":"weekday","code":"C2","count":2},{"dayType":"saturday","code":"C1","count":1.5},{"dayType":"friday","code":"C2","count":1},{"dayType":"sunday","code":"C2","count":1}]}]}}'::jsonb,
       updated_at = now()
 WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
   AND status = 'active';

-- Assertions. The negative clauses are the decisive ones: a containment check
-- alone would pass on a doc that still carried the old value elsewhere.
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n
    FROM scheduling.call_patterns
   WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
     AND status = 'active'
     -- 1. four obligation bands, and the two that pin his model
     AND jsonb_array_length(definition->'obligations'->'bands') = 4
     AND definition->'obligations'->'bands' @> '[{"minFte":1,"calls":[{"dayType":"weekday","code":"C1","count":4}]}]'::jsonb
     AND definition->'obligations'->'bands' @> '[{"minFte":0,"calls":[{"dayType":"saturday","code":"C1","count":1.5}]}]'::jsonb
     -- 2. the neuro band is universal, and the half band is GONE
     AND definition->'neuroWeekend'->'requirementBands' @> '[{"minFte":0,"units":1}]'::jsonb
     AND jsonb_array_length(definition->'neuroWeekend'->'requirementBands') = 1
     AND NOT definition->'neuroWeekend'->'requirementBands' @> '[{"units":0.5}]'::jsonb
     -- 3. the Sat C3 -> Sun C3 gate is gone (no minFte survives on that link)
     AND definition->'blocks' @> '[{"anchorDayType":"saturday","chains":[{"trigger":"C3","links":[{"offset":1,"code":"C3"}]}]}]'::jsonb
     AND NOT definition->'blocks' @> '[{"anchorDayType":"saturday","chains":[{"trigger":"C3","links":[{"minFte":0.6}]}]}]'::jsonb;
  IF n <> 1 THEN
    RAISE EXCEPTION 'patch46: active doc did not take the stated obligations + universal neuro weekend (matched % rows) — aborting', n;
  END IF;
END $$;

COMMIT;
