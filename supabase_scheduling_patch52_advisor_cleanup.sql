-- patch52 — close two open public tables, drop duplicate indexes, pin search_path
--
-- Source: the Supabase advisors on project qhwdbtixhzdsgwwtcfrm, read 2026-09-15.
-- Everything here is either a security ERROR or free; nothing changes app behaviour.
--
-- ── What this patch deliberately does NOT do ────────────────────────────────
-- The performance advisor reports 42 unindexed foreign keys. They are not worth
-- indexing here, and adding them would make the database slower, not faster.
-- Measured row counts on the live project today:
--
--     schedule_slots 1,225   assignments 1,225   providers 288
--     employment_profiles 288   availability 107   rooms 28
--     rule_sets 3   user_roles 1   notifications 0   audit_log 0
--
-- At those sizes Postgres seq-scans in well under a millisecond and the planner
-- will decline an index anyway, while every index still has to be maintained on
-- write — and assignments is fully rewritten on each schedule generation. The
-- advisor's advice is sound for tables at scale; these are not those tables. If
-- a table crosses roughly 10k rows, revisit with EXPLAIN on the actual query
-- rather than indexing the FK list wholesale.
--
-- The 5 "unused index" findings are left alone for the same reason in reverse:
-- unused today mostly means the feature is new (notifications has 0 rows), and
-- dropping an index that a not-yet-exercised code path needs is a worse trade
-- than the few kB it costs.

begin;

-- ── 1. Two public tables were readable by anyone with the anon key ──────────
-- Advisor level ERROR (rls_disabled_in_public). Both sit in `public`, which is
-- exposed to PostgREST, with RLS never enabled — so the anon key that ships to
-- every browser could read them. `_floorrunner_bak_20260729_b8d6446c` holds 654
-- rows of real assignment history (provider_id, slot_date, notes) left over
-- from the July org merge; that is staff PII on an internet-facing endpoint.
--
-- Enabling RLS with no policy is a deny-all, which is what both tables should
-- be: the app reaches them through the service-role key, and service_role
-- bypasses RLS entirely. So this closes the hole with no code change.
--
-- The backup table is left in place rather than dropped — it is someone's
-- safety net and deleting it is Gabriel's call, not this patch's.
alter table public._floorrunner_bak_20260729_b8d6446c enable row level security;
alter table public.board_assistant_actions              enable row level security;

-- ── 2. Duplicate indexes ───────────────────────────────────────────────────
-- Advisor level WARN, and confirmed byte-identical by pg_indexes.indexdef —
-- not merely similar:
--   assignments_provider_status_idx == idx_assignments_provider
--       both: btree (provider_id, assignment_status)
--   idx_availability_provider == provider_availability_pid_dates_idx
--       both: btree (provider_id, start_date, end_date)
-- Pure waste: double the write cost on two tables the engine rewrites often,
-- for a planner that can only ever use one of each pair. The older-named
-- (idx_*) copy is kept in each case since it matches the prevailing convention.
drop index if exists scheduling.assignments_provider_status_idx;
drop index if exists scheduling.provider_availability_pid_dates_idx;

-- ── 3. Mutable search_path on SECURITY DEFINER ─────────────────────────────
-- Advisor level WARN (function_search_path_mutable). This one matters for
-- `current_user_org_id`, which is SECURITY DEFINER *and* is called from RLS
-- policies: without a pinned search_path, a caller who can create objects in a
-- schema earlier on their own search_path can shadow what the function body
-- resolves and have it run as the definer. The other four are not SECURITY
-- DEFINER, so they are hardening rather than a fix, but the setting costs
-- nothing and keeps the advisor quiet enough to notice the next real finding.
alter function scheduling.current_user_org_id()                        set search_path = scheduling, public, pg_temp;
alter function scheduling.set_updated_at()                             set search_path = scheduling, public, pg_temp;
alter function scheduling.touch_updated_at()                           set search_path = scheduling, public, pg_temp;
alter function scheduling.historical_call_counts(uuid, date)           set search_path = scheduling, public, pg_temp;
alter function scheduling.schedule_last_activity(uuid[])               set search_path = scheduling, public, pg_temp;

-- ── 4. Per-row re-evaluation in the notifications policy ───────────────────
-- Advisor level WARN (auth_rls_initplan). auth.uid() and the two helper
-- functions were being called once per row instead of once per query; wrapping
-- each in a scalar subquery lets the planner hoist it to an InitPlan.
--
-- notifications is empty today so this buys nothing yet — it is here because
-- the policy is about to matter, and because the rewrite is the risky part:
-- the policy is RESTRICTIVE, and a restrictive policy recreated as permissive
-- would silently invert from "must also satisfy" to "additionally allows",
-- widening access instead of narrowing it. AS RESTRICTIVE below is load-bearing
-- and must not be dropped. The predicate itself is unchanged, character for
-- character, apart from the three (select …) wrappers.
drop policy if exists notifications_person_scope on scheduling.notifications;
create policy notifications_person_scope on scheduling.notifications
  as restrictive
  for all
  using (
    (select scheduling.is_admin())
    or (user_id = (select auth.uid()))
    or (provider_id = (select scheduling.current_provider_id()))
  )
  with check (
    (select scheduling.is_admin())
    or (user_id = (select auth.uid()))
    or (provider_id = (select scheduling.current_provider_id()))
  );

commit;

-- ── Left for Gabriel, not fixable in SQL ───────────────────────────────────
-- * Leaked-password protection is OFF (advisor WARN). It checks new passwords
--   against HaveIBeenPwned. Providers are about to set their own passwords via
--   the invitation flow, so this is worth turning on: Supabase dashboard →
--   Authentication → Policies → "Prevent use of leaked passwords".
-- * Auth is capped at 10 absolute DB connections rather than a percentage, so
--   resizing the instance would not help the auth server. Same dashboard.
-- * `scheduling.assistant_actions`, `call_patterns` and `provider_invitations`
--   have RLS on with no policies (advisor INFO). That is deny-all, which is
--   correct for service-role-only tables — no action needed, noted so the next
--   reader does not "fix" it by adding a permissive policy.
