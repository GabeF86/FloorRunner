-- patch53 — remove the superseded half of four duplicated rule definitions
--
-- Paoli's rule set holds 12 definitions but describes 8 distinct rules. Four
-- were written twice: once on 2026-04-06 and again on 2026-04-14. The later
-- row is a REFINEMENT of the earlier one in every case, not a copy, so the
-- pairs are not interchangeable and the April 6 rows are the ones to drop.
--
--   C1 Post-Call Day Off
--     Apr 6   action {days_off: 1}
--     Apr 14  action {days_off: 1, exempt_next_shift_codes: ["C3"]}   ← keep
--     The later row permits a C3 on the day after a C1, which the earlier one
--     would flag. Strictly more correct, and dropping it would re-introduce a
--     false violation.
--
--   D1 = Post-C2 / D2 = Pre-C1 / D3 = Pre-C2
--     Apr 6   hard_constraint = true
--     Apr 14  hard_constraint = false                                 ← keep
--     Condition and action are byte-identical; only severity differs.
--     SOFT is the correct one, and this is a clinical point rather than a
--     stylistic one: invariant 4 says a derived shift blocked by PTO or a
--     cross-site booking must be left unassigned AND RECORDED. A legitimate
--     skip is expected behaviour, so marking the D-chain hard would report
--     the engine's correct handling of PTO as a hard violation and train a
--     chief to ignore the count.
--
-- All 12 are currently is_active = false, so nothing changes about what is
-- evaluated today. This is tidying the list before any of it is switched on.
--
-- NOT touched here, but worth a decision later: "Friday C2 -> Saturday C2 ->
-- Sunday C1" is still hard_constraint = true and is the same shape of rule as
-- the D-chain — a weekend chain broken by someone's PTO is a legitimate skip,
-- not a violation. Left alone because it is not a duplicate and changing a
-- severity is a clinical call, not a cleanup.

begin;

-- Guard: refuse to run if any of these ever got switched on, since deleting a
-- LIVE rule would silently stop checking something.
do $$
declare live int;
begin
  select count(*) into live
  from scheduling.rule_definitions
  where id in (
    'bfbc707f-4f8e-402d-b337-9862c36503f9',  -- C1 Post-Call Day Off (no C3 exemption)
    '6f70908e-caee-493b-a5e2-c08951ff6f32',  -- D1 = Post-C2 (hard)
    'bf978bef-38cd-444d-9f92-1b7310a3119f',  -- D2 = Pre-C1 (hard)
    'c786c5c6-0620-4cc3-8fa5-b3733cacf03d'   -- D3 = Pre-C2 (hard)
  ) and is_active;
  if live > 0 then
    raise exception 'Refusing to delete % ACTIVE rule definition(s) — review before re-running.', live;
  end if;
end $$;

delete from scheduling.rule_definitions
where id in (
  'bfbc707f-4f8e-402d-b337-9862c36503f9',
  '6f70908e-caee-493b-a5e2-c08951ff6f32',
  'bf978bef-38cd-444d-9f92-1b7310a3119f',
  'c786c5c6-0620-4cc3-8fa5-b3733cacf03d'
);

-- Post-condition: 8 definitions, and no rule_name appearing twice within a set.
do $$
declare total int; dupes int;
begin
  select count(*) into total from scheduling.rule_definitions;
  select count(*) into dupes from (
    select rule_set_id, rule_name
    from scheduling.rule_definitions
    group by rule_set_id, rule_name
    having count(*) > 1
  ) d;
  if total <> 8 then
    raise exception 'Expected 8 rule definitions after dedupe, found %', total;
  end if;
  if dupes > 0 then
    raise exception 'Still % duplicated rule_name(s) within a rule set', dupes;
  end if;
end $$;

commit;
