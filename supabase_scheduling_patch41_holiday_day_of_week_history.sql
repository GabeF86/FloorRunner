-- supabase_scheduling_patch41_holiday_day_of_week_history.sql
-- A holiday counts as the DAY OF THE WEEK it falls on — history side.
--
-- PROJECT: apply ONLY to Supabase ref qhwdbtixhzdsgwwtcfrm ("Floor Runner" —
-- the ref in .env.local). Two OTHER Supabase projects are connected to this
-- machine for DIFFERENT apps (atlas-staging, ChiefOS). VERIFY THE REF FIRST.
--
-- STATUS: APPLIED 2026-07-28 to project qhwdbtixhzdsgwwtcfrm via the
--   project-scoped supabase-floorrunner MCP (apply_migration
--   "patch41_holiday_day_of_week_history").
--   Post-apply spot check: the site has ZERO published versions, so the RPC
--   returns no rows and DISTINCT bucket is empty — 'holiday' is provably not
--   among them. That is the expected state, not a failure: this patch is
--   correctness for the first block published AFTER the bucket change, and
--   until something is published there is no history to key either way.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- Gabriel, verbatim: "Holidays that fall out on a weekend Friday saturday or
-- sunday, get included in the obligatory weekend count, and those that fall out
-- on weekdays do the same." There is no separate holiday fairness bucket: a
-- Monday holiday is a weekday call, a Saturday holiday is a Saturday call.
--
-- THE BUG THIS CLOSES. dayTypeBucket mapped federal_holiday/major_holiday to a
-- 'holiday' bucket, so on his live 11-week block two of the 44 Mon–Thu dates
-- (Labor Day 2026-09-07, Columbus Day 2026-10-12, both MONDAYS) fell out of the
-- weekday bucket. That left 42 slots, and the quota target is
-- (blockTotal / par) * fte = 42/11 = 3.818. The gate is `assigned + 1 > target`,
-- so a 1.0 FTE was permitted 3 weekday C1 calls and refused the 4th. His model
-- says 4. Measured, not argued: re-typing those two dates as weekday moves the
-- target to exactly 4.000 and every 1.0 FTE receives 4.
--
-- In 'all' fill mode the quota never binds (IF-3 relaxation fills regardless),
-- which is why this only surfaced on an 'obligatory' run.
--
-- ── WHAT ────────────────────────────────────────────────────────────────────
-- The CODE side shipped separately (dayTypeBucketOn, shared.ts — the day type
-- still wins whenever it names a real day; the DATE is consulted only for the
-- two holiday types, so every non-holiday key is byte-identical to before).
-- This patch moves the HISTORY RPC to the same rule so past call keys into the
-- same buckets the live targets read.
--
-- patch24's `WHEN ... IN ('saturday','sunday')` branch is subsumed by the ELSE
-- and is dropped. EXTRACT(DOW ...) is 0=Sun..6=Sat, exactly getUTCDay(); the
-- column is a `date`, so there is no timezone hazard.
--
-- Everything else from patch24/patch21 is PRESERVED verbatim: the published-only
-- join (draft isolation, invariant 3), the assigned/non-null/call-category
-- filters, the signature, and the grants. Start from the patch24 definition, not
-- patch18's.
--
-- ── ORDER ───────────────────────────────────────────────────────────────────
-- Order-independent, and safe in the reverse window — the same failure mode
-- patch24 documented for `weekend`. Until this lands, past HOLIDAY call keys
-- into `holiday|CODE`, which no live target looks up, so holiday history
-- contributes NOTHING to deficit carry-forward rather than contributing WRONG
-- data. Non-holiday history is unaffected either way.
--
-- ── SCOPE OF EFFECT ─────────────────────────────────────────────────────────
-- Only PUBLISHED past call feeds this. If nothing is published yet, the RPC
-- returns no rows and this patch changes nothing observable today — it is
-- correctness for the first block published after the bucket change.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, no data changes, safe to re-run.

CREATE OR REPLACE FUNCTION scheduling.historical_call_counts(p_site_id uuid, p_before date)
RETURNS TABLE (provider_id uuid, bucket text, code text, n bigint)
LANGUAGE sql STABLE AS $$
  SELECT a.provider_id,
         CASE
           -- A holiday counts as the day of the week it falls on (2026-07-27).
           WHEN ss.derived_day_type IN ('federal_holiday','major_holiday') THEN
             CASE EXTRACT(DOW FROM ss.slot_date)::int
               WHEN 6 THEN 'saturday'
               WHEN 0 THEN 'sunday'
               WHEN 5 THEN 'friday'
               ELSE 'weekday'
             END
           ELSE ss.derived_day_type::text
         END AS bucket,
         st.code,
         count(*) AS n
  FROM scheduling.assignments a
  JOIN scheduling.schedule_slots ss ON ss.id = a.schedule_slot_id
  -- Draft isolation: committed = published version only (patch21, preserved).
  JOIN scheduling.schedule_versions sv
    ON sv.id = ss.schedule_version_id AND sv.version_status = 'published'
  JOIN scheduling.shift_types st ON st.id = ss.shift_type_id
  WHERE ss.site_id = p_site_id
    AND ss.slot_date < p_before
    AND a.assignment_status = 'assigned'
    AND a.provider_id IS NOT NULL
    AND st.category = 'call'
  GROUP BY 1, 2, 3
$$;
GRANT EXECUTE ON FUNCTION scheduling.historical_call_counts(uuid, date) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- ── VERIFICATION (run after applying) ───────────────────────────────────────
--
-- 1. No 'holiday' bucket can ever come back:
--   SELECT DISTINCT bucket
--     FROM scheduling.historical_call_counts(
--            '2ddd2427-22fb-4290-9c4c-03a957e5af4e', CURRENT_DATE + 3650);
--   -- expect: only weekday / friday / saturday / sunday. NEVER 'holiday'.
--   -- (Returns zero rows while nothing is published — that is not a failure.)
--
-- 2. The folding is real, checked against the raw rows. This re-derives the
--    answer independently instead of trusting the function:
--   SELECT EXTRACT(DOW FROM ss.slot_date)::int AS dow,
--          ss.derived_day_type::text AS day_type,
--          count(*) AS holiday_call_rows
--     FROM scheduling.assignments a
--     JOIN scheduling.schedule_slots ss ON ss.id = a.schedule_slot_id
--     JOIN scheduling.schedule_versions sv
--       ON sv.id = ss.schedule_version_id AND sv.version_status = 'published'
--     JOIN scheduling.shift_types st ON st.id = ss.shift_type_id
--    WHERE ss.site_id = '2ddd2427-22fb-4290-9c4c-03a957e5af4e'
--      AND ss.derived_day_type IN ('federal_holiday','major_holiday')
--      AND a.assignment_status = 'assigned' AND a.provider_id IS NOT NULL
--      AND st.category = 'call'
--    GROUP BY 1, 2 ORDER BY 1;
--   -- expect: every dow here appears as the matching bucket in query 1
--   -- (6→saturday, 0→sunday, 5→friday, anything else→weekday).
--
-- 3. Non-holiday history is untouched — compare a bucket total before and
--    after applying; weekday/friday/saturday/sunday counts may only INCREASE,
--    and only by the number of holiday rows folded in.
