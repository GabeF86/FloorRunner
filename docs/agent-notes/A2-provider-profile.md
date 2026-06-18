# A2 — Provider Profile Agent Notes

**Owner:** Agent A2 (Provider Profile)
**Scope:** Extend `scheduling.provider_employment_profiles` with leave-bucket
and backup-call fields the FTE simulator (A7) and call burden agent (A8) need.
**Migration file:** `supabase_scheduling_patch15_provider_leave_buckets.sql`
**TS module:** `src/lib/gridCalculator/providerProfile.ts`

## Investigation summary

Scanned `supabase_scheduling_schema.sql` (lines 137–188) and all existing
`supabase_scheduling_patch*.sql` files (1–13). No conflicting columns exist on
`scheduling.provider_employment_profiles` — the existing schema already has:

- `pto_weeks` (integer, default 0) — reused as-is for PTO.
- `backup_call_eligible` (boolean, default true) — preserved; new field is a
  **target share**, not eligibility.
- `max_consecutive_calls` (integer, nullable) — preserved; the new
  `max_consecutive_post_call_days` is a complementary post-call rest cap.

`scheduling.availability_type` enum (schema line 25) already includes `'sick'`,
`'fmla'`, `'cme'`, `'parental_leave'`, so the leave taxonomy is consistent.

**No conflicts found** — proceeding with additive patch 15.

## Columns added (patch 15)

| Column | Type | Default | Rationale |
|---|---|---|---|
| `sick_days_per_year` | `integer` NOT NULL | `5` | Industry median sick/personal call-out budget. Used as Poisson lambda by A7 Monte Carlo. PRD §10 cites 3/CRNA, 1.5/Anesthesiologist defaults; per-provider override needed. |
| `maternity_eligible` | `boolean` NOT NULL | `false` | Cohort flag for the worst-case deterministic hold-out: PRD §10 specifies "Holds out one provider for maternity (12 weeks)". A7 picks the held-out provider from this cohort. |
| `fmla_eligible` | `boolean` NOT NULL | `false` | Cohort flag for Monte Carlo FMLA absence sampling. PRD §10: "FMLA / maternity sampled from a per-cohort probability." Default false because most rosters need explicit opt-in. |
| `cme_days_per_year` | `integer` NOT NULL | `5` | Continuing medical education days subtracted from annual availability. Typical anesthesia contract. |
| `backup_call_share_target` | `numeric(3,2)` nullable | `NULL` | Fractional FTE share (0..1) of total backup-call demand. `NULL` means "engine decides" (A8 runs FTE-weighted greedy). Allows directors to pin specific providers without forcing a value on everyone. PRD §11. |
| `max_consecutive_post_call_days` | `integer` NOT NULL | `1` | Cap on consecutive post-call rest days when a provider takes back-to-back 24h calls. Default 1 matches the standard one-rest-day-per-call rule. PRD §5 (post-call glossary). |

All columns use `ADD COLUMN IF NOT EXISTS` so the migration is idempotent and
re-running it after a partial application is safe. A `-- DOWN` section at the
foot of the file documents the rollback path (drop the four CHECK constraints,
then drop the six columns).

## Sanity-range CHECK constraints

- `sick_days_per_year` BETWEEN 0 AND 60 (60 ≈ 12 work-weeks; anything more
  belongs to FMLA, not sick).
- `cme_days_per_year` BETWEEN 0 AND 30 (most groups cap at ~10).
- `backup_call_share_target` NULL OR BETWEEN 0 AND 1 (fractional share).
- `max_consecutive_post_call_days` BETWEEN 0 AND 7.

Constraints are dropped+recreated by name (`provider_employment_profiles_*_check`)
so the migration is re-runnable without "constraint already exists" errors.

## TypeScript module — `providerProfile.ts`

Exposes:

- `ProviderLeaveProfile` interface — mirrors the new columns + the pre-existing
  `pto_weeks`. SQL column names preserved (snake_case) so DB rows can pass
  through with no remapping.
- `AnnualCalendar` and `AnnualAvailabilitySummary` interfaces — minimal shapes
  consumed by A7.
- `withProfileDefaults(partial)` — coerces partial/legacy profiles into a
  fully-defaulted shape. Single source of truth for fallback defaults.
- `deriveAnnualAvailability(profile, calendar)` — pure function returning
  expected available/sick/PTO/FMLA/CME days. Used as the deterministic
  baseline by A7. **Maternity intentionally excluded** — it is a worst-case
  hold-out (PRD §10), applied to exactly one provider, not a per-provider
  expectation.

All defaults centralized as top-level `DEFAULT_*` constants matching the SQL
defaults — no magic numbers buried in function bodies.

## Assumptions

1. **Sick days expressed in working days, not calendar days.** Aligns with how
   PTO weeks are interpreted (PTO weeks × 5 working days/week).
2. **Default annual FMLA event probability = 4%**, expected event length = 60
   working days (12 weeks). A7 should recalibrate from telemetry once we have
   a year of data; for v1 these are conservative national-baseline priors.
3. **`backup_call_share_target = NULL` means "engine decides"**, not
   "share = 0". A8 must treat NULL as a signal to compute from FTE, not as a
   zero-share constraint.
4. **No CHECK on the sum of leave types.** A provider could in theory have
   `pto_weeks=10 + sick=60 + cme=30` totaling more than a working year. The TS
   helper clamps `availableDays` at 0; the DB intentionally does not constrain
   this because directors may briefly enter exploratory values while planning.
5. **`maternity_eligible` is independent of biological sex.** It is a binary
   "should this provider be in the maternity hold-out pool" flag — the director
   sets it manually per roster, and A7 picks one from the pool for the
   worst-case run.

## Open questions for A7 / A8

- Should the worst-case maternity hold-out pick the highest-FTE eligible
  provider (most conservative) or rotate? Defer to A7.
- Should `backup_call_share_target` enforce sum ≤ 1.0 across all providers on a
  given roster? Defer to A8 — likely yes, with a soft warning rather than a DB
  constraint, since the roster is the unit of validation.

## Conflicts found

**None.** Migration proceeds.
