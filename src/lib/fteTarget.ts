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

// One call assignment as the OVER-selection helper sees it.
export interface OverParCall {
  id: string;           // assignment id
  provider_id: string;
  slot_date: string;    // ISO date
  shift_type_code: string;
}

// Per-slot OVER labeling (2026-07-17): when a provider exceeds their rounded
// TOTAL obligation, only their LAST N call assignments get the OVER treatment
// (N = extraCalls), chronological by slot_date with shift-code tiebreak — not
// every cell they own. `totalExpectedFor` returns the provider's FRACTIONAL
// total expected calls (the caller computes it from whatever slot totals it
// already has; the rounding lives here).
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
    const extra = extraCalls(list.length, totalExpectedFor(pid));
    if (extra <= 0) continue;
    list.sort((a, b) =>
      a.slot_date.localeCompare(b.slot_date)
      || a.shift_type_code.localeCompare(b.shift_type_code)
      || a.id.localeCompare(b.id));
    for (const c of list.slice(-extra)) over.add(c.id);
  }
  return over;
}
