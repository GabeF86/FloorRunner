-- patch56 — C2 does not require a backup behind it (Gabriel, 2026-09-15)
--
-- APPLIED to qhwdbtixhzdsgwwtcfrm 2026-09-15; verified after (no C2* row
-- carries the flag).
--
-- requires_backup_pairing was true on BOTH C1 and C2 at Paoli. C1 is right:
-- first call is backed by second call. C2 was not — Gabriel: weekday C2 works
-- the day and carries backup overnight, so it IS the backup rather than
-- something needing one, and weekend C2 is home call.
--
-- This matters now because the flag drives an always-on check for the first
-- time. Left as it was, "a shift needing a backup needs the next-ranked call
-- filled that day" would have C2 (rank 1) looking for C3 (rank 2) and flagging
-- every C2 day at Paoli for lacking neuro cover — a false alarm on every
-- single day, which is how a check teaches people to ignore it.

begin;

update scheduling.shift_types st
set requires_backup_pairing = false,
    updated_at = now()
from scheduling.sites s
where s.id = st.site_id
  and st.code = 'C2'
  and st.parent_call_code is null
  and st.requires_backup_pairing;

do $$
declare wrong int;
begin
  select count(*) into wrong
  from scheduling.shift_types
  where code like 'C2%' and requires_backup_pairing;
  if wrong > 0 then
    raise exception '% C2 shift type(s) still flagged as requiring a backup', wrong;
  end if;
end $$;

commit;
