-- Patch 1: Add partner_track and employed status
-- Run this in the Supabase SQL Editor

-- Add 'employed' to employment_status enum
ALTER TYPE scheduling.employment_status ADD VALUE IF NOT EXISTS 'employed';

-- Add is_partner_track column to provider_employment_profiles
ALTER TABLE scheduling.provider_employment_profiles
  ADD COLUMN IF NOT EXISTS is_partner_track boolean NOT NULL DEFAULT false;
