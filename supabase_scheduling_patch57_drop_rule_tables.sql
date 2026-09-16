-- patch57 — drop rule_sets and rule_definitions
--
-- CODE FIRST, deliberately: the commit that removed every reader of these
-- tables shipped and deployed before this ran, so production never queried a
-- table that was gone. That is the reverse of the additive-column rule.
--
-- ── THE RECORD, BECAUSE THE ROWS ARE ABOUT TO STOP EXISTING ────────────────
-- Three rule sets, ten definitions. Every definition was is_active = false, so
-- none of this had ever been evaluated. Preserved here because a git history
-- that only says "dropped two tables" makes the next person wonder what was in
-- them.
--
--   Rule sets
--     "PH Scheduling Rules"      Paoli      active    8 definitions
--     "Lankenau Schedule Rules"  Lankenau   draft     0 definitions
--     "ddd"                      Paoli      draft     0 definitions
--
--   The two drafts are the Create Rule Set button's whole legacy. Validation
--   only ever loaded rule sets with status 'active', and nothing in the UI
--   promoted a draft, so both were unreadable from the moment they were made.
--   One of them is named "ddd".
--
--   Definitions in "PH Scheduling Rules" (all inactive)
--     eligibility  C3 Requires Neuro-Eligibility            HARD
--     eligibility  Call Shifts Require Call Taker           HARD
--     pairing      C1 Requires C2 Backup                    HARD
--     rest         C1 Post-Call Day Off                     HARD
--     sequence     D1 = Post-C2                             soft
--     sequence     D2 = Pre-C1                              soft
--     sequence     D3 = Pre-C2                              soft
--     sequence     Friday C2 -> Saturday C2 -> Sunday C1    HARD
--
-- ── WHERE THE TWO THAT MATTERED WENT ───────────────────────────────────────
-- "C3 Requires Neuro-Eligibility" and "C1 Requires C2 Backup" checked things
-- nothing else checked. They are now always-on evaluators driven by columns on
-- shift_types (requires_specific_skills, requires_backup_pairing), so they work
-- at every site without a rule row — see evaluators.ts shiftSkills and
-- backupPairing. The rest either duplicated what the engine already enforces
-- (post-call rest, call-taker-only) or restated structure that lives in the
-- call pattern (the D-chain, the weekend chain).
--
-- ── FOREIGN KEYS ───────────────────────────────────────────────────────────
-- Checked before running: nothing outside these two tables references either.
-- Every FK points OUT (organizations, sites, users) plus rule_definitions →
-- rule_sets. No CASCADE reaches another table.

begin;

drop table if exists scheduling.rule_definitions;
drop table if exists scheduling.rule_sets;

-- Both enums existed solely for these tables (verified: zero columns elsewhere).
-- provider_group is NOT dropped — schedule_slots, schedules and shift_types all
-- use it.
drop type if exists scheduling.rule_category;
drop type if exists scheduling.rule_set_status;

do $$
declare left_over int;
begin
  select count(*) into left_over
  from information_schema.tables
  where table_schema = 'scheduling' and table_name in ('rule_sets', 'rule_definitions');
  if left_over > 0 then
    raise exception '% rule table(s) still present', left_over;
  end if;
  -- The shared enum must have survived, or three live tables just lost a type.
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'scheduling' and t.typname = 'provider_group'
  ) then
    raise exception 'provider_group enum was dropped — it is still in use';
  end if;
end $$;

commit;
