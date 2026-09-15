-- patch54 — correct `crosses_midnight` on the three shift types that do
--
-- C1 (15:00→07:00) and CC1 both cross midnight and were stored as false. The
-- split segments added later (C1N12, C1N8, C2N12, C2N8) were set correctly, so
-- this is the original seed never having filled the column in rather than a
-- rule that changed.
--
-- Blast radius is small and worth stating: nothing in the engine reads this
-- column. Its only consumer is the "+1d" badge on the site's shift-type list,
-- so the visible effect is that C1 will now be marked as ending the following
-- morning, which it does. No generated schedule changes.
--
-- Derived rather than hand-listed, so it is also correct for any shift type
-- added between this patch being written and being applied.
--
-- ── THE EQUALITY CASE, MISSED ON THE FIRST PASS ────────────────────────────
-- `end_time < start_time` is not the whole rule. Three shifts are stored as
-- 07:00→07:00 with duration_hours = 24 — Lankenau C2 and CC2, and Paoli C3 —
-- and a 24-hour shift starting and ending at the same clock time obviously
-- wraps midnight, but equality is not less-than. The first run of this patch
-- left all three wrong. A start equal to its end is either a zero-length shift
-- (nonsense, and none exist) or a full-day wrap, so equality counts as
-- crossing.
--
-- NOT fixed here, because it is a clinical question rather than a data fault:
-- Paoli's C2 is stored as 07:00→19:00 with duration_hours = 24. Gabriel
-- describes weekday C2 as working the day and carrying backup by beeper
-- overnight, which is exactly what call_coverage_type = 'partial_beeper'
-- records — so the times describe the in-house portion and the duration
-- describes the whole commitment. That is defensible, but the site page prints
-- them side by side as "07:00–19:00 · 24h", which reads as a contradiction.
-- Whether the times should change is Gabriel's call.

begin;

update scheduling.shift_types
set crosses_midnight = (end_time <= start_time),
    updated_at = now()
where start_time is not null
  and end_time is not null
  and crosses_midnight is distinct from (end_time <= start_time);

-- Post-condition: the stored flag agrees with the times, everywhere.
do $$
declare wrong int;
begin
  select count(*) into wrong
  from scheduling.shift_types
  where start_time is not null and end_time is not null
    and crosses_midnight is distinct from (end_time <= start_time);
  if wrong > 0 then
    raise exception '% shift type(s) still disagree with their own times', wrong;
  end if;
end $$;

commit;
