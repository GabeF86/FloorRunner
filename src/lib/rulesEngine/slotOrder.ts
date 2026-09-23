// SLOT ORDER — diversification over the greedy's COMMITMENT ORDER.
//
// Gabriel 2026-09-22: "would it be possible for the engine to attack the
// schedule simultaneously from both ends of the block?"
//
// Not as a single bidirectional pass, deliberately. Post-call rest and chain
// links propagate FORWARD (+1/+2 offsets), so a backward sweep meeting a
// forward sweep collides exactly where chains live, and the seam needs
// conflict arbitration that can only break them. Instead each ordering is a
// COMPLETE, forward-consistent solve — solveMultiStart already runs K of those
// and keeps the best, so direction becomes one more start dimension and the
// seam never exists.
//
// What this fixes: solveMultiStart's K starts currently differ only in
// tieBreakSeed, which rotates scoreCall's FINAL id tiebreak — the last term in
// a lexicographic sort, so it changes nothing unless request tier, neuro
// shortfall, lifetime ratio and recency have ALL tied. Eight starts that
// explore almost nothing. The commitment order is the knob that actually
// moves the outcome.
//
// SCOPE: only CALL-category slots are permuted. Non-call slots keep their
// exact original index — the relief and mop-up passes rank the pool
// themselves (see SolveOptions.callsOnly), so reordering day slots here would
// be noise at best.
import type { GenerationContext, SlotOrder, SlotToFill } from './genTypes';
import { evaluateEligibility } from './eligibility';
import { emptySolveState } from './solveState';

export type { SlotOrder };

export const SLOT_ORDERS: SlotOrder[] = ['forward', 'reverse', 'outside-in', 'constrained'];

/** Dates in first-appearance order, each mapped to its slots in array order. */
function groupByDate(calls: readonly SlotToFill[]): Map<string, SlotToFill[]> {
  const groups = new Map<string, SlotToFill[]>();
  for (const s of calls) {
    const bucket = groups.get(s.slot_date);
    if (bucket) bucket.push(s);
    else groups.set(s.slot_date, [s]);
  }
  return groups;
}

/** [first, last, second, second-last, …] — both ends inward. */
function outsideIn<T>(items: readonly T[]): T[] {
  const out: T[] = [];
  let lo = 0;
  let hi = items.length - 1;
  while (lo <= hi) {
    out.push(items[lo]);
    if (lo !== hi) out.push(items[hi]);
    lo++;
    hi--;
  }
  return out;
}

/**
 * Fewest statically-eligible providers first — the classic constraint-
 * programming "most constrained variable" rule: commit the slots with the
 * least freedom while freedom still exists, so the hard ones are not left to
 * whatever capacity survives.
 *
 * Eligibility is measured against an EMPTY solve state, so only the static
 * gates fire (group, credentials, weekday availability, PTO with bookend,
 * adjacent-week weekend exclusion, cross-schedule conflicts). The dynamic
 * gates depend on what has been placed, which is precisely the thing this
 * ordering is choosing — reading them here would be circular. 'call-no-quota'
 * for the same reason the CP-SAT export uses it: the quota is a dynamic rule,
 * and letting it fire would bake a greedy artefact into the ordering.
 */
function byConstrainedness(
  calls: readonly SlotToFill[],
  ctx: GenerationContext,
): SlotToFill[] {
  const state = emptySolveState();
  const providers = ctx.providers.filter(p => p.fte_value > 0);
  const freedom = new Map<string, number>();
  for (const s of calls) {
    let n = 0;
    for (const p of providers) {
      if (evaluateEligibility(s, p, state, ctx, 'call-no-quota').eligible) n++;
    }
    freedom.set(s.slot_id, n);
  }
  // Original index is carried explicitly rather than relying on sort
  // stability: same ctx must always produce the same order.
  return calls
    .map((s, i) => ({ s, i }))
    .sort((a, b) =>
      (freedom.get(a.s.slot_id)! - freedom.get(b.s.slot_id)!) || (a.i - b.i))
    .map(x => x.s);
}

/**
 * Reorder the call slots the main loop will attempt. Absent / 'forward'
 * returns the input array UNCHANGED (identity, not a copy), so the default
 * path is byte-identical to the pre-change engine.
 */
export function applySlotOrder(
  slots: SlotToFill[],
  order: SlotOrder | undefined,
  ctx: GenerationContext,
): SlotToFill[] {
  if (!order || order === 'forward') return slots;

  const positions: number[] = [];
  const calls: SlotToFill[] = [];
  slots.forEach((s, i) => {
    if (s.shift_type_category === 'call') { positions.push(i); calls.push(s); }
  });
  if (calls.length === 0) return slots;

  let reordered: SlotToFill[];
  if (order === 'constrained') {
    reordered = byConstrainedness(calls, ctx);
  } else {
    const groups = groupByDate(calls);
    const dates = [...groups.keys()];
    const seq = order === 'reverse' ? [...dates].reverse() : outsideIn(dates);
    reordered = seq.flatMap(d => groups.get(d)!);
  }

  const out = [...slots];
  positions.forEach((pos, k) => { out[pos] = reordered[k]; });
  return out;
}
