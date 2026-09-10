-- supabase_scheduling_patch49_invitation_role.sql
-- The role an invitation grants when it is redeemed. (Gabriel 2026-09-09.)
--
-- PROJECT: apply ONLY to Supabase ref qhwdbtixhzdsgwwtcfrm ("Floor Runner").
--
-- STATUS: APPLIED 2026-09-09 to ref qhwdbtixhzdsgwwtcfrm. Additive, defaulted,
--         and the table held 0 rows at the time, so nothing was backfilled.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- patch48's acceptance flow always granted 'provider'. That leaves no way to
-- create the FIRST admin without either inserting auth rows by hand or shipping
-- a privileged HTTP endpoint that must be reachable before any admin exists --
-- and such an endpoint then lives in production forever, one misconfiguration
-- away from being the way in.
--
-- Carrying the role on the invitation instead means the bootstrap uses the same
-- code path everyone else does: scripts/bootstrap-admin.ts issues an invitation
-- with role='admin', the chief redeems it, and the account is admin from the
-- moment it exists. No window in which the first chief holds only provider
-- access, and no privileged route.
--
-- It also covers the ordinary case of promoting a partner to admin later.
--
-- ── SAFETY ──────────────────────────────────────────────────────────────────
-- DEFAULT 'provider' plus a CHECK constraint, so an invitation can only ever
-- name one of the two seeded roles. acceptInvitation additionally coerces
-- anything it does not recognise back to 'provider' -- a garbled value must
-- never widen into admin, and the test suite pins that.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────

ALTER TABLE scheduling.provider_invitations
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'provider';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'scheduling.provider_invitations'::regclass
       AND conname = 'provider_invitations_role_check'
  ) THEN
    ALTER TABLE scheduling.provider_invitations
      ADD CONSTRAINT provider_invitations_role_check CHECK (role IN ('admin', 'provider'));
  END IF;
END $$;

COMMENT ON COLUMN scheduling.provider_invitations.role IS
  'Role granted when this invitation is redeemed. Defaults to provider; admin is used to bootstrap the first chief account and to promote a partner later (patch49).';
