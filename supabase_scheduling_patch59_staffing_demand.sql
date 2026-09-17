-- supabase_scheduling_patch59_staffing_demand.sql
--
-- How many anaesthetists a site NEEDS on a day — as a fact in its own right,
-- separate from how many the schedule happens to contain.
--
-- PROJECT: apply ONLY to Supabase ref qhwdbtixhzdsgwwtcfrm ("Floor Runner").
--
-- STATUS: APPLIED 2026-09-17 to ref qhwdbtixhzdsgwwtcfrm. Verified after:
--         table present, RLS enabled, org-scope policy in place, and a
--         round-trip through the API (PUT 12 MD / 6 CRNA for Paoli 09/14 read
--         back on the board as "MD 10/12 · CRNA 0/6 — 8 short").
--
-- ORDER: ADDITIVE, so DB FIRST — one new table nothing references yet, then
-- the code that reads it.
--
-- ── WHY THIS TABLE HAS TO EXIST ────────────────────────────────────────────
-- The staffing board's "needed" column was the slot census: it counted the
-- positions the published schedule already contained. That can only ever say
-- "the schedule matches the schedule". A block built two rooms light reads as
-- fully covered, because the missing rooms were never slots to begin with.
--
-- Demand is a different fact from supply and belongs in its own row. It comes
-- from the OR schedule — how many anaesthetising sites are actually running —
-- and today a scheduler reads that out of Epic and counts. Later the staffing
-- calculator will derive it.
--
-- ── MANUAL BEATS CALCULATED, AND BOTH ARE KEPT ─────────────────────────────
-- `source` is part of the unique key, so one manual row and one calculated row
-- can coexist for the same site and day. The reader prefers manual. That is
-- the precedence Gabriel asked for, and keeping both means a manual override
-- can be compared against what the calculator would have said instead of
-- destroying it — which is how you ever find out the calculator is wrong.
--
-- ── A MISSING ROW IS NOT ZERO ──────────────────────────────────────────────
-- No row means nobody has said what that day needs, and the board renders it
-- N/A. Defaulting to 0 would paint an uncounted day green and report an
-- unstaffed hospital as fully covered — the exact failure this table exists to
-- prevent. Hence NO default on the count columns and a NULL-permitting shape:
-- a row may state MD only, CRNA only, or both.

begin;

create table if not exists scheduling.staffing_demand (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references scheduling.organizations(id) on delete cascade,
  site_id          uuid not null references scheduling.sites(id) on delete cascade,
  demand_date      date not null,

  -- Null means "not stated", never zero. A site that genuinely needs no
  -- physicians that day is a 0, and the two must stay distinguishable.
  md_needed        integer check (md_needed is null or md_needed >= 0),
  crna_needed      integer check (crna_needed is null or crna_needed >= 0),

  -- 'manual'     — a scheduler counted the OR schedule.
  -- 'calculated' — the staffing calculator derived it (not yet built).
  source           text not null default 'manual'
                     check (source in ('manual', 'calculated')),

  notes            text,
  entered_by       uuid references scheduling.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- One row per source per site-day. Re-entering a day UPDATES it rather than
  -- stacking a second opinion nobody can choose between.
  unique (site_id, demand_date, source)
);

comment on table scheduling.staffing_demand is
  'How many MDs and CRNAs a site needs on a date. Manual rows are entered by a scheduler from the OR schedule; calculated rows will come from the staffing calculator. A reader prefers manual over calculated, and treats a missing row as "not stated" — never as zero.';

comment on column scheduling.staffing_demand.md_needed is
  'Null = not stated. Zero = genuinely no physician needed. Keep the two apart.';

create index if not exists staffing_demand_lookup
  on scheduling.staffing_demand (site_id, demand_date);

create index if not exists staffing_demand_window
  on scheduling.staffing_demand (organization_id, demand_date);

drop trigger if exists staffing_demand_touch on scheduling.staffing_demand;
create trigger staffing_demand_touch before update on scheduling.staffing_demand
  for each row execute function scheduling.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────────────────────
-- The org-scoped permissive shape every sibling table uses. Every route runs
-- on the service-role key, which bypasses RLS, so this changes no behaviour
-- today — it is the guard for the day a client reads directly.
create policy staffing_demand_org_scope on scheduling.staffing_demand
  for all to public using (organization_id = scheduling.current_user_org_id());
alter table scheduling.staffing_demand enable row level security;

do $$
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'scheduling' and table_name = 'staffing_demand'
  ) then
    raise exception 'staffing_demand was not created';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'scheduling' and c.relname = 'staffing_demand'
       and c.relrowsecurity is true
  ) then
    raise exception 'staffing_demand has RLS disabled';
  end if;
end $$;

commit;
