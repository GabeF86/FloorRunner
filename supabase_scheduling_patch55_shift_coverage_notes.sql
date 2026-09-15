-- patch55 — somewhere to record what a shift actually COVERS
--
-- Additive column, so DB FIRST (the reverse of the call-pattern rule): code
-- that reads it can ship afterwards, and code that does not read it is
-- unaffected either way.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
-- The Scheduling Logic page derives what the engine enforces — chains, rest,
-- fill order, obligations — from live data, so it cannot drift. But some of
-- the most load-bearing facts about a call are not in any field:
--
--   "Weekday C2 works the day and carries backup overnight by beeper."
--   "Weekend C2 is home call."
--   "C2 cross-covers neuro on Friday nights."
--
-- That last one is WHY Paoli has no Friday C3 template. A reader looking at
-- the slate can see the absence but not the reason, and a future chief could
-- reasonably add a Friday C3 and double-cover it. The knowledge lived in one
-- person's head.
--
-- ── SITE-SCOPED FOR FREE ───────────────────────────────────────────────────
-- shift_types is already keyed by site_id, so a note on Paoli's C2 row says
-- nothing about Lankenau's C2 row. That matters here: the Friday neuro
-- cross-cover is a Paoli arrangement (Gabriel, 2026-09-15) and would be wrong
-- stated group-wide.
--
-- ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
-- Prose. The engine does not read it and must never start: the moment
-- generation depends on a free-text field, the strict CallPatternDoc schema
-- stops being the single source of structural truth. It is displayed under a
-- heading that says it describes coverage rather than enforcement, so the page
-- never implies the engine acts on it.

begin;

alter table scheduling.shift_types
  add column if not exists coverage_notes text;

comment on column scheduling.shift_types.coverage_notes is
  'What this shift actually covers, in plain language — beeper vs in-house, '
  'home call, cross-coverage of another service. DESCRIPTIVE ONLY: the '
  'generation engine does not read this and must not, or free text would '
  'become structural truth alongside the CallPatternDoc schema.';

-- Seed the three facts that prompted the column, exactly as Gabriel stated
-- them on 2026-09-15, scoped to Paoli.
update scheduling.shift_types st
set coverage_notes =
      'Weekdays: works during the day and covers backup at night. '
      || 'Weekends: home call. '
      || 'Also cross-covers neuro on Friday nights — which is why this site has '
      || 'no Friday C3 template.',
    updated_at = now()
from scheduling.sites s
where s.id = st.site_id
  and s.name = 'Paoli Hospital'
  and st.code = 'C2'
  and st.parent_call_code is null;

do $$
declare n int;
begin
  select count(*) into n
  from scheduling.shift_types st
  join scheduling.sites s on s.id = st.site_id
  where s.name = 'Paoli Hospital' and st.code = 'C2'
    and st.parent_call_code is null and st.coverage_notes is not null;
  if n <> 1 then
    raise exception 'Expected exactly 1 seeded Paoli C2 note, found %', n;
  end if;
end $$;

commit;
