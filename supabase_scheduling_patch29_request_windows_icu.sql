-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ STATUS: NOT APPLIED.                                                      ║
-- ║ Apply to project qhwdbtixhzdsgwwtcfrm ("Floor Runner"), ref verified,     ║
-- ║ via the project-scoped supabase-floorrunner MCP server (or the dashboard  ║
-- ║ SQL editor). Never run through the atlas-staging / chiefos MCP servers.   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Patch 29: request-intake windows + ICU-doc flag. Additive only.
--
--  1. scheduling.request_windows — a per-site submission window for the next
--     scheduling block. Gabriel opens one from the schedules page, shares the
--     single tokenized link (/requests/submit/<token>) with the group, and
--     closes it manually. The token is the only gate (no auth in this app);
--     it is crypto-random, generated server-side on create, and unique.
--     One OPEN window per site at a time (partial unique index, mirroring
--     call_patterns_one_active) — the UI copy speaks of "the one shared
--     link", and a second concurrent window would make the per-provider
--     no-call cap ambiguous.
--  2. provider_employment_profiles.is_icu_doc — flags providers who rotate
--     through the ICU. Drives the ICU Rotation section on the profile
--     Availability tab (which writes plain 'blocked' provider_availability
--     rows with reason_code 'icu_week' / 'icu_post_call' — no engine change;
--     'blocked' is already in BLOCKING_AVAIL).
--
-- No RLS statements: follows patch18's call_patterns precedent — the app
-- talks to the scheduling schema with the service-role key; RLS/auth work is
-- tracked separately as the platform's #1 blocker.

-- ── request_windows ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduling.request_windows (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id              uuid NOT NULL REFERENCES scheduling.sites(id) ON DELETE CASCADE,
  block_start          date NOT NULL,
  block_end            date NOT NULL,
  max_no_call_requests int  NOT NULL DEFAULT 3 CHECK (max_no_call_requests >= 0),
  token                text NOT NULL UNIQUE,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at            timestamptz NOT NULL DEFAULT now(),
  closed_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (block_end >= block_start)
);

-- One open window per site (see header). Closed windows are history.
CREATE UNIQUE INDEX IF NOT EXISTS request_windows_one_open
  ON scheduling.request_windows(site_id) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS request_windows_site_idx
  ON scheduling.request_windows(site_id, opened_at DESC);

COMMENT ON TABLE scheduling.request_windows IS
  'Tokenized public-intake windows: providers submit PTO / days-off / no-call requests for a scheduling block via /requests/submit/<token>. Token is the gate (no auth).';
COMMENT ON COLUMN scheduling.request_windows.max_no_call_requests IS
  'Per-provider cap on window-sourced no_call_request availability rows; enforced server-side in the intake route by counting rows with notes = request_window:<id>.';

-- ── provider_employment_profiles.is_icu_doc ─────────────────────────────────
ALTER TABLE scheduling.provider_employment_profiles
  ADD COLUMN IF NOT EXISTS is_icu_doc boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN scheduling.provider_employment_profiles.is_icu_doc IS
  'Rotates through the ICU. Shows the ICU Rotation entry section on the profile Availability tab (blocked/icu_week + blocked/icu_post_call rows).';

-- ── VERIFY AFTER ────────────────────────────────────────────────────────────
--   SELECT count(*) FROM scheduling.request_windows;                 -- expect: 0
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='scheduling'
--      AND table_name='provider_employment_profiles'
--      AND column_name='is_icu_doc';                                 -- expect: 1 row
--   \d scheduling.request_windows  -- expect request_windows_one_open partial unique idx
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS scheduling.request_windows;
--   ALTER TABLE scheduling.provider_employment_profiles DROP COLUMN IF EXISTS is_icu_doc;
--   -- (window-sourced provider_availability rows carry notes 'request_window:<id>'
--   --  and source 'request_window'; remove with:
--   --  DELETE FROM scheduling.provider_availability WHERE source = 'request_window';)
