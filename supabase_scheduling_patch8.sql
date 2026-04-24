-- Patch 8: Drop neuro_eligible from provider_employment_profiles
--
-- The field is no longer used: any active call-taker with site credentials
-- is considered eligible for C3 (neuro) call. The UI toggle and the
-- autoGenerate.ts C3 gating have been removed. The column is now dead data.

ALTER TABLE scheduling.provider_employment_profiles
  DROP COLUMN IF EXISTS neuro_eligible;
