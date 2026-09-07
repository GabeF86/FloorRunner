import { WEIGHT_EPSILON, callBurdenWeight, parentCallCodeOf } from './callBurden';
import { dayTypeBucketOn } from './rulesEngine/shared';
import { owedCallsFor, type CallPatternDoc } from './rulesEngine/callPattern';
import { owedUnitsFor } from './rulesEngine/neuroWeekend';

// The house FTE-weighted call-obligation formula (spec choice A):
//   target = (slots in the bucket ÷ site call_par_level) × provider FTE.
// Single source for: grid over-par red cells, modal Extra Calls, and the
// modal's expected-calls displays. Blind to eligibility by design (mirrors
// the pre-existing Extra Calls semantics).
export function fteWeightedTarget(bucketTotal: number, parLevel: number, fte: number): number {
  if (!Number.isFinite(parLevel) || parLevel <= 0) return 0;
  return (bucketTotal / parLevel) * fte;
}

// ── Whole-number obligations, TOTAL level (2026-07-17) ───────────────────────
// A provider's obligatory call count is the ROUNDED total expected calls:
//   round( Σ_buckets fteWeightedTarget(bucketTotal, par, fte) )
//     ≡ round( totalCallSlots / par × fte )     (linearity)
// Round-half-up (Math.round): 1.5 → 2, 1.3 → 1, 0.45 → 0. Calls up to the
// rounded obligation are NEVER counted or labeled as extra. This rounding
// defines obligation/extra ACCOUNTING (and the engine's obligatory-mode cap);
// category-level fairness/rotation keeps the FRACTIONAL targets for ordering.
// Single home shared by the schedule grid, the Call Counts modal, and the
// rules engine (src/lib/rulesEngine/obligation.ts) so the three can't drift.
export function roundedObligation(totalExpected: number): number {
  if (!Number.isFinite(totalExpected) || totalExpected <= 0) return 0;
  return Math.round(totalExpected);
}

// Extra calls = everything past the rounded obligation, floored at 0.
export function extraCalls(actualCalls: number, totalExpected: number): number {
  return Math.max(0, actualCalls - roundedObligation(totalExpected));
}

// ── Par-authoritative (Gabriel 2026-07-24, SUPERSEDES the 2026-07-16 clamp) ──
// The stored `sites.call_par_level` is THE obligation denominator, in BOTH
// directions, unconditionally. His verbatim decision: "I want the math to use
// a par of 11 and even though there are only 8.75 FTE thats fine. I want the
// left over call shifts to be taken after the schedule is made." When the
// pool's ΣFTE is below the par, obligations deliberately UNDER-COVER the
// schedule — the uncovered remainder is the paid-pickup layer, filled after
// the schedule is built (an assignment past the rounded obligation gets the
// OVER treatment and is paid extra). A par below the pool ΣFTE remains the
// legitimate spread-thinner choice it always was. The old clampParToPoolFte
// helper is deleted; every consumer (engine obligation census, this file's
// UI census, plannerMath) now uses the stored par directly, so engine cap and
// UI labeling still cannot disagree — they share the same denominator rule.

// One call assignment as the OVER-selection helper sees it. `weight` /
// `parent_code` (2026-07-22, call splits): fractional call credit + the
// parent grouping code — optional so pre-split callers (and their literals)
// keep compiling; absent means weight 1 / parent = own code.
//
// `bucket` (2026-07-29, bucket fairness): the assignment's DAY-TYPE fairness
// bucket — ALWAYS the engine's `dayTypeBucketOn(derived_day_type, slot_date)`
// (rulesEngine/shared.ts), never a locally re-derived one, so a holiday-dated
// call is charged to the day of the week it lands on. Optional: absent means
// "this caller cannot say which bucket this call is in", and the bucket
// preference below simply does not apply to it.
export interface OverParCall {
  id: string;           // assignment id
  provider_id: string;
  slot_date: string;    // ISO date
  shift_type_code: string;
  weight?: number;
  parent_code?: string;
  bucket?: string;
}

/** The per-bucket target key: fairness bucket × PARENT call code (weekday|C1,
 * saturday|C3…). Single home so the census that computes bucket slot totals
 * and the selector that reads them can never key them differently. The code
 * must already be folded to its parent (`parentCallCodeOf`) — a split segment
 * counts under the call it is a piece of. */
export function overParBucketKey(bucket: string, parentCode: string): string {
  return `${bucket}|${parentCode}`;
}

// Per-slot OVER labeling (2026-07-17; WEIGHTED 2026-07-22; MINIMAL-COVER and
// BUCKET-FAIR 2026-07-29). When a provider's cumulative call WEIGHT exceeds
// their rounded TOTAL obligation, the flagged set is chosen by this rule, in
// this order of precedence:
//
//   1. MINIMAL TOTAL WEIGHT — the smallest-total-weight set of their
//      assignments that brings the rest back to at most the obligation.
//   2. BUCKET FAIRNESS — among covers that tie on weight, the one that draws
//      the least WEIGHT out of buckets the provider is at-or-under their
//      per-bucket target in. Equivalently: blame the buckets they are actually
//      over in, EACH ONLY AS FAR AS IT IS OVER (2026-07-30 — see
//      overTargetBuckets for the Jones case that forced the quantity cap; a
//      bucket 1 over may absorb 1 flag, not 3). A "bucket" is
//      (dayTypeBucketOn(day type, date) × parent call code) and its target is
//      the same `fteWeightedTarget` the rest of the app uses — (bucket slot
//      weight ÷ par) × FTE — supplied by the caller, which already has the
//      slot totals (see computeCallObligationCensus).
//   3. LATER DATES — the pre-existing tie-break, unchanged.
//
// WEIGHT_EPSILON absorbs stored-fraction noise (3 × 0.3333 = 0.9999 is not
// "over" a 1-call obligation) on all three comparisons. `totalExpectedFor`
// returns the provider's FRACTIONAL total expected calls (the caller computes
// it from whatever slot totals it already has; the rounding lives here).
// `bucketTargetFor` is OPTIONAL: without it (and for any call carrying no
// `bucket`) every member weighs the same on rule 2, so the selection falls
// through to rules 1 + 3 — the 2026-07-29 minimal-cover behavior verbatim.
//
// WHY MINIMAL WEIGHT, not the chronological tail (Gabriel 2026-07-29, live
// case): Horan, 0.5 FTE at par 11 on a 176-weight block, owes 8 and holds 8.5
// — eight whole calls plus one 12h Saturday half (C1D12, weight 0.5). The
// chronological tail removed his LAST WHOLE call (a weekday C1), which
// (a) flagged a call he is not over on — his 2 weekday C1s are exactly his
// weekday-C1 target — and (b) overstated the overage, painting 1.0 red when
// he is 0.5 over and leaving the remainder 0.5 UNDER. Minimal weight flags
// the 0.5 split instead: 8.5 − 0.5 = 8.0, exactly the obligation.
//
// WHY BUCKET FAIRNESS ON TOP (Gabriel 2026-07-29, same day, second report:
// "she is listed as over on C1 weekday calls, she is supposed to have 3
// weekday calls, why is it showing as over?"): Havildar, 0.75 FTE at par 11 on
// the same 176-weight block, owes 12 and holds 13.5 — 1.5 over. Her weekday
// targets are whole numbers (44 weekday C1 slots ÷ 11 × 0.75 = 3.00) and she
// sits EXACTLY on them; every bit of her overage comes from the Friday/weekend
// buckets, where a 0.75 target can only be met by taking a whole 1.0 call —
// SEVEN such buckets over by 0.25 each, against the one Saturday C1 she holds
// a 12h half of and is 0.25 UNDER in: 7 × 0.25 − 0.25 = exactly her 1.5
// (the fteTarget.test.ts fixture asserts this table). Minimal weight alone
// covered the 1.5 with {latest 1.0} + {the 0.5 split} and her latest 1.0 was a
// weekday C1: a call she is not one minute over on. Rule 2 moves that 1.0 onto
// a bucket she IS over in (her latest such), and the weekday row goes clean.
//
// RETIRED 2026-07-29 — the old byte-identical guarantee. This comment used to
// promise: "With every weight 1 this selects exactly the last N = actual −
// obligation assignments — the pre-split behavior, byte for byte." That no
// longer holds and is not meant to: with bucket data present, bucket fairness
// outranks recency, so an all-weight-1 provider who is over in weekend buckets
// and on-target on weekdays now has WEEKEND calls flagged rather than their
// chronologically last ones. Red cells move for providers across the whole
// grid, deliberately. The last-N rule survives exactly where there is no
// bucket data to reason with (no `bucketTargetFor`, or calls with no
// `bucket`), which is the shape every pre-2026-07-29 caller has.
export function selectOverParAssignmentIds(
  calls: OverParCall[],
  totalExpectedFor: (providerId: string) => number,
  bucketTargetFor?: (providerId: string, bucketKey: string) => number,
): Set<string> {
  const byPid = new Map<string, OverParCall[]>();
  for (const c of calls) {
    const list = byPid.get(c.provider_id);
    if (list) list.push(c); else byPid.set(c.provider_id, [c]);
  }
  const over = new Set<string>();
  for (const [pid, list] of byPid) {
    const obligation = roundedObligation(totalExpectedFor(pid));
    const bucketTarget = bucketTargetFor && ((key: string) => bucketTargetFor(pid, key));
    for (const id of selectOverParCover(list, obligation, bucketTarget).ids) over.add(id);
  }
  return over;
}

// ── The per-provider cover search ────────────────────────────────────────────

/** How a provider's cover was chosen. Exported so the bounded search's
 * fallback is OBSERVABLE (and testable) rather than silent. An empty cover
 * (nobody is over) reports 'minimal-weight': the empty set IS the minimum. */
export type OverParCoverMethod = 'minimal-weight' | 'chronological-tail';

export interface OverParCover {
  /** Assignment ids to flag, in the order the search picked them. */
  ids: string[];
  /** Σ weight of the flagged assignments — ≥ the overage, equal when an exact
   * cover exists. The DISPLAYED overage is `callOverageWeight`, not this. */
  coveredWeight: number;
  method: OverParCoverMethod;
}

// SEARCH BOUND. Minimal-weight-subset is subset-sum in general, so the search
// is NOT run over subsets: it enumerates COUNT VECTORS over the distinct stored
// weights (how many weight-1 calls, how many 0.5 halves, how many 0.3333
// thirds…), which is Π(count_i + 1) — polynomial in the holdings and tiny for
// real data (the house weight set is {1, 0.5, 0.3333} and a provider holds a
// few dozen calls, so a live provider costs on the order of 100 steps). For a
// given count vector the best members are forced (the LATEST count_i of each
// weight class — see below), so nothing is lost by not enumerating subsets.
// 4096 is ~an order of magnitude above anything the live data can produce
// (e.g. 40 whole calls + 8 halves + 6 thirds = 41×9×7 = 2583) while capping
// the per-provider work at a few thousand cheap arithmetic steps on a render
// path. Past the cap — only reachable with pathological weight variety — the
// search bails and the ORIGINAL chronological-tail rule runs, reported as
// method 'chronological-tail'.
export const MAX_COVER_COMBINATIONS = 4096;

const chronoCompare = (a: OverParCall, b: OverParCall) =>
  a.slot_date.localeCompare(b.slot_date)
  || a.shift_type_code.localeCompare(b.shift_type_code)
  || a.id.localeCompare(b.id);

/** Which of ONE provider's calls carry the OVER treatment against `obligation`
 * (already rounded). Exported for the census, and so tests can observe which
 * method fired.
 *
 * `bucketTarget` (2026-07-29) is THIS provider's per-bucket target lookup,
 * keyed by `overParBucketKey` — the caller has already bound the provider.
 * Omit it and the bucket preference is inert (rule 2 above is a constant), so
 * the selection is the plain minimal-weight-then-later-dates one. */
export function selectOverParCover(
  calls: ReadonlyArray<OverParCall>,
  obligation: number,
  bucketTarget?: (bucketKey: string) => number,
): OverParCover {
  const sorted = [...calls].sort(chronoCompare);
  const weights = sorted.map(c => callBurdenWeight({ call_burden_weight: c.weight }));
  const total = weights.reduce((s, w) => s + w, 0);
  // Not over (WEIGHT_EPSILON: three 0.3333 thirds are not over a 1.0 obligation).
  if (total <= obligation + WEIGHT_EPSILON) {
    return { ids: [], coveredWeight: 0, method: 'minimal-weight' };
  }
  const needed = total - obligation;
  const minimal = minimalWeightCover(
    sorted, weights, needed, overTargetBuckets(sorted, weights, bucketTarget));
  if (minimal) return minimal;

  // FALLBACK — the pre-2026-07-29 rule, verbatim: take whole assignments from
  // the chronological END until the remainder no longer exceeds the obligation.
  const ids: string[] = [];
  let remaining = total;
  let coveredWeight = 0;
  for (let i = sorted.length - 1; i >= 0 && remaining > obligation + WEIGHT_EPSILON; i--) {
    ids.push(sorted[i].id);
    coveredWeight += weights[i];
    remaining -= weights[i];
  }
  return { ids, coveredWeight, method: 'chronological-tail' };
}

/** Per-call blame budget: may THIS call be charged to the provider's overage,
 *  given how far over their target that call's bucket actually is?
 *
 * QUANTITY-AWARE, not a yes/no (Gabriel 2026-07-30, live case). It used to
 * return a boolean per call — "is this bucket over target?" — with no cap on
 * how many calls one bucket could contribute. Jones held 19 calls against an
 * obligation of 16, exactly 1 over in each of THREE buckets (weekday|C1 5 vs 4,
 * weekday|C2 5 vs 4, sunday|C1 2 vs 1). All three buckets answered "true", the
 * date tie-break then took his three LATEST calls — 10/06 C1, 10/13 C2, 10/22
 * C1, every one a weekday — and weekday|C1 was blamed TWICE while being 1 over,
 * with the extra Sunday C1 blamed not at all. The Sunday C1 was in the count
 * all along; it was the EXTRA-CALL attribution that mispriced it, and day type
 * is exactly what that column exists to report ("each one has a different
 * price", 2026-07-29).
 *
 * So each bucket may contribute at most its OWN overage, latest dates first.
 * Jones now flags one weekday C1, one weekday C2 and one Sunday C1 — the
 * per-bucket table read back exactly.
 *
 * Held weight per bucket comes from the provider's OWN records (this is their
 * complete holding — the caller groups by provider before calling), so it can
 * never disagree with the weights the cover search is spending; only the
 * TARGET is external. A call with no `bucket`, or no target lookup at all, is
 * never preferred: unknown is not "over", so the selection degrades to
 * weight-then-date exactly as before. */
function overTargetBuckets(
  sorted: ReadonlyArray<OverParCall>,
  weights: ReadonlyArray<number>,
  bucketTarget?: (bucketKey: string) => number,
): boolean[] {
  const preferred = new Array<boolean>(sorted.length).fill(false);
  if (!bucketTarget) return preferred;
  const keys = sorted.map(c => (c.bucket
    ? overParBucketKey(c.bucket, c.parent_code || c.shift_type_code)
    : null));
  const held = new Map<string, number>();
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k) held.set(k, (held.get(k) || 0) + weights[i]);
  }
  // Remaining blame each bucket can absorb = held − target, only where over.
  const budget = new Map<string, number>();
  for (const [k, h] of held) {
    const over = h - bucketTarget(k);
    if (over > WEIGHT_EPSILON) budget.set(k, over);
  }
  // Spend it LATEST-FIRST, matching the date tie-break that ranks within the
  // preferred group — so the calls marked here are the ones that group would
  // have chosen anyway, just capped per bucket.
  for (let i = sorted.length - 1; i >= 0; i--) {
    const k = keys[i];
    if (!k) continue;
    const left = budget.get(k);
    if (left == null || left <= WEIGHT_EPSILON) continue;
    preferred[i] = true;
    budget.set(k, left - weights[i]);
  }
  return preferred;
}

/** Smallest-total-weight set covering `needed`; among equal-weight covers the
 * one drawing the least weight from buckets the provider is NOT over in; then
 * latest dates. Null when the enumeration would exceed MAX_COVER_COMBINATIONS
 * (caller falls back). `sorted` is chronological ascending; `weights` and
 * `overBucket` are parallel to it. */
function minimalWeightCover(
  sorted: ReadonlyArray<OverParCall>,
  weights: ReadonlyArray<number>,
  needed: number,
  overBucket: ReadonlyArray<boolean>,
): OverParCover | null {
  // Group by exact stored weight — the indices of each class stay ascending.
  const classes = new Map<number, number[]>();
  for (let i = 0; i < weights.length; i++) {
    const list = classes.get(weights[i]);
    if (list) list.push(i); else classes.set(weights[i], [i]);
  }
  // Within a class every member costs the same weight, so which ones to take
  // is decided entirely by the two lower-ranked rules: OVER-TARGET BUCKETS
  // FIRST, later dates first inside each of those two groups. `order` is that
  // preference order, so "take k of this class" is always its first k, and the
  // members drawn from at-or-under buckets are exactly the overflow past
  // `overCount`. That keeps the per-candidate cost O(classes) arithmetic.
  const classList = Array.from(classes, ([weight, indices]) => ({
    weight,
    order: [...indices].sort((a, b) =>
      (overBucket[a] ? 0 : 1) - (overBucket[b] ? 0 : 1) || b - a),
    overCount: indices.reduce((n, i) => n + (overBucket[i] ? 1 : 0), 0),
  }));
  let combinations = 1;
  for (const c of classList) {
    combinations *= c.order.length + 1;
    if (combinations > MAX_COVER_COMBINATIONS) return null; // → observable fallback
  }

  // Candidate = a count per weight class; `penalty` = the weight it draws out
  // of at-or-under buckets (rule 2 — lower is better, 0 = it blames only
  // buckets the provider is genuinely over in).
  const membersOf = (counts: ReadonlyArray<number>): number[] => {
    const indices: number[] = [];
    for (let g = 0; g < classList.length; g++) {
      const src = classList[g].order;
      for (let k = 0; k < counts[g]; k++) indices.push(src[k]);
    }
    return indices.sort((a, b) => b - a); // descending = latest first
  };
  let best: { indices: number[]; total: number; penalty: number } | null = null;
  const counts = new Array<number>(classList.length).fill(0);
  for (let n = 0; n < combinations; n++) {
    let rest = n;
    let total = 0;
    let penalty = 0;
    for (let g = 0; g < classList.length; g++) {
      const c = classList[g];
      const radix = c.order.length + 1;
      counts[g] = rest % radix;
      rest = (rest - counts[g]) / radix;
      total += counts[g] * c.weight;
      penalty += Math.max(0, counts[g] - c.overCount) * c.weight;
    }
    if (total < needed - WEIGHT_EPSILON) continue;              // does not cover
    if (best) {
      if (total > best.total + WEIGHT_EPSILON) continue;        // heavier than the best
      if (total > best.total - WEIGHT_EPSILON) {
        // Tie on weight (inside the house tolerance). Keep the SMALLEST tied
        // total/penalty as the yardstick so a chain of near-ties can never
        // drift a comparison by more than one epsilon.
        best.total = Math.min(best.total, total);
        if (penalty > best.penalty + WEIGHT_EPSILON) continue;  // blames cleaner buckets
        if (penalty > best.penalty - WEIGHT_EPSILON) {          // tie on the buckets too
          best.penalty = Math.min(best.penalty, penalty);
          const indices = membersOf(counts);
          if (isLaterCover(indices, best.indices)) best.indices = indices; // later dates win
          continue;
        }
        best = { indices: membersOf(counts), total: best.total, penalty };
        continue;
      }
    }
    best = { indices: membersOf(counts), total, penalty };      // first cover, or strictly lighter
  }
  if (!best) return null; // unreachable: the whole holding always covers
  return {
    ids: best.indices.map(i => sorted[i].id),
    coveredWeight: best.total,
    method: 'minimal-weight',
  };
}

/** Later-dates tie-break: both lists are DESCENDING chronological positions.
 * The one holding the later assignment at the first difference wins; if one is
 * a prefix of the other (only possible when the totals merely tie inside the
 * epsilon, never when they are equal — weights are strictly positive), the
 * shorter wins, flagging fewer calls for the same weight. */
function isLaterCover(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return a.length < b.length;
}

/** Call weight held PAST the rounded obligation — the true size of the
 * overage, which the flagged cover can legitimately EXCEED when no smaller
 * combination of whole assignments fits (0.7 over, only 1.0 calls to flag).
 * 0 inside the house tolerance. */
export function callOverageWeight(actualWeight: number, obligation: number): number {
  const over = actualWeight - obligation;
  return over > WEIGHT_EPSILON ? over : 0;
}

// ── Shared grid/modal obligation census (2026-07-17) ─────────────────────────
// ONE derivation of every obligation input the schedule page needs, consumed
// by BOTH the grid over-par memo and the Call Counts modal so the two surfaces
// cannot feed different denominators or call lists into the shared selector.
// (Before this, the grid counted every call-category slot while the modal
// skipped holiday day types and restricted to C1/C2/C3 — same selector,
// different inputs, disagreeing red cells.)
//
// Census rules (mirrors the engine, src/lib/rulesEngine/obligation.ts):
//   - totalCallSlots = EVERY call-category slot instance — holiday-dated
//     included, ANY call code (CB/beeper etc.), filled or not. Engine
//     equivalent: open call slots + call seeds.
//   - effectivePar  = the stored par, verbatim (par-authoritative 2026-07-24;
//     pool ΣFTE below the par means the obligations under-cover the schedule
//     and the remainder is the paid-pickup layer).
//     Pool mirrors loadGenerationContext: a non-empty `included_provider_ids`
//     override NARROWS the pool (Gabriel 2026-07-21) — it skips only the
//     home-site gate; the call_taker/partial_call_taker role criterion is
//     always intersected (a day doc in a custom pool never counts toward
//     call-pool FTE). Default pool = home-site call/partial-call takers.
//     Grid profiles are already restricted to active providers of the
//     schedule's provider group.
//   - fte coercion `|| 1` matches genContext's profile load (null/0 → 1);
//     providers with no profile default to 1 (pre-existing UI semantics —
//     expected stays blind to eligibility by design).

export interface CensusProfile {
  provider_id: string;
  home_site_id: string | null;
  call_taker: boolean;
  partial_call_taker: boolean;
  fte_value: number | null;
}

export interface CensusSlot {
  slot_date: string;
  // schedule_slots.derived_day_type (2026-07-29, bucket fairness): the input
  // to the engine's dayTypeBucketOn, which is what makes a per-bucket target
  // computable. OPTIONAL, and the census is all-or-nothing about it — see
  // `bucketTargetFor` below: one call slot without a day type disables the
  // bucket preference for the whole census rather than silently deflating the
  // bucket totals that slot belongs to. Every live grid payload carries it
  // (all three narrow-retry rungs select it).
  derived_day_type?: string | null;
  // call_burden_weight / parent_call_code (2026-07-22, call splits): optional
  // patch35 columns — absent (pre-patch payloads, unsplit schedules) means
  // weight 1 / parent = own code via the callBurden.ts defaults.
  shift_types: {
    category: string;
    code: string;
    call_burden_weight?: number | null;
    parent_call_code?: string | null;
  } | null;
  assignments?: Array<{ id: string; provider_id: string | null }> | null;
}

export interface CallObligationCensusInput {
  storedParLevel: number;              // sites.call_par_level (caller applies the ?? 12 fallback)
  siteId: string;                      // schedule.site_id — scopes the default pool
  includedProviderIds?: string[] | null; // schedule.included_provider_ids override pool
  profiles: CensusProfile[];
  slots: CensusSlot[];
  /** The site's active CallPatternDoc (2026-08-03). When it states obligation
   * bands the census switches to STATED, PER-CATEGORY accounting — see
   * statedBucketObligations. Absent/null keeps the derived FTE formula and the
   * netted minimal-weight cover exactly as they were. */
  callPattern?: CallPatternDoc | null;
}

// ── Stated, per-category obligations (Gabriel 2026-08-03) ────────────────────
//
// "if someone is above any of their obligatory calls, it should show up in the
// above obligatory column for that specific call, regardless if they are
// missing a different type of call somewhere else."
//
// NO NETTING. Under the derived formula an overage was a single TOTAL number
// and the selector picked the cheapest set of calls covering it, so a provider
// over on two buckets and short on a third showed ONE extra. Farkas, live
// 8/10–10/25 block: 5 M–Th C1 (owes 4) and 5 M–Th C2 (owes 4) but no Sunday
// C2 (owes 1) — 17 held against 16 owed, and the old rule flagged exactly one
// call. His rule flags TWO, and records the Sunday C2 as short. Σ extras can
// therefore EXCEED the net overage, on purpose: the day types price
// differently, so an extra weekday C1 and a missing Sunday C2 are not the same
// money and must not cancel.
//
// WHAT EACH BUCKET OWES, in three tiers, because obligations are stated in
// three different units and always have been:
//   • a code the bands GOVERN (C1/C2 at Paoli) — the band's stated count, and
//     ZERO for a bucket the band omits (a band is exhaustive for its tier).
//   • the NEURO code — the pattern's requirement bands, in weekend UNITS,
//     spread one call across each neuro day the block actually stands. Owed
//     units are a weekend count; the extras column is a call count.
//   • anything else (beeper/CB) — the derived FTE formula, untouched.
//
// Null when the pattern states no band covering this FTE: that provider keeps
// the derived formula end to end rather than half-migrating.
export function statedBucketObligations(
  doc: CallPatternDoc,
  fte: number,
  bucketSlotWeight: ReadonlyMap<string, number>,
  parLevel: number,
): Map<string, number> | null {
  const owed = owedCallsFor(doc, fte);
  if (!owed) return null;

  const governed = new Set<string>();
  for (const band of doc.obligations?.bands ?? []) {
    for (const c of band.calls) governed.add(c.code);
  }
  const neuroCode = doc.neuroWeekend?.code;
  // The neuro days this block actually stands, so owed UNITS become owed CALLS
  // on the right days. Read off the slot census rather than the chain shape:
  // the block is the ground truth for which days carry neuro, and a retired
  // Friday neuro still present in an old draft must still be counted.
  const neuroBuckets = neuroCode
    ? [...bucketSlotWeight.keys()].filter(k => k.endsWith(`|${neuroCode}`))
    : [];
  const neuroUnits = doc.neuroWeekend ? owedUnitsFor(fte, doc.neuroWeekend) : 0;

  const out = new Map<string, number>();
  for (const [key, slotWeight] of bucketSlotWeight) {
    const lastPipe = key.lastIndexOf('|');
    const code = key.slice(lastPipe + 1);
    if (governed.has(code)) {
      out.set(key, owed.get(key) ?? 0);
    } else if (neuroCode && code === neuroCode) {
      // One call per stood neuro day per owed weekend unit. A half unit (a
      // pattern band stating 0.5) owes half a call on each day, which is what
      // a lone weekend day is worth.
      out.set(key, neuroBuckets.length > 0 ? neuroUnits : 0);
    } else {
      out.set(key, fteWeightedTarget(slotWeight, parLevel, fte));
    }
  }
  // A band may state a bucket the block stands no slots for. Keep it: the
  // provider is short there, and the shortfall is real information even though
  // it can never produce an extra.
  for (const [key, count] of owed) {
    if (!out.has(key)) out.set(key, count);
  }
  return out;
}

export interface CallObligationCensus {
  poolFte: number;
  effectivePar: number;
  totalCallSlots: number;
  callRecords: OverParCall[];
  /** Slot weight per `overParBucketKey(bucket, parentCode)` — the block's call
   *  slate. Null when a call slot could not be bucketed (same all-or-nothing
   *  rule as bucketTargetFor). */
  bucketSlotWeight: ReadonlyMap<string, number> | null;
  // Real FTE for ANY provider (profile value, engine coercion, `?? 1` when
  // unprofiled) — for workday math and display, which apply to everyone.
  fteFor: (providerId: string) => number;
  // CALL-OBLIGATION weight: the provider's FTE when they are a member of the
  // call pool, 0 otherwise (2026-07-22, Gabriel's 53.3-expected report — a day
  // doc owes zero calls; summing real FTE over non-pool providers inflated
  // every Expected figure by nonPoolFte/effectivePar). All obligation-derived
  // numbers (totalExpectedFor, over-par selection, the modal's Expected row)
  // MUST weight by this, never by fteFor.
  poolFteFor: (providerId: string) => number;
  totalExpectedFor: (providerId: string) => number;  // fractional — callers round via roundedObligation
  // THE OBLIGATION TO DISPLAY AND BILL AGAINST (2026-08-03). Under the derived
  // formula this is roundedObligation(totalExpectedFor) — the whole-number
  // obligation that has always driven extra-call accounting. Under STATED
  // bands it is the band's own total, UNROUNDED: rounding exists only because
  // the formula produced fractions that had to be resolved into whole calls,
  // and a stated table has already resolved them. Paoli's 0.5 FTE owes exactly
  // 9.5 (he takes half of a 12h Saturday split); round-half-up would print 10
  // and invent half a call of obligation nobody stated.
  //
  // Callers MUST use this rather than re-rounding totalExpectedFor.
  obligationFor: (providerId: string) => number;
  actualCallsFor: (providerId: string) => number;
  // PER-BUCKET target (2026-07-29): (this bucket's slot weight ÷ effective par)
  // × POOL fte — the same fteWeightedTarget as everything else, one rung down
  // from totalExpectedFor. Keyed by `overParBucketKey(dayTypeBucketOn(...),
  // parent code)`. NULL when the slot census could not bucket every call slot
  // (a slot with no derived_day_type): partial bucket totals would understate
  // targets and invent over-target buckets, so the over-par selection drops
  // the bucket preference entirely instead. Exposed so that fallback is
  // observable rather than silent.
  bucketTargetFor: ((providerId: string, bucketKey: string) => number) | null;
  // FRACTIONAL overage: held call weight − rounded obligation, 0 when within
  // the house tolerance. This — NOT the flagged assignments' weight — is how
  // far over the provider actually is; the flagged cover may exceed it when no
  // smaller combination of whole assignments closes the gap.
  overageFor: (providerId: string) => number;
  overParAssignmentIds: Set<string>;
}

export function computeCallObligationCensus(input: CallObligationCensusInput): CallObligationCensus {
  const override = input.includedProviderIds && input.includedProviderIds.length > 0
    ? new Set(input.includedProviderIds)
    : null;

  let poolFte = 0;
  const fteByPid = new Map<string, number>();
  const poolPids = new Set<string>();
  for (const prof of input.profiles) {
    const fte = prof.fte_value || 1; // engine coercion (genContext profile load)
    fteByPid.set(prof.provider_id, fte);
    // Role criterion applies on BOTH paths (override = narrowing, never
    // widening — mirrors genContext §3); override skips only the home-site gate.
    const inPool = (prof.call_taker || prof.partial_call_taker) && (override
      ? override.has(prof.provider_id)
      : prof.home_site_id === input.siteId);
    if (inPool) { poolFte += fte; poolPids.add(prof.provider_id); }
  }
  // Par-authoritative (2026-07-24): the stored par IS the denominator — never
  // clamped to poolFte. See the doc block above `OverParCall`.
  const effectivePar = input.storedParLevel;

  // WEIGHT SUMS (2026-07-22, call splits): every call-category slot counts its
  // call_burden_weight (default 1 — unsplit schedules are byte-identical), so
  // a split call (0.5 + 0.5, or 3 × 0.3333) totals exactly ONE call across
  // obligation, actuals and the OVER selection. Records carry weight + the
  // parent grouping code for the modal's parent-code columns.
  //
  // PER-BUCKET SLOT WEIGHTS (2026-07-29) ride the same single pass: the same
  // slot that adds its weight to the block total adds it to its (bucket ×
  // parent code) total, so the two can never be computed off different slot
  // sets. The bucket is the ENGINE's — dayTypeBucketOn(derived_day_type,
  // slot_date), which charges a holiday-dated call to the day of the week it
  // lands on — and the code is folded through parentCallCodeOf, so a split
  // segment counts under the call it is a piece of. A call slot with no
  // derived_day_type makes the whole map untrustworthy (its weight would be
  // missing from a bucket whose target is then too small, inventing an
  // over-target bucket), so it turns the bucket preference OFF for the census
  // rather than half-on.
  let totalCallSlots = 0;
  const callRecords: OverParCall[] = [];
  const actualByPid = new Map<string, number>();
  const bucketSlotWeight = new Map<string, number>();
  // pid -> bucket key -> weight HELD, for the per-category overage. Rides the
  // same single pass as bucketSlotWeight so held and owed are measured off one
  // walk of the slots and cannot disagree about bucketing.
  const heldByPidBucket = new Map<string, Map<string, number>>();
  let everySlotBucketed = true;
  for (const slot of input.slots) {
    if (slot.shift_types?.category !== 'call') continue;
    const weight = callBurdenWeight(slot.shift_types);
    totalCallSlots += weight;
    const parentCode = parentCallCodeOf(slot.shift_types.code, slot.shift_types);
    const dayType = slot.derived_day_type;
    let bucket: string | undefined;
    if (typeof dayType === 'string' && dayType.length > 0) {
      bucket = dayTypeBucketOn(dayType, slot.slot_date);
      const key = overParBucketKey(bucket, parentCode);
      bucketSlotWeight.set(key, (bucketSlotWeight.get(key) || 0) + weight);
    } else {
      everySlotBucketed = false;
    }
    for (const a of slot.assignments || []) {
      if (!a.provider_id) continue;
      callRecords.push({
        id: a.id, provider_id: a.provider_id,
        slot_date: slot.slot_date, shift_type_code: slot.shift_types.code,
        weight,
        parent_code: parentCode,
        bucket,
      });
      actualByPid.set(a.provider_id, (actualByPid.get(a.provider_id) || 0) + weight);
      if (bucket) {
        const key = overParBucketKey(bucket, parentCode);
        let held = heldByPidBucket.get(a.provider_id);
        if (!held) { held = new Map(); heldByPidBucket.set(a.provider_id, held); }
        held.set(key, (held.get(key) || 0) + weight);
      }
    }
  }

  const fteFor = (pid: string) => fteByPid.get(pid) ?? 1;
  // Obligation weight: pool members only. A non-pool provider (day doc, a
  // visiting doc outside the override) owes zero calls — every call they DO
  // hold is beyond obligation by definition (over-par selection sees it).
  const poolFteFor = (pid: string) => (poolPids.has(pid) ? fteByPid.get(pid)! : 0);

  // STATED per-bucket obligations, per provider (2026-08-03). Null throughout
  // when the site states no bands, or for a provider whose FTE clears none —
  // that provider keeps the derived formula end to end. A NON-POOL provider is
  // never given stated obligations: they owe zero calls, and handing them a
  // tier table would invent an obligation for a day doc.
  const statedByPid = new Map<string, Map<string, number>>();
  if (input.callPattern?.obligations && everySlotBucketed) {
    for (const pid of poolPids) {
      const stated = statedBucketObligations(
        input.callPattern, poolFteFor(pid), bucketSlotWeight, effectivePar);
      if (stated) statedByPid.set(pid, stated);
    }
  }
  const statedTotalFor = (pid: string): number | null => {
    const stated = statedByPid.get(pid);
    if (!stated) return null;
    let total = 0;
    for (const v of stated.values()) total += v;
    return total;
  };

  const totalExpectedFor = (pid: string) =>
    statedTotalFor(pid) ?? fteWeightedTarget(totalCallSlots, effectivePar, poolFteFor(pid));
  const obligationFor = (pid: string) =>
    statedTotalFor(pid) ?? roundedObligation(totalExpectedFor(pid));
  const actualCallsFor = (pid: string) => actualByPid.get(pid) || 0;
  // Same formula as totalExpectedFor, one rung down: this bucket's slots
  // instead of all of them. Null (→ no bucket preference) when any call slot
  // could not be bucketed, or when there are no call slots to bucket.
  const bucketTargetFor = everySlotBucketed && bucketSlotWeight.size > 0
    ? (pid: string, key: string) =>
      fteWeightedTarget(bucketSlotWeight.get(key) || 0, effectivePar, poolFteFor(pid))
    : null;
  return {
    poolFte,
    effectivePar,
    totalCallSlots,
    callRecords,
    // Per-(bucket × parent code) slot weight, keyed by overParBucketKey — the
    // SAME map bucketTargetFor divides, exposed so the coverage forecast reads
    // the block's slate from this one pass instead of re-walking the slots and
    // risking a different bucketing. Null under the same all-or-nothing rule
    // as bucketTargetFor: one unbucketable call slot makes every bucket total
    // suspect, and a silently-short denominator would understate the gap.
    bucketSlotWeight: everySlotBucketed ? bucketSlotWeight : null,
    fteFor,
    poolFteFor,
    totalExpectedFor,
    obligationFor,
    actualCallsFor,
    bucketTargetFor,
    // PER-CATEGORY when the site states bands: Σ over buckets of how far past
    // that bucket's stated count the provider is, with under-filled buckets
    // contributing NOTHING rather than offsetting. Otherwise the netted total
    // overage, unchanged.
    overageFor: pid => {
      const stated = statedByPid.get(pid);
      if (!stated) {
        return callOverageWeight(actualCallsFor(pid), roundedObligation(totalExpectedFor(pid)));
      }
      let over = 0;
      for (const [key, held] of heldByPidBucket.get(pid) ?? []) {
        over += callOverageWeight(held, stated.get(key) ?? 0);
      }
      return over;
    },
    overParAssignmentIds: selectStatedOrNettedOverPar(
      callRecords, statedByPid, totalExpectedFor, bucketTargetFor ?? undefined),
  };
}

/** Which assignments carry the OVER treatment, under whichever accounting the
 * site is on.
 *
 * STATED: each (bucket × parent code) is judged ON ITS OWN against its stated
 * count — the no-netting rule. The per-bucket selection reuses
 * selectOverParCover with the bucket's own calls and its stated count as the
 * obligation, so the within-bucket choice (minimal weight, then later dates)
 * is the same tested machinery, one rung down. No bucket preference is passed:
 * inside a single bucket there is nothing left to prefer.
 *
 * DERIVED: the pre-2026-08-03 whole-provider cover, untouched. */
function selectStatedOrNettedOverPar(
  callRecords: OverParCall[],
  statedByPid: ReadonlyMap<string, ReadonlyMap<string, number>>,
  totalExpectedFor: (pid: string) => number,
  bucketTargetFor?: (pid: string, key: string) => number,
): Set<string> {
  if (statedByPid.size === 0) {
    return selectOverParAssignmentIds(callRecords, totalExpectedFor, bucketTargetFor);
  }
  const netted: OverParCall[] = [];
  const statedByPidBucket = new Map<string, Map<string, OverParCall[]>>();
  for (const c of callRecords) {
    if (!statedByPid.has(c.provider_id)) { netted.push(c); continue; }
    const key = c.bucket
      ? overParBucketKey(c.bucket, c.parent_code || c.shift_type_code)
      : null;
    // A call the census could not bucket cannot be judged per bucket; it falls
    // to the netted path with the rest of its provider's un-bucketed calls
    // rather than being silently exempted.
    if (!key) { netted.push(c); continue; }
    let byBucket = statedByPidBucket.get(c.provider_id);
    if (!byBucket) { byBucket = new Map(); statedByPidBucket.set(c.provider_id, byBucket); }
    const list = byBucket.get(key);
    if (list) list.push(c); else byBucket.set(key, [c]);
  }
  const over = netted.length > 0
    ? selectOverParAssignmentIds(netted, totalExpectedFor, bucketTargetFor)
    : new Set<string>();
  for (const [pid, byBucket] of statedByPidBucket) {
    const stated = statedByPid.get(pid)!;
    for (const [key, calls] of byBucket) {
      for (const id of selectOverParCover(calls, stated.get(key) ?? 0).ids) over.add(id);
    }
  }
  return over;
}
