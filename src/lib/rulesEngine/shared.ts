// Shared helpers for the scheduling rules engine.
//
// Split out of autoGenerate.ts and dayShiftAutoGen.ts after both files
// ended up with their own near-identical copies of date math, availability
// constants, PTO bookend logic, etc. Everything in here is pure
// (no I/O, no mutable state) — the two schedulers own their own query
// boilerplate and call into this module for the fiddly math.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SupabaseClient = any;

// Availability types that block an assignment entirely. A provider with
// any entry of one of these types covering the slot date is not eligible.
export const BLOCKING_AVAIL: ReadonlySet<string> = new Set([
  'pto', 'sick', 'fmla', 'parental_leave', 'military_leave',
  'jury_duty', 'unavailable', 'blocked',
]);

// Multi-day planned-leave types that also trigger a weekend-bookend
// extension. Ad-hoc single-day types (sick, jury_duty, unavailable,
// blocked) are intentionally left out — extending them would swallow
// weekends for one-off days that shouldn't.
export const BOOKEND_EXTENDING_TYPES: ReadonlySet<string> = new Set([
  'pto', 'fmla', 'parental_leave', 'military_leave',
]);

// ── Date math (YYYY-MM-DD strings, no Date objects leaking) ─────────────────

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function dayOfWeekUTC(iso: string): number {
  return new Date(iso + 'T00:00:00Z').getUTCDay(); // 0=Sun..6=Sat
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

// Collapse day-of-week into the group used for FTE-proportional quotas.
// Saturday + Sunday share one "weekend" bucket so fractional FTE targets
// (e.g. 1.44 for a 0.6 FTE) have enough granularity to distinguish from
// integer assignments. Holidays lump together regardless of major/federal.
export function dayTypeBucket(dt: string): string {
  if (dt === 'weekday') return 'weekday';
  if (dt === 'friday') return 'friday';
  if (dt === 'saturday' || dt === 'sunday') return 'weekend';
  if (dt === 'federal_holiday' || dt === 'major_holiday') return 'holiday';
  return dt;
}
