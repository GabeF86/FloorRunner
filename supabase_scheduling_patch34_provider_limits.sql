-- patch34: per-provider block limits on schedules (2026-07-22)
--
-- PURPOSE
--   Gabriel's Limits tab on the custom-pool modal: per provider, an expected
--   max of each call type for the block (calls.C1/C2/C3/...), and EITHER an
--   expected working-days count OR an expected days-off count. The generation
--   engine treats these as HARD CEILINGS for auto-generation (manual edits
--   bypass them — same seam as the FTE workdays cap); validation soft-flags
--   assignment sets exceeding a stated cap.
--
-- SHAPE (nullable jsonb, stored AS-ENTERED — a daysOff entry is re-derived
-- against PTO at generation time, never frozen into a converted number):
--   { "<provider_id>": { "calls": { "C1": 2, "C2": 1 },
--                        "workingDays": 15 } }
--   { "<provider_id>": { "daysOff": 4 } }
--   workingDays and daysOff are mutually exclusive per provider; blank/absent
--   fields fall back to the existing FTE-derived workday budget (Gabriel,
--   verbatim and binding). NULL column = no limits anywhere.
--
-- Shape is enforced by the app (hardened PATCH parsing in
-- src/app/api/scheduling/schedules/[id]/route.ts via src/lib/providerLimits.ts);
-- no CHECK constraint so hand repair stays possible.
--
-- ROLLBACK
--   ALTER TABLE scheduling.schedules DROP COLUMN provider_limits;
--
-- Apply via the project-scoped supabase-floorrunner MCP (ref qhwdbtixhzdsgwwtcfrm)
-- after review — verify the ref first (CLAUDE.md Migrations).

ALTER TABLE scheduling.schedules
  ADD COLUMN IF NOT EXISTS provider_limits jsonb;

COMMENT ON COLUMN scheduling.schedules.provider_limits IS
  'Per-provider block limits, keyed by provider_id: { calls?: { <code>: max }, workingDays?: n, daysOff?: n }. Hard ceilings for auto-generation; blank = FTE-derived budget. Shape enforced in-app (src/lib/providerLimits.ts). patch34 2026-07-22.';
