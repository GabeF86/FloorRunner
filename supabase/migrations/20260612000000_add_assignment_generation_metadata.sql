-- Phase 2a: per-assignment generation explainability.
-- Additive + nullable. Holds { source, ratioAtAssignment?, daysSinceLastCall?,
-- competingCandidates? } written by the auto-generator. Safe to apply anytime;
-- the app writes it best-effort and no-ops if the column is absent.
ALTER TABLE scheduling.assignments
  ADD COLUMN IF NOT EXISTS generation_metadata jsonb;
