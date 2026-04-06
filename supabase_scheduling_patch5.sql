-- Patch 5: Clean up duplicate assignments created by bug
-- Run this in the Supabase SQL Editor

-- Delete duplicate assignments, keeping only the oldest per slot
DELETE FROM scheduling.assignments a
WHERE a.id NOT IN (
  SELECT DISTINCT ON (schedule_slot_id) id
  FROM scheduling.assignments
  ORDER BY schedule_slot_id, created_at ASC
);
