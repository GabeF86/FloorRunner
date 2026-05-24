-- Patch 13: Pre-call activation flag on assignments
--
-- A weekday C1 assignment is overnight call only — the provider is not on
-- the floor during the day. For the "MDs working today" count (calendar +
-- grid view date headers), weekday C1 is excluded by default.
--
-- "Pre-call activation" is the operational override: a C1-assigned provider
-- who has been called in to work the daytime AS WELL AS overnight on the
-- same date. When this flag is true on a C1 assignment, that provider IS
-- counted as a daytime MD for that date.
--
-- Stored per-assignment (not per-slot) because the activation decision
-- attaches to the specific provider who is taking the call, not the slot
-- itself. Weekend C1 is unaffected (24h call already counts as working).

ALTER TABLE scheduling.assignments
  ADD COLUMN IF NOT EXISTS pre_call_activation boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN scheduling.assignments.pre_call_activation IS
  'When true on a weekday C1 assignment, the provider is counted as a daytime MD on that date. Default behavior excludes weekday C1 (overnight call only).';

NOTIFY pgrst, 'reload schema';
