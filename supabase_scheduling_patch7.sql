-- Patch 7: Provider compensation + admin-only custom-field flag
--
-- Two changes bundled together because both are part of the same feature set
-- ("admin-only data on the provider profile"):
--
--   1. A new `provider_compensation` table holding current-snapshot comp data
--      (base salary, stipends, bonuses, benefits costs). Kept out of the main
--      `providers` table so a future RLS policy can gate it with a single
--      rule: "only members of the admin role can read/write this table".
--
--   2. An `admin_only` column on `provider_custom_field_definitions` so
--      organizations can define additional admin-only fields without code
--      changes.
--
-- Both pieces are currently unenforced at the DB level — the app is still
-- running under the service-role key — but the schema is now in place so
-- that when auth + RLS land, these are the two surfaces that need policies.

-- ── 1. Provider Compensation Table ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduling.provider_compensation (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id                    uuid NOT NULL UNIQUE REFERENCES scheduling.providers(id) ON DELETE CASCADE,
  base_salary                    numeric(12,2),
  fellowship_stipend             numeric(12,2),
  admin_stipend                  numeric(12,2),
  retention_bonus                numeric(12,2),
  retention_bonus_end_date       date,
  health_insurance_cost          numeric(12,2),
  malpractice_cost               numeric(12,2),
  retirement_401k_contribution   numeric(12,2),
  profit_share                   numeric(12,2),
  notes                          text,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE scheduling.provider_compensation IS
  'Current-snapshot compensation data per provider. One row per provider (UNIQUE). Sensitive — gate with RLS once auth is wired up.';

-- Reuse the existing updated_at trigger helper if present; otherwise create
-- it locally so this patch is self-contained.
CREATE OR REPLACE FUNCTION scheduling.touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS provider_compensation_touch_updated_at ON scheduling.provider_compensation;
CREATE TRIGGER provider_compensation_touch_updated_at
  BEFORE UPDATE ON scheduling.provider_compensation
  FOR EACH ROW EXECUTE FUNCTION scheduling.touch_updated_at();

-- ── 2. Admin-Only Flag on Custom Field Definitions ─────────────────────────
ALTER TABLE scheduling.provider_custom_field_definitions
  ADD COLUMN IF NOT EXISTS admin_only boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN scheduling.provider_custom_field_definitions.admin_only IS
  'When true, only admins should see/edit this field. Enforced in-app today; will be enforced by RLS once auth is wired up.';
