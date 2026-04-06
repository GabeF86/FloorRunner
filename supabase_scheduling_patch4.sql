-- Patch 4: Add 'combined' schedule type for unified call + shift schedules
-- Run this in the Supabase SQL Editor

ALTER TYPE scheduling.schedule_type ADD VALUE IF NOT EXISTS 'combined';
