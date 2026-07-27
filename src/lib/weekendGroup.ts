// Weekend grouping — THE definition of "one weekend" for this app
// (Gabriel 2026-07-22, stated for no-call requests: "A no weekend call (no
// Friday, no Saturday and no Sunday call) is considered one request not
// three"). A weekend is the Fri/Sat/Sun triple, keyed by its SATURDAY.
//
// Lived in validation/requestIntake.ts until 2026-07-27; moved here (pure,
// zod-free) so the Call Counts modal's Obligatory Weekends column can share
// the same grouping without pulling the request-intake schemas into the
// schedule-page bundle. requestIntake re-exports both functions, so every
// existing import keeps working and there is still ONE definition.

import { addDays, dayOfWeekUTC } from './rulesEngine/shared';

/** Saturday (YYYY-MM-DD) of the Fri/Sat/Sun weekend containing `date`;
 * null for Mon–Thu. */
export function weekendGroupKey(date: string): string | null {
  const dow = dayOfWeekUTC(date);
  if (dow === 5) return addDays(date, 1);   // Fri → its Saturday
  if (dow === 6) return date;               // Sat → itself
  if (dow === 0) return addDays(date, -1);  // Sun → its Saturday
  return null;
}

/** The [Fri, Sat, Sun] dates of `date`'s weekend group; [] for Mon–Thu. */
export function weekendGroupDates(date: string): string[] {
  const sat = weekendGroupKey(date);
  return sat ? [addDays(sat, -1), sat, addDays(sat, 1)] : [];
}
