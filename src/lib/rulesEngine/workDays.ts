// FTE working-days contract (2026-07-17) — the single home for the
// working-days predicate, the required/entitled-off arithmetic, the PTO-netting
// counter, the ICU credit classifier, and the placement cap predicate.
//
// THE MODEL
//   workingDays(block) = weekdays in [date_start, date_end] MINUS major federal
//     holidays (holiday_calendars.is_major_holiday = true — the "big six") that
//     fall on weekdays. Minor federal holidays (MLK, Juneteenth, …) are NOT
//     excluded — the department works them.
//   requiredWorkDays(fte, WD, pto) = round(fte × WD) − pto  (floored at 0). PTO
//     excuses 1:1 regardless of FTE (Gabriel: round(1.0×200) − 25 = 175).
//   entitledOffDays(fte, WD)      = WD − round(fte × WD). The partial's inherent
//     entitlement, independent of PTO. With the cap active, a partial's
//     unassigned weekdays ≥ entitledOff automatically (WD − pto − required =
//     WD − round(fte×WD) = entitledOff).
//
// TWO FTEs (2026-07-29, patch43 — provider_employment_profiles.work_days_fte)
//   The `fte` in the formulas above is the WORKING-DAYS FTE, which is normally
//   — and for every provider on file today, exactly — the CALL FTE
//   (`fte_value`). They are separate contracts and one provider needs them
//   separated: Hussain is 0.66 FTE for CALL (he spends a third of his time in
//   the ICU) but owes a FULL-TIME set of working days — Gabriel, verbatim:
//   "that only applies to pro rating the call shifts, and does not apply to the
//   actual days he's obligated to work. Meaning if hes not on call, PTO, or
//   'off', he should be placed in a D slot to work."
//
//   So every arithmetic entry point below takes an OPTIONAL stated work-days
//   FTE and resolves it through `effectiveWorkDaysFte` — the ONE place the
//   "null means use fte_value" fallback lives, so no caller writes its own `??`
//   and no two surfaces can disagree. Omitting the argument (bare fixtures,
//   parity fixtures, every pre-patch43 read) is byte-identical to the
//   pre-change arithmetic.
//
//   NOTHING on the CALL side reads it: quotas, obligations, bucket targets, the
//   over-par census and the neuro bands all keep reading `fte_value`. The only
//   contract that switches is the working-days one.
//
// Every consumer (genContext budget, eligibility cap gate, solve credit
// tracking, dayShiftAutoGen cap supersession, sequenceAutoFill, the report)
// routes through this module so no two engines can disagree.

import { dayOfWeekUTC, BOOKEND_EXTENDING_TYPES, isDismissedAvailability, isActiveSellback, type SupabaseClient } from './shared';
import { ICU_WEEK_REASON, ICU_POST_CALL_REASON } from '@/lib/icuRotation';
import type { ProviderLimitEntry } from '@/lib/providerLimits';

// Major-holiday dates within [start, end] for an organization (holiday rows
// are org-wide, site_id NULL). Single home for the query both placement
// engines run (genContext's budget build; dayShiftAutoGen's working-days cap).
// Swallow-errors-to-no-majors posture: a missing/unreadable holiday table
// degrades to an empty set — every weekday counts as a working day — rather
// than aborting the load. Callers keep their own organizationId guards and
// query counting.
export async function loadMajorHolidayDates(
  sb: SupabaseClient,
  organizationId: string,
  start: string,
  end: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const { data: holidays } = await sb
      .from('holiday_calendars')
      .select('holiday_date, is_major_holiday')
      .eq('organization_id', organizationId)
      .eq('is_major_holiday', true)
      .gte('holiday_date', start)
      .lte('holiday_date', end);
    for (const h of ((holidays as Array<Record<string, unknown>> | null) || [])) {
      if (h.is_major_holiday && h.holiday_date) out.add(h.holiday_date as string);
    }
  } catch { /* holiday table missing/unreadable — treat every weekday as a working day */ }
  return out;
}

// Availability types whose covered weekdays reduce the working-days obligation
// 1:1 — planned, contractually-entitled leave. Reuses BOOKEND_EXTENDING_TYPES:
// pto / fmla / parental_leave / military_leave.
//
// JUDGMENT CALL (documented): sick / jury_duty / unavailable / blocked do NOT
// net.
//   • sick — involuntary short-term absence; the day was still owed, so it
//     surfaces as an honest "under" in the report rather than silently shrinking
//     the obligation. Not contractually-entitled planned leave.
//   • unavailable (days-off requests) — these ARE the partial's entitledOff
//     being consumed, not a reduction of the requirement.
//   • blocked-with-ICU-reason — credits as WORKED (below), not as PTO.
//   • plain blocked / jury_duty — treated like sick (honest "under").
export const PTO_NETTING_TYPES: ReadonlySet<string> = BOOKEND_EXTENDING_TYPES;

// Per-provider working-days accounting for a block. `required` is the placement
// cap (credited weekday count may not exceed it); the rest feed the report.
// (Moved beside the arithmetic below; genTypes re-exports both types.)
export interface ProviderWorkDayBudget {
  fte: number;           // CALL FTE (fte_value) — carried for reporting only
  workingDays: number;   // block working days (weekday, not major holiday)
  ptoWeekdays: number;   // working days covered by PTO-netting leave (nets 1:1)
  required: number;      // round(workFte × workingDays) − ptoWeekdays, floored at 0
  entitledOff: number;   // workingDays − round(workFte × workingDays)
  // The WORKING-DAYS FTE actually used for `required`/`entitledOff` — the
  // stated work_days_fte when the provider has one, otherwise `fte`
  // (effectiveWorkDaysFte). Optional so bare fixtures that build budgets by
  // hand stay valid; absent means "same as fte", which is what it always was.
  workDaysFte?: number;
}

export interface WorkDayBudget {
  workingDays: number;                     // |workingDaySet|
  workingDaySet: ReadonlySet<string>;      // block dates that are working days
  majorHolidayDates: ReadonlySet<string>;  // major-holiday dates within the block
  byProvider: Map<string, ProviderWorkDayBudget>;
}

// A `blocked` availability row carrying an ICU reason_code: the provider is
// working the ICU rotation (icu_week) or on their earned ICU post-call rest
// (icu_post_call). Both CREDIT as a worked day. Independent of blocking —
// availability_type 'blocked' is already in BLOCKING_AVAIL, so these rows also
// keep the provider out of call/day placement; crediting only affects the
// working-days accounting. Denied/canceled rows credit nothing.
export function creditsAsWorkedAvailability(
  entry: { availability_type: string; reason_code?: string | null; approval_status: string },
): boolean {
  if (isDismissedAvailability(entry)) return false;
  return entry.availability_type === 'blocked'
    && (entry.reason_code === ICU_WEEK_REASON || entry.reason_code === ICU_POST_CALL_REASON);
}

// A working day = a weekday (Mon–Fri) that is not a MAJOR federal holiday.
export function isWorkingDay(date: string, majorHolidayDates: ReadonlySet<string>): boolean {
  const dow = dayOfWeekUTC(date); // 0=Sun .. 6=Sat
  if (dow === 0 || dow === 6) return false; // weekend
  return !majorHolidayDates.has(date);      // major holidays on weekdays excluded
}

// Count of working days among `dates` (any iterable of ISO YYYY-MM-DD strings —
// the block's enumerated calendar span).
export function workingDaysInRange(
  dates: Iterable<string>, majorHolidayDates: ReadonlySet<string>,
): number {
  let n = 0;
  for (const d of dates) if (isWorkingDay(d, majorHolidayDates)) n++;
  return n;
}

// The set of working-day dates covered by a provider's PTO-netting availability
// rows (pending included; denied/canceled ignored). Restricted to the block's
// working-day set and deduped, so the count nets against exactly the days that
// were obligations in the first place — keeping the entitledOff identity exact.
//
// pto_sellback (2026-07-20): a working day covered by a LIVE sell-back row is
// removed from the netting set — the sold-back day is OWED AGAIN (the chief
// bought the PTO back; the provider works it). It credits as worked only when
// an assignment actually lands on it, via the normal placement credit path
// (creditWorkedDay) — a standalone sell-back row credits nothing. With zero
// sell-back rows the subtraction pass no-ops (byte-identical netting).
export function ptoWeekdaysCovered(
  entries: ReadonlyArray<{ availability_type: string; start_date: string; end_date: string; approval_status: string }>,
  workingDaySet: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    if (isDismissedAvailability(e)) continue;
    if (!PTO_NETTING_TYPES.has(e.availability_type)) continue;
    for (const d of workingDaySet) {
      if (e.start_date <= d && d <= e.end_date) out.add(d);
    }
  }
  for (const e of entries) {
    if (out.size === 0) break;
    if (!isActiveSellback(e)) continue;
    for (const d of [...out]) {
      if (e.start_date <= d && d <= e.end_date) out.delete(d);
    }
  }
  return out;
}

// ── The working-days FTE (2026-07-29, patch43) ──────────────────────────────
// THE SINGLE HOME for "which FTE does the working-days contract multiply by".
// A provider may state a `work_days_fte` on their employment profile that is
// independent of their call `fte_value`; NULL/absent (every provider on file
// before this shipped) means "same as the call FTE", so the whole codebase's
// numbers are unchanged until somebody deliberately states one.
//
// Rejects non-finite and negative values by falling back to the call FTE —
// garbage in a nullable numeric column must never silently zero out someone's
// obligation. The 0..1 range is enforced at the two write gates (the DB CHECK
// and validateAndSplitPatch); a stated 0 is legitimate and IS honored (a
// provider who owes calls but no working days), which is why the guard tests
// `< 0` rather than `<= 0`.
export function effectiveWorkDaysFte(callFte: number, workDaysFte?: number | null): number {
  if (workDaysFte == null) return callFte;
  const n = Number(workDaysFte);
  if (!Number.isFinite(n) || n < 0) return callFte;
  return n;
}

// requiredWorkDays = round(workFte × WD) − pto, floored at 0. Half-up rounding
// (Math.round): 10.5 → 11. `workDaysFte` omitted/null ⇒ workFte = fte, i.e.
// the pre-patch43 formula exactly.
export function requiredWorkDays(
  fte: number, workingDays: number, ptoWeekdays: number, workDaysFte?: number | null,
): number {
  return Math.max(
    0, Math.round(effectiveWorkDaysFte(fte, workDaysFte) * workingDays) - ptoWeekdays);
}

// entitledOffDays = WD − round(workFte × WD), floored at 0. Independent of PTO.
// A provider whose work-days FTE is 1.0 is entitled to zero off days no matter
// what their call FTE is — that is the whole point of the split.
export function entitledOffDays(
  fte: number, workingDays: number, workDaysFte?: number | null,
): number {
  return Math.max(
    0, workingDays - Math.round(effectiveWorkDaysFte(fte, workDaysFte) * workingDays));
}

// ── Provider-limit working-days override (2026-07-22, patch34) ──────────────
// The STATED working-days cap from a provider-limit entry, or null when the
// entry states none. Single-homed beside the netting formula it reuses:
//   workingDays entry → that number, AS ENTERED.
//   daysOff entry     → WD − ptoWeekdays − daysOff (same 1:1 netting as
//                       requiredWorkDays; floored at 0). Re-derived at every
//                       generation so later PTO changes shift it — live-lever
//                       discipline: the stored daysOff is never frozen into a
//                       converted number.
// workingDays and daysOff are mutually exclusive at the parse gate
// (parseProviderLimits); if a hand-edited row carries both, workingDays wins
// deterministically.
export function statedWorkingDaysCap(
  limit: ProviderLimitEntry | undefined,
  workingDays: number,
  ptoWeekdays: number,
): number | null {
  if (limit?.workingDays != null) return Math.max(0, limit.workingDays);
  if (limit?.daysOff != null) return Math.max(0, workingDays - ptoWeekdays - limit.daysOff);
  return null;
}

// `required` with the optional provider-limit override. BLANK limit → the
// existing round(FTE × WD) − PTO machinery UNTOUCHED (Gabriel, verbatim and
// binding: "if the working days allowed or days off is left empty, continue
// to use the current FTE derived workday budget that is already in place").
//
// PRECEDENCE (2026-07-29): the per-SCHEDULE Limits-tab cap still wins over the
// per-PROVIDER work-days FTE. The limit is a deliberate one-block override the
// scheduler typed for this schedule; the work-days FTE is the standing
// contract the formula falls back to. Stated limit > work_days_fte > fte_value.
export function requiredWorkDaysWithLimit(
  fte: number,
  workingDays: number,
  ptoWeekdays: number,
  limit: ProviderLimitEntry | undefined,
  workDaysFte?: number | null,
): number {
  return statedWorkingDaysCap(limit, workingDays, ptoWeekdays)
    ?? requiredWorkDays(fte, workingDays, ptoWeekdays, workDaysFte);
}

// Credit ledger writer (single home): mark `date` as a worked day for `pid`.
// Skips non-working dates (weekend / major holiday placements consume nothing)
// and dedupes per (provider, date) via the Set. Both placement engines route
// their credit writes through this (solve's creditWorkDay wrapper on
// SolveState.creditedWorkDays; dayShiftAutoGen's creditDay on its
// creditedDaysByPid) so the crediting rules cannot drift.
export function creditWorkedDay(
  ledger: Map<string, Set<string>>,
  workingDaySet: ReadonlySet<string>,
  pid: string,
  date: string,
): void {
  if (!workingDaySet.has(date)) return; // weekend / major holiday: no credit
  let set = ledger.get(pid);
  if (!set) { set = new Set(); ledger.set(pid, set); }
  set.add(date);
}

// Cap predicate: would placing `date` block the provider under the working-days
// cap? True only when the date is a working day the provider is not ALREADY
// credited for (a placement on an already-credited day consumes no new credit)
// AND their credited count has reached `required`. Weekend / major-holiday
// dates are exempt (not working days → never consume a credit).
export function exceedsWorkDayCap(
  date: string,
  workingDaySet: ReadonlySet<string>,
  creditedDays: ReadonlySet<string> | undefined,
  required: number,
): boolean {
  if (!workingDaySet.has(date)) return false;   // non-working day: exempt
  if (creditedDays?.has(date)) return false;    // not a NEW credit
  return (creditedDays?.size ?? 0) >= required;
}
