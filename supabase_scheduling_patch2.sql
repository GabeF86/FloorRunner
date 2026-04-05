-- Patch 2: Add call_type to shift_types
-- Run this in the Supabase SQL Editor

ALTER TABLE scheduling.shift_types
  ADD COLUMN IF NOT EXISTS call_type text; -- weekday, weekend, holiday, additional (null if not a call shift)
