// Shared helpers for the scheduling rules engine.
//
// Split out of autoGenerate.ts and dayShiftAutoGen.ts after both files
// ended up with their own near-identical copies of date math, availability
// constants, PTO bookend logic, etc. Everything in here is pure
// (no I/O, no mutable state) — the two schedulers own their own query
// boilerplate and call into this module for the fiddly math.

import type { CandidateProvider, AvailabilityEntry, SlotToFill } from './genTypes';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SupabaseClient = any;

// Availability types that block an assignment entirely. A provider with
// any entry of one of these types covering the slot date is not eligible.
export const BLOCKING_AVAIL: ReadonlySet<string> = new Set([
  'pto', 'sick', 'fmla', 'parental_leave', 'military_leave',
  'jury_duty', 'unavailable', 'blocked',
]);

// An availability entry the scheduler ignores entirely: the request was
// denied or canceled. Counterpart of isBlockingAvailability for availability
// types outside BLOCKING_AVAIL (e.g. no_call_request soft flags) that still
// need the same status semantics.
export function isDismissedAvailability(entry: { approval_status: string }): boolean {
  return entry.approval_status === 'denied' || entry.approval_status === 'canceled';
}

// Single-home predicate for a LIVE no-call request (2026-07-17). NOT a
// blocking type — the request is algorithm-arbitrated (soft): the call
// engine's scoreCall drops live requesters a sort tier (solve.ts) and
// validation soft-flags any call that still lands on one (evaluators.ts
// timeOff). Both consumers route through here so they can never disagree
// about which requests are live (pending counts; denied/canceled don't).
export function isActiveNoCallRequest(
  entry: { availability_type: string; approval_status: string },
): boolean {
  return entry.availability_type === 'no_call_request' && !isDismissedAvailability(entry);
}

// Canonical "does this availability entry block scheduling?" predicate
// (clinical invariant 2 / spec §6.7): PENDING requests BLOCK — only entries
// explicitly denied or canceled are ignored. Every engine (call gen, day-shift
// gen, eligibility, pre-PTO placement, validation) must route through this so
// no two engines can disagree about a pending request.
export function isBlockingAvailability(
  entry: { availability_type: string; approval_status: string },
): boolean {
  return !isDismissedAvailability(entry) && BLOCKING_AVAIL.has(entry.availability_type);
}

// Multi-day planned-leave types that also trigger a weekend-bookend
// extension. Ad-hoc single-day types (sick, jury_duty, unavailable,
// blocked) are intentionally left out — extending them would swallow
// weekends for one-off days that shouldn't.
export const BOOKEND_EXTENDING_TYPES: ReadonlySet<string> = new Set([
  'pto', 'fmla', 'parental_leave', 'military_leave',
]);

// ── Validation lookback/lookahead windows (days) ────────────────────────────
// Shared by the serial (loadContext) and batch (batchValidate) validation
// paths so their windows cannot drift — batch/serial parity depends on it.
//
// NEIGHBOR_WINDOW_DAYS: a provider's other assignments around the slot; ±31
// so frequency/fairness checks see a full month on each side.
// AVAIL_WINDOW_DAYS: PTO/unavailability rows around the slot; ±14 covers the
// weekend-adjacent-PTO check's widest reach.
export const NEIGHBOR_WINDOW_DAYS = 31;
export const AVAIL_WINDOW_DAYS = 14;

// ── Date math (YYYY-MM-DD strings, no Date objects leaking) ─────────────────

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function dayOfWeekUTC(iso: string): number {
  return new Date(iso + 'T00:00:00Z').getUTCDay(); // 0=Sun..6=Sat
}

// Day-of-week → derived day type. Single home for the DOW fallback mapping
// (sequenceOwnership's out-of-block anchors; test fixtures). Holiday typing is
// unknowable from the DOW alone — callers relying on this fallback must scope
// holiday day types together with 'weekday' (every shipped pattern does).
export function dayTypeFromDow(dow: number): string {
  return dow === 6 ? 'saturday' : dow === 0 ? 'sunday' : dow === 5 ? 'friday' : 'weekday';
}

// Monday of the (Mon-Sun) week containing `iso`. If iso is a Sunday,
// returns the Monday 6 days prior.
export function mondayOfWeek(iso: string): string {
  const dow = dayOfWeekUTC(iso);
  const daysBack = dow === 0 ? 6 : dow - 1;
  return addDays(iso, -daysBack);
}

// Thursday of the week BEFORE the week containing `iso`. Used by the
// pre-PTO Thursday placement rule.
export function thursdayBeforeWeekOf(iso: string): string {
  return addDays(mondayOfWeek(iso), -4);
}

export function datesOverlap(rangeStart: string, rangeEnd: string, date: string): boolean {
  return rangeStart <= date && rangeEnd >= date;
}

// Whole-day difference (to - from) in UTC days. Positive when `to` is later.
// Inputs are YYYY-MM-DD strings parsed at UTC midnight, so this is DST-safe.
export function daysBetween(from: string, to: string): number {
  const f = new Date(from + 'T00:00:00Z').getTime();
  const t = new Date(to + 'T00:00:00Z').getTime();
  return Math.round((t - f) / 86400000);
}

// ── PTO bookend extension ──────────────────────────────────────────────────

// Given an availability entry's dates + type, return the effective
// blocked range after applying the weekend-bookend rule:
//
//   - extend back 2 days if PTO starts on a Monday (captures Sat before)
//   - extend forward 2 days if PTO ends on a Friday (captures Sun after)
//
// PTO that starts/ends on a weekend day is left alone — the weekend is
// already inside the range.
export function effectivePtoRange(
  entry: { start_date: string; end_date: string; availability_type: string },
): { start: string; end: string } {
  if (!BOOKEND_EXTENDING_TYPES.has(entry.availability_type)) {
    return { start: entry.start_date, end: entry.end_date };
  }
  const startDow = dayOfWeekUTC(entry.start_date); // 0=Sun..6=Sat
  const endDow = dayOfWeekUTC(entry.end_date);
  return {
    start: startDow === 1 ? addDays(entry.start_date, -2) : entry.start_date,
    end: endDow === 5 ? addDays(entry.end_date, 2) : entry.end_date,
  };
}

// ── Provider availability normalization ────────────────────────────────────

// Coerce the jsonb `available_weekdays` into a guaranteed 7-element bool
// array indexed Sun..Sat. Nullable / malformed values collapse to all-true.
export function normalizeWeekdays(v: unknown): boolean[] {
  const out = [true, true, true, true, true, true, true];
  if (!Array.isArray(v)) return out;
  for (let i = 0; i < 7; i++) {
    if (typeof v[i] === 'boolean') out[i] = v[i];
  }
  return out;
}

// ── Bucket keys ────────────────────────────────────────────────────────────

// Collapse day-of-week into the group used for FTE-proportional call-fairness
// quotas. Saturday and Sunday each get their OWN bucket (they used to share a
// merged 'weekend' bucket) so weekend fairness is tracked per-day: a provider's
// Saturday call load no longer offsets a Sunday deficit, and across successive
// blocks call-takers rotate through Saturday and Sunday evenly instead of one
// person accumulating all the Saturdays. Friday and weekday stand alone; the two
// holiday types still lump into one 'holiday' bucket (out of scope for the split).
export function dayTypeBucket(dt: string): string {
  if (dt === 'weekday') return 'weekday';
  if (dt === 'friday') return 'friday';
  if (dt === 'saturday') return 'saturday';
  if (dt === 'sunday') return 'sunday';
  if (dt === 'federal_holiday' || dt === 'major_holiday') return 'holiday';
  return dt;
}

// ── Pre-PTO Thursday placement index ────────────────────────────────────────

// Thursday-of-prior-week -> providers with blocking leave that week. Drives
// the pre_pto placement pass (give PTO-bound providers their call before they
// leave). Pure: precomputed once in genContext, but solve keeps it as a
// fallback so bare fixtures (no precomputed field) still work.
//
// Uses isBlockingAvailability — spec §6.7: pending PTO blocks everywhere, so a
// pending request must also EARN the Thursday placement. A provider whose
// request is merely awaiting approval is treated exactly like an approved one.
export function buildPrePtoByThursday(
  providers: CandidateProvider[],
  availByPid: Map<string, AvailabilityEntry[]>,
  slotIndex: Map<string, Map<string, SlotToFill>>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const p of providers) {
    for (const a of availByPid.get(p.id) || []) {
      if (!isBlockingAvailability(a)) continue;
      const thu = thursdayBeforeWeekOf(a.start_date);
      if (!slotIndex.has(thu)) continue;
      const set = out.get(thu) || new Set<string>();
      set.add(p.id);
      out.set(thu, set);
    }
  }
  return out;
}
