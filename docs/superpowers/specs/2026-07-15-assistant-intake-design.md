# Assistant Intake — One-Prompt Scheduling Variables Design

**Date:** 2026-07-15 · **Status:** approved ("yes build it") · **Scope:** schedule assistant tools + snapshot/undo + prompt. No schema changes.

Gabriel's ask: feed the assistant ALL scheduling variables in one prompt — docs' PTO schedules, no-call requests, FTE status, etc. — and have it compute the schedule (record the facts, then run the hardcoded algorithm).

## Grounding (investigated 2026-07-15; full report in session)

- `provider_availability` is THE live lever for time-off AND no-call: `isBlockingAvailability` (shared.ts) hard-blocks `pto/sick/fmla/parental_leave/military_leave/jury_duty/unavailable/blocked` in every engine (pending included — invariant 2); `no_call_request` deliberately does NOT block — it soft-flags call-category assignments only (evaluators.ts timeOff ~257). `call_request` has no consumer (skip).
- Live profile fields: `fte_value` (bucket quotas, re-read every generation — takes effect immediately), `call_taker`/`partial_call_taker` (pool gate), `is_day_doc` (day pool). DEAD (do NOT write): `blocked_dates`, `weekend/holiday/night/backup/late_*_eligible` on the profile, `max_monthly_calls`, `max_consecutive_calls`.
- Permanent call-eligibility ("X never takes weekend call") lives on `provider_site_credentials.can_take_call/can_take_weekend_call/can_take_holiday_call/can_take_backup_call` (eligibility.ts:89-105) — the hard generation gate.
- Direct-write semantics to mirror: `POST /api/scheduling/availability` (type/status/date validation, org check, `approval_status` default `'approved'`, `all_day: true`). The provider-requests queue is a separate provider-submitted flow — the assistant intake bypasses it BY DESIGN (the scheduler is stating decisions, not requesting them). Grid virtual rows render approved entries only, so assistant writes must be `'approved'` (pending would steer generation invisibly).
- Assistant architecture: tools declared in tools.ts (strict budget: ≤20 optional params across strict tools, ≤1000B per strict schema — pinned by tools.test.ts bounds tests; currently 5 optionals used); executors via createToolExecutors, mutating tools listed in MUTATING_TOOLS trigger takeSnapshot; snapshot/revert is per-type (config_before keys + bespoke restore blocks). ctx carries siteId/versionId; provider resolution is UUID-in, roster from get_schedule_context.

## New tools (5)

1. **`list_availability`** (read; strict; optionals: provider_id?, date_start?, date_end? = 3): rows for the site's providers overlapping the window (default: schedule range + bookend margin), returning id, provider, type, dates, approval_status, source. Gives the model (and the user) the current picture and the ids needed for corrections.
2. **`record_availability`** (write; strict; required provider_id, availability_type, start_date, end_date; optional notes = 1): inserts a `provider_availability` row. `availability_type` restricted to the engine-meaningful set: `pto, sick, fmla, parental_leave, military_leave, jury_duty, unavailable, blocked, no_call_request`. Semantics mirror POST /availability: date/type validation, org/site check, `all_day: true`, `approval_status: 'approved'`, `source: 'assistant'` (column is free text; provenance is useful — verify and fall back to 'manual' if constrained). Description text must teach the model: PTO/vacation → `pto`; "out/unavailable/off" → `unavailable`; "no call that day but working" → `no_call_request` (soft-flags call, never blocks).
3. **`cancel_availability`** (write; strict; required id; 0 optionals): sets `approval_status = 'canceled'` (never hard-deletes — dismissed entries stop blocking per isDismissedAvailability; history preserved).
4. **`update_provider_profile`** (write; strict; required provider_id; optionals fte_value?, call_taker?, partial_call_taker?, is_day_doc? = 4): patches ONLY those live fields on provider_employment_profiles. Reject (ToolInputError) if no field provided.
5. **`update_site_credentials`** (write; strict; required provider_id; optionals can_take_call?, can_take_weekend_call?, can_take_holiday_call?, can_take_backup_call? = 4): patches the provider's credential row for ctx.siteId — the hard eligibility gate for "never takes weekend call"-type facts. Reject if no field provided; error clearly if no credential row exists for that provider+site (do not invent one silently — surface it so the scheduler decides).

Strict-budget math: 5 + 3 + 1 + 0 + 4 + 4 = 17 optional params ≤ 20 ✓; every schema well under 1000B. All five stay strict.

## Undo coverage (snapshot extension)

`ConfigBefore` gains three optional keys, captured in takeSnapshot ONLY when present (backward-compatible with old stored actions):
- `provider_availability`: rows for the site's org overlapping [dateStart − AVAIL_WINDOW_DAYS, dateEnd + AVAIL_WINDOW_DAYS] (full rows).
- `provider_employment_profiles`: full rows for the site's home providers.
- `provider_site_credentials`: full rows for ctx.siteId.

revertAction gains matching restore blocks (upsert-by-id via bulkWriteWithRowFallback) PLUS a delete-new-rows pass for availability (a row inserted after the snapshot must be deleted on revert — mirror the step-4b open-slot pattern). Profiles/credentials are pure upserts (tools never insert new rows there). Restore order: before assignments (availability affects revalidation). Old actions without the new keys revert exactly as today (skip blocks when keys absent).

## Prompt (assistant.md) — new "Intake" section

Codify the intake workflow (echoes Gabriel's PTO-insertion process rules from 2026-07-12):
1. NEVER guess a name→provider mapping. Resolve via get_schedule_context's roster; ambiguous or unknown names → STOP and ask, listing candidates.
2. Parse the scheduler's variables into a preview table (provider → fact → tool + dates/values), present it, and WAIT for confirmation before writing anything.
3. Vocabulary mapping: vacation/PTO → pto; sick → sick; "out/off/unavailable" → unavailable; "no call on X but working" → no_call_request; "never takes weekend call" → update_site_credentials; FTE changes → update_provider_profile. Facts the system cannot represent (e.g. soft preferences like "prefers Tuesdays") → say so honestly; suggest rule_definitions where they fit.
4. After writing: regenerate_schedule, then find_unfilled + get_fairness_report + get_coverage_summary and report the outcome (incl. skipped derived shifts and any no_call_request soft flags the generator could not avoid).
5. Remind that everything is one Undo away (existing action framework).

## Testing
- Executor tests (fake sb): each tool's validation (bad type, bad dates, org mismatch, empty patch, missing credential row), approved-status default, source provenance.
- Snapshot round-trip: take → record_availability + profile change → revert → new availability row DELETED, profile restored, old actions (no new keys) still revert.
- Bounds regression tests updated (17 optionals ≤ 20; schema sizes).
- MUTATING_TOOLS includes the four writers; loop snapshot-gating covered by existing loop tests + one new case.
- assistant.test.ts conversation fixture: intake turn (record + confirm flow) with fake client.
- Full suite; scheduleAssistant existing tests must pass (behavior additions only).

## Non-goals
- No provider_requests queue integration (scheduler-stated facts are decisions).
- No writes to dead fields, ever.
- No natural-language name resolution server-side — the model resolves via roster + confirmation (prompt-enforced).
- Availability recurrence (recurrence_rule) — out of scope v1; date-range rows only.
