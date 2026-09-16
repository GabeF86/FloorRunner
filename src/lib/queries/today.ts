/** Today as a plain calendar date.
 *
 * Everything in this app works in YYYY-MM-DD — a slot_date is a calendar day,
 * not an instant — so the only thing that can go wrong is slipping a day west
 * of GMT when the server clock is UTC. Shifting by the offset before taking
 * the ISO date is what prevents that. */
export function todayIso(now: Date = new Date()): string {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString().slice(0, 10);
}
