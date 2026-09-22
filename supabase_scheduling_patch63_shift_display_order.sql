-- supabase_scheduling_patch63_shift_display_order.sql
--
-- Give Bryn Mawr, Lankenau and Riddle a sensible row order on the grid.
--
-- PROJECT: apply ONLY to the Supabase project for "Floor Runner".
--
-- STATUS: APPLIED 2026-09-22. Verified after — the three sites now read:
--   BMH  C1 → C2 → C3 → NEURO → DAY → 07-13 → 07-15 → 07-16 → 07-17
--                                    → 07-19 → 07-20 → 11-19
--   LMC  C1 → C2 → C3 → C4 → CC2 → DAY → OB → ICU → 7a-3p → 7a-4p → 7a-5p
--                                    → 7a-7p → 9a-4p → 9a-7p → 10a-8p → 2p-8p
--   RH   C1 → C2 → DAY → D1 → D8H → D10H
--
--   The first apply FAILED its own tie post-condition, which is the check
--   doing its job: BMH gives C3 and NEURO the same call_rank of 2, so the raw
--   rank left exactly the ambiguity this patch exists to remove. Fixed by
--   ranking with row_number and breaking ties on code.
--
-- ORDER: DB-only. No code change — the grid already sorts on this column
--        (schedules/[id]/page.tsx sorts shiftTypes by display_order ?? 999).
--
-- ── THE BUG ────────────────────────────────────────────────────────────────
-- Every active shift type at BMH, LMC and RH has display_order = 0. The grid's
-- sort is therefore a no-op: Array.sort is stable, so equal keys preserve
-- insertion order, and insertion order is whatever sequence the assignments
-- happened to arrive in. That is the "random order of shifts" on the published
-- schedules — not a rendering fault, an absent sort key.
--
-- Paoli was configured by hand and shows the intended convention:
--     0,1,2   C1, C2, C3            call, by rank
--     3..10   D1..D8                the numbered day rooms
--     12,13   7-3, 7-5              generic day shifts
--     20+     C1D12, C1N12, ...     the split call segments, rarely used
--
-- ── THE RULE APPLIED HERE ──────────────────────────────────────────────────
-- Computed, not hand-typed, so it is reproducible and so a shift type added
-- tomorrow can be slotted by re-running the same expression:
--
--     0..9    ranked call, by call_rank          C1, C2, C3, C4
--     10..19  call with NO rank, by code         CC2, NEURO (weekend/backup)
--     20+     everything else
--             house shifts first (DAY, OB, ICU — the structural ones a reader
--             looks for), then the explicit time-range codes by start time,
--             then end time, then code.
--
-- Call sits at the top because it is the spine of the schedule: it is the row
-- somebody opens the grid to check, and it is the one that must be filled
-- every single day. The day rows below it are read as a block.
--
-- Sorting the time-range codes by START then END puts 7a-3p, 7a-4p, 7a-5p,
-- 7a-7p in ascending length — a reader scanning for "who is here latest" runs
-- down the column rather than hunting.
--
-- Paoli is deliberately UNTOUCHED: its order is already deliberate and encodes
-- a room numbering (D1..D8) this rule knows nothing about.

begin;

with ordered as (
  select
    st.id,
    case
      -- Ranked call: 0..9, in rank order. NOT the raw call_rank — BMH gives
      -- C3 and NEURO (weekend neuro) the same rank 2, so the raw value ties
      -- and leaves exactly the arbitrary order this patch exists to remove.
      -- row_number keeps rank as the primary key and breaks ties on code.
      when st.category = 'call' and st.call_rank is not null
        then row_number() over (
          partition by st.site_id, (st.category = 'call' and st.call_rank is not null)
          order by st.call_rank, st.code) - 1
      -- Unranked call (cardiac backup, weekend neuro): after the ranked ones.
      when st.category = 'call'
        then 10 + row_number() over (
          partition by st.site_id, (st.category = 'call' and st.call_rank is null)
          order by st.code)
      -- Everything else: house shifts first, then time ranges by start/end.
      else 20 + row_number() over (
        partition by st.site_id, (st.category = 'call')
        order by
          case upper(st.code) when 'DAY' then 0 when 'OB' then 1 when 'ICU' then 2 else 3 end,
          st.start_time nulls last,
          st.end_time nulls last,
          st.code)
    end as new_order
  from scheduling.shift_types st
  join scheduling.sites si on si.id = st.site_id
  where si.short_name in ('BMH', 'LMC', 'RH')
    and st.is_active is not false
)
update scheduling.shift_types t
   set display_order = o.new_order
  from ordered o
 where t.id = o.id;

-- ── Post-conditions ────────────────────────────────────────────────────────
do $$
declare bad int;
begin
  -- Within each of the three sites, every active type must now hold a DISTINCT
  -- order — a tie is exactly the condition that produced the arbitrary order.
  select count(*) into bad from (
    select st.site_id, st.display_order, count(*) n
      from scheduling.shift_types st
      join scheduling.sites si on si.id = st.site_id
     where si.short_name in ('BMH','LMC','RH') and st.is_active is not false
     group by 1,2 having count(*) > 1
  ) x;
  if bad > 0 then
    raise exception 'ties remain in display_order at % site/order pairs', bad;
  end if;

  -- First call must be the top row at each of the three.
  if exists (
    select 1 from scheduling.sites si
     where si.short_name in ('BMH','LMC','RH')
       and (select st.code from scheduling.shift_types st
             where st.site_id = si.id and st.is_active is not false
             order by st.display_order limit 1) <> 'C1'
  ) then
    raise exception 'C1 is not the first row at one of the three sites';
  end if;

  -- Paoli must be untouched: its D1..D8 room numbering is deliberate.
  if (select count(*) from scheduling.shift_types st
        join scheduling.sites si on si.id = st.site_id
       where si.short_name = 'PH' and st.code = 'C1' and st.display_order = 0) <> 1 then
    raise exception 'Paoli display_order was modified';
  end if;
end $$;

commit;
