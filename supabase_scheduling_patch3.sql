-- Patch 3: Add call coverage type and early out post-call
-- Run this in the Supabase SQL Editor

ALTER TABLE scheduling.shift_types
  ADD COLUMN IF NOT EXISTS call_coverage_type text,  -- partial_beeper, full_beeper (null if not applicable)
  ADD COLUMN IF NOT EXISTS early_out_post_call boolean NOT NULL DEFAULT false;
