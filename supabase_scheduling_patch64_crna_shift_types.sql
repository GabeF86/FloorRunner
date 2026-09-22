-- supabase_scheduling_patch64_crna_shift_types.sql
--
-- CRNA shift types for the five sites the CRNA master schedule covers.
--
-- PROJECT: apply ONLY to the Supabase project for "Floor Runner".
--
-- STATUS: pending. Post-conditions below assert the shape after apply.
--
-- ORDER: DB FIRST. Purely additive: 50 new rows, all provider_group='crna',
--        so nothing that reads physician shift types changes.
--
-- ── WHERE THESE COME FROM ──────────────────────────────────────────────────
-- The group's CRNA master spreadsheet (1 Sep – 1 Dec 2026, 2,601 assignments).
-- Until now the system held 62 shift types and EVERY ONE was a physician type,
-- which is why the Master CRNA Schedule renders empty.
--
-- ── THE SITE IS IN THE CODE, NOT IN THE FILENAME ───────────────────────────
-- The file is called "Lankenau Master" and only 54% of it is Lankenau. Each
-- cell names its own site: cLank / cBM / cOrthoBM / cPaoli / cRoth. Same rule
-- the physician import discovered — the CODE owns the site, and filing a cell
-- under the sheet's title would put a Bryn Mawr shift at Lankenau.
--
-- NOTE THE PREFIX ORDER: cOrthoBM must be tested BEFORE cBM, or every
-- Orthopedic Surgical shift is read as a Bryn Mawr one. 204 cells turn on it.
--
-- ── CODE FORM ──────────────────────────────────────────────────────────────
-- Source `cLank8` becomes `c8` at Lankenau: the site is already the site_id,
-- so repeating it in the code is noise. The lowercase `c` is kept — it is the
-- group's own mark for a CRNA line, and it makes collision with a physician
-- code impossible (no physician code begins with a lowercase letter). `C1` the
-- first-call row and `c12` the CRNA twelve-hour day can never be confused.
--
-- ── TIMES ──────────────────────────────────────────────────────────────────
-- A bare number is the shift LENGTH in hours from 07:00 (Gabriel confirmed):
-- c8 = 07:00–15:00, c12 = 07:00–19:00. Explicit ranges are taken literally.
-- crosses_midnight is set from `end <= start`, so 07:00→07:00 is 24 hours and
-- not a zero-length shift.
--
-- ── POST-CALL: ALL THREE CALL TYPES, INCLUDING BRYN MAWR ───────────────────
-- Gabriel: CRNA call is a 24-hour shift requiring a post-call day, weekdays
-- and weekends. Confirmed against the sheet — the day after call is:
--     cLankCall  → cLankPC   175/179  (98%)
--     cPaoliCall → cPaoliPC   41/42   (98%)
--     cBMCall    → blank      71/72   (99%)
-- Bryn Mawr gives the rest day but does not write a code for it. All three
-- therefore carry requires_post_call_rule; reading BMH's silence as "no post
-- call" would have dropped clinical invariant 1 for 72 call nights.
--
-- The PC codes themselves are NOT shift types. They mark a day off that the
-- post-call rule already implies, and a zero-hour "PC" row would put a phantom
-- line on every grid — the same decision the physician import made for PostC1.
--
-- ── TWO JUDGEMENT CALLS, STATED ────────────────────────────────────────────
-- cPaoliTrBeep (bare, 25 cells) is modelled as the 24-hour trauma beeper.
-- Its three ranged variants (7a-3p, 3p-11p, 11p-7a) cover a full day between
-- them and NEVER share a date with the bare code — 25 bare-only days, 16
-- split days, zero overlap. That is the same shape as Paoli's physician C1
-- splitting into C1D12 / C1E8 / C1N12.
--
-- cLankTr7a (31 cells) is modelled as a 24-hour trauma line WITHOUT post-call,
-- like Lankenau's existing CC2 cardiac backup. It runs on consecutive days in
-- 29% of cases, which rules out a post-call-generating call: marking it one
-- would report nine legitimate back-to-back pairs as invariant-1 violations.
begin;

insert into scheduling.shift_types
  (site_id, code, name, start_time, end_time, category, crosses_midnight,
   requires_post_call_rule, provider_group, is_active, display_order)
select si.id, v.code, v.name, v.st::time, v.en::time, v.cat::scheduling.shift_category,
       v.cm, v.pc, 'crna', true, 100 + row_number() over (partition by v.site order by v.code)
  from (values
    ('BMH','c10','CRNA 10','07:00:00','17:00:00','regular',false,false),
    ('BMH','c11a7p','CRNA 11a7p','11:00:00','19:00:00','regular',false,false),
    ('BMH','c12','CRNA 12','07:00:00','19:00:00','regular',false,false),
    ('BMH','c3p-7p','CRNA 3p-7p','15:00:00','19:00:00','regular',false,false),
    ('BMH','c7a1p','CRNA 7a1p','07:00:00','13:00:00','regular',false,false),
    ('BMH','c7a7pBeep','CRNA 7a7pBeep','07:00:00','19:00:00','regular',false,false),
    ('BMH','c7p-11pBeep','CRNA 7p-11pBeep','19:00:00','23:00:00','regular',false,false),
    ('BMH','c7p7a','CRNA 7p7a','19:00:00','07:00:00','regular',true,false),
    ('BMH','c8','CRNA 8','07:00:00','15:00:00','regular',false,false),
    ('BMH','c9','CRNA 9','07:00:00','16:00:00','regular',false,false),
    ('BMH','cCall','CRNA Call','07:00:00','07:00:00','call',true,true),
    ('BMH','cOrient','CRNA Orient','07:00:00','15:00:00','regular',false,false),
    ('LMC','c10','CRNA 10','07:00:00','17:00:00','regular',false,false),
    ('LMC','c11a-3p','CRNA 11a-3p','11:00:00','15:00:00','regular',false,false),
    ('LMC','c11a-5p','CRNA 11a-5p','11:00:00','17:00:00','regular',false,false),
    ('LMC','c11a-7p','CRNA 11a-7p','11:00:00','19:00:00','regular',false,false),
    ('LMC','c11a-9p','CRNA 11a-9p','11:00:00','21:00:00','regular',false,false),
    ('LMC','c11p-7a','CRNA 11p-7a','23:00:00','07:00:00','regular',true,false),
    ('LMC','c12','CRNA 12','07:00:00','19:00:00','regular',false,false),
    ('LMC','c13','CRNA 13','07:00:00','20:00:00','regular',false,false),
    ('LMC','c14','CRNA 14','07:00:00','21:00:00','regular',false,false),
    ('LMC','c3p-11p','CRNA 3p-11p','15:00:00','23:00:00','regular',false,false),
    ('LMC','c3p-8p','CRNA 3p-8p','15:00:00','20:00:00','regular',false,false),
    ('LMC','c7a-11a','CRNA 7a-11a','07:00:00','11:00:00','regular',false,false),
    ('LMC','c7a-11p','CRNA 7a-11p','07:00:00','23:00:00','regular',false,false),
    ('LMC','c7a-1p','CRNA 7a-1p','07:00:00','13:00:00','regular',false,false),
    ('LMC','c8','CRNA 8','07:00:00','15:00:00','regular',false,false),
    ('LMC','c830a-2p','CRNA 830a-2p','08:30:00','14:00:00','regular',false,false),
    ('LMC','c830a-3p','CRNA 830a-3p','08:30:00','15:00:00','regular',false,false),
    ('LMC','c9a-1p','CRNA 9a-1p','09:00:00','13:00:00','regular',false,false),
    ('LMC','c9a-3p','CRNA 9a-3p','09:00:00','15:00:00','regular',false,false),
    ('LMC','c9a-7p','CRNA 9a-7p','09:00:00','19:00:00','regular',false,false),
    ('LMC','cCall','CRNA Call','07:00:00','07:00:00','call',true,true),
    ('LMC','cOrient','CRNA Orient','07:00:00','15:00:00','regular',false,false),
    ('LMC','cTr7a','CRNA Tr7a','07:00:00','07:00:00','call',true,false),
    ('OSC','c10','CRNA 10','07:00:00','17:00:00','regular',false,false),
    ('OSC','c8','CRNA 8','07:00:00','15:00:00','regular',false,false),
    ('PH','c10','CRNA 10','07:00:00','17:00:00','regular',false,false),
    ('PH','c12','CRNA 12','07:00:00','19:00:00','regular',false,false),
    ('PH','c7a-1p','CRNA 7a-1p','07:00:00','13:00:00','regular',false,false),
    ('PH','c7p-7a','CRNA 7p-7a','19:00:00','07:00:00','regular',true,false),
    ('PH','c8','CRNA 8','07:00:00','15:00:00','regular',false,false),
    ('PH','cCall','CRNA Call','07:00:00','07:00:00','call',true,true),
    ('PH','cOrient','CRNA Orient','07:00:00','15:00:00','regular',false,false),
    ('PH','cTrBeep','CRNA TrBeep','07:00:00','07:00:00','call',true,false),
    ('PH','cTrBeep11p-7a','CRNA TrBeep 11p-7a','23:00:00','07:00:00','regular',true,false),
    ('PH','cTrBeep3p-11p','CRNA TrBeep 3p-11p','15:00:00','23:00:00','regular',false,false),
    ('PH','cTrBeep7a-3p','CRNA TrBeep 7a-3p','07:00:00','15:00:00','regular',false,false),
    ('RSH','c8','CRNA 8','07:00:00','15:00:00','regular',false,false),
    ('RSH','cOrient','CRNA Orient','07:00:00','15:00:00','regular',false,false)
  ) as v(site, code, name, st, en, cat, cm, pc)
  join scheduling.sites si on si.short_name = v.site
 where not exists (select 1 from scheduling.shift_types x
                    where x.site_id = si.id and x.code = v.code);
-- 50 CRNA shift types

-- ── Post-conditions ────────────────────────────────────────────────────────
do $$
declare n_crna int; n_call int; n_bad int;
begin
  select count(*) into n_crna from scheduling.shift_types where provider_group = 'crna';
  if n_crna <> 50 then
    raise exception 'expected 50 CRNA shift types, found %', n_crna;
  end if;

  -- Every CRNA call type must carry the post-call rule. This is the check
  -- that would have caught reading Bryn Mawr's blank as "no rest day".
  select count(*) into n_call
    from scheduling.shift_types
   where provider_group = 'crna' and code = 'cCall';
  if n_call <> 3 then
    raise exception 'expected cCall at 3 sites, found %', n_call;
  end if;
  if exists (select 1 from scheduling.shift_types
              where provider_group='crna' and code='cCall'
                and requires_post_call_rule is not true) then
    raise exception 'a CRNA call type is missing requires_post_call_rule';
  end if;

  -- crosses_midnight must agree with the times, or a 24h shift reads as zero.
  select count(*) into n_bad from scheduling.shift_types
   where provider_group='crna' and crosses_midnight <> (end_time <= start_time);
  if n_bad > 0 then
    raise exception '% CRNA types have crosses_midnight disagreeing with their times', n_bad;
  end if;

  -- Physician types must be untouched. 62, not 60: two are RETIRED
  -- (is_active=false, CC1 among them) and still count as rows. Asserting the
  -- active count here would have failed this patch for a reason that has
  -- nothing to do with it.
  if (select count(*) from scheduling.shift_types where provider_group='physician') <> 62 then
    raise exception 'physician shift types changed count';
  end if;
end $$;

commit;
