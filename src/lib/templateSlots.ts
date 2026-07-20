// Slot-materialization template semantics (2026-07-20) — extracted VERBATIM
// from the schedules POST route (src/app/api/scheduling/schedules/route.ts)
// so the Physician Planner's template→slot-count estimates consume the EXACT
// rules real slot creation uses. Both the route and src/lib/plannerMath.ts
// import from here; neither re-implements any of it, so a planner estimate
// can never diverge from what a created schedule actually materializes
// (the Friday union in particular — an estimate that missed it would lie
// about every Friday's slate).
//
// Pure functions only — no I/O, vitest-covered directly.

import { dayOfWeekUTC, dayTypeFromDow } from './rulesEngine/shared';

// Minimal structural shape the union needs. Route rows (Record<string,
// unknown>) and the planner's aggregated rows both satisfy it.
export interface TemplateUnionRow {
  day_type?: unknown;
  shift_type_id?: unknown;
}

// The template slate that materializes for one day of `dayType`.
//
// FRIDAY PARTIAL-OVERRIDE CONTRACT (2026-07-16): friday-specific templates
// override PER SHIFT TYPE; weekday templates whose shift_type_id has no
// friday-specific row still materialize. The old fallback was all-or-nothing
// (`matching.length === 0`), so the moment ANY friday template existed
// (patch25 added friday C3 + D4) every Friday silently lost its whole weekday
// slate — C1/C2/D1-D7 slots were never created and the engine had nothing to
// fill. Zero friday rows still yields the pure weekday slate (previous
// fallback preserved); a friday row with required_count 0 deliberately
// suppresses that shift type on Fridays (see templateSlotCount). Saturday/
// sunday slates are complete and intentionally distinct — no union there.
export function slateForDayType<T extends TemplateUnionRow>(
  templates: readonly T[],
  dayType: string,
): T[] {
  let matching = templates.filter(t => t.day_type === dayType);
  if (dayType === 'friday') {
    const fridaySpecificShiftTypes = new Set(matching.map(t => t.shift_type_id));
    const weekdayFill = templates.filter(t =>
      t.day_type === 'weekday' && !fridaySpecificShiftTypes.has(t.shift_type_id));
    matching = [...matching, ...weekdayFill];
  }
  return matching;
}

// How many sibling slots one template row materializes per day:
// required_count <= 0 means "no slots for this template" — never coerce 0 to 1
// (Task 11 review finding). null/undefined keep the default of 1.
export function templateSlotCount(tmpl: { required_count?: unknown }): number {
  const count = (tmpl.required_count as number | null | undefined) ?? 1;
  return count <= 0 ? 0 : count;
}

// derived_day_type for a date given its (possible) holiday row — the same
// major/federal/DOW precedence the route stamps onto schedule_slots.
// Single-homed DOW→dayType map (shared.dayTypeFromDow); UTC DOW equals the
// old local-noon getDay() for offsets in (-12,+12] — every deployed target.
export function derivedDayTypeFor(
  date: string,
  holiday: { is_major_holiday: boolean } | null | undefined,
): string {
  if (holiday && holiday.is_major_holiday) return 'major_holiday';
  if (holiday) return 'federal_holiday';
  return dayTypeFromDow(dayOfWeekUTC(date));
}
