-- supabase_scheduling_patch48_provider_auth.sql
-- Provider authentication, part 1 of 2: the schema.
-- (Gabriel 2026-09-09. Spec: docs/superpowers/specs/2026-09-09-provider-auth-design.md)
--
-- PROJECT: apply ONLY to Supabase ref qhwdbtixhzdsgwwtcfrm ("Floor Runner").
--
-- STATUS: APPLIED 2026-09-09 to ref qhwdbtixhzdsgwwtcfrm. All in-transaction
--         assertions passed. Verified after:
--           RESTRICTIVE policies  11   (providers + 9 provider_id tables + notifications)
--           PERMISSIVE policies   28   (UNCHANGED -- the fail-open guard)
--           roles                  4   (admin + provider, x2 organizations)
--           provider_invitations   exists, 0 rows
--           providers             83   (untouched)
--         The app is unaffected: every route still uses the service-role key,
--         which bypasses RLS, so these policies are inert until the middleware
--         ships. That is the intended state at this step.
--
-- ── WHAT THIS DOES ──────────────────────────────────────────────────────────
--   1. scheduling.provider_invitations — the chief-issues-an-invite table
--   2. scheduling.current_provider_id() / is_admin() — session helpers
--   3. seed the 'admin' and 'provider' roles for every organization
--   4. RESTRICTIVE person-scoped policies on every table holding one
--      provider's private data
--
-- ── THIS PATCH CHANGES NOTHING TODAY, ON PURPOSE ────────────────────────────
-- Every API route currently uses the service-role key, which bypasses RLS
-- entirely. So the policies below are inert until the middleware ships and
-- sessions start reaching the database. That is the point: schema first,
-- verify the admin account can authenticate, and only then start denying.
-- See the spec's sequencing section — RLS with zero users locks everyone out.
--
-- ── WHY *RESTRICTIVE*, AND WHY THIS IS THE WHOLE BALLGAME ───────────────────
-- All 28 pre-existing policies are PERMISSIVE (verified 2026-09-09), and
-- PostgreSQL ORs permissive policies together. Adding a permissive
-- "provider_id = current_provider_id()" policy would therefore have WIDENED
-- access, not narrowed it: the existing org-wide policy would still have
-- matched on its own and every physician would still have read every
-- colleague's compensation. It would have looked exactly like a fix.
--
-- RESTRICTIVE policies AND with the permissive set. So the effective rule
-- becomes (org matches) AND (is admin OR row is mine), which is what the
-- design actually calls for.
--
-- ── THE BOUNDARY THIS DRAWS ─────────────────────────────────────────────────
-- A provider session can read ITS OWN rows and nothing else -- including its
-- own `providers` row. Anything a provider legitimately needs to know about a
-- COLLEAGUE (who is on call Saturday) is served by the /api/scheduling/me/*
-- routes, which run server-side with the service key and select explicit
-- columns. That is deliberate: NEXT_PUBLIC_SUPABASE_ANON_KEY is public by
-- design, so a logged-in physician can query PostgREST directly from a
-- browser. Anything readable at the table level is readable by them, whatever
-- the app's UI shows. Locking the tables and letting the server decide what to
-- share is the only boundary that holds. It also keeps `providers.
-- notes_admin_only` out of reach, which no row-level policy could do.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- Every object uses IF NOT EXISTS or DROP-then-CREATE. Safe to re-run.

BEGIN;

-- ── 1. Invitations ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scheduling.provider_invitations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id      uuid NOT NULL REFERENCES scheduling.providers(id) ON DELETE CASCADE,
  email            text NOT NULL,
  -- SHA-256 of the token, hex. The token itself exists only in the emailed
  -- link: a database read -- a backup, a dump, a curious query -- yields
  -- nothing usable.
  token_hash       text NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'accepted', 'revoked')),
  invited_by       uuid REFERENCES scheduling.users(id) ON DELETE SET NULL,
  accepted_at      timestamptz,
  accepted_user_id uuid REFERENCES scheduling.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- At most ONE live invitation per provider, so "invite again" can never leave
-- two valid tokens in circulation. Re-inviting must revoke first.
CREATE UNIQUE INDEX IF NOT EXISTS provider_invitations_one_pending
  ON scheduling.provider_invitations (provider_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS provider_invitations_provider
  ON scheduling.provider_invitations (provider_id);

ALTER TABLE scheduling.provider_invitations ENABLE ROW LEVEL SECURITY;

-- No policy is created for this table, which means NO session can read or
-- write it -- not even an admin's. Invitations are handled exclusively by
-- server routes holding the service key. There is no reason for a browser to
-- ever see a token hash, and the acceptance endpoint must be reachable by
-- someone who has no session at all.

-- ── 2. Session helpers ─────────────────────────────────────────────────────

-- The provider this login IS, or NULL for a login not bound to one (an admin
-- who is not a physician, or a half-provisioned account).
CREATE OR REPLACE FUNCTION scheduling.current_provider_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = scheduling, public
AS $$
  SELECT id FROM scheduling.providers WHERE linked_user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION scheduling.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = scheduling, public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM scheduling.user_roles ur
      JOIN scheduling.roles r ON r.id = ur.role_id
     WHERE ur.user_id = auth.uid()
       AND r.name = 'admin'
  )
$$;

COMMENT ON FUNCTION scheduling.current_provider_id() IS
  'The provider row this session is bound to, via providers.linked_user_id. NULL when unbound (patch48).';
COMMENT ON FUNCTION scheduling.is_admin() IS
  'True when the session holds the admin role. Used by the RESTRICTIVE person-scoped policies (patch48).';

-- ── 3. Seed roles ──────────────────────────────────────────────────────────
-- Two roles. A third (a scheduler who is not a physician) is a real future
-- case but nothing needs it yet, so it is not created.

INSERT INTO scheduling.roles (organization_id, name, description, permissions)
SELECT o.id, 'admin', 'Full access: schedule generation, all provider records, compensation.', '{}'::jsonb
  FROM scheduling.organizations o
 WHERE NOT EXISTS (
   SELECT 1 FROM scheduling.roles r WHERE r.organization_id = o.id AND r.name = 'admin'
 );

INSERT INTO scheduling.roles (organization_id, name, description, permissions)
SELECT o.id, 'provider', 'A physician: their own profile, schedule and requests only.', '{}'::jsonb
  FROM scheduling.organizations o
 WHERE NOT EXISTS (
   SELECT 1 FROM scheduling.roles r WHERE r.organization_id = o.id AND r.name = 'provider'
 );

-- ── 4. RESTRICTIVE person-scoped policies ──────────────────────────────────
-- Read the header before touching these. PERMISSIVE would fail open.
--
-- Each is `is_admin() OR <this row is mine>`. They AND with the existing
-- org-scoped permissive policies, so a provider must satisfy BOTH.

-- providers: a provider sees only their own row. Colleague names reach the UI
-- through /api/scheduling/me/*, server-side, explicit columns.
DROP POLICY IF EXISTS providers_person_scope ON scheduling.providers;
CREATE POLICY providers_person_scope ON scheduling.providers
  AS RESTRICTIVE FOR ALL TO public
  USING (scheduling.is_admin() OR id = scheduling.current_provider_id())
  WITH CHECK (scheduling.is_admin() OR id = scheduling.current_provider_id());

-- Tables keyed directly by provider_id.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'provider_employment_profiles',
    'provider_compensation',
    'provider_custom_field_values',
    'provider_availability',
    'provider_requests',
    'provider_site_credentials',
    'burden_targets',
    'burden_actuals',
    'assignments'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON scheduling.%I', t || '_person_scope', t);
    EXECUTE format($f$
      CREATE POLICY %I ON scheduling.%I
        AS RESTRICTIVE FOR ALL TO public
        USING (scheduling.is_admin() OR provider_id = scheduling.current_provider_id())
        WITH CHECK (scheduling.is_admin() OR provider_id = scheduling.current_provider_id())
    $f$, t || '_person_scope', t);
  END LOOP;
END $$;

-- notifications carries BOTH user_id and provider_id; either identifies the
-- owner, so either grants.
DROP POLICY IF EXISTS notifications_person_scope ON scheduling.notifications;
CREATE POLICY notifications_person_scope ON scheduling.notifications
  AS RESTRICTIVE FOR ALL TO public
  USING (
    scheduling.is_admin()
    OR user_id = auth.uid()
    OR provider_id = scheduling.current_provider_id()
  )
  WITH CHECK (
    scheduling.is_admin()
    OR user_id = auth.uid()
    OR provider_id = scheduling.current_provider_id()
  );

-- ── Assertions ─────────────────────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  -- 11 restrictive policies: providers + 9 provider_id tables + notifications.
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'scheduling' AND permissive = 'RESTRICTIVE';
  IF n <> 11 THEN
    RAISE EXCEPTION 'patch48: expected 11 RESTRICTIVE policies, found % — aborting', n;
  END IF;

  -- Nothing may have been added as PERMISSIVE: that is the fail-open shape.
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'scheduling' AND permissive = 'PERMISSIVE';
  IF n <> 28 THEN
    RAISE EXCEPTION 'patch48: permissive policy count moved from 28 to % — a person-scoped policy was created PERMISSIVE and would fail OPEN. Aborting', n;
  END IF;

  -- Both roles exist for both organizations.
  SELECT count(*) INTO n FROM scheduling.roles WHERE name IN ('admin', 'provider');
  IF n <> (SELECT count(*) * 2 FROM scheduling.organizations) THEN
    RAISE EXCEPTION 'patch48: expected 2 roles per organization, found % — aborting', n;
  END IF;

  -- The helpers resolve. Under the service role auth.uid() is NULL, so both
  -- must return "nothing/false" rather than error.
  IF scheduling.current_provider_id() IS NOT NULL THEN
    RAISE EXCEPTION 'patch48: current_provider_id() returned a row for a NULL auth.uid() — aborting';
  END IF;
  IF scheduling.is_admin() THEN
    RAISE EXCEPTION 'patch48: is_admin() returned true for a NULL auth.uid() — aborting';
  END IF;
END $$;

COMMIT;
