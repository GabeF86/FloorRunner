-- Add hospital column to staff table so each hospital has its own roster
ALTER TABLE staff ADD COLUMN IF NOT EXISTS hospital text;

-- Index for fast filtering by hospital
CREATE INDEX IF NOT EXISTS idx_staff_hospital ON staff(hospital);
