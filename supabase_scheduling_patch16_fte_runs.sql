-- Patch 16: Grid Calculator — FTE simulator run history
--
-- Owned by agent A7 (FTE Simulator). Persists worst-case + Monte Carlo output
-- so the UI can show the most-recent recommendation per config, and so the
-- nightly cron loop can diff today's recommendation against the prior accepted
-- one (PRD §10, §13, §14 A7).
--
-- Coordinate-safe: only CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS.
-- Re-running is a no-op.
--
-- PRD: docs/PRD-Grid-Calculator.md §13.

-- ── grid_calculator_fte_runs ───────────────────────────────────────────────
--
-- One row per simulator run. `recommendation` is the final FTERecommendation
-- the UI renders; `worst_case` and `monte_carlo` are the raw simulation
-- outputs preserved for audit + diff. `rationale` is the human-readable
-- Claude-written explanation (templated fallback when the API key is missing).
CREATE TABLE IF NOT EXISTS scheduling.grid_calculator_fte_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id       uuid NOT NULL REFERENCES scheduling.grid_calculator_configs(id) ON DELETE CASCADE,
  ran_at          timestamptz NOT NULL DEFAULT now(),
  worst_case      jsonb NOT NULL,
  monte_carlo     jsonb NOT NULL,
  recommendation  jsonb NOT NULL,
  rationale       text,
  trials_count    integer,
  seed            bigint,
  rationale_source text CHECK (rationale_source IN ('claude','template')),
  -- Float-health auto-bump trace: how many extra CRNAs were added to keep
  -- break feasibility above the `tight` threshold (PRD §12).
  float_bumps     integer NOT NULL DEFAULT 0
);

-- Idempotent re-runs: add columns if the table predates this patch.
ALTER TABLE scheduling.grid_calculator_fte_runs
  ADD COLUMN IF NOT EXISTS config_id        uuid,
  ADD COLUMN IF NOT EXISTS ran_at           timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS worst_case       jsonb,
  ADD COLUMN IF NOT EXISTS monte_carlo      jsonb,
  ADD COLUMN IF NOT EXISTS recommendation   jsonb,
  ADD COLUMN IF NOT EXISTS rationale        text,
  ADD COLUMN IF NOT EXISTS trials_count     integer,
  ADD COLUMN IF NOT EXISTS seed             bigint,
  ADD COLUMN IF NOT EXISTS rationale_source text,
  ADD COLUMN IF NOT EXISTS float_bumps      integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS grid_calculator_fte_runs_config_idx
  ON scheduling.grid_calculator_fte_runs (config_id, ran_at DESC);

COMMENT ON TABLE scheduling.grid_calculator_fte_runs IS
  'Simulator run history. Most recent row per config is what the UI shows; older rows enable diffing recommendations over time.';

-- RLS enabled; policy bodies deferred to the FloorRunner-wide auth pass
-- (see A1 patch 14 notes — same convention).
ALTER TABLE scheduling.grid_calculator_fte_runs ENABLE ROW LEVEL SECURITY;

-- -- DOWN
-- DROP INDEX IF EXISTS scheduling.grid_calculator_fte_runs_config_idx;
-- DROP TABLE IF EXISTS scheduling.grid_calculator_fte_runs;
