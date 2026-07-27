-- supabase_scheduling_patch38_paoli_neuro_weekend.sql
-- Paoli neuro weekend becomes SAT + SUN on one doc, with an FTE-gated Sunday
-- partner, and NO Friday neuro slot at all (spec 2026-07-27, Gabriel).
--
-- PROJECT: apply ONLY to Supabase ref qhwdbtixhzdsgwwtcfrm ("Floor Runner" —
-- the ref in .env.local). Two OTHER Supabase projects are connected to this
-- machine for DIFFERENT apps (atlas-staging, ChiefOS); running FloorRunner DDL
-- through those is a known foot-gun. VERIFY THE REF BEFORE APPLYING.
-- Site: 2ddd2427-22fb-4290-9c4c-03a957e5af4e (Paoli).
--
-- STATUS: NOT YET APPLIED.
--   Applied ____-__-__ to project qhwdbtixhzdsgwwtcfrm via ______________.
--   Post-apply spot checks (see VERIFICATION at the bottom): ______________
--
-- ── ORDER: DEPLOY THE CODE FIRST, THEN APPLY THIS PATCH ─────────────────────
-- NOT the usual patch-then-push. CallPatternDocSchema is .strict(), so the
-- PRE-change deployed code REJECTS the doc in statement 2 — `minFte` and
-- `neuroWeekend` are unrecognized keys. genContext turns a parse failure into
-- callPattern = undefined + a warning, and solve() then falls back to
-- CLASSIC_PATTERN. So if this patch lands before the code, every Paoli
-- generation in that window silently produces a CLASSIC-pattern schedule — no
-- weekend chains, no dayTypeFillOrder, no relief pass, no C2→D1 post-call
-- chain — and commits it, with only a warning to show for it.
--
-- Code-first is safe in the other direction: both new fields are OPTIONAL, so
-- new code reading the OLD doc behaves byte-identically to today. The window
-- between deploy and apply is therefore a no-op, not a degradation.
--
-- ── WHAT (two statements, ONE transaction) ──────────────────────────────────
--   1. Deactivate the friday/C3 shift_templates row. That row is the ONLY
--      thing that generates Friday neuro slots: new-schedule creation fetches
--      active templates and materializes a slot per template per date
--      (schedules/route.ts ~90, `.from('shift_templates').eq('is_active',
--      true)`). Auto-Generate only FILLS existing slots — it never creates
--      them. Deactivating the template is therefore the whole mechanism, the
--      same lever patch22 used to retire D8/D9.
--   2. Replace the site's ACTIVE call_patterns.definition with the new
--      WEEKEND_V2_PATTERN doc. NOTE the column is `definition` (not
--      `pattern_doc`). The JSON below was EMITTED from the constant in
--      src/lib/rulesEngine/patterns/weekendV2.ts (zod-validated by
--      CallPatternDocSchema at emit time), never hand-written:
--        npx tsx -e "import('./src/lib/rulesEngine/patterns/weekendV2.ts')
--          .then(m => console.log(JSON.stringify(m.WEEKEND_V2_PATTERN)))"
--
-- ── WHY THEY MUST LAND TOGETHER ─────────────────────────────────────────────
-- Either half on its own is a live bug, which is why both are in one
-- transaction and neither should be applied separately:
--   * Template OFF + OLD doc: the old doc's saturday-C3 chain still carries a
--     -1 Friday C3 link pointing at a slot that no longer exists. Invariant 4
--     says a skipped derived shift must be RECORDED, so the engine emits a
--     phantom `no-slot` skippedDerived entry every single weekend and every
--     generation report grows a permanent bogus warning.
--   * Template ON + NEW doc: the new doc has no Friday C3 link at all, so the
--     still-materialized Friday neuro slot is chained by nothing and fills as
--     an ordinary standalone call — i.e. a Friday neuro doc, precisely what
--     this change is meant to abolish. (Intended behavior: the Friday C2 doc
--     cross-covers neuro that day, unnamed on the board.)
--
-- ── DOC DELTA (new vs what is live today = patch33's doc + patch35's chains) ─
-- Verified, not assumed: re-emitting the PRE-change constant from git
-- 38e0962^ reproduces the currently-live doc EXACTLY (patch33's JSON literal
-- with patch35's four segment dayChains appended), and the ONLY differences
-- between that and the doc below are these two:
--   * blocks[saturday].chains[C3].links
--       was  [{-1 C3}, {-1 D4}, {+1 C3}]            (three links)
--       now  [{-1 D4}, {+1 C3, minFte 0.75}]        (two links)
--     The -1 Friday D4 link STAYS — the neuro doc still works that regular
--     Friday day shift. The -1 Friday C3 link is GONE. The +1 Sunday C3 link
--     is now FTE-gated at 0.75: a 0.75+ doc takes the Sat+Sun pair, while a
--     sub-0.75 doc takes Saturday alone and the Sunday falls through to the
--     neuro remainder set.
--   * NEW top-level `neuroWeekend` config:
--       { code: 'C3', requirementBands: [ 0.75 -> 1 unit,
--                                          0   -> 0.5 units ] }
--     TWO bands, not three — REVISED 2026-07-27 after the first draft of this
--     patch was written. Gabriel: "Every call taker should be given a neuro
--     weekend call, except for horan it should only be one weekend day of
--     neuro." The earlier draft carried a third band, { 1.0 -> 0 units },
--     exempting full-timers; the requirement is now universal, so that band is
--     gone and every 0.75+ doc owes a full neuro weekend per block. Horan
--     (0.5) falls to the bottom band and owes a single weekend day, which is
--     what the +1 Sun C3 link's minFte 0.75 gate above physically produces.
--   Everything else is byte-identical to what is live: dayChains (including
--   patch35's C2N12/C2N8 segment chains), spans, placementPasses, reliefPass,
--   optimizerMovableDayTypes, callFillOrder, dayTypeFillOrder.
--
-- ── DELIBERATELY NOT IN SCOPE ───────────────────────────────────────────────
--   * Friday C3 slots ALREADY materialized in EXISTING draft schedules are
--     left untouched. shift_templates.is_active gates only FUTURE slot
--     generation; it does not remove slots that already exist (patch22 had to
--     DELETE those separately). Query 5 in VERIFICATION counts them.
--     Any that remain WILL fill as ordinary standalone Friday calls — i.e.
--     existing drafts keep exhibiting the exact behavior this change removes
--     until something is done about them.
--     THIS IS THE OWNER'S DECISION, NOT THE PATCH'S. The two options are:
--       (a) DELETE the stale Friday C3 slots (and their assignment rows) from
--           the affected drafts, patch22-style; or
--       (b) REGENERATE those drafts from scratch, so slot creation re-runs
--           against the now-deactivated template and never mints them.
--     Deliberately not chosen here: both are destructive to in-flight drafts
--     and the right answer depends on how far along each draft is.
--   * C3 is NOT retired as a shift type and its templates for saturday/sunday
--     stay active — neuro call still exists, just not on Fridays.
--   * shift_types.is_overlay stays TRUE on C3 (set by patch25). With Friday
--     C3 gone the pattern no longer mints a same-date regular+call pair, but
--     the flag still serves the Sat/Sun rows and manual edits.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- Safe to re-run. Statement 1 is guarded on is_active (matches 0 rows on a
-- re-run), statement 2 is a bare UPDATE of the active row, and all four
-- DO-block assertions are written to pass on a re-run (the weekday/C3 guard
-- is unaffected by this patch, so it reads the same before and after).

BEGIN;

-- Pre-flight: exactly ONE friday/C3 call template must exist for Paoli
-- (active or not). Catches a wrong site id, a renamed code, or a duplicated
-- template row BEFORE anything is written. Passes on a re-run.
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n
    FROM scheduling.shift_templates t
    JOIN scheduling.shift_types st ON st.id = t.shift_type_id
   WHERE t.site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
     AND t.day_type = 'friday'
     AND st.code = 'C3';
  IF n <> 1 THEN
    RAISE EXCEPTION 'patch38: expected exactly 1 friday/C3 shift_templates row for Paoli, found % — aborting', n;
  END IF;
END $$;

-- Pre-flight: NO active weekday/C3 template may exist. This patch depends on
-- the ABSENCE of that row, so it says so out loud rather than failing quietly.
--
-- Why it matters: slateForDayType() in src/lib/templateSlots.ts builds a
-- Friday's slate as the friday-specific rows UNION every WEEKDAY row whose
-- shift_type_id has no friday-specific row (a per-shift-type override, not
-- all-or-nothing). That union is why Paoli's Fridays get C1/C2 at all — there
-- are no friday C1/C2 rows; they come from the weekday templates.
--
-- The consequence for statement 1: deactivating friday/C3 REMOVES it from the
-- friday-specific set, which UN-SHADOWS any active weekday/C3 row. A weekday
-- C3 would then materialize on Fridays through the union and silently defeat
-- this entire patch — a Friday neuro slot would reappear.
--
-- Verified read-only on 2026-07-27: Paoli has no weekday/C3 row, so the hazard
-- is not live today. The guard exists for the someone-adds-one-later case.
--
-- REMEDY if this ever fires: do NOT just deactivate the weekday row (other day
-- types may legitimately need it, and weekday C3 would stop materializing on
-- Mon-Thu too). The correct lever is to keep the friday/C3 row ACTIVE with
-- required_count = 0 instead of deactivating it: an active friday row still
-- shadows the weekday row in the union, while templateSlotCount() returns 0 so
-- no Friday slot is created. templateSlots.ts documents that suppression
-- mechanism explicitly. Statement 1 would need to change accordingly.
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n
    FROM scheduling.shift_templates t
    JOIN scheduling.shift_types st ON st.id = t.shift_type_id
   WHERE t.site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
     AND t.day_type = 'weekday'
     AND st.code = 'C3'
     AND t.is_active;
  IF n <> 0 THEN
    RAISE EXCEPTION 'patch38: % active weekday/C3 shift_templates row(s) exist for Paoli — deactivating friday/C3 would un-shadow them via the friday template union (slateForDayType, src/lib/templateSlots.ts) and re-materialize a Friday neuro slot. See the REMEDY note above. Aborting', n;
  END IF;
END $$;

-- 1. Friday neuro call loses its slot. Scoped by site + day_type + the C3
--    shift_type id; `AND is_active` means a re-run is a no-op instead of
--    re-stamping updated_at. The scalar subquery raises on its own if Paoli
--    ever has more than one C3 shift type.
-- Expect: UPDATE 1   (UPDATE 0 on a re-run — see the assertion below)
UPDATE scheduling.shift_templates
   SET is_active = false, updated_at = now()
 WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
   AND day_type = 'friday'
   AND is_active
   AND shift_type_id = (SELECT id FROM scheduling.shift_types
                         WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e' AND code = 'C3');

DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n
    FROM scheduling.shift_templates t
    JOIN scheduling.shift_types st ON st.id = t.shift_type_id
   WHERE t.site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
     AND t.day_type = 'friday'
     AND st.code = 'C3'
     AND t.is_active;
  IF n <> 0 THEN
    RAISE EXCEPTION 'patch38: friday/C3 template still active after the UPDATE (% rows) — aborting', n;
  END IF;
END $$;

-- 2. Install the new pattern doc on the site's ACTIVE row. Emitted from
--    WEEKEND_V2_PATTERN (patch19/patch25/patch33 convention: the literal below
--    is machine-generated from the constant, so the live definition and the
--    in-repo pattern stay in sync).
-- Expect: UPDATE 1   (the call_patterns_one_active partial unique index from
--                     patch18 guarantees at most one active row per site)
UPDATE scheduling.call_patterns
   SET definition = '{"version":1,"blocks":[{"anchorDayType":"saturday","chains":[{"trigger":"C3","links":[{"offset":-1,"code":"D4"},{"offset":1,"code":"C3","minFte":0.75}]},{"trigger":"C1","links":[{"offset":-1,"code":"D2"}]},{"trigger":"C2","links":[{"offset":-1,"code":"C2"},{"offset":1,"code":"C1"}]}]},{"anchorDayType":"friday","chains":[{"trigger":"C1","links":[{"offset":2,"code":"C2"}]}]}],"dayChains":[{"trigger":"C1","dayTypes":["weekday","friday","federal_holiday","major_holiday"],"links":[{"offset":-1,"code":"D2"}],"blocks":[{"offset":1}]},{"trigger":"C1","dayTypes":["saturday"],"blocks":[{"offset":1}]},{"trigger":"C1","dayTypes":["sunday"],"blocks":[{"offset":1}]},{"trigger":"C2","dayTypes":["weekday","friday","federal_holiday","major_holiday"],"links":[{"offset":-1,"code":"D3"},{"offset":1,"code":"D1"}]},{"trigger":"C2","dayTypes":["sunday"],"links":[{"offset":1,"code":"D1"}]},{"trigger":"C2N12","dayTypes":["weekday","friday","federal_holiday","major_holiday"],"links":[{"offset":1,"code":"D1"}]},{"trigger":"C2N12","dayTypes":["sunday"],"links":[{"offset":1,"code":"D1"}]},{"trigger":"C2N8","dayTypes":["weekday","friday","federal_holiday","major_holiday"],"links":[{"offset":1,"code":"D1"}]},{"trigger":"C2N8","dayTypes":["sunday"],"links":[{"offset":1,"code":"D1"}]}],"spans":[],"placementPasses":[{"kind":"pre_pto","relativeDay":"thursday_prior_week","codes":["C1","C2"],"maxProviders":2,"enabled":true}],"reliefPass":{"enabled":true,"dayTypes":["weekday","friday"]},"optimizerMovableDayTypes":["weekday","friday"],"callFillOrder":"call_rank","dayTypeFillOrder":["saturday","friday","sunday","weekday","federal_holiday","major_holiday"],"neuroWeekend":{"code":"C3","requirementBands":[{"minFte":0.75,"units":1},{"minFte":0,"units":0.5}]}}'::jsonb,
       updated_at = now()
 WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
   AND status = 'active';

-- The doc must have landed on exactly one active row, must carry the
-- neuroWeekend config, must contain the new two-link saturday C3 chain, and
-- must NOT contain a -1 C3 link anywhere in blocks. Containment (@>) is
-- order-independent, so this does not depend on array positions.
--
-- The last clause was ADDED with the 2026-07-27 band revision. `IS NOT NULL`
-- alone cannot tell the two-band doc from the superseded three-band one, and
-- both now exist in the project's history — an earlier emit pasted here by
-- mistake would install a doc that exempts every full-timer from neuro and
-- the assertion would wave it through. A positive `@>` on the two bands would
-- NOT catch it either: array containment means "contains all of these", so a
-- three-band doc satisfies it. Only the ABSENCE of the exempting band is
-- decisive, which is the same NOT-@> idiom used for the removed -1 C3 link
-- one line up.
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n
    FROM scheduling.call_patterns
   WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
     AND status = 'active'
     AND definition->'neuroWeekend' IS NOT NULL
     AND definition->'blocks' @> '[{"anchorDayType":"saturday","chains":[{"trigger":"C3","links":[{"offset":-1,"code":"D4"},{"offset":1,"code":"C3","minFte":0.75}]}]}]'::jsonb
     AND NOT definition->'blocks' @> '[{"anchorDayType":"saturday","chains":[{"trigger":"C3","links":[{"offset":-1,"code":"C3"}]}]}]'::jsonb
     AND NOT definition->'neuroWeekend' @> '{"requirementBands":[{"minFte":1,"units":0}]}'::jsonb;
  IF n <> 1 THEN
    RAISE EXCEPTION 'patch38: active call_patterns doc did not take the Sat+Sun neuro shape (matched % rows) — aborting', n;
  END IF;
END $$;

COMMIT;

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ VERIFICATION — run these by hand around the apply. Queries 1-2 BEFORE,   ║
-- ║ queries 3-5 AFTER. STOP and do not apply if a BEFORE query disagrees.    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── BEFORE (1): exactly ONE active friday+C3 call template exists ───────────
--   SELECT t.id, t.day_type, st.code, t.is_active, t.required_count, t.updated_at
--     FROM scheduling.shift_templates t
--     JOIN scheduling.shift_types st ON st.id = t.shift_type_id
--    WHERE t.site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
--      AND t.day_type = 'friday'
--      AND st.code = 'C3';
--   -- expect: EXACTLY 1 row, is_active = true.
--   -- STOP if 0 rows (wrong site id, or already applied) or >1 row (duplicate
--   -- template — decide which one is real before deactivating anything).
--
-- ── BEFORE (2): the OLD pattern doc is the one live right now ───────────────
--   SELECT name,
--          jsonb_array_length(c->'links') AS n_links,
--          c->'links'                     AS sat_c3_links,
--          definition->'neuroWeekend'     AS neuro_weekend
--     FROM scheduling.call_patterns cp
--     CROSS JOIN LATERAL jsonb_array_elements(cp.definition->'blocks') b
--     CROSS JOIN LATERAL jsonb_array_elements(b->'chains') c
--    WHERE cp.site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
--      AND cp.status = 'active'
--      AND b->>'anchorDayType' = 'saturday'
--      AND c->>'trigger' = 'C3';
--   -- expect: 1 row; n_links = 3;
--   --   sat_c3_links = [{"offset":-1,"code":"C3"},{"offset":-1,"code":"D4"},
--   --                   {"offset":1,"code":"C3"}]
--   --   neuro_weekend = NULL  (the config does not exist yet)
--   -- If n_links is already 2 and neuro_weekend is non-null, this patch has
--   -- already been applied — re-running is harmless but pointless.
--
-- ── AFTER (3): friday/C3 is now inactive AND no other call template moved ───
-- Run this census BOTH before and after the apply and diff the two result
-- sets — that is the actual proof, and unlike a bare row count it does not
-- assume anything about which rows were active to begin with.
--   SELECT t.day_type, st.code, t.is_active, t.updated_at
--     FROM scheduling.shift_templates t
--     JOIN scheduling.shift_types st ON st.id = t.shift_type_id
--    WHERE t.site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
--      AND st.code IN ('C1','C2','C3')
--    ORDER BY t.day_type, st.code;
--   -- expect: the BEFORE and AFTER result sets are IDENTICAL except for the
--   -- single friday/C3 row, whose is_active flips true -> false and whose
--   -- updated_at becomes the apply timestamp. No other row may differ in
--   -- either column — in particular no other updated_at may move.
--   -- Expected census — CORRECTED 2026-07-27 against the live project. An
--   -- earlier draft of this comment claimed 15 rows including friday C1/C2.
--   -- That is wrong: Paoli has NO friday C1/C2 template rows. The real
--   -- census is 13 rows:
--   --   weekday          C1, C2
--   --   friday           C3              (the only friday call row; now inactive)
--   --   saturday         C1, C2, C3
--   --   sunday           C1, C2, C3
--   --   federal_holiday  C1, C2
--   --   major_holiday    C1, C2
--   --
--   -- Friday still gets C1 and C2 after this patch, and that is NOT a bug:
--   -- slateForDayType() in src/lib/templateSlots.ts fills a friday date from
--   -- the friday-specific rows PLUS every weekday row whose shift type has no
--   -- friday-specific override. So friday C1/C2 have always come from the
--   -- WEEKDAY templates, and the friday/C3 row was the Friday-only addition.
--   -- Deactivating it leaves the pure weekday slate — C1 + C2, no neuro —
--   -- which is exactly the intended Friday shape.
--   --
--   -- Two related facts that are easy to conflate, kept straight here:
--   --   * CURRENT designed behavior: a friday row for a shift type that ALSO
--   --     has a weekday row shadows that weekday row — a per-shift-type
--   --     override. Intended, not a hazard. It is also the reason for the
--   --     second pre-flight guard above: removing the friday/C3 row lifts that
--   --     shadow, so an active weekday/C3 would leak onto Fridays.
--   --   * HISTORICAL bug, already fixed 2026-07-16: the fallback used to be
--   --     all-or-nothing (`matching.length === 0`), so once patch25 added ANY
--   --     friday row every Friday silently lost its ENTIRE weekday slate.
--   --     That is what templateSlots.ts's header comment records. It is fixed
--   --     and does not bear on this patch.
--   -- If the BEFORE census shows any OTHER inactive C1/C2/C3 row, that is a
--   -- pre-existing condition this patch did not cause — note it and carry on,
--   -- but do not let it mask a real diff.
--
-- ── AFTER (4): the stored pattern has the Sat+Sun neuro shape ───────────────
--   SELECT jsonb_array_length(c->'links') AS n_links,
--          c->'links'                     AS sat_c3_links,
--          cp.definition->'neuroWeekend'  AS neuro_weekend
--     FROM scheduling.call_patterns cp
--     CROSS JOIN LATERAL jsonb_array_elements(cp.definition->'blocks') b
--     CROSS JOIN LATERAL jsonb_array_elements(b->'chains') c
--    WHERE cp.site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
--      AND cp.status = 'active'
--      AND b->>'anchorDayType' = 'saturday'
--      AND c->>'trigger' = 'C3';
--   -- expect: 1 row
--   --   n_links = 2
--   --   sat_c3_links  = [{"offset":-1,"code":"D4"},
--   --                    {"offset":1,"code":"C3","minFte":0.75}]
--   --   neuro_weekend = {"code":"C3","requirementBands":[
--   --                      {"minFte":0.75,"units":1},
--   --                      {"minFte":0,"units":0.5}]}
--   -- TWO bands (2026-07-27 revision — see the DOC DELTA note above). A third
--   -- {"minFte":1,"units":0} band here means a stale doc was applied.
--
--   -- Same thing as two hard booleans (position-independent):
--   SELECT definition->'blocks' @> '[{"anchorDayType":"saturday","chains":[{"trigger":"C3","links":[{"offset":-1,"code":"C3"}]}]}]'::jsonb
--            AS still_has_friday_c3_link,
--          definition->'neuroWeekend' IS NOT NULL AS has_neuro_weekend,
--          position('minFte' in definition::text) > 0 AS has_fte_gate
--     FROM scheduling.call_patterns
--    WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e' AND status = 'active';
--   -- expect: false, true, true
--
-- ── AFTER (5): informational — Friday C3 slots left in EXISTING schedules ───
--   SELECT sv.version_status, count(*) AS friday_c3_slots
--     FROM scheduling.schedule_slots ss
--     JOIN scheduling.schedule_versions sv ON sv.id = ss.schedule_version_id
--     JOIN scheduling.shift_types st ON st.id = ss.shift_type_id
--    WHERE ss.site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
--      AND st.code = 'C3'
--      AND ss.derived_day_type = 'friday'
--    GROUP BY 1;
--   -- NOT changed by this patch (see "DELIBERATELY NOT IN SCOPE" above). Any
--   -- rows here are pre-existing slots that will still fill as standalone
--   -- Friday calls. Regenerate those drafts, or delete the slots, as desired.
--   -- Schedules created AFTER this patch will have no Friday C3 slot at all.
--
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ ROLLBACK                                                                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Statement 1 is trivially reversible; statement 2 is NOT recoverable from the
-- database and must be restored from the repo. Read the note before acting.
--
-- ── Reactivate the Friday C3 template ───────────────────────────────────────
--   UPDATE scheduling.shift_templates
--      SET is_active = true, updated_at = now()
--    WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
--      AND day_type = 'friday'
--      AND shift_type_id = (SELECT id FROM scheduling.shift_types
--                            WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e' AND code = 'C3');
--   -- Expect: UPDATE 1. Note this restores the TEMPLATE, so future schedules
--   -- get a Friday C3 slot again; it does not retro-add slots to schedules
--   -- created while the template was off.
--
-- ── Restore the previous pattern doc ────────────────────────────────────────
-- IMPORTANT — a plain SQL UPDATE like statement 2 archives NOTHING. Verified
-- in this repo:
--   * The ONLY trigger on scheduling.call_patterns is `set_updated_at`
--     (patch18). There is no archive trigger and no history table, so the
--     UPDATE overwrites `definition` in place and the old JSON is GONE.
--   * Archiving is APPLICATION logic only: replaceActivePattern() in
--     src/lib/scheduleAssistant/mutations.ts — used by PUT
--     /api/scheduling/call-patterns and the assistant's update_call_pattern
--     tool — flips the current active row to status = 'archived' and INSERTs a
--     new active row. Raw SQL bypasses that path entirely.
--   * Therefore patches 25, 33 and 35 left NO archived row either; they all
--     UPDATEd in place. Any archived Paoli row you find is patch19's
--     classic -> weekend-v2 cutover, NOT the doc this patch replaces. Do not
--     restore from it.
--
-- The real recovery path is to RE-EMIT the pre-change constant from git. This
-- was verified, not assumed: emitting WEEKEND_V2_PATTERN from git 38e0962^
-- (i.e. 2070a4e, the last commit to touch the file before the neuro change)
-- reproduces the pre-patch38 live doc EXACTLY — patch33's JSON literal with
-- patch35's four C2N12/C2N8 dayChains appended, byte for byte.
--
--   # Repoint the relative import so the detached copy still resolves, then
--   # emit. This is the exact command sequence that was used to verify the
--   # round-trip above (run from the repo root):
--   git show '38e0962^:src/lib/rulesEngine/patterns/weekendV2.ts' \
--     | sed "s#from '../callPattern'#from '$PWD/src/lib/rulesEngine/callPattern'#" \
--     > /tmp/prev.ts
--   npx tsx -e "import('/tmp/prev.ts').then(m => console.log(JSON.stringify(m.WEEKEND_V2_PATTERN)))"
--
-- then paste the result into:
--   UPDATE scheduling.call_patterns
--      SET definition = '<emitted JSON>'::jsonb, updated_at = now()
--    WHERE site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e' AND status = 'active';
--
-- Paper-trail fallback if git is unavailable: the doc literal in
-- supabase_scheduling_patch33_precall_no_waiver.sql PLUS the four dayChains
-- appended by supabase_scheduling_patch35_call_splits.sql equals the same doc.
--
-- Roll BOTH back together, for the same reason they land together.
