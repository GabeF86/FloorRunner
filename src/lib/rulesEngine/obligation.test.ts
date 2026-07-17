import { describe, it, expect } from 'vitest';
import { computeObligations, totalExpectedCalls } from './obligation';
import { buildCtx, prov, callSlot, dSlot } from './__fixtures__/buildContext';

// Whole-number TOTAL-level obligations (2026-07-17): per provider,
//   obligation = roundedObligation( Σ_call-buckets (bucketTotal / effectivePar) × fte )
//              = round( totalCallSlots / effectivePar × fte )
// effectivePar = min(ctx.parLevel, Σ pool FTE) — same clamp the quota math uses.
// Deficit carry-forward is NOT part of the obligation (pure base share of THIS
// block); ordering/fairness keeps the fractional bucketTarget map untouched.

describe('computeObligations — rounded total-level obligation per provider', () => {
  it('rounds the FTE share of total call slots (half up), using the par clamp', () => {
    // 6 call slots; pool FTE = 1 + 1 = 2 → effectivePar = min(12, 2) = 2.
    // p1 (1.0): 6/2×1 = 3 → 3.  p2 (0.5 would be 1.5 → 2, tested below).
    const slots = [
      callSlot('c1a', '2026-01-05', 'C1'), callSlot('c2a', '2026-01-05', 'C2'),
      callSlot('c1b', '2026-01-06', 'C1'), callSlot('c2b', '2026-01-06', 'C2'),
      callSlot('c1c', '2026-01-07', 'C1'), callSlot('c2c', '2026-01-07', 'C2'),
    ];
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')]);
    const obl = computeObligations(ctx);
    expect(obl.get('p1')).toBe(3);
    expect(obl.get('p2')).toBe(3);
  });

  it('1.5 rounds up to 2 and 1.3 rounds down to 1 (half-up boundary)', () => {
    // 6 call slots, pool = p1 1.0 + p2 0.5 + p3 0.5 → ΣFTE 2 → effectivePar 2.
    // p2/p3 (0.5): 6/2×0.5 = 1.5 → 2.
    const slots = [
      callSlot('c1a', '2026-01-05', 'C1'), callSlot('c2a', '2026-01-05', 'C2'),
      callSlot('c1b', '2026-01-06', 'C1'), callSlot('c2b', '2026-01-06', 'C2'),
      callSlot('c1c', '2026-01-07', 'C1'), callSlot('c2c', '2026-01-07', 'C2'),
    ];
    const ctx = buildCtx(slots, [prov('p1'), prov('p2', 0.5), prov('p3', 0.5)]);
    const obl = computeObligations(ctx);
    expect(obl.get('p2')).toBe(2); // 1.5 → 2
    expect(obl.get('p1')).toBe(3); // 3.0

    // 13 call slots at par 10 (stored par BELOW pool FTE keeps the stored value):
    // p1 (1.0): 13/10 = 1.3 → 1.
    const manySlots = Array.from({ length: 13 }, (_, i) =>
      callSlot(`c${i}`, `2026-01-${String(5 + i).padStart(2, '0')}`, 'C1'));
    const bigPool = Array.from({ length: 11 }, (_, i) => prov(`q${i}`)); // ΣFTE 11 > par 10
    const ctx2 = buildCtx(manySlots, bigPool, { parLevel: 10 });
    expect(computeObligations(ctx2).get('q0')).toBe(1); // 1.3 → 1
  });

  it('sums across buckets AND codes — total level, not per category', () => {
    // 2 weekday C1 + 1 saturday C2 + 1 sunday C3 = 4 call slots.
    // Pool FTE 2 → effectivePar 2 → p1 (1.0): 4/2 = 2.
    const slots = [
      callSlot('w1', '2026-01-05', 'C1'), callSlot('w2', '2026-01-06', 'C1'),
      callSlot('s1', '2026-01-10', 'C2', 'saturday'),
      callSlot('s2', '2026-01-11', 'C3', 'sunday'),
    ];
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')]);
    expect(computeObligations(ctx).get('p1')).toBe(2);
  });

  it('ignores non-call slots and historical deficit (pure base share of this block)', () => {
    const slots = [
      callSlot('c1', '2026-01-05', 'C1'),
      callSlot('c2', '2026-01-06', 'C1'),
      dSlot('d1', '2026-01-05', 'D1'), // regular — not in bucketTotals
    ];
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      // A large historical deficit must NOT inflate the obligation.
      historicalTotalByBucket: new Map([['weekday|C1', 40]]),
      historicalAssignedByPid: new Map(),
    });
    expect(computeObligations(ctx).get('p1')).toBe(1); // 2/2×1 = 1
  });

  it('zero-FTE providers owe nothing', () => {
    const slots = [callSlot('c1', '2026-01-05', 'C1')];
    const ctx = buildCtx(slots, [prov('p1'), prov('p0', 0)]);
    expect(computeObligations(ctx).get('p0')).toBe(0);
  });

  it('exposes the fractional total expected for accounting displays', () => {
    // 3 call slots, pool FTE 2 → p2 (0.5): 3/2×0.5 = 0.75 fractional → 1 rounded.
    const slots = [
      callSlot('a', '2026-01-05', 'C1'),
      callSlot('b', '2026-01-06', 'C1'),
      callSlot('c', '2026-01-07', 'C1'),
    ];
    const ctx = buildCtx(slots, [prov('p1', 1.5), prov('p2', 0.5)]);
    const frac = totalExpectedCalls(ctx);
    expect(frac.get('p2')).toBeCloseTo(0.75, 9);
    expect(computeObligations(ctx).get('p2')).toBe(1);
  });
});
