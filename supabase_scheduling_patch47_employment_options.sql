-- supabase_scheduling_patch47_employment_options.sql
-- Provider profile tightening, part 1 (Gabriel 2026-09-09):
--   1. a new employment status, "Employed (non-call)"
--   2. a third partnership standing, "Employed Call Taker", alongside
--      is_shareholder and is_partner_track
--
-- PROJECT: apply ONLY to Supabase ref qhwdbtixhzdsgwwtcfrm ("Floor Runner").
--
-- STATUS: APPLIED 2026-09-09 to ref qhwdbtixhzdsgwwtcfrm, DB-FIRST honoured --
--         this ran BEFORE the code that writes is_employed_call_taker was
--         pushed. Target verified first: 83 providers / 83 employment profiles.
--         Pre-state: full_time 42, part_time 26, per_diem 15, 7 shareholders.
--         Post-assertions all passed --
--           enum now: full_time, part_time, per_diem, locums, contract,
--                     retired, terminated, employed, employed_non_call_taker
--           column:   boolean, NOT NULL, default false                  (1 row)
--           flagged:  0 profiles have is_employed_call_taker = true
--           untouched: still 83 profiles and 7 shareholders
--
--         Note the pre-existing `employed` label, which validation's
--         EMPLOYMENT_STATUSES does NOT allow. No row uses it. Rather than
--         resolve what it means, the UI gained a "(legacy)" escape hatch so
--         such a row stays editable -- see providerEmploymentForm.ts.
--
-- ── ORDER: DATABASE FIRST ───────────────────────────────────────────────────
-- This REVERSES the call-pattern rule, and the reversal is the point. A
-- pattern doc is code-first because an unknown key fails the strict schema and
-- falls back to CLASSIC_PATTERN silently. Nothing here is silent and the
-- failure runs the other way: if the code ships first, the tab's save payload
-- names is_employed_call_taker against a table with no such column, and EVERY
-- save on the Employment & Scheduling tab fails -- not only the ones that touch
-- the new toggle. Applying this first is inert: the new enum value is offered
-- by no UI, and the new column is false for all 83 profiles.
--
-- ── NO TRANSACTION ──────────────────────────────────────────────────────────
-- Deliberately NOT wrapped in BEGIN/COMMIT. A value added by ALTER TYPE ...
-- ADD VALUE cannot be USED until the adding transaction commits, and bundling
-- it with other work is the standard way to get a patch that half-applies.
-- Two independent auto-committed statements is the correct shape.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- Both statements carry IF NOT EXISTS. Safe to re-run.
--
-- ── NO BACKFILL ─────────────────────────────────────────────────────────────
-- is_employed_call_taker defaults false and stays false. 76 of 83 profiles are
-- currently neither Partner nor Partner Track; defaulting them all to Employed
-- Call Taker would invent a fact about 15 per diems and every day doc. "None of
-- the three" is the honest state for a profile nobody has classified.

ALTER TYPE scheduling.employment_status
  ADD VALUE IF NOT EXISTS 'employed_non_call_taker';

ALTER TABLE scheduling.provider_employment_profiles
  ADD COLUMN IF NOT EXISTS is_employed_call_taker boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN scheduling.provider_employment_profiles.is_employed_call_taker IS
  'Partnership standing: employed physician who takes call. Mutually exclusive '
  'with is_shareholder and is_partner_track -- the UI models the three as one '
  'value and derives the booleans at the storage boundary (patch47).';
