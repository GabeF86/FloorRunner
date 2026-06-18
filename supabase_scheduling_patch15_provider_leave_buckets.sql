-- Patch 15: Provider leave buckets + backup-call share for Grid Calculator
--
-- Owned by agent A2 (Provider Profile). Per PRD §5, §10, §11, §13, §14.
--
-- Adds leave-bucket and backup-call fields to
-- scheduling.provider_employment_profiles so that:
--
--   - The FTE simulator (A7) can sample sick / FMLA / maternity / CME draws
--     per-provider for the Monte Carlo run and apply the worst-case
--     deterministic hold-outs (PRD §10).
--   - The call burden agent (A8) can target a fractional backup-call FTE
--     share per provider and respect post-call exhaustion limits (PRD §11).
--
-- This patch is purely additive. Every column uses ADD COLUMN IF NOT EXISTS
-- so it is safe to re-run, and every column has a default so existing rows
-- continue to behave as they do today (no NOT NULL backfill needed).
--
-- A pre-flight check below confirms none of the target columns already exist
-- under a different name elsewhere in scheduling.provider_employment_profiles.
-- If a future patch re-introduces any of these names, this migration's
-- IF NOT EXISTS guards will no-op cleanly — but the duplicated semantics
-- should be reconciled in a follow-up.

-- ============================================================================
-- UP
-- ============================================================================

ALTER TABLE scheduling.provider_employment_profiles
  ADD COLUMN IF NOT EXISTS sick_days_per_year             integer       NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS maternity_eligible             boolean       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fmla_eligible                  boolean       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cme_days_per_year              integer       NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS backup_call_share_target       numeric(3,2),
  ADD COLUMN IF NOT EXISTS max_consecutive_post_call_days integer       NOT NULL DEFAULT 1;

-- Sanity-range checks. Rationale:
--  - sick_days_per_year:    0..60 (60 ~ 12 work-weeks; anything higher is FMLA).
--  - cme_days_per_year:     0..30 (most groups cap at 10).
--  - backup_call_share_target: NULL allowed (engine decides). When set, must be
--    in [0, 1] — it is a fractional FTE share of total backup-call demand.
--  - max_consecutive_post_call_days: 0..7 — a provider taking back-to-back
--    24h calls accumulates post-call days. Default 1 mirrors current
--    house rules (one post-call rest day per call).
ALTER TABLE scheduling.provider_employment_profiles
  DROP CONSTRAINT IF EXISTS provider_employment_profiles_sick_days_check;
ALTER TABLE scheduling.provider_employment_profiles
  ADD CONSTRAINT provider_employment_profiles_sick_days_check
  CHECK (sick_days_per_year BETWEEN 0 AND 60);

ALTER TABLE scheduling.provider_employment_profiles
  DROP CONSTRAINT IF EXISTS provider_employment_profiles_cme_days_check;
ALTER TABLE scheduling.provider_employment_profiles
  ADD CONSTRAINT provider_employment_profiles_cme_days_check
  CHECK (cme_days_per_year BETWEEN 0 AND 30);

ALTER TABLE scheduling.provider_employment_profiles
  DROP CONSTRAINT IF EXISTS provider_employment_profiles_backup_share_check;
ALTER TABLE scheduling.provider_employment_profiles
  ADD CONSTRAINT provider_employment_profiles_backup_share_check
  CHECK (backup_call_share_target IS NULL
         OR (backup_call_share_target >= 0 AND backup_call_share_target <= 1));

ALTER TABLE scheduling.provider_employment_profiles
  DROP CONSTRAINT IF EXISTS provider_employment_profiles_post_call_days_check;
ALTER TABLE scheduling.provider_employment_profiles
  ADD CONSTRAINT provider_employment_profiles_post_call_days_check
  CHECK (max_consecutive_post_call_days BETWEEN 0 AND 7);

COMMENT ON COLUMN scheduling.provider_employment_profiles.sick_days_per_year IS
  'Expected sick/personal call-out days per year, used by A7 FTE simulator as the Poisson lambda for same-day call-outs. Default 5 = industry median; override per provider.';

COMMENT ON COLUMN scheduling.provider_employment_profiles.maternity_eligible IS
  'True if this provider is eligible for maternity leave (used by worst-case simulator hold-out of one provider for 12 weeks, PRD §10).';

COMMENT ON COLUMN scheduling.provider_employment_profiles.fmla_eligible IS
  'True if this provider qualifies for FMLA leave, used by Monte Carlo simulator to sample multi-week absences.';

COMMENT ON COLUMN scheduling.provider_employment_profiles.cme_days_per_year IS
  'CME (continuing medical education) days per year. Counted against availability by A7 FTE simulator. Default 5 — typical contract.';

COMMENT ON COLUMN scheduling.provider_employment_profiles.backup_call_share_target IS
  'Fractional FTE share of total backup-call demand this provider should carry. NULL = call burden engine (A8) decides via FTE-weighted greedy. 0..1.';

COMMENT ON COLUMN scheduling.provider_employment_profiles.max_consecutive_post_call_days IS
  'Cap on consecutive post-call rest days when this provider takes back-to-back 24h calls. Default 1 mirrors the standard one-rest-day-per-call rule.';

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- DOWN (manual rollback — run only if patch 15 must be reverted)
-- ============================================================================
--
-- ALTER TABLE scheduling.provider_employment_profiles
--   DROP CONSTRAINT IF EXISTS provider_employment_profiles_sick_days_check,
--   DROP CONSTRAINT IF EXISTS provider_employment_profiles_cme_days_check,
--   DROP CONSTRAINT IF EXISTS provider_employment_profiles_backup_share_check,
--   DROP CONSTRAINT IF EXISTS provider_employment_profiles_post_call_days_check;
--
-- ALTER TABLE scheduling.provider_employment_profiles
--   DROP COLUMN IF EXISTS sick_days_per_year,
--   DROP COLUMN IF EXISTS maternity_eligible,
--   DROP COLUMN IF EXISTS fmla_eligible,
--   DROP COLUMN IF EXISTS cme_days_per_year,
--   DROP COLUMN IF EXISTS backup_call_share_target,
--   DROP COLUMN IF EXISTS max_consecutive_post_call_days;
--
-- NOTIFY pgrst, 'reload schema';
