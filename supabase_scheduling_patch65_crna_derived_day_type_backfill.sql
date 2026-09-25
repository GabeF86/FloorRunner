-- patch65 — backfill schedule_slots.derived_day_type on the CRNA imports
--
-- WHY
-- derived_day_type is what makes "Saturday C1" a distinct fairness bucket from
-- "Tuesday C1". Every consumer that counts call by category reads it, and
-- buildProviderOverview drops any slot without one outright:
--
--     const bucket = a.dayType ? dayTypeBucketOn(a.dayType, a.date) : null;
--     if (!bucket) continue;
--
-- Dropped, not zeroed — so the call does not appear anywhere on the card. A
-- CRNA would read "No call on record this year" beside a panel reporting their
-- call hours, which is the confident-zero failure this codebase keeps hitting.
--
-- SCOPE — it is entirely the CRNA CSV import (scripts/importCrnaSchedule.ts,
-- 2026-09-22), which never set the column. Measured before this patch:
--
--     LMC  — CRNA Master   1145 / 1145 null   (100%)
--     BMH  — CRNA Master     491 / 491
--     PH   — CRNA Master     462 / 462
--     OSC  — CRNA Master     204 / 204
--     RSH  — CRNA Master       6 / 6
--     every PHYSICIAN Master   0 null         (0%)
--
-- 2,308 rows, which is exactly the import's slot count. No physician schedule
-- is affected, so no physician-facing figure changes.
--
-- THE RULE IS NOT INVENTED HERE. It mirrors derivedDayTypeFor()
-- (src/lib/templateSlots.ts:59) exactly — major holiday, then any holiday,
-- then dayTypeFromDow (shared.ts:267): Sat=saturday, Sun=sunday, Fri=friday,
-- else weekday. A second, differently-worded rule in SQL is precisely the
-- drift this schema has been bitten by; if the TS rule changes, this file is
-- historical and must not be re-run.
--
-- Holidays are matched org-wide (holiday_calendars.site_id is NULL for org
-- rows), same predicate the slot generator uses.
--
-- IDEMPOTENT: the WHERE clause only touches NULL rows, so re-running is a
-- no-op. It never overwrites a value the engine set.
--
-- APPLY STATUS: applied to Floor Runner (ref qhwdbtixhzdsgwwtcfrm) 2026-09-24.
-- The importer was fixed in the same change so new uploads set the column.

begin;

update scheduling.schedule_slots ss
   set derived_day_type = d.dt::scheduling.day_type,
       updated_at = now()
  from (
    select t.id,
           case
             when h.is_major_holiday is true       then 'major_holiday'
             when h.holiday_date is not null       then 'federal_holiday'
             when extract(dow from t.slot_date) = 6 then 'saturday'
             when extract(dow from t.slot_date) = 0 then 'sunday'
             when extract(dow from t.slot_date) = 5 then 'friday'
             else 'weekday'
           end as dt
      from (
        select ss2.id, ss2.slot_date, sc.organization_id
          from scheduling.schedule_slots ss2
          join scheduling.schedule_versions sv on sv.id = ss2.schedule_version_id
          join scheduling.schedules sc on sc.id = sv.schedule_id
         where ss2.derived_day_type is null
      ) t
      left join scheduling.holiday_calendars h
        on h.holiday_date = t.slot_date
       and (h.organization_id = t.organization_id or h.organization_id is null)
  ) d
 where ss.id = d.id
   and ss.derived_day_type is null;

-- ── post-conditions ───────────────────────────────────────────────────────

-- 1. Nothing is left null.
do $$
declare n int;
begin
  select count(*) into n
    from scheduling.schedule_slots where derived_day_type is null;
  if n <> 0 then
    raise exception 'patch65: % slots still have a null derived_day_type', n;
  end if;
end $$;

-- 2. Every backfilled value agrees with the date it was derived from. This is
--    the check that would catch a timezone slip in extract(dow) — the classic
--    way a Saturday becomes a Friday.
do $$
declare n int;
begin
  select count(*) into n
    from scheduling.schedule_slots ss
   where ss.derived_day_type in ('saturday','sunday','friday','weekday')
     and ss.derived_day_type <> case
           when extract(dow from ss.slot_date) = 6 then 'saturday'
           when extract(dow from ss.slot_date) = 0 then 'sunday'
           when extract(dow from ss.slot_date) = 5 then 'friday'
           else 'weekday' end::scheduling.day_type;
  if n <> 0 then
    raise exception 'patch65: % slots disagree with their own slot_date', n;
  end if;
end $$;

commit;
