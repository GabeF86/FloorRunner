/* ───────────────────────────────────────────────────────────────────────────
 * Availability-aware candidate ordering — an EXPERIMENTAL tier for scoreCall.
 *
 * ── THE PROBLEM ───────────────────────────────────────────────────────────
 * The greedy construction loop places a slot and never reconsiders it. Its
 * candidate sort ranks on fairness (lifetime ratio) and recency, and nothing
 * in that tuple knows that one candidate is away for half the block and the
 * other is here all of it. At week 1 they look identical, so the tie falls to
 * a hash — and by the time the heavy-PTO provider's leave arrives, the weeks
 * they could have covered are gone.
 *
 * The call quota makes this bite harder than it looks. `required` (working
 * days) nets PTO 1:1, but the call target does NOT — it is
 * `blockTotal / par × fte`, with no leave term anywhere. So a provider away
 * half the block owes the whole obligation with half the window to meet it,
 * and nothing places them early to protect that.
 *
 * ── TWO CANDIDATE HEURISTICS, DELIBERATELY BOTH ───────────────────────────
 * They are different ideas and it is not obvious which is better, so this
 * module implements both and the harness measures them rather than assuming:
 *
 *   'scarcity'      Fewest remaining eligible dates first. The classical
 *                   most-constrained-variable rule: spend the scarce resource
 *                   while it exists. Counts FORWARD from the slot date —
 *                   "how many chances do you have left", not "how many did
 *                   you have".
 *
 *   'pto_distance'  Furthest from your own next leave first (Gabriel
 *                   2026-09-22). A distance rather than a count: it pushes
 *                   each provider's calls away from their own PTO, which
 *                   front-loads people whose leave is late and back-loads
 *                   people whose leave is early.
 *
 * A KNOWN ASYMMETRY in 'pto_distance', stated rather than smoothed over: a
 * provider with NO leave at all has infinite distance and therefore always
 * sorts first. That is the literal reading of the rule, and it is the exact
 * behaviour the scarcity heuristic exists to avoid — so the two may pull in
 * opposite directions for the no-leave providers. 'pto_distance_capped'
 * clamps the no-leave case to the block horizon so they rank as "far but
 * finite" instead of "ahead of everyone".
 *
 * ── A TIER, NEVER A GATE ──────────────────────────────────────────────────
 * Like every other term in scoreCall, this only reorders candidates who have
 * ALREADY passed every eligibility gate. It cannot strand a slot, cannot
 * place anyone on leave, and cannot override a clinical block.
 * ─────────────────────────────────────────────────────────────────────────── */

import { isDateBlocked } from './shared';
import type { AvailabilityEntry } from './genTypes';

export type CandidateTierStrategy =
  | 'none'
  | 'scarcity'
  | 'pto_distance'
  | 'pto_distance_capped';

/** Sort key for one candidate. Lower sorts first, matching every other term
 *  in scoreCall's comparator. */
export type TierKey = number;

const DAY_MS = 86_400_000;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/**
 * How many dates from `from` onward this provider is NOT blocked on.
 *
 * Counts the schedule's own dates, so a block with gaps is measured in days
 * that actually exist rather than in calendar days. Bookend is applied: the
 * days a PTO block reaches into are not chances either.
 */
export function remainingEligibleDates(
  entries: ReadonlyArray<AvailabilityEntry>,
  scheduleDates: ReadonlyArray<string>,
  from: string,
): number {
  let n = 0;
  for (const d of scheduleDates) {
    if (d < from) continue;
    if (!isDateBlocked(entries, d, { bookend: true })) n++;
  }
  return n;
}

/**
 * Days from `from` to this provider's nearest blocking leave, in either
 * direction. Infinity when they have none in the window.
 *
 * Nearest in EITHER direction on purpose: leave that just ended constrains a
 * provider as much as leave about to start — the week after a fortnight away
 * is when they are catching up, and it is also when §6.5 is still excluding
 * their weekends.
 */
export function daysToNearestLeave(
  entries: ReadonlyArray<AvailabilityEntry>,
  scheduleDates: ReadonlyArray<string>,
  from: string,
): number {
  let best = Infinity;
  for (const d of scheduleDates) {
    if (!isDateBlocked(entries, d, { bookend: true })) continue;
    const gap = Math.abs(daysBetween(from, d));
    if (gap < best) best = gap;
  }
  return best;
}

/**
 * The tier key for one candidate under one strategy.
 *
 * Returns 0 for every candidate under 'none', which makes the term inert and
 * the comparator byte-identical to the pre-change engine — the property the
 * golden-parity pins depend on.
 */
export function tierKeyFor(
  strategy: CandidateTierStrategy,
  entries: ReadonlyArray<AvailabilityEntry>,
  scheduleDates: ReadonlyArray<string>,
  slotDate: string,
): TierKey {
  if (strategy === 'none') return 0;

  if (strategy === 'scarcity') {
    // Ascending: fewest chances left sorts first.
    return remainingEligibleDates(entries, scheduleDates, slotDate);
  }

  const gap = daysToNearestLeave(entries, scheduleDates, slotDate);
  if (strategy === 'pto_distance') {
    // Descending distance → negate, so "furthest from leave" sorts first.
    // Infinity negates to -Infinity: a provider with no leave outranks
    // everyone, which is the literal rule and is measured, not assumed.
    return -gap;
  }
  // Capped: no leave in the window reads as the block horizon, so a
  // never-absent provider is "far" but does not dominate the tier.
  const horizon = scheduleDates.length;
  return -(Number.isFinite(gap) ? Math.min(gap, horizon) : horizon);
}
