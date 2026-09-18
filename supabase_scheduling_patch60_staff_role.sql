-- supabase_scheduling_patch60_staff_role.sql
--
-- A third role: back-office STAFF. And invitations that do not require the
-- invitee to be a clinician.
--
-- PROJECT: apply ONLY to Supabase ref for "Floor Runner".
--
-- STATUS: APPLIED 2026-09-18 (as patch60 + patch60b). Verified after: the
--         staff role exists for the organization, provider_id is nullable, the
--         clinician one-pending index survived, and a staff invitation was
--         issued and resolved end to end.
--
-- ORDER: DB FIRST (additive), then the code that reads it.
--
-- ── WHY A THIRD ROLE ───────────────────────────────────────────────────────
-- There were two: `admin` (everything) and `provider` (your own record). A
-- back-office coordinator fits neither. They need to enter staffing demand,
-- maintain provider information, work the schedule and demonstrate the
-- platform — and they must NOT be able to change how schedules are generated
-- or to alter who can sign in.
--
-- Making that person an admin was the alternative, and it is the wrong one:
-- admin can reach every structural surface, and the only account that could
-- undo a mistake is the one the mistake might lock out.
--
-- ── WHY INVITATIONS HAD TO CHANGE ──────────────────────────────────────────
-- `provider_invitations` was built for clinicians: provider_id NOT NULL, the
-- invitee's name read from the provider row, and the acceptance step links the
-- login to that provider. A coordinator is not a clinician. Inventing a
-- provider record for them would put a non-clinician into the roster, the call
-- pool and every staffing count — a data lie told to satisfy a foreign key.
--
-- So provider_id becomes nullable, and a staff invitation carries its own name.
-- The acceptance path skips provider linking when there is no provider.
--
-- ── ONE PENDING INVITATION, STILL ──────────────────────────────────────────
-- The existing partial unique index is on provider_id WHERE status='pending'.
-- NULLs do not collide in a btree unique index, so staff invitations would not
-- be covered by it. A second partial index on the email covers them.

begin;

-- ── 1. The role ────────────────────────────────────────────────────────────
-- Seeded per organization, mirroring how patch48 seeded admin and provider.
insert into scheduling.roles (organization_id, name, description, permissions)
select o.id, 'staff',
       'Back office: enter and maintain operational data, work the schedule, '
       || 'demonstrate the platform. No structural configuration and no user '
       || 'administration.',
       '{}'::jsonb
from scheduling.organizations o
where not exists (
  select 1 from scheduling.roles r
   where r.organization_id = o.id and r.name = 'staff'
);

-- ── 2. Invitations without a clinician ─────────────────────────────────────
-- NOTE (applied as patch60b): the role column carries a CHECK limiting it to
-- admin|provider, which rejected the first staff invitation at the write. The
-- constraint is doing its job — it is why a garbled role cannot widen into
-- admin — so it was widened deliberately rather than dropped, and a second
-- check now requires a staff invitation to name an organization.
alter table scheduling.provider_invitations
  alter column provider_id drop not null;

alter table scheduling.provider_invitations
  add column if not exists invitee_first_name text,
  add column if not exists invitee_last_name  text,
  -- A staff invitation is not tied to a provider, so it needs to know which
  -- organization it is for. Nullable because every existing row derives it
  -- from its provider.
  add column if not exists organization_id uuid
    references scheduling.organizations(id) on delete cascade;

comment on column scheduling.provider_invitations.provider_id is
  'NULL for a back-office staff invitation — the invitee is not a clinician and must not be given a provider record to satisfy a foreign key.';

-- One pending invitation per email among the provider-less ones, matching the
-- guarantee provider_invitations_one_pending gives clinicians.
alter table scheduling.provider_invitations
  drop constraint if exists provider_invitations_role_check;
alter table scheduling.provider_invitations
  add constraint provider_invitations_role_check
  check (role = any (array['admin'::text, 'staff'::text, 'provider'::text]));

alter table scheduling.provider_invitations
  add constraint provider_invitations_staff_needs_org
  check (provider_id is not null or organization_id is not null);

create unique index if not exists provider_invitations_one_pending_staff
  on scheduling.provider_invitations (lower(email))
  where status = 'pending' and provider_id is null;

-- ── Post-conditions ────────────────────────────────────────────────────────
do $$
declare n_roles int; n_orgs int;
begin
  select count(*) into n_orgs from scheduling.organizations;
  select count(*) into n_roles from scheduling.roles where name = 'staff';
  if n_roles <> n_orgs then
    raise exception 'expected one staff role per organization (% orgs, % roles)', n_orgs, n_roles;
  end if;

  if (select is_nullable from information_schema.columns
       where table_schema='scheduling' and table_name='provider_invitations'
         and column_name='provider_id') <> 'YES' then
    raise exception 'provider_invitations.provider_id is still NOT NULL';
  end if;

  -- The clinician guarantee must survive untouched.
  if not exists (
    select 1 from pg_indexes
     where schemaname='scheduling' and indexname='provider_invitations_one_pending'
  ) then
    raise exception 'the clinician one-pending index was lost';
  end if;
end $$;

commit;
