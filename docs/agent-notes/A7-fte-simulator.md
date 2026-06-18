# A7 — FTE Simulator Agent Notes

**Owner:** Agent A7 (FTE Simulator)
**Scope:** Worst-case deterministic + Monte Carlo simulator producing an `FTERecommendation`. Persists results to `scheduling.grid_calculator_fte_runs`.
**Status:** Code + tests shipped. Missing patch16 SQL and these notes were filled in by the orchestrator after A7's watchdog stalled post-tests.

## Files shipped

- `src/lib/gridCalculator/fteSimulator.ts` (~49 KB, 1178 lines)
- `src/lib/gridCalculator/__tests__/fteSimulator.test.ts` (~19 KB, 12 tests, all pass)
- `supabase_scheduling_patch16_fte_runs.sql` (added by orchestrator)
- This notes file (added by orchestrator)

## Public API

- `simulate(input): Promise<FTERecommendation>` — entry point.
- `runWorstCase(input): WorstCaseResult` — pure, synchronous, smallest roster that clears every weekday.
- `runMonteCarlo(input, trialsCount = 1000): MonteCarloResult` — sampled PTO/sick/FMLA/maternity/post-call.
- `recommendFTE(worstCase, monteCarlo): FTERecommendation` — `max(worstCase, p95)`, labels `binding`, assembles `backupCall` via A8.
- `generateAnnualCalendar(options)` + `createRng(seed)` for reuse outside the simulator.
- `persistFTERun(runResult, supabase)` — DB writer; module never imports a Supabase client directly.

## Constants (tunable in one place)

- `WORST_CASE_CRNA_CALLOUT_RATE = 0.15`
- `WORST_CASE_MD_CALLOUT_RATE = 0.08`
- `WORST_CASE_MATERNITY_WEEKS = 12`
- `WORST_CASE_FORCED_PTO_MD = 1`, `WORST_CASE_FORCED_PTO_CRNA = 1`
- `WORST_CASE_FORCED_POST_CALL_PER_WEEKDAY = 1`
- `FLOAT_HEALTH_BUMP_THRESHOLD = 0.10` (PRD §12 trigger)
- `MAX_FLOAT_HEALTH_BUMPS = 3` (runaway guard)
- `DEFAULT_TRIALS_COUNT = 1000`
- `RECOMMENDATION_MIN/MAX = [0, 200]` (escalation cap)

## RNG

`xoshiro128**`-style seeded RNG via `createRng(seed)`. Tests pass an explicit seed for byte-for-byte reproducibility; production leaves `seed` undefined and the wrapper picks a crypto-secure seed.

## Calendar / holidays

Defaults to US federal observances:
- New Year's Day, MLK Day, Presidents' Day, Memorial Day, Independence Day, Labor Day, Columbus Day, Veterans Day, Thanksgiving + day after, Christmas Eve + Christmas Day.

Customizable via `CalendarOptions.holidays`; pass `[]` to disable.

## Float-health auto-bump (PRD §12)

After each recommendation, A7 calls A6's `assessFloatHealth` per simulated day. If `>10%` of days fall below `tight`, the CRNA recommendation increments by 1 and the simulation re-runs. Capped at `MAX_FLOAT_HEALTH_BUMPS = 3` to avoid runaway recursion. The number of bumps is persisted as `float_bumps` for audit.

## Rationale generation

Default model: `claude-sonnet-4-6` (speed > Opus for a 1-paragraph explanation). If `ANTHROPIC_API_KEY` is unset OR `anthropicClient: null` is injected, falls back to a templated rationale that names the binding constraint explicitly (e.g. "binding constraint: worst-case Anesthesiologist headcount of 22 driven by forced 1 post-call vacancy + 15% CRNA call-out rate"). `rationale_source` persists which path was used.

## Tests (12/12 passing, 0.75s)

1. Empty roster → recommendation is zero everywhere with clear violations; does not throw.
2. Monte Carlo is reproducible across two runs with the same seed.
3. Worst-case ≥ Monte Carlo p50 on a non-trivial roster.
4. `binding='worst_case'` when worstCase ≥ p95.
5. `binding='monte_carlo'` when p95 > worstCase.
6. Float-health auto-bump fires under heavy demand and adds a CRNA.
7. Backup-call distribution sums to ≈ 1.0 and reflects posture.
8. Rationale falls back to template when no client is available.
9. Rationale uses Claude client when one is supplied.
10. Holiday calendar flags Thanksgiving + Christmas + New Year correctly.
11. Templated rationale calls out the binding constraint by name.
12. `createRng` produces identical sequences for the same seed.

## Open items for the orchestrator

- The nightly cron registration (PRD §14 A7 "Outputs: simulator module + nightly cron via /schedule skill") is NOT included here. Recommend dispatching a dedicated follow-up to register the cron via the `/schedule` skill, since cron registration is a side-effect that doesn't belong in the simulator module itself.
- The float-bump trace currently logs a count, not the per-day list of bumped days. A14 (PRD Curator) should decide whether the FTE panel needs that detail surfaced for hospital admin debugging.

## Conflicts found

**None.** Migration is purely additive. No existing column or table conflicts.
