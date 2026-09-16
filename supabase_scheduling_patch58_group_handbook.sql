-- supabase_scheduling_patch58_group_handbook.sql
--
-- The group handbook: the reference records back office currently keeps in
-- email and spreadsheets — pay rates, committee minutes, the hiring pipeline,
-- who runs what, and the document library.
--
-- PROJECT: apply ONLY to Supabase ref qhwdbtixhzdsgwwtcfrm ("Floor Runner").
-- The `supabase` (atlas-staging) and `supabase-chiefos` servers are OTHER apps.
--
-- STATUS: APPLIED 2026-09-15 to ref qhwdbtixhzdsgwwtcfrm, in two migrations
--         (patch58_group_handbook_tables, patch58_group_handbook_rls).
--         Verified after: 6 tables present, RLS enabled on all 6, restrictive
--         policies on candidates and documents exactly as designed, every
--         table holding 0 rows.
--
-- ORDER: ADDITIVE, so DB FIRST — six new tables nothing references yet, then
-- the code that reads them. There is no window where deployed code queries a
-- table that does not exist.
--
-- ── NOTHING IS SEEDED ──────────────────────────────────────────────────────
-- Every table ships EMPTY. The rates, minutes, candidates and names shown in
-- the design deck are illustrative and are explicitly not to be taken as data
-- (Gabriel 2026-09-15); seeding them would put invented money and invented
-- people in front of staff who would reasonably believe them. The page renders
-- "nothing recorded yet" until somebody enters the real thing.
--
-- ── WHY RATES ARE APPEND-ONLY ──────────────────────────────────────────────
-- pay_rates is a LOG, not a row you edit. A rate change inserts a new row with
-- a new effective_date; the current rate is the latest row on or before today,
-- and the change history is every other row. Editing in place would answer
-- "what is the rate" while destroying "when did it move", which is the half of
-- the question that causes the emails.
--
-- ── WHY THE PIPELINE STORES INITIALS ───────────────────────────────────────
-- candidates.initials, not a name: a hiring pipeline is visible to more people
-- than a candidate's name should be, and somebody's job search reaching their
-- current employer through a staffing dashboard is a real harm. The column is
-- length-capped so a full name cannot be quietly typed into it, and the table
-- carries an admin-only RESTRICTIVE policy on top.

begin;

-- ── 1. Pay rates ───────────────────────────────────────────────────────────

create table if not exists scheduling.pay_rates (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references scheduling.organizations(id) on delete cascade,
  -- Null = group-wide. A site_id narrows a rate to one hospital.
  site_id           uuid references scheduling.sites(id) on delete cascade,
  label             text not null check (length(btrim(label)) between 1 and 120),
  -- CENTS, integer. Money in a float eventually prints $2,399.99.
  amount_cents      bigint not null check (amount_cents >= 0),
  -- What the amount buys: 'call', 'shift', 'day', 'hour', 'weekend'.
  unit              text not null default 'shift'
                      check (unit in ('call', 'shift', 'day', 'hour', 'weekend', 'other')),
  effective_date    date not null,
  notes             text,
  created_at        timestamptz not null default now(),
  created_by        uuid references scheduling.users(id) on delete set null,
  -- One rate per label per start date. A correction to a same-day rate is an
  -- update of that row; a CHANGE is a new row on a new date.
  unique (organization_id, site_id, label, effective_date)
);

comment on table scheduling.pay_rates is
  'Append-only rate log. Current rate = latest effective_date <= today; every other row is the change history. Never edit a past row to change a rate.';

create index if not exists pay_rates_lookup
  on scheduling.pay_rates (organization_id, label, effective_date desc);

-- ── 2. Operating committee ─────────────────────────────────────────────────

create table if not exists scheduling.committee_meetings (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references scheduling.organizations(id) on delete cascade,
  meets_on           date not null,
  meets_at           time,
  location           text,
  agenda_posted_on   date,
  -- 'scheduled' is a future meeting; 'held' happened but minutes are not up;
  -- 'posted' means the minutes are available. The distinction is the whole
  -- reason anyone emails about a meeting.
  minutes_status     text not null default 'scheduled'
                       check (minutes_status in ('scheduled', 'held', 'posted')),
  topics             text,
  minutes_url        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists committee_meetings_when
  on scheduling.committee_meetings (organization_id, meets_on desc);

create table if not exists scheduling.committee_action_items (
  id            uuid primary key default gen_random_uuid(),
  meeting_id    uuid not null references scheduling.committee_meetings(id) on delete cascade,
  description   text not null check (length(btrim(description)) > 0),
  owner_name    text,
  due_on        date,
  status        text not null default 'open' check (status in ('open', 'done', 'dropped')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists committee_action_items_open
  on scheduling.committee_action_items (meeting_id, status);

-- ── 3. Candidate pipeline ──────────────────────────────────────────────────

create table if not exists scheduling.candidates (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references scheduling.organizations(id) on delete cascade,
  -- INITIALS ONLY — see the header. Capped so a full name will not fit.
  initials         text not null check (length(btrim(initials)) between 1 and 8),
  stage            text not null
                     check (stage in ('screened', 'interviewed', 'references',
                                      'contract_sent', 'credentialing', 'start_date_set')),
  /* When the candidate entered the CURRENT stage — what "DAY 62" counts from. */
  stage_on         date not null default current_date,
  home_site_id     uuid references scheduling.sites(id) on delete set null,
  /* A deadline the pipeline should surface on its own: a contract that lapses,
     a reference due. Null when the stage has no clock. */
  expires_on       date,
  note             text,
  status           text not null default 'active'
                     check (status in ('active', 'hired', 'withdrawn')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on column scheduling.candidates.initials is
  'Initials only. A pipeline is visible to more people than a name should be.';

create index if not exists candidates_active
  on scheduling.candidates (organization_id, status, stage);

-- ── 4. Leadership ──────────────────────────────────────────────────────────

create table if not exists scheduling.leadership_roles (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references scheduling.organizations(id) on delete cascade,
  title            text not null check (length(btrim(title)) > 0),
  person_name      text,
  /* Optional link to a provider record, for the people who are both. */
  provider_id      uuid references scheduling.providers(id) on delete set null,
  division         text,
  display_order    integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists leadership_roles_order
  on scheduling.leadership_roles (organization_id, display_order, title);

-- ── 5. Documents ───────────────────────────────────────────────────────────

create table if not exists scheduling.documents (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references scheduling.organizations(id) on delete cascade,
  title            text not null check (length(btrim(title)) > 0),
  category         text,
  /* The version on file. `rolling` marks a document with no single version
     date (credentialing packets), so the UI can say "rolling" instead of
     printing a blank that reads as missing. */
  version_on       date,
  rolling          boolean not null default false,
  access_level     text not null default 'all_staff'
                     check (access_level in ('all_staff', 'partners', 'admin')),
  url              text,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists documents_library
  on scheduling.documents (organization_id, access_level, title);

-- ── updated_at ─────────────────────────────────────────────────────────────

do $$
declare t text;
begin
  foreach t in array array['committee_meetings', 'committee_action_items',
                           'candidates', 'leadership_roles', 'documents']
  loop
    execute format(
      'drop trigger if exists %I_touch on scheduling.%I', t, t);
    execute format(
      'create trigger %I_touch before update on scheduling.%I
         for each row execute function scheduling.set_updated_at()', t, t);
  end loop;
end $$;

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Same shape as the 30 sibling tables: an org-scoped PERMISSIVE policy, plus a
-- RESTRICTIVE narrowing where the contents warrant it. Every route uses the
-- service-role key, which bypasses RLS entirely, so none of this changes
-- behaviour today — it is the guard for the day a client reads directly.

create policy pay_rates_org_scope on scheduling.pay_rates
  for all to public using (organization_id = scheduling.current_user_org_id());
alter table scheduling.pay_rates enable row level security;

create policy committee_meetings_org_scope on scheduling.committee_meetings
  for all to public using (organization_id = scheduling.current_user_org_id());
alter table scheduling.committee_meetings enable row level security;

create policy committee_action_items_org_scope on scheduling.committee_action_items
  for all to public using (exists (
    select 1 from scheduling.committee_meetings m
     where m.id = committee_action_items.meeting_id
       and m.organization_id = scheduling.current_user_org_id()));
alter table scheduling.committee_action_items enable row level security;

-- The pipeline is admin-only on top of the org scope: a RESTRICTIVE policy
-- cannot grant, so both must pass.
create policy candidates_org_scope on scheduling.candidates
  for all to public using (organization_id = scheduling.current_user_org_id());
create policy candidates_admin_only on scheduling.candidates
  as restrictive for all to public using (scheduling.is_admin());
alter table scheduling.candidates enable row level security;

create policy leadership_roles_org_scope on scheduling.leadership_roles
  for all to public using (organization_id = scheduling.current_user_org_id());
alter table scheduling.leadership_roles enable row level security;

-- Document access is per row, as designed: all-staff documents are readable by
-- the org, partner documents by shareholders (is_shareholder on the employment
-- profile) and admins, admin documents by admins alone. One library, two
-- audiences, no second set of files to drift.
create policy documents_org_scope on scheduling.documents
  for all to public using (organization_id = scheduling.current_user_org_id());
create policy documents_access_level on scheduling.documents
  as restrictive for all to public using (
    access_level = 'all_staff'
    or scheduling.is_admin()
    or (access_level = 'partners' and exists (
          select 1 from scheduling.provider_employment_profiles pep
           where pep.provider_id = scheduling.current_provider_id()
             and pep.is_shareholder is true))
  );
alter table scheduling.documents enable row level security;

-- ── Post-conditions ────────────────────────────────────────────────────────

do $$
declare made int; unguarded int;
begin
  select count(*) into made
    from information_schema.tables
   where table_schema = 'scheduling'
     and table_name in ('pay_rates', 'committee_meetings', 'committee_action_items',
                        'candidates', 'leadership_roles', 'documents');
  if made <> 6 then
    raise exception 'expected 6 handbook tables, found %', made;
  end if;

  -- RLS enabled on every one of them. patch51's lesson: a policy on a table
  -- with row security OFF does nothing at all, and counting policies does not
  -- catch it.
  select count(*) into unguarded
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'scheduling'
     and c.relname in ('pay_rates', 'committee_meetings', 'committee_action_items',
                       'candidates', 'leadership_roles', 'documents')
     and c.relrowsecurity is false;
  if unguarded > 0 then
    raise exception '% handbook table(s) have RLS disabled', unguarded;
  end if;
end $$;

commit;
