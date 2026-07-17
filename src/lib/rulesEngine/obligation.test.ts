import { describe, it, expect } from 'vitest';
import { computeObligations, totalExpectedCalls } from './obligation';
import { computeCallObligationCensus, roundedObligation, type CensusSlot } from '@/lib/fteTarget';
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

describe('engine ↔ UI agreement — computeCallObligationCensus mirrors totalExpectedCalls', () => {
  // The obligatory-mode cap (engine) and the OVER/extra labeling (grid + Call
  // Counts modal) must agree on every provider's obligation, or the UI labels
  // calls the engine placed WITHIN obligation as extra. Same stored par, same
  // pool, same slot census — the two formulations must be numerically equal.
  const censusProfiles = (providers: Array<{ id: string; fte_value: number }>) =>
    providers.map(p => ({
      provider_id: p.id, home_site_id: 'site1',
      call_taker: true, partial_call_taker: false, fte_value: p.fte_value,
    }));

  it('matches on open call slots with a par above pool FTE (the live 11-vs-8.82 shape)', () => {
    const providers = [prov('p1'), prov('p2', 0.5)];
    const slots = Array.from({ length: 6 }, (_, i) =>
      callSlot(`c${i}`, `2026-01-${String(5 + i).padStart(2, '0')}`, 'C1'));
    const ctx = buildCtx(slots, providers, { parLevel: 11 });
    const engine = totalExpectedCalls(ctx);
    const engineObl = computeObligations(ctx);

    const census = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1', includedProviderIds: null,
      profiles: censusProfiles(providers),
      slots: slots.map<CensusSlot>(s => ({
        slot_date: s.slot_date,
        shift_types: { category: s.shift_type_category, code: s.shift_type_code },
        assignments: [],
      })),
    });

    for (const p of providers) {
      expect(census.totalExpectedFor(p.id)).toBeCloseTo(engine.get(p.id)!, 9);
      expect(roundedObligation(census.totalExpectedFor(p.id))).toBe(engineObl.get(p.id));
    }
  });

  it('matches when call seeds exist — engine seeds ≡ UI slots that already hold assignments', () => {
    const providers = [prov('p1'), prov('p2', 0.5)];
    const openSlots = [
      callSlot('c1', '2026-01-05', 'C1'),
      callSlot('c2', '2026-01-06', 'C1'),
    ];
    const ctx = buildCtx(openSlots, providers, {
      parLevel: 11,
      seedAssignments: [{
        slot_date: '2026-01-07', provider_id: 'p1',
        shift_type_code: 'C1', shift_type_category: 'call', derived_day_type: 'weekday',
      }],
    });
    const engine = totalExpectedCalls(ctx);

    const census = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1', includedProviderIds: null,
      profiles: censusProfiles(providers),
      slots: [
        ...openSlots.map<CensusSlot>(s => ({
          slot_date: s.slot_date,
          shift_types: { category: s.shift_type_category, code: s.shift_type_code },
          assignments: [],
        })),
        // The seeded call, as the grid sees it: a call slot WITH an assignment.
        {
          slot_date: '2026-01-07', shift_types: { category: 'call', code: 'C1' },
          assignments: [{ id: 'seeded', provider_id: 'p1' }],
        },
      ],
    });

    expect(census.totalCallSlots).toBe(3);
    for (const p of providers) {
      expect(census.totalExpectedFor(p.id)).toBeCloseTo(engine.get(p.id)!, 9);
    }
  });
});
