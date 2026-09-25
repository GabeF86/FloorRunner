/* ───────────────────────────────────────────────────────────────────────────
 * ONE PHYSICIAN'S CALL SPACING — a thin adapter over lib/callSpacing.ts.
 *
 * ── THIS MODULE RE-IMPLEMENTS NOTHING ──────────────────────────────────────
 * lib/callSpacing.ts already owns every rule that matters here, written for the
 * chief's roster-wide review (Gabriel 2026-07-31). This module calls it and
 * reshapes the answer for one person's dashboard:
 *
 *   which calls count        callsByProvider  — category 'call', folded to the
 *                            PARENT code so a split C1D12/C1N12 is one C1
 *   what a gap is            daysBetweenDates — calendar days, UTC-parsed
 *   which adjacencies are    reviewTightPairs — pairs at/under the threshold,
 *   a real defect            minus the chain-locked ones
 *
 * The ONLY arithmetic added is descriptive statistics over the gap list
 * (shortest / median / longest), which lib/callSpacing has no need for: the
 * chief's review asks "which pairs are fixable", a physician asks "how spread
 * out is my year".
 *
 * ── DESIGNED ADJACENCY IS NOT BAD SPACING ──────────────────────────────────
 * A Paoli weekend is one doc taking a designed chain — Friday C2, Saturday C1,
 * Sunday C1 — so a same-code pair one day apart can be the pattern working as
 * intended. lib/callSpacing excludes those two ways and BOTH are inherited
 * here, unchanged:
 *
 *   1. SCOPED TO ONE PARENT CODE. A Sat C2 → Sun C1 pair is never compared at
 *      all; mixing codes would report the pattern's own structure as a defect.
 *   2. A PAIR WITH NO WEEKDAY END IS CHAIN-LOCKED. Every weekend-bucket call
 *      is pinned by the block chain, so a pair whose both ends sit in a weekend
 *      bucket cannot be moved and is not a complaint. callSpacing counts those
 *      as `excludedChainLocked`; they surface here as `chainExemptPairs` —
 *      reported separately, never folded into `tightPairs`, never silently
 *      dropped.
 *
 * The bucket is the ENGINE's (`dayTypeBucketOn` inside callsByProvider), so a
 * holiday counts as the day of the week it fell on and Friday is weekend-side.
 *
 * ── GAP STATISTICS SPAN EVERY PAIR ─────────────────────────────────────────
 * `gaps` / `shortestGap` / `medianGap` describe the whole distribution,
 * including designed adjacency — they are a description of the year as lived,
 * and hiding the weekend chain from them would make the median flatter than the
 * physician's actual experience. The exemption governs only the JUDGEMENT
 * (`tightPairs`), which is the number that reads as a complaint.
 * ─────────────────────────────────────────────────────────────────────────── */

import { dayOfWeekUTC, dayTypeFromDow, daysBetween } from '../rulesEngine/shared';
import {
  callsByProvider, reviewTightPairs,
  type CallHeld, type SpacingSlot, type TightPair,
} from '../callSpacing';
import {
  computeCoverage, type Coverage, type DateSpan, type MetricAssignment, type MetricStatus,
} from './types';

/** Gabriel's review threshold (lib/callSpacing's live default): post-call rest
 *  makes a gap of 1 impossible for a rest-requiring code, so the interesting
 *  range is 2–3 days. */
export const DEFAULT_TIGHT_GAP_DAYS = 3;

export interface ProviderSpacingResult {
  providerId: string;
  /** The PARENT call code measured — 'C1' covers C1, C1D12, C1N12. */
  code: string;
  tightThresholdDays: number;
  window: DateSpan;
  coverage: Coverage;
  /** Every call of `code` held in the window, date-ascending. */
  calls: CallHeld[];
  callCount: number;
  /** Consecutive gaps in calendar days, in date order. */
  gaps: number[];
  /** Null — never 0 — with fewer than two calls: there is no gap to be short. */
  shortestGap: number | null;
  /** Even gap counts average the two middle values, so a 2/4 pair reads 3. */
  medianGap: number | null;
  longestGap: number | null;
  /** Pairs at or under the threshold that are NOT designed chain adjacency.
   *  Null with fewer than two calls. */
  tightPairs: number | null;
  tightPairDetail: TightPair[];
  /** Pairs inside the threshold pinned by the pattern's weekend chains. Real,
   *  and deliberately not a complaint. Null with fewer than two calls. */
  chainExemptPairs: number | null;
  status: MetricStatus;
}

/**
 * Build `callSpacing`'s grid-shaped slots from flattened assignments, so the
 * /me loader can feed the same rows it feeds every other tile.
 *
 * Slot ids are derived from the date, code and ordinal — deterministic, no
 * `Math.random`, and unique enough for a single provider's holdings (the id is
 * only ever used for display and swap targeting).
 *
 * A missing `dayType` falls back to the engine's single-homed DOW → day-type
 * mapping rather than an empty string, because an empty day type would bucket
 * to '' and quietly disable the chain exemption.
 */
export function toSpacingSlots(
  providerId: string,
  assignments: ReadonlyArray<MetricAssignment>,
): SpacingSlot[] {
  return assignments.map((a, i) => ({
    id: `${a.date}|${a.code}|${i}`,
    slot_date: a.date,
    derived_day_type: a.dayType || dayTypeFromDow(dayOfWeekUTC(a.date)),
    shift_types: {
      code: a.code,
      category: a.category,
      parent_call_code: a.parentCode ?? null,
    },
    assignments: [{ id: `${a.date}|${a.code}|${i}|a`, provider_id: providerId }],
  }));
}

/** Middle value; the mean of the two middle values for an even count. */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One provider's spacing for one parent call code.
 *
 * `slots` may carry the whole roster — everything but this provider's calls is
 * filtered out first, which also keeps `reviewTightPairs`'s chain-locked count
 * scoped to this person rather than the board.
 */
export function computeProviderSpacing(input: {
  providerId: string;
  /** PARENT call code, e.g. 'C1'. */
  code: string;
  slots: ReadonlyArray<SpacingSlot>;
  window: DateSpan;
  /** The span published schedule data covers. Null when none does. */
  published: DateSpan | null;
  tightThresholdDays?: number;
}): ProviderSpacingResult {
  const { providerId, code, window, published } = input;
  const tightThresholdDays = input.tightThresholdDays ?? DEFAULT_TIGHT_GAP_DAYS;
  const coverage = computeCoverage(window, published);

  // Narrow to THIS provider inside the window — both the slot and its
  // assignment list, so nothing another provider holds on a shared slot can
  // leak into the chain-locked count below.
  const mine: SpacingSlot[] = [];
  for (const s of input.slots) {
    if (s.slot_date < window.start || s.slot_date > window.end) continue;
    const held = (s.assignments ?? []).filter(a => a.provider_id === providerId);
    if (held.length === 0) continue;
    mine.push({ ...s, assignments: held });
  }

  const calls = callsByProvider(mine, code).get(providerId) ?? [];
  const gaps: number[] = [];
  for (let i = 1; i < calls.length; i++) {
    gaps.push(daysBetween(calls[i - 1].date, calls[i].date));
  }

  // The tight-pair judgement — and the chain exemption with it — stays entirely
  // inside lib/callSpacing. `mine` holds only this provider, so
  // `excludedChainLocked` is already provider-scoped.
  const review = reviewTightPairs(mine, code, tightThresholdDays);
  const measurable = calls.length >= 2;

  return {
    providerId,
    code,
    tightThresholdDays,
    window,
    coverage,
    calls,
    callCount: calls.length,
    gaps,
    shortestGap: gaps.length ? Math.min(...gaps) : null,
    medianGap: medianOf(gaps),
    longestGap: gaps.length ? Math.max(...gaps) : null,
    tightPairs: measurable ? review.pairs.length : null,
    tightPairDetail: review.pairs,
    chainExemptPairs: measurable ? review.excludedChainLocked : null,
    status: measurable ? 'found'
      : coverage.kind === 'full' ? 'none_in_window'
      : coverage.kind === 'partial' ? 'partially_covered'
      : 'not_covered',
  };
}
