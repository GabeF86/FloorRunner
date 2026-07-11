// PostgREST embed-shape normalizer.
//
// scheduling.assignments carries UNIQUE(schedule_slot_id) (migration
// 20260524000000_add_assignment_unique_constraints.sql). PostgREST detects
// the unique FK and treats the schedule_slots → assignments embed as
// ONE-TO-ONE, returning a SINGLE OBJECT (or null) instead of an array.
// Dev fakes and pre-constraint databases return arrays for the same select.
//
// Every consumer of an `assignments(...)` embed off schedule_slots must
// normalize through this helper at its parse seam so both shapes work.
// (Embeds in the other direction — assignments → schedule_slots/providers —
// are many-to-one and unaffected.)
export function embedArray<T>(v: T | T[] | null | undefined): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
