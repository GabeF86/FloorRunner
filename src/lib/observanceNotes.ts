// Observance notes — small labels under a date on the grid (Gabriel
// 2026-07-31: "add the major jewish holidays to the schedule, dont highlight
// the cells , just put small text in the date cell with the name of the
// holiday, example YK Sundown , YK day , RH sundown , RH, RH etc...").
//
// LABELS ONLY. These are deliberately NOT scheduling.holiday_calendars rows.
// A holiday row changes `derived_day_type`, which changes which shift
// TEMPLATES materialize, which day-type bucket a call is charged to, and how
// the pattern chains fire — the Columbus Day episode (2026-07-29) is exactly
// what that costs. A note changes nothing: it does not tint the cell, does not
// reach the engine, and nothing but the date header reads this module. If a
// practice later wants one of these to actually suppress staffing, that is a
// holiday_calendars row and a deliberate decision, not this.
//
// WHY A DATE TABLE RATHER THAN HEBREW-CALENDAR ARITHMETIC. Converting
// Gregorian↔Hebrew correctly (Metonic cycle, the four postponement rules) is
// far more code than a schedule app should carry for a caption, and getting it
// subtly wrong would put Yom Kippur on the wrong day — worse than not showing
// it. A reviewed table is auditable: every date below can be checked at a
// glance against a calendar, which is the property that matters here.
//
// CONSISTENCY CHECK on the 5787 entries (autumn 2026). The Hebrew calendar
// forbids Rosh Hashanah on Sunday, Wednesday or Friday ("lo ADU rosh"), and
// forbids Yom Kippur on Sunday, Tuesday or Friday. Below, RH day 1 is a
// SATURDAY and Yom Kippur a MONDAY — both permitted, and YK sits exactly 9
// days after RH day 1 as it must. That does not prove the year is right, but
// an internally inconsistent table would fail it.

export interface ObservanceNote {
  /** ISO date (UTC-anchored, like every date in this app). */
  date: string;
  /** Short caption. Kept terse — this renders at 9px under the date. */
  label: string;
}

/** Autumn 5787 (September–October 2026) — the major Jewish holidays that fall
 *  inside a late-2026 block, each with its sundown eve.
 *
 *  Only YAMIM TOVIM and their eves are listed. The intermediate days of Sukkot
 *  (Chol HaMoed) are ordinary working days and captioning them would put text
 *  under nearly a fortnight of the grid for no scheduling meaning.
 *
 *  ADDING A YEAR: append entries. Nothing else needs to change — the lookup
 *  and the renderer are date-driven. */
export const OBSERVANCE_NOTES: readonly ObservanceNote[] = [
  // Rosh Hashanah 5787 — eve Fri 11 Sep, days Sat 12 / Sun 13 Sep 2026.
  { date: '2026-09-11', label: 'RH sundown' },
  { date: '2026-09-12', label: 'RH day 1' },
  { date: '2026-09-13', label: 'RH day 2' },
  // Yom Kippur — eve Sun 20 Sep, day Mon 21 Sep 2026.
  { date: '2026-09-20', label: 'YK sundown' },
  { date: '2026-09-21', label: 'YK day' },
  // Sukkot — eve Fri 25 Sep, first two days Sat 26 / Sun 27 Sep 2026.
  { date: '2026-09-25', label: 'Sukkot sundown' },
  { date: '2026-09-26', label: 'Sukkot day 1' },
  { date: '2026-09-27', label: 'Sukkot day 2' },
  // Shemini Atzeret — eve Fri 2 Oct, day Sat 3 Oct 2026.
  { date: '2026-10-02', label: 'Sh. Atzeret sundown' },
  { date: '2026-10-03', label: 'Sh. Atzeret' },
  // Simchat Torah — eve Sat 3 Oct (so 3 Oct carries two), day Sun 4 Oct 2026.
  { date: '2026-10-03', label: 'S. Torah sundown' },
  { date: '2026-10-04', label: 'S. Torah' },
];

/** date → labels, in table order. A date may carry more than one: 3 Oct 2026
 *  is Shemini Atzeret AND the eve of Simchat Torah. */
export function observanceNotesByDate(
  notes: readonly ObservanceNote[] = OBSERVANCE_NOTES,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const n of notes) {
    const list = out.get(n.date);
    if (list) list.push(n.label); else out.set(n.date, [n.label]);
  }
  return out;
}

/** The one-line caption for a date, or null. Multiple observances are joined
 *  with a middot — at 9px there is no room for two lines. */
export function observanceLabelFor(
  date: string, byDate: ReadonlyMap<string, string[]>,
): string | null {
  const list = byDate.get(date);
  return list && list.length > 0 ? list.join(' · ') : null;
}
