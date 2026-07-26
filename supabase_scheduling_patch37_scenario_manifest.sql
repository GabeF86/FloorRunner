-- patch37: per-schedule scenario manifest (2026-07-26, Paoli block phase 2)
--
-- PURPOSE
--   The Paoli 8/10–10/25 block runs off a workbook of per-provider
--   constraints (per-bucket call targets, no-call prohibitions, fixed
--   mandatory assignments, linkages, scenario FTEs, soft preferences).
--   Phase 1 (paoli-import) normalizes the workbook into a validated
--   MANIFEST (src/lib/paoliBlock/manifest.ts — paoliBlockManifestSchema).
--   This column attaches that manifest to the schedule so generation can
--   honor it: genContext loads it, projectScenario (src/lib/rulesEngine/
--   scenario.ts) projects it into engine terms, and the engine applies the
--   targets as hard per-(bucket,code) ceilings + steering targets,
--   prohibitions as eligibility gates, linkages as placement constraints,
--   and scenarioFte as a generation-only FTE override (the master
--   provider_employment_profiles row is NEVER written).
--
-- SHAPE (nullable jsonb)
--   The FULL phase-1 import manifest VERBATIM — deliberately NOT a trimmed
--   engine projection. The manifest is the audit source of truth (original
--   source text, parser warnings, mandatory-vs-prohibition conflicts);
--   storing a projection would fork that truth, and keeping projection logic
--   in code means projection fixes never require a re-import. Validated
--   in-app by paoliBlockManifestSchema (zod) at write AND load time; an
--   invalid stored manifest degrades LOUDLY to scenario-free generation.
--   NULL column / NULL value = no scenario — the engine is byte-identical to
--   the pre-scenario code (pinned by the fill-mode golden plans).
--
-- No CHECK constraint so hand repair stays possible (patch34 posture).
--
-- ROLLBACK
--   ALTER TABLE scheduling.schedules DROP COLUMN scenario_manifest;
--
-- Apply via the project-scoped supabase-floorrunner MCP (ref qhwdbtixhzdsgwwtcfrm)
-- after review — verify the ref first (CLAUDE.md Migrations). NOT applied to
-- the live DB as of 2026-07-26 (phase 2 ships the file only; phase 3 applies
-- it before the real generation).

ALTER TABLE scheduling.schedules
  ADD COLUMN IF NOT EXISTS scenario_manifest jsonb;

COMMENT ON COLUMN scheduling.schedules.scenario_manifest IS
  'Full validated Paoli block-import manifest (paoliBlockManifestSchema, src/lib/paoliBlock/manifest.ts): per-provider scenario FTEs, per-bucket call targets, prohibitions, fixed assignments, linkages, preferences, source text + conflicts. Projected at load by src/lib/rulesEngine/scenario.ts; NULL = no scenario (engine unchanged). patch37 2026-07-26.';
