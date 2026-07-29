import { WEIGHT_EPSILON, callBurdenWeight, parentCallCodeOf } from './callBurden';

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
export interface OverParCall {
  id: string;           // assignment id
  provider_id: string;
  slot_date: string;    // ISO date
  shift_type_code: string;
  weight?: number;
  parent_code?: string;
}

// Per-slot OVER labeling (2026-07-17; WEIGHTED 2026-07-22; MINIMAL-COVER
// 2026-07-29): when a provider's cumulative call WEIGHT exceeds their rounded
// TOTAL obligation, the flagged set is the SMALLEST-TOTAL-WEIGHT set of their
// assignments that brings the rest back to at most the obligation, ties broken
// toward LATER dates. With every weight 1 this selects exactly the last
// N = actual − obligation assignments — the pre-split behavior, byte for
// byte. WEIGHT_EPSILON absorbs stored-fraction noise (3 × 0.3333 = 0.9999
// is not "over" a 1-call obligation). `totalExpectedFor` returns the
// provider's FRACTIONAL total expected calls (the caller computes it from
// whatever slot totals it already has; the rounding lives here).
//
// WHY MINIMAL WEIGHT, not the chronological tail (Gabriel 2026-07-29, live
// case): Horan, 0.5 FTE at par 11 on a 176-weight block, owes 8 and holds 8.5
// — eight whole calls plus one 12h Saturday half (C1D12, weight 0.5). The
// chronological tail removed his LAST WHOLE call (a weekday C1), which
// (a) flagged a call he is not over on — his 2 weekday C1s are exactly his
// weekday-C1 target — and (b) overstated the overage, painting 1.0 red when
// he is 0.5 over and leaving the remainder 0.5 UNDER. Minimal weight flags
// the 0.5 split instead: 8.5 − 0.5 = 8.0, exactly the obligation. What is
// flagged is now what actually caused the overage.
export function selectOverParAssignmentIds(
  calls: OverParCall[],
  totalExpectedFor: (providerId: string) => number,
): Set<string> {
  const byPid = new Map<string, OverParCall[]>();
  for (const c of calls) {
    const list = byPid.get(c.provider_id);
    if (list) list.push(c); else byPid.set(c.provider_id, [c]);
  }
  const over = new Set<string>();
  for (const [pid, list] of byPid) {
    const obligation = roundedObligation(totalExpectedFor(pid));
    for (const id of selectOverParCover(list, obligation).ids) over.add(id);
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
 * method fired. */
export function selectOverParCover(
  calls: ReadonlyArray<OverParCall>,
  obligation: number,
): OverParCover {
  const sorted = [...calls].sort(chronoCompare);
  const weights = sorted.map(c => callBurdenWeight({ call_burden_weight: c.weight }));
  const total = weights.reduce((s, w) => s + w, 0);
  // Not over (WEIGHT_EPSILON: three 0.3333 thirds are not over a 1.0 obligation).
  if (total <= obligation + WEIGHT_EPSILON) {
    return { ids: [], coveredWeight: 0, method: 'minimal-weight' };
  }
  const needed = total - obligation;
  const minimal = minimalWeightCover(sorted, weights, needed);
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

/** Smallest-total-weight set covering `needed`, latest dates on a tie; null
 * when the enumeration would exceed MAX_COVER_COMBINATIONS (caller falls back).
 * `sorted` is chronological ascending and `weights` is parallel to it. */
function minimalWeightCover(
  sorted: ReadonlyArray<OverParCall>,
  weights: ReadonlyArray<number>,
  needed: number,
): OverParCover | null {
  // Group by exact stored weight — the indices of each class stay ascending.
  const classes = new Map<number, number[]>();
  for (let i = 0; i < weights.length; i++) {
    const list = classes.get(weights[i]);
    if (list) list.push(i); else classes.set(weights[i], [i]);
  }
  const classList = Array.from(classes, ([weight, indices]) => ({ weight, indices }));
  let combinations = 1;
  for (const c of classList) {
    combinations *= c.indices.length + 1;
    if (combinations > MAX_COVER_COMBINATIONS) return null; // → observable fallback
  }

  // Candidate = a count per weight class. Its BEST members are forced: taking
  // the LATEST count_i of a class is pointwise later than any other choice with
  // the same counts, so it wins the later-dates tie-break outright.
  let best: { indices: number[]; total: number } | null = null;
  const counts = new Array<number>(classList.length).fill(0);
  for (let n = 0; n < combinations; n++) {
    let rest = n;
    let total = 0;
    for (let g = 0; g < classList.length; g++) {
      const radix = classList[g].indices.length + 1;
      counts[g] = rest % radix;
      rest = (rest - counts[g]) / radix;
      total += counts[g] * classList[g].weight;
    }
    if (total < needed - WEIGHT_EPSILON) continue;              // does not cover
    if (best && total > best.total + WEIGHT_EPSILON) continue;  // heavier than the best
    const indices: number[] = [];
    for (let g = 0; g < classList.length; g++) {
      const src = classList[g].indices;
      for (let k = src.length - counts[g]; k < src.length; k++) indices.push(src[k]);
    }
    indices.sort((a, b) => b - a); // descending = latest first
    if (!best || total < best.total - WEIGHT_EPSILON) {
      best = { indices, total };
    } else if (isLaterCover(indices, best.indices)) {
      // Tie on weight (inside the house tolerance): later dates win. Keep the
      // SMALLEST tied total as the yardstick so a chain of near-ties can never
      // drift the comparison by more than one epsilon.
      best = { indices, total: Math.min(total, best.total) };
    } else {
      best.total = Math.min(best.total, total);
    }
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
}

export interface CallObligationCensus {
  poolFte: number;
  effectivePar: number;
  totalCallSlots: number;
  callRecords: OverParCall[];
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
  actualCallsFor: (providerId: string) => number;
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
  let totalCallSlots = 0;
  const callRecords: OverParCall[] = [];
  const actualByPid = new Map<string, number>();
  for (const slot of input.slots) {
    if (slot.shift_types?.category !== 'call') continue;
    const weight = callBurdenWeight(slot.shift_types);
    totalCallSlots += weight;
    for (const a of slot.assignments || []) {
      if (!a.provider_id) continue;
      callRecords.push({
        id: a.id, provider_id: a.provider_id,
        slot_date: slot.slot_date, shift_type_code: slot.shift_types.code,
        weight,
        parent_code: parentCallCodeOf(slot.shift_types.code, slot.shift_types),
      });
      actualByPid.set(a.provider_id, (actualByPid.get(a.provider_id) || 0) + weight);
    }
  }

  const fteFor = (pid: string) => fteByPid.get(pid) ?? 1;
  // Obligation weight: pool members only. A non-pool provider (day doc, a
  // visiting doc outside the override) owes zero calls — every call they DO
  // hold is beyond obligation by definition (over-par selection sees it).
  const poolFteFor = (pid: string) => (poolPids.has(pid) ? fteByPid.get(pid)! : 0);
  const totalExpectedFor = (pid: string) => fteWeightedTarget(totalCallSlots, effectivePar, poolFteFor(pid));
  const actualCallsFor = (pid: string) => actualByPid.get(pid) || 0;
  return {
    poolFte,
    effectivePar,
    totalCallSlots,
    callRecords,
    fteFor,
    poolFteFor,
    totalExpectedFor,
    actualCallsFor,
    overageFor: pid =>
      callOverageWeight(actualCallsFor(pid), roundedObligation(totalExpectedFor(pid))),
    overParAssignmentIds: selectOverParAssignmentIds(callRecords, totalExpectedFor),
  };
}
