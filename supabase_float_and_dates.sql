-- ============================================================
-- ORBoard v4 — Float site + date planning additions
-- Run in Supabase → SQL Editor → New Query
-- ============================================================

-- Add is_float column to sites
ALTER TABLE sites ADD COLUMN IF NOT EXISTS is_float boolean NOT NULL DEFAULT false;

-- Auto-create the Float/Breaks site if it doesn't exist
INSERT INTO sites (name, color, icon, position, is_float)
SELECT 'Float / Breaks', '#10b981', '🔄', 999, true
WHERE NOT EXISTS (SELECT 1 FROM sites WHERE is_float = true);
