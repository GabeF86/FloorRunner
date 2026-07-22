-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ STATUS: NOT YET APPLIED.                                                  ║
-- ║ Apply to project qhwdbtixhzdsgwwtcfrm ("Floor Runner"), ref verified,     ║
-- ║ via the project-scoped supabase-floorrunner MCP server (or the dashboard  ║
-- ║ SQL editor). Never run through the atlas-staging / chiefos MCP servers.   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Patch 36: call-shift requests in request windows. Additive only.
--
-- Feature (Gabriel 2026-07-22): providers can request TO BE GIVEN call on
-- specific dates through the same tokenized request-window form that takes
-- no-call requests, and "the total requests should be chosen by the admin."
--
--  1. scheduling.request_windows.max_call_requests — the admin-set
--     per-provider cap on call-shift requests for the window. NULL (the
--     default) = the category is OFF for that window (the form doesn't show
--     it); when set it must be ≥ 1 — "off" is expressed by NULL, never 0.
--     One request = one requested DATE (a 3-day span is 3 requests) —
--     enforced server-side in the intake route by counting the provider's
--     existing window-sourced call_request rows (notes = request_window:<id>),
--     exactly mirroring the no-call cap.
--
--  NO enum change: 'call_request' has been a scheduling.availability_type
--  value since the original schema (verified against the live DB read-only on
--  2026-07-22: PostgREST filter availability_type=eq.call_request returns 200,
--  no invalid-enum error). The rows the intake route writes are
--  provider_availability (type 'call_request', approved, all_day, source
--  'request_window') — the engine soft-PREFERS them (scoreCall preferred
--  tier, solveKernel.ts; mirror image of the no_call_request soft avoidance).
--
--  max_no_call_requests needs NO change: it has existed since patch29
--  (int NOT NULL DEFAULT 3, admin-chosen at window open, enforced in the
--  intake route) — the "same optional cap for No Call" already ships, and
--  existing behavior is untouched.
--
-- No RLS statements: follows patch18's precedent — the app talks to the
-- scheduling schema with the service-role key; RLS/auth work is tracked
-- separately as the platform's #1 blocker.

ALTER TABLE scheduling.request_windows
  ADD COLUMN IF NOT EXISTS max_call_requests int
  CHECK (max_call_requests IS NULL OR max_call_requests >= 1);

COMMENT ON COLUMN scheduling.request_windows.max_call_requests IS
  'Admin-set per-provider cap on window-sourced call_request availability rows (one request = one requested date). NULL = call-shift requests OFF for this window; when set, must be >= 1. Enforced server-side in the intake route by counting rows with notes = request_window:<id>.';

-- ── VERIFY AFTER ────────────────────────────────────────────────────────────
--   SELECT column_name, is_nullable, data_type
--     FROM information_schema.columns
--    WHERE table_schema = 'scheduling'
--      AND table_name = 'request_windows'
--      AND column_name = 'max_call_requests';        -- expect: 1 row, YES, integer
--   SELECT max_call_requests FROM scheduling.request_windows LIMIT 5;
--                                                    -- expect: NULL on existing rows
--   SELECT enum_range(NULL::scheduling.availability_type);
--                                                    -- expect: contains call_request (pre-existing)
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
--   ALTER TABLE scheduling.request_windows DROP COLUMN IF EXISTS max_call_requests;
--   -- (window-sourced call_request provider_availability rows carry
--   --  source 'request_window' and notes 'request_window:<id>'; remove with:
--   --  DELETE FROM scheduling.provider_availability
--   --   WHERE availability_type = 'call_request' AND source = 'request_window';)
