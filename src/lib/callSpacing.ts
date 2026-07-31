// Call spacing review (Gabriel 2026-07-31: "identify providers with C1 calls
// that are spaced too close together and options to swap with them other call
// takers that are available").
//
// WHAT THIS IS NOT. The engine already weighs proximity — scoreCall carries a
// recency tier, and spacingScore.ts is a full lexicographic spacing objective.
// This module does not re-implement either. It answers the REVIEW question the
// engine cannot: given a schedule that already exists, which pairs are too
// close, and who could take one of them instead without simply moving the
// problem onto themselves.
//
// SCOPED TO ONE CALL CODE, by parent code (a split C1D12/C1N12 counts as its
// parent C1). Gabriel asked about C1 specifically and the distinction matters:
// a Sat C2 → Sun C1 pair is one day apart BY DESIGN — the weekend block chain
// puts them on the same doc on purpose — so mixing codes would report the
// pattern's own structure as a defect. Same-code pairs have no such excuse.
//
// GAP is calendar days between consecutive same-code calls. Post-call rest
// already makes gap 1 impossible for a rest-requiring code, so the interesting
// range starts at 2 — which is exactly what the live Paoli block shows (four
// C1 pairs at 2 days, three at 3, none at 1).
//
// ONLY A WEEKDAY CALL IS SWAPPABLE (Gabriel 2026-07-31: "i cant swap weekday
// calls because they are fixed chains, I want to focus only on Weekday C1
// calls that are too close in proximity to either weekend C1's or other
// weekday C1's"). Every weekend-bucket C1 is chain-locked by the pattern: a
// Friday C1 anchors the Sunday C2 two days later, and the Sat/Sun C1s ride the
// weekend block chains that bundle a whole weekend onto one doc. Reassigning
// one severs a designed pairing, so it is not a real option and offering it
// wastes the reviewer's time. A WEEKDAY C1 carries no call chain — only a −1
// D2 pre-fill and its post-call rest day, both of which the ordinary
// assignment path already rewrites — so it is the one end that can actually
// move.
//
// The BUCKET is the engine's own (dayTypeBucketOn), so a holiday counts as the
// day of the week it falls on and Friday is correctly weekend-side rather than
// lumped in with M–Th.

import { dayTypeBucketOn } from './rulesEngine/shared';

/** Grid-shaped slot. Structural subset of the schedule page's Slot. */
export interface SpacingSlot {
  id: string;
  slot_date: string;
  /** schedule_slots.derived_day_type — folded through the engine's
   *  dayTypeBucketOn so a holiday lands on its real day of the week. */
  derived_day_type?: string | null;
  shift_types: {
    code: string;
    category: string;
    parent_call_code?: string | null;
  } | null;
  assignments?: ReadonlyArray<{
    id?: string;
    provider_id?: string | null;
  }> | null;
}

/** One call a provider holds, in date order. */
export interface CallHeld {
  date: string;
  slotId: string;
  assignmentId: string | null;
  /** The code actually stored (a segment keeps its own code for display). */
  code: string;
  /** Engine fairness bucket: weekday | friday | saturday | sunday. */
  bucket: string;
}

/** The one bucket whose calls carry no pattern call-chain, and so are the only
 *  ones a swap can actually move. See the header. */
export const SWAPPABLE_BUCKET = 'weekday';

/** Two consecutive same-code calls closer together than the threshold. */
export interface TightPair {
  providerId: string;
  earlier: CallHeld;
  later: CallHeld;
  /** Calendar days between them. */
  gap: number;
  /** The member(s) that can actually be reassigned — weekday-bucket only.
   *  Never empty in a returned pair: a pair with no swappable end is not
   *  reported at all (see findTightPairs). */
  swappable: CallHeld[];
}

const DAY_MS = 86_400_000;

/** Whole days between two ISO dates, UTC — DST-safe (the app's date-math
 *  convention: parse at UTC midnight, never local). */
export function daysBetweenDates(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

const parentOf = (st: SpacingSlot['shift_types']): string =>
  (st?.parent_call_code || st?.code) ?? '';

/** Every call of `code` (by PARENT code) each provider holds, date-ascending.
 *  Exported because the swap ranking needs the same holdings the pair finder
 *  used — two derivations could disagree about what a provider already has. */
export function callsByProvider(
  slots: readonly SpacingSlot[], code: string,
): Map<string, CallHeld[]> {
  const out = new Map<string, CallHeld[]>();
  for (const slot of slots) {
    const st = slot.shift_types;
    if (st?.category !== 'call' || parentOf(st) !== code) continue;
    for (const a of slot.assignments ?? []) {
      if (!a.provider_id) continue;
      const list = out.get(a.provider_id) ?? [];
      list.push({
        date: slot.slot_date, slotId: slot.id,
        assignmentId: a.id ?? null, code: st.code,
        bucket: dayTypeBucketOn(slot.derived_day_type ?? '', slot.slot_date),
      });
      out.set(a.provider_id, list);
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/** Consecutive same-code pairs at or under `maxGap` days, tightest first.
 *
 *  ONLY pairs with at least one WEEKDAY-bucket member are returned — the rest
 *  are chain-locked on both ends and nothing can be done about them, so
 *  listing them is noise. `excludedChainLocked` on the result of
 *  `reviewTightPairs` reports how many were dropped, so the omission is
 *  visible rather than silent.
 *
 *  A provider with three calls two days apart yields TWO pairs — each is a
 *  separately fixable adjacency, and collapsing them would hide one. */
export function findTightPairs(
  slots: readonly SpacingSlot[], code: string, maxGap: number,
): TightPair[] {
  return reviewTightPairs(slots, code, maxGap).pairs;
}

export interface TightPairReview {
  pairs: TightPair[];
  /** Pairs inside the threshold whose BOTH ends are weekend-bucket, so no
   *  swap is possible. Counted, never listed. */
  excludedChainLocked: number;
}

export function reviewTightPairs(
  slots: readonly SpacingSlot[], code: string, maxGap: number,
): TightPairReview {
  const pairs: TightPair[] = [];
  let excludedChainLocked = 0;
  for (const [providerId, held] of callsByProvider(slots, code)) {
    for (let i = 1; i < held.length; i++) {
      const earlier = held[i - 1];
      const later = held[i];
      const gap = daysBetweenDates(earlier.date, later.date);
      if (gap > maxGap) continue;
      const swappable = [earlier, later].filter(c => c.bucket === SWAPPABLE_BUCKET);
      if (swappable.length === 0) { excludedChainLocked++; continue; }
      pairs.push({ providerId, earlier, later, gap, swappable });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap || a.later.date.localeCompare(b.later.date));
  return { pairs, excludedChainLocked };
}

/** How the gap distribution looks, so a threshold can be chosen from the
 *  board rather than guessed: gap → how many pairs sit at exactly that gap. */
export function gapHistogram(
  slots: readonly SpacingSlot[], code: string, upTo: number,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const p of findTightPairs(slots, code, upTo)) {
    out.set(p.gap, (out.get(p.gap) ?? 0) + 1);
  }
  return out;
}

/** What a provider's tightest same-code adjacency would become if they took a
 *  call on `date`.
 *
 *  Any call they already hold ON that date is skipped, which covers the
 *  current holder being among the candidates: their gap is then measured
 *  against their OTHER calls, not against the one being reassigned. (An
 *  explicit ignore-this-slot parameter was written first and removed as dead —
 *  a slot has exactly one date, so the date check already subsumes it, and a
 *  parameter no input can exercise is worse than none.)
 *
 *  Infinity when they hold no other call of this code: nothing to be close to. */
export function tightestGapIfAdded(held: readonly CallHeld[], date: string): number {
  let best = Infinity;
  for (const h of held) {
    if (h.date === date) continue;
    best = Math.min(best, Math.abs(daysBetweenDates(h.date, date)));
  }
  return best;
}

/** One provider considered for taking a tight call off someone. */
export interface SwapCandidate {
  providerId: string;
  /** Their tightest same-code gap if they took it. Infinity = no other call. */
  resultingGap: number;
  /** True when this is at least as good as what the current holder has. */
  improves: boolean;
}

/** Rank providers for taking `slotId` on `date`.
 *
 * `eligible` is the caller's list — the PICKER's own decision
 * (slotCandidates.candidatesForSlot), so PTO, post-call rest, same-date
 * occupancy, cross-site, credentials and weekday availability are all already
 * applied and this module never re-derives them.
 *
 * Ranked by resulting gap DESCENDING: the provider who ends up furthest from
 * their nearest other call of this code is the best home for it. `improves`
 * compares against `currentGap` — the pair's gap — so a candidate who would
 * land just as tight is shown but not recommended. */
export function rankSwapCandidates(
  eligible: readonly string[],
  byProvider: ReadonlyMap<string, CallHeld[]>,
  date: string,
  currentGap: number,
): SwapCandidate[] {
  return eligible
    .map(providerId => {
      const resultingGap = tightestGapIfAdded(byProvider.get(providerId) ?? [], date);
      return { providerId, resultingGap, improves: resultingGap > currentGap };
    })
    .sort((a, b) => b.resultingGap - a.resultingGap || a.providerId.localeCompare(b.providerId));
}
