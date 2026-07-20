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
// Every consumer (genContext budget, eligibility cap gate, solve credit
// tracking, dayShiftAutoGen cap supersession, sequenceAutoFill, the report)
// routes through this module so no two engines can disagree.

import { dayOfWeekUTC, BOOKEND_EXTENDING_TYPES, isDismissedAvailability, type SupabaseClient } from './shared';
import { ICU_WEEK_REASON, ICU_POST_CALL_REASON } from '@/lib/icuRotation';

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
  return out;
}

// requiredWorkDays = round(fte × WD) − pto, floored at 0. Half-up rounding
// (Math.round): 10.5 → 11.
export function requiredWorkDays(fte: number, workingDays: number, ptoWeekdays: number): number {
  return Math.max(0, Math.round(fte * workingDays) - ptoWeekdays);
}

// entitledOffDays = WD − round(fte × WD), floored at 0. Independent of PTO.
export function entitledOffDays(fte: number, workingDays: number): number {
  return Math.max(0, workingDays - Math.round(fte * workingDays));
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
