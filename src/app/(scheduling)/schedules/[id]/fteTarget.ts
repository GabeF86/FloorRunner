// The house FTE-weighted call-obligation formula (spec choice A):
//   target = (slots in the bucket ÷ site call_par_level) × provider FTE.
// Single source for: grid over-par red cells, modal Extra Calls, and the
// modal's expected-calls displays. Blind to eligibility by design (mirrors
// the pre-existing Extra Calls semantics).
export function fteWeightedTarget(bucketTotal: number, parLevel: number, fte: number): number {
  if (!Number.isFinite(parLevel) || parLevel <= 0) return 0;
  return (bucketTotal / parLevel) * fte;
}
