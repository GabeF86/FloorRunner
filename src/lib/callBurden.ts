// Call-split burden weights (2026-07-22, patch35) — THE single home for the
// fractional-call-credit vocabulary shared by the UI census (fteTarget.ts),
// the schedule grid / Call Counts modal, and the rules engine (genContext /
// solve seed counting / provider caps / validation).
//
// A split call is served by SEGMENT shift types (patch35):
//   • shift_types.call_burden_weight — fractional call credit (12h = 0.5,
//     8h = 0.3333). Whole calls store 1 (column default).
//   • shift_types.parent_call_code — the parent call code (e.g. 'C1') the
//     segment groups under for fairness buckets, caps, obligations and the
//     modal columns. THIS COLUMN IS THE MAPPING — never key any of this on
//     code-name patterns.
//
// Every helper defaults to the pre-patch35 behavior (weight 1, parent = own
// code) on absent/degenerate input, so unsplit schedules — and pre-patch35
// DBs whose loads never see the columns — are byte-identical by construction.

export interface BurdenWeighted {
  call_burden_weight?: number | null;
}

export interface ParentCoded {
  parent_call_code?: string | null;
}

// Comparison slack for stored-fraction sums: three 0.3333 thirds sum to
// 0.9999, which must never read as "over" a whole-call obligation. Any
// cumulative-weight comparison against a whole number goes through this.
export const WEIGHT_EPSILON = 0.01;

/** Fractional call credit for a shift type; 1 unless a valid positive weight is stored. */
export function callBurdenWeight(st: BurdenWeighted | null | undefined): number {
  const w = st?.call_burden_weight;
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 1;
}

/** The grouping/caps/bucket key: the stored parent call code, else the own code. */
export function parentCallCodeOf(code: string, st: ParentCoded | null | undefined): string {
  const parent = st?.parent_call_code;
  return typeof parent === 'string' && parent.length > 0 ? parent : code;
}

/** Weighted call counts render with one decimal ONLY when fractional; near-integer
 * float noise (3 × 0.3333) collapses to the integer. */
export function formatCallWeight(n: number): string {
  const rounded = Math.round(n);
  if (Math.abs(n - rounded) < WEIGHT_EPSILON) return String(rounded);
  return n.toFixed(1);
}
