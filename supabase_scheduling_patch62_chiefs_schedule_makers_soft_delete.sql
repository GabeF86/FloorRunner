-- supabase_scheduling_patch62_chiefs_schedule_makers_soft_delete.sql
--
-- Site chiefs, a department chair, the Schedule Maker flag, and soft-deleted
-- schedules.
--
-- PROJECT: apply ONLY to the Supabase project for "Floor Runner".
--
-- STATUS: APPLIED 2026-09-22. Verified after: four chiefs in post (Paoli →
--         Gabriel Farkas, Bryn Mawr → Lisa Luyun, Lankenau → Bilal Ahmad,
--         Riddle → Ernest Ricco), the chair seeded, the four surgery centres
--         correctly vacant, schedule_maker false for all 300 profiles, and
--         deleted_at carrying no default.
--
--         NOTE ON THE SPELLING: Gabriel wrote "Lisa Luyon"; the roster holds
--         "Lisa Luyun" (LUYL, BMH, full-time) and there is no Luyon. Seeded
--         against the roster id, not the spoken spelling.
--
-- ORDER: DB FIRST — every column is additive and either nullable or defaulted,
--        so the running code ignores all of it until the deploy that reads it.
--
-- ── WHY THE CHIEF LIVES ON THE SITE, NOT ON THE PROVIDER ───────────────────
-- "Site Chief is one per site" (Gabriel 2026-09-22). A boolean on the provider
-- cannot say that: two rows could both be flagged for Paoli and the database
-- would be perfectly happy. A single column on `sites` can hold exactly one
-- value, so the rule is structural rather than a thing the UI has to remember
-- to enforce. The same argument puts the department chair on `organizations`.
--
-- Deliberately NOT a row in `roles`. A chief is a person holding a post at a
-- hospital, not a login tier — they may or may not have an account, and the
-- three roles (admin / staff / provider) already describe what a session may
-- reach. Modelling the post as a role would force every chief to hold one, and
-- would make "who runs Paoli" unanswerable when they do not.
--
-- ── WHY SCHEDULE MAKER IS A FLAG AND NOT A POST ────────────────────────────
-- "Schedule maker ... can be anyone" — it is a job handed out by an admin or a
-- site chief, and several people can hold it at once. That is a boolean on the
-- employment profile, which is also where Gabriel asked for the checkbox.
--
-- It is deliberately NOT site-scoped today. If it later needs to be ("a Paoli
-- schedule maker may not touch Riddle") that is a join table, not a widened
-- column — and this comment is here so the next person does not try to encode
-- a second site into a boolean.
--
-- ── WHY DELETE IS A TIMESTAMP, AND WHAT IT DOES *NOT* DO ───────────────────
-- Deleting a schedule hides it; it never removes rows. Assignments, slots and
-- versions all hang off `schedules`, and a real DELETE would take a published
-- block of somebody's working life with it.
--
-- IMPORTANT, AND DELIBERATE: this flag governs DISPLAY ONLY. It does not
-- change what counts as a committed booking for clinical invariant 3. A
-- deleted-but-recoverable published schedule still blocks cross-site
-- double-booking, because the alternative is that hiding a schedule silently
-- frees up a doctor who is, as far as anybody knows, still working that day.
-- Under-blocking is a patient-safety failure; over-blocking is an
-- inconvenience. If that trade is ever revisited it must be a deliberate
-- change to filterPublishedVersions (the single home of that predicate), not a
-- side effect of a delete button.

begin;

-- ── 1. Site chief — one per site ───────────────────────────────────────────
alter table scheduling.sites
  add column if not exists chief_provider_id uuid
    references scheduling.providers(id) on delete set null;

comment on column scheduling.sites.chief_provider_id is
  'The site chief. ONE per site — enforced by this being a single column, not '
  'a flag on providers. ON DELETE SET NULL: removing a provider vacates the '
  'post rather than deleting the hospital.';

create index if not exists sites_chief_provider_idx
  on scheduling.sites (chief_provider_id) where chief_provider_id is not null;

-- ── 2. Department chair — one per organization ─────────────────────────────
alter table scheduling.organizations
  add column if not exists chair_provider_id uuid
    references scheduling.providers(id) on delete set null;

comment on column scheduling.organizations.chair_provider_id is
  'Chairman of the Department of Anesthesia. One per organization, for the '
  'same structural reason as sites.chief_provider_id.';

-- ── 3. Schedule Maker ──────────────────────────────────────────────────────
alter table scheduling.provider_employment_profiles
  add column if not exists schedule_maker boolean not null default false;

comment on column scheduling.provider_employment_profiles.schedule_maker is
  'May build and edit draft schedules, and delete schedules. Assigned by an '
  'admin or a site chief; can be anyone. NOT site-scoped — see patch62 header '
  'before adding a second site to this.';

-- ── 4. Soft delete on schedules ────────────────────────────────────────────
alter table scheduling.schedules
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid;

comment on column scheduling.schedules.deleted_at is
  'Hidden from every list and view when set. Rows are NEVER removed — an '
  'admin can restore. DISPLAY ONLY: a deleted published schedule still counts '
  'as a committed booking for cross-site conflict checking (invariant 3).';

-- Partial index: every list query filters `deleted_at is null`, and the live
-- rows are almost all of them.
create index if not exists schedules_live_idx
  on scheduling.schedules (organization_id, site_id) where deleted_at is null;

-- ── 5. Seed the posts Gabriel named (2026-09-22) ───────────────────────────
-- Matched on the exact provider ids looked up before writing this patch, so a
-- later namesake cannot silently inherit a chiefdom. Each is guarded: if the
-- id is not present the update simply affects nothing, and the post-condition
-- below reports the shortfall rather than the patch claiming success.
update scheduling.sites s set chief_provider_id = v.pid
  from (values
    ('2ddd2427-22fb-4290-9c4c-03a957e5af4e'::uuid, '3a6f7647-9867-4b11-8529-bcd76426e04f'::uuid), -- Paoli    → Gabriel Farkas
    ('0e9ea24d-0bec-4100-a44e-e68bda69b4df'::uuid, '8466c4f0-ea8a-4696-86a7-21b3398ac421'::uuid), -- Bryn Mawr→ Lisa Luyun
    ('008774e9-f588-4c15-a8aa-1da4e7191809'::uuid, '35ce407e-9876-404f-ae8f-9828e2eb5963'::uuid), -- Lankenau → Bilal Ahmad
    ('907b2b90-47dc-49e7-96ea-ecfad4aad388'::uuid, 'b80c0371-4435-4789-a8c0-65d832fce27d'::uuid)  -- Riddle   → Ernest Ricco
  ) as v(site_id, pid)
 where s.id = v.site_id;

update scheduling.organizations
   set chair_provider_id = '18598d26-4298-46bd-a65e-cd1de806ee98'  -- Nina Kalawadia
 where chair_provider_id is null;

-- ── Post-conditions ────────────────────────────────────────────────────────
do $$
declare n_chiefs int; n_chair int;
begin
  select count(*) into n_chiefs from scheduling.sites where chief_provider_id is not null;
  if n_chiefs <> 4 then
    raise exception 'expected 4 site chiefs seeded, found %', n_chiefs;
  end if;

  select count(*) into n_chair from scheduling.organizations where chair_provider_id is not null;
  if n_chair < 1 then
    raise exception 'department chair was not seeded';
  end if;

  -- A chief must be an ACTIVE provider. A vacated or archived record holding a
  -- hospital is the failure this check exists to catch.
  if exists (
    select 1 from scheduling.sites s
      join scheduling.providers p on p.id = s.chief_provider_id
     where p.status <> 'active'
  ) then
    raise exception 'a site chief points at a non-active provider';
  end if;

  -- schedule_maker must not have been handed out by the default.
  if (select count(*) from scheduling.provider_employment_profiles
       where schedule_maker) <> 0 then
    raise exception 'schedule_maker defaulted to true somewhere — it must start false for everyone';
  end if;

  if (select column_default from information_schema.columns
       where table_schema='scheduling' and table_name='schedules'
         and column_name='deleted_at') is not null then
    raise exception 'schedules.deleted_at must have no default — NULL means live';
  end if;
end $$;

commit;
