-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ STATUS: APPLIED 2026-07-12 to project qhwdbtixhzdsgwwtcfrm (manually,     ║
-- ║ via the dashboard SQL editor — no connected MCP server matched the ref).  ║
-- ║ Post-apply spot checks passed: 11 sites = 11 active seeded patterns;      ║
-- ║ shift_types backfill sane (C1/C2/C3 ranks 0/1/2, D4-D9 relief 1-6,        ║
-- ║ D-codes engine=call, day codes engine=day_pool);                          ║
-- ║ historical_call_counts RPC returns rows; assistant_actions reachable;     ║
-- ║ GET /api/scheduling/call-patterns serves the seeded classic pattern.      ║
-- ║                                                                           ║
-- ║ Safety note (kept for reruns): the DO block at the bottom ASSERTS that    ║
-- ║ the unique index assignments_schedule_slot_id_key (from migration         ║
-- ║ 20260524000000_add_assignment_unique_constraints.sql) exists and raises   ║
-- ║ if it doesn't.                                                            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Patch 18: call patterns (data-driven call structures), shift_type engine
-- columns, assistant undo snapshots, historical-fairness aggregate, indexes.
-- Spec: docs/superpowers/specs/2026-07-07-scheduling-v2-design.md §4.

-- ── call_patterns ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduling.call_patterns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id      uuid NOT NULL REFERENCES scheduling.sites(id) ON DELETE CASCADE,
  name         text NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  definition   jsonb NOT NULL,
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','assistant','seed')),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS call_patterns_one_active
  ON scheduling.call_patterns(site_id) WHERE status = 'active';
CREATE TRIGGER set_updated_at BEFORE UPDATE ON scheduling.call_patterns
  FOR EACH ROW EXECUTE FUNCTION scheduling.set_updated_at();

-- ── shift_types engine columns ──────────────────────────────────────────────
ALTER TABLE scheduling.shift_types
  ADD COLUMN IF NOT EXISTS call_rank int,
  ADD COLUMN IF NOT EXISTS relief_rank int,
  ADD COLUMN IF NOT EXISTS is_overlay boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS generation_engine text NOT NULL DEFAULT 'day_pool'
    CHECK (generation_engine IN ('call','day_pool','none'));

-- Backfill from today's naming conventions (one-time; new rows set explicitly).
UPDATE scheduling.shift_types SET call_rank = CASE code WHEN 'C1' THEN 0 WHEN 'C2' THEN 1 WHEN 'C3' THEN 2 END
  WHERE code IN ('C1','C2','C3') AND call_rank IS NULL;
UPDATE scheduling.shift_types SET relief_rank = (substring(code from '^D([4-9])$'))::int - 3
  WHERE code ~ '^D[4-9]$' AND relief_rank IS NULL;         -- D4→1 .. D9→6
UPDATE scheduling.shift_types SET generation_engine = 'call'
  WHERE category = 'call' OR code ~ '^D[0-9]+$';           -- calls + derived/relief D-codes

-- ── assistant_actions (undo snapshots) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduling.assistant_actions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id         uuid NOT NULL REFERENCES scheduling.schedules(id) ON DELETE CASCADE,
  schedule_version_id uuid REFERENCES scheduling.schedule_versions(id) ON DELETE SET NULL,
  summary             text NOT NULL,
  request_text        text,
  config_before       jsonb NOT NULL,
  assignments_before  jsonb NOT NULL,
  reverted_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ── historical fairness aggregate (replaces unbounded row fetch) ───────────
CREATE OR REPLACE FUNCTION scheduling.historical_call_counts(p_site_id uuid, p_before date)
RETURNS TABLE (provider_id uuid, bucket text, code text, n bigint)
LANGUAGE sql STABLE AS $$
  SELECT a.provider_id,
         CASE
           WHEN ss.derived_day_type IN ('saturday','sunday') THEN 'weekend'
           WHEN ss.derived_day_type IN ('federal_holiday','major_holiday') THEN 'holiday'
           ELSE ss.derived_day_type::text
         END AS bucket,
         st.code,
         count(*) AS n
  FROM scheduling.assignments a
  JOIN scheduling.schedule_slots ss ON ss.id = a.schedule_slot_id
  JOIN scheduling.shift_types st ON st.id = ss.shift_type_id
  WHERE ss.site_id = p_site_id
    AND ss.slot_date < p_before
    AND a.assignment_status = 'assigned'
    AND a.provider_id IS NOT NULL
    AND st.category = 'call'
  GROUP BY 1, 2, 3
$$;
GRANT EXECUTE ON FUNCTION scheduling.historical_call_counts(uuid, date) TO anon, authenticated, service_role;

-- ── indexes for hot query shapes (skip any that already exist) ──────────────
CREATE INDEX IF NOT EXISTS assignments_provider_status_idx
  ON scheduling.assignments (provider_id, assignment_status);
CREATE INDEX IF NOT EXISTS schedule_slots_version_date_idx
  ON scheduling.schedule_slots (schedule_version_id, slot_date, slot_index);
CREATE INDEX IF NOT EXISTS schedule_slots_date_site_idx
  ON scheduling.schedule_slots (slot_date, site_id);
CREATE INDEX IF NOT EXISTS provider_availability_pid_dates_idx
  ON scheduling.provider_availability (provider_id, start_date, end_date);

-- ── seed one classic pattern per existing site ──────────────────────────────
-- Definition JSON mirrors CLASSIC_PATTERN in src/lib/rulesEngine/callPattern.ts.
INSERT INTO scheduling.call_patterns (site_id, name, status, source, definition)
SELECT s.id, 'Classic (ported from engine)', 'active', 'seed', '{
  "version": 1,
  "blocks": [{ "anchorDayType": "saturday", "chains": [
    { "trigger": "C3", "links": [{ "offset": 1, "code": "C3" }] },
    { "trigger": "C1", "links": [{ "offset": 1, "code": "C2" }, { "offset": -1, "code": "C2" }] },
    { "trigger": "C2", "links": [{ "offset": 1, "code": "C1" }, { "offset": -1, "code": "D2" }] } ] }],
  "dayChains": [
    { "trigger": "C1", "dayTypes": ["weekday","friday","federal_holiday","major_holiday"],
      "links": [{ "offset": -1, "code": "D2", "unlessCallWithinDays": 2 }], "blocks": [{ "offset": 1 }] },
    { "trigger": "C1", "dayTypes": ["sunday"], "blocks": [{ "offset": 1 }] },
    { "trigger": "C2", "dayTypes": ["weekday","friday","federal_holiday","major_holiday"],
      "links": [{ "offset": -1, "code": "D3", "unlessCallWithinDays": 2 }, { "offset": 1, "code": "D1" }] },
    { "trigger": "C2", "dayTypes": ["sunday"], "links": [{ "offset": 1, "code": "D1" }] } ],
  "spans": [],
  "placementPasses": [{ "kind": "pre_pto", "relativeDay": "thursday_prior_week",
                        "codes": ["C1","C2"], "maxProviders": 2, "enabled": true }],
  "reliefPass": { "enabled": true, "dayTypes": ["weekday","friday"] },
  "optimizerMovableDayTypes": ["weekday","friday"]
}'::jsonb
FROM scheduling.sites s
WHERE NOT EXISTS (
  SELECT 1 FROM scheduling.call_patterns cp WHERE cp.site_id = s.id AND cp.status = 'active'
);

-- ── assignments: one-row-per-slot sanity check ──────────────────────────────
-- The schedule-assignments POST route upserts with onConflict:'schedule_slot_id',
-- which depends on the UNIQUE constraint added by
-- supabase/migrations/20260524000000_add_assignment_unique_constraints.sql
-- (assignments_schedule_slot_id_key, live since 2026-05). This patch does NOT
-- recreate it — a second unique index on the busiest table would be pure write
-- overhead. Instead, fail loudly if the constraint has somehow gone missing so
-- the applier investigates before the upsert path silently breaks.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
    WHERE n.nspname = 'scheduling'
      AND t.relname = 'assignments'
      AND i.indisunique
      AND i.indisvalid          -- exclude half-built/failed CONCURRENTLY indexes
      AND i.indpred IS NULL     -- a PARTIAL unique index can't back ON CONFLICT
      AND i.indnkeyatts = 1
      AND a.attname = 'schedule_slot_id'
  ) THEN
    RAISE EXCEPTION USING MESSAGE =
      'scheduling.assignments has no UNIQUE(schedule_slot_id) constraint '
      || '(expected assignments_schedule_slot_id_key from migration '
      || '20260524000000_add_assignment_unique_constraints.sql). The '
      || 'schedule-assignments POST upsert depends on it — apply that '
      || 'migration before patch18.';
  END IF;
END $$;
