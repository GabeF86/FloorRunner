-- supabase_scheduling_patch61_per_diem_shift_minimum.sql
--
-- A per diem's contracted minimum shifts per month.
--
-- PROJECT: apply ONLY to the Supabase project for "Floor Runner".
--
-- STATUS: APPLIED 2026-09-18. Verified after: the column exists as a nullable
--         integer with the >= 0 check and the comment below, no row carries a
--         value yet (nobody's minimum has been entered), and the staffing
--         board renders "n/mo of N" once one is set.
--
-- ORDER: DB FIRST — additive and nullable, so the running code ignores it
--        until the deploy that reads it lands.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
-- The per diem bench answered one question: who is free today. It could not
-- answer the slower and more expensive one — who is barely working at all. A
-- per diem carrying a contracted minimum who quietly runs under it is a
-- problem discovered at review time, months after it could have been fixed by
-- offering them a shift.
--
-- ── WHY NULL IS NOT ZERO ───────────────────────────────────────────────────
-- NULL means nobody has stated a minimum for this person, and they are never
-- flagged. 0 means a minimum was stated and it is none.
--
-- The distinction has to survive in the column itself, because the day someone
-- backfills this table in bulk it is the only thing standing between "we have
-- not asked" and "they owe nothing" — and a DEFAULT 0 would erase it silently,
-- converting 135 unknowns into 135 confident zeroes. Hence no default.
--
-- ── WHY IT LIVES ON THE EMPLOYMENT PROFILE ─────────────────────────────────
-- It is a term of employment, beside employment_status and fte. It is written
-- only while employment_status = 'per_diem', and the form clears it when
-- somebody is moved off per diem, so a promotion to part-time does not leave a
-- stale obligation behind to be flagged against forever.
--
-- ── WHAT THE READER MUST NOT ASSUME ────────────────────────────────────────
-- This column is one half of a comparison; the other half is shifts worked per
-- month, and that average is only as honest as the schedule history behind it.
-- FloorRunner holds published schedules from Sep 2026, so the average is taken
-- over the data window (see monthsWorkedThisYear in src/lib/operationsBoard.ts)
-- and nobody is judged on under a month of it. Dividing a real shift count by
-- the whole elapsed year would flag the entire bench and measure our data gap
-- rather than anyone's work.

begin;

alter table scheduling.provider_employment_profiles
  add column if not exists min_monthly_shifts integer;

alter table scheduling.provider_employment_profiles
  drop constraint if exists provider_employment_profiles_min_monthly_shifts_check;
alter table scheduling.provider_employment_profiles
  add constraint provider_employment_profiles_min_monthly_shifts_check
  check (min_monthly_shifts is null or min_monthly_shifts >= 0);

comment on column scheduling.provider_employment_profiles.min_monthly_shifts is
  'Per-diem contracted minimum shifts per month. NULL = no minimum stated '
  '(never flagged); 0 = explicitly none required. Compared against shifts '
  'worked per month YTD.';

-- ── Post-conditions ────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema='scheduling'
       and table_name='provider_employment_profiles'
       and column_name='min_monthly_shifts'
       and data_type='integer'
       and is_nullable='YES'
  ) then
    raise exception 'min_monthly_shifts is missing, not an integer, or NOT NULL';
  end if;

  -- A default would turn "not stated" into "owes nothing" for every existing
  -- row, which is the one outcome this column exists to prevent.
  if (select column_default from information_schema.columns
       where table_schema='scheduling'
         and table_name='provider_employment_profiles'
         and column_name='min_monthly_shifts') is not null then
    raise exception 'min_monthly_shifts must have no default — NULL means not stated';
  end if;
end $$;

commit;
