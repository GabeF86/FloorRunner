-- Patch 14: Grid Calculator — configs + distance matrix
--
-- Owned by agent A1 (Site Architect). Adds the universal-config envelope and
-- per-config distance edges that drive supervisability decisions in
-- `src/lib/gridCalculator/distanceMatrix.ts`.
--
-- This patch is intentionally narrow:
--   - `grid_calculator_configs`   — one row per saved configuration
--   - `grid_calculator_distances` — sparse edge list for the distance matrix
--
-- A2 (Provider Profile) owns provider-side leave-bucket columns and may add
-- additional ALTER TABLE statements in a separate patch.
-- A4 (Rules Normalizer) owns `grid_calculator_guidelines`.
-- A7 (FTE Simulator)    owns `grid_calculator_fte_runs`.
--
-- Coordinate-safe: only CREATE TABLE IF NOT EXISTS and ALTER TABLE ... ADD
-- COLUMN IF NOT EXISTS so this can be re-run safely and merged with sibling
-- agent patches without conflict.
--
-- PRD: docs/PRD-Grid-Calculator.md §13.

-- ── grid_calculator_configs ────────────────────────────────────────────────
--
-- One row per saved configuration. `hospital` is free-text (matches the
-- existing FloorRunner convention used in `staff.hospital`) rather than an
-- FK so a config can be authored before any FloorRunner sites are imported.
CREATE TABLE IF NOT EXISTS scheduling.grid_calculator_configs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital              text NOT NULL,
  name                  text NOT NULL,
  coverage_style        text CHECK (coverage_style IN ('md_heavy','balanced','crna_heavy')),
  supervision_ratio     text CHECK (supervision_ratio IN ('mostly_1_3','mostly_1_4','mixed')),
  float_strategy        text CHECK (float_strategy IN ('break_priority','emergency_priority','balanced')),
  backup_call_posture   text CHECK (backup_call_posture IN ('aggressive','conservative')),
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Idempotent re-runs: add columns if the table predates this patch in any
-- environment (e.g. a partial drop/restore). Safe no-op otherwise.
ALTER TABLE scheduling.grid_calculator_configs
  ADD COLUMN IF NOT EXISTS hospital            text,
  ADD COLUMN IF NOT EXISTS name                text,
  ADD COLUMN IF NOT EXISTS coverage_style      text,
  ADD COLUMN IF NOT EXISTS supervision_ratio   text,
  ADD COLUMN IF NOT EXISTS float_strategy      text,
  ADD COLUMN IF NOT EXISTS backup_call_posture text,
  ADD COLUMN IF NOT EXISTS created_by          uuid,
  ADD COLUMN IF NOT EXISTS created_at          timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at          timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS grid_calculator_configs_hospital_idx
  ON scheduling.grid_calculator_configs (hospital);

COMMENT ON TABLE scheduling.grid_calculator_configs IS
  'Saved Grid Calculator configurations. One row per (hospital, name). Toggle state lives in URL params for sharing; persisted state is the source-of-truth defaults.';

-- ── grid_calculator_distances ──────────────────────────────────────────────
--
-- Sparse edge list. The application code defaults missing pairs to band
-- `near` per `distanceMatrix.ts`. `supervisable` is stored as an explicit
-- boolean so admins can override the band default (e.g. mark a `near` pair
-- as not supervisable due to a closed corridor).
--
-- `site_a` and `site_b` reference `scheduling.sites(id)` only when the
-- config uses imported sites. For purely standalone configs (universal mode)
-- the FK target may be NULL; we keep the FK with ON DELETE CASCADE so
-- removing a site cleans its edges.
CREATE TABLE IF NOT EXISTS scheduling.grid_calculator_distances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id       uuid NOT NULL REFERENCES scheduling.grid_calculator_configs(id) ON DELETE CASCADE,
  site_a          uuid REFERENCES scheduling.sites(id) ON DELETE CASCADE,
  site_b          uuid REFERENCES scheduling.sites(id) ON DELETE CASCADE,
  distance_band   text NOT NULL CHECK (distance_band IN ('same_room','adjacent','near','far','off_campus')),
  supervisable    boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE scheduling.grid_calculator_distances
  ADD COLUMN IF NOT EXISTS config_id     uuid,
  ADD COLUMN IF NOT EXISTS site_a        uuid,
  ADD COLUMN IF NOT EXISTS site_b        uuid,
  ADD COLUMN IF NOT EXISTS distance_band text,
  ADD COLUMN IF NOT EXISTS supervisable  boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at    timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at    timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS grid_calculator_distances_config_idx
  ON scheduling.grid_calculator_distances (config_id);

-- Unique edge per config — the distance graph is undirected, so we constrain
-- by sorted (least, greatest) pair. Using LEAST/GREATEST keeps a single row
-- per unordered pair regardless of insert order.
CREATE UNIQUE INDEX IF NOT EXISTS grid_calculator_distances_pair_uidx
  ON scheduling.grid_calculator_distances (
    config_id,
    LEAST(site_a, site_b),
    GREATEST(site_a, site_b)
  );

COMMENT ON TABLE scheduling.grid_calculator_distances IS
  'Sparse distance graph for a Grid Calculator config. Absent pairs default to band ''near''. `supervisable` is stored as an explicit boolean so admins can override the band default.';
COMMENT ON COLUMN scheduling.grid_calculator_distances.supervisable IS
  'Admin override. Defaults derived from `distance_band` via `defaultBandSupervisability` in src/lib/gridCalculator/distanceMatrix.ts.';

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Mirror existing scheduling-schema RLS posture: enable now, expect detailed
-- policies to ship in a follow-up patch alongside the FloorRunner auth model.
ALTER TABLE scheduling.grid_calculator_configs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.grid_calculator_distances ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
