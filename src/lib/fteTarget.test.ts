import { describe, it, expect } from 'vitest';
import {
  fteWeightedTarget, roundedObligation, extraCalls, selectOverParAssignmentIds,
  clampParToPoolFte, computeCallObligationCensus,
  type CensusProfile, type CensusSlot,
} from './fteTarget';
import { effectiveParLevel } from './rulesEngine/genContext';
import { prov } from './rulesEngine/__fixtures__/buildContext';

describe('fteWeightedTarget', () => {
  it('is (bucketTotal / parLevel) × fte', () => {
    expect(fteWeightedTarget(12, 12, 1)).toBe(1);
    expect(fteWeightedTarget(13, 12, 0.75)).toBeCloseTo(0.8125, 6);
    expect(fteWeightedTarget(9, 12, 0.5)).toBeCloseTo(0.375, 6);
  });
  it('returns 0 for empty buckets and degenerate par levels', () => {
    expect(fteWeightedTarget(0, 12, 1)).toBe(0);
    expect(fteWeightedTarget(10, 0, 1)).toBe(0);
    expect(fteWeightedTarget(10, -3, 1)).toBe(0);
  });
});

describe('roundedObligation — whole-number TOTAL-level obligation (2026-07-17)', () => {
  it('rounds half up: 1.5 → 2', () => {
    expect(roundedObligation(1.5)).toBe(2);
    expect(roundedObligation(2.5)).toBe(3);
  });
  it('rounds down below the half: 1.3 → 1, 0.45 → 0', () => {
    expect(roundedObligation(1.3)).toBe(1);
    expect(roundedObligation(0.45)).toBe(0);
  });
  it('whole numbers pass through', () => {
    expect(roundedObligation(0)).toBe(0);
    expect(roundedObligation(3)).toBe(3);
  });
  it('degenerate inputs (negative / non-finite) yield 0', () => {
    expect(roundedObligation(-0.4)).toBe(0);
    expect(roundedObligation(NaN)).toBe(0);
    expect(roundedObligation(Infinity)).toBe(0);
  });
  it('summing per-bucket fractional targets equals the total-slots formulation (linearity)', () => {
    // Σ_buckets (bucketTotal/par × fte) === (Σ bucketTotals)/par × fte — the
    // obligation may be computed either way without drift.
    const par = 8.82; const fte = 0.75;
    const buckets = [17, 4, 5, 5]; // weekday / fri / sat / sun C-slots
    const summed = buckets.reduce((s, b) => s + fteWeightedTarget(b, par, fte), 0);
    const total = fteWeightedTarget(buckets.reduce((s, b) => s + b, 0), par, fte);
    expect(summed).toBeCloseTo(total, 9);
    expect(roundedObligation(summed)).toBe(roundedObligation(total));
  });
});

describe('extraCalls — actual minus ROUNDED obligation, floored at 0', () => {
  it('calls up to the rounded obligation are never extra', () => {
    expect(extraCalls(2, 1.5)).toBe(0);  // obligation 2
    expect(extraCalls(1, 1.3)).toBe(0);  // obligation 1
    expect(extraCalls(0, 0.45)).toBe(0); // obligation 0
  });
  it('everything past the rounded obligation is extra', () => {
    expect(extraCalls(3, 1.5)).toBe(1);  // obligation 2 → 1 extra
    expect(extraCalls(2, 1.3)).toBe(1);  // obligation 1 → 1 extra
    expect(extraCalls(1, 0.45)).toBe(1); // obligation 0 → 1 extra
  });
  it('under-allocated providers never go negative', () => {
    expect(extraCalls(1, 4.2)).toBe(0);
  });
});

describe('selectOverParAssignmentIds — only the LAST N calls carry the OVER treatment', () => {
  const call = (id: string, pid: string, date: string, code: string) =>
    ({ id, provider_id: pid, slot_date: date, shift_type_code: code });

  it('flags exactly the last N chronological calls, N = extra', () => {
    // p1: expected 1.3 → obligation 1; 3 actual calls → 2 extra → last 2 flagged.
    const calls = [
      call('a1', 'p1', '2026-01-05', 'C1'),
      call('a2', 'p1', '2026-01-12', 'C2'),
      call('a3', 'p1', '2026-01-20', 'C1'),
    ];
    const over = selectOverParAssignmentIds(calls, () => 1.3);
    expect(over).toEqual(new Set(['a2', 'a3']));
  });

  it('flags nothing when actual ≤ rounded obligation', () => {
    const calls = [
      call('a1', 'p1', '2026-01-05', 'C1'),
      call('a2', 'p1', '2026-01-12', 'C2'),
    ];
    expect(selectOverParAssignmentIds(calls, () => 1.5)).toEqual(new Set()); // obligation 2
  });

  it('breaks same-date ties by shift code', () => {
    // Same date, C1 sorts before C2 → the C2 assignment is "later".
    const calls = [
      call('x-c2', 'p1', '2026-01-10', 'C2'),
      call('x-c1', 'p1', '2026-01-10', 'C1'),
      call('y', 'p1', '2026-01-03', 'C1'),
    ];
    const over = selectOverParAssignmentIds(calls, () => 1.6); // obligation 2 → 1 extra
    expect(over).toEqual(new Set(['x-c2']));
  });

  it('selection is per provider and independent across providers', () => {
    const calls = [
      call('p1-a', 'p1', '2026-01-05', 'C1'),
      call('p1-b', 'p1', '2026-01-06', 'C1'),
      call('p2-a', 'p2', '2026-01-05', 'C1'),
    ];
    const expected = (pid: string) => (pid === 'p1' ? 0.6 : 5); // p1 obligation 1; p2 obligation 5
    expect(selectOverParAssignmentIds(calls, expected)).toEqual(new Set(['p1-b']));
  });

  it('input order does not matter (sorted internally)', () => {
    const calls = [
      call('late', 'p1', '2026-01-20', 'C1'),
      call('early', 'p1', '2026-01-02', 'C1'),
    ];
    expect(selectOverParAssignmentIds(calls, () => 1.2)).toEqual(new Set(['late']));
  });
});

describe('clampParToPoolFte — the effective-par clamp shared by engine and UI', () => {
  it('clamps DOWN to the pool ΣFTE when the stored par exceeds it (live: 11 vs 8.82)', () => {
    expect(clampParToPoolFte(11, 8.82)).toBeCloseTo(8.82, 9);
    expect(clampParToPoolFte(12, 1.5)).toBeCloseTo(1.5, 9);
  });
  it('never clamps up — a par below pool FTE is a legitimate spread-thinner choice', () => {
    expect(clampParToPoolFte(2, 3)).toBe(2);
  });
  it('empty / zero-FTE pool keeps the stored par (nothing to clamp to)', () => {
    expect(clampParToPoolFte(12, 0)).toBe(12);
    expect(clampParToPoolFte(12, -1)).toBe(12);
  });
  it('is the SAME clamp the engine quota math uses (genContext.effectiveParLevel delegates)', () => {
    const pool = [prov('p1', 1), prov('p2', 0.5)];
    expect(effectiveParLevel(12, pool)).toBe(clampParToPoolFte(12, 1.5));
    expect(effectiveParLevel(1, pool)).toBe(clampParToPoolFte(1, 1.5));
    expect(effectiveParLevel(12, [])).toBe(clampParToPoolFte(12, 0));
  });
});

describe('computeCallObligationCensus — ONE obligation input set for grid and modal', () => {
  const profile = (pid: string, over: Partial<CensusProfile> = {}): CensusProfile => ({
    provider_id: pid, home_site_id: 'site1',
    call_taker: true, partial_call_taker: false, fte_value: 1, ...over,
  });
  const slot = (
    date: string, code: string,
    assignments: Array<{ id: string; provider_id: string | null }> = [],
    category = 'call',
  ): CensusSlot => ({ slot_date: date, shift_types: { category, code }, assignments });
  const asg = (id: string, pid: string | null) => ({ id, provider_id: pid });

  it('default pool = home-site call/partial-call takers; effectivePar clamps to their ΣFTE', () => {
    const census = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1', includedProviderIds: null,
      profiles: [
        profile('p1'),                                                              // 1.0 taker
        profile('p2', { fte_value: 0.75 }),                                         // 0.75 taker
        profile('p3', { call_taker: false, partial_call_taker: true, fte_value: 0.5 }), // partial counts
        profile('p4', { call_taker: false }),                                       // non-taker → out
        profile('p5', { home_site_id: 'site2' }),                                   // other site → out
      ],
      slots: [],
    });
    expect(census.poolFte).toBeCloseTo(2.25, 9);
    expect(census.effectivePar).toBeCloseTo(2.25, 9);
  });

  it('override pool (included_provider_ids) is exactly those providers — home-site/taker gates skipped', () => {
    const census = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1',
      includedProviderIds: ['p4', 'p5'],
      profiles: [
        profile('p1'),                                // taker but NOT in override → out
        profile('p4', { call_taker: false }),          // non-taker, in override → in
        profile('p5', { home_site_id: 'site2', fte_value: 0.5 }), // other site, in override → in
      ],
      slots: [],
    });
    expect(census.poolFte).toBeCloseTo(1.5, 9);
    expect(census.effectivePar).toBeCloseTo(1.5, 9);
  });

  it('an EMPTY override array falls back to the default pool (mirrors the generate route)', () => {
    const census = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1', includedProviderIds: [],
      profiles: [profile('p1'), profile('p2', { call_taker: false })],
      slots: [],
    });
    expect(census.poolFte).toBe(1);
  });

  it('counts EVERY call-category slot — holiday-dated and non-C1/C2/C3 codes included', () => {
    // The grid memo always counted these; the modal used to skip holiday day
    // types and restrict to C1–C3 — feeding DIFFERENT inputs into the shared
    // selector. The census is the single source now; there is no day-type or
    // code filter at all.
    const census = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1', includedProviderIds: null,
      profiles: [profile('p1')],
      slots: [
        slot('2026-01-01', 'C1', [asg('a1', 'p1')]),            // New Year's Day — still a call slot
        slot('2026-01-02', 'CB', [asg('a2', 'p1')]),            // beeper-style call code
        slot('2026-01-03', 'C2', [asg('a3', 'p1')]),
        slot('2026-01-03', 'D1', [asg('a4', 'p1')], 'regular'), // regular — ignored
        slot('2026-01-04', 'C2', [asg('a5', null)]),            // unfilled — counts, no record
      ],
    });
    expect(census.totalCallSlots).toBe(4);
    expect(census.callRecords.map(r => r.id).sort()).toEqual(['a1', 'a2', 'a3']);
    expect(census.actualCallsFor('p1')).toBe(3);
  });

  it('expected + obligation use effectivePar, NOT the stored par', () => {
    // storedPar 11 but pool ΣFTE 2 → effectivePar 2. Six call slots.
    // p1 (1.0): 6/2×1 = 3 expected. At the stored par it would be 6/11 ≈ 0.55
    // → obligation 1 — the engine-vs-UI mismatch this census kills: the engine
    // caps at 3, so the UI must owe 3 too or it mislabels calls 2-3 as extra.
    const slots: CensusSlot[] = [];
    for (let d = 5; d <= 10; d++) slots.push(slot(`2026-01-${String(d).padStart(2, '0')}`, 'C1'));
    const census = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1', includedProviderIds: null,
      profiles: [profile('p1'), profile('p2')],
      slots,
    });
    expect(census.effectivePar).toBe(2);
    expect(census.totalExpectedFor('p1')).toBeCloseTo(3, 9);
    expect(roundedObligation(census.totalExpectedFor('p1'))).toBe(3);
  });

  it('over-par selection runs on the FULL census — a holiday call is selectable and counted', () => {
    // p1 owes 2 (4 slots / pool 2 × 1.0), holds 3 → last 1 chronological is
    // OVER, and that latest call sits on a holiday date the modal used to drop.
    const census = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1', includedProviderIds: null,
      profiles: [profile('p1'), profile('p2')],
      slots: [
        slot('2026-05-04', 'C1', [asg('a1', 'p1')]),
        slot('2026-05-11', 'C1', [asg('a2', 'p1')]),
        slot('2026-05-25', 'C1', [asg('a3', 'p1')]), // Memorial Day
        slot('2026-05-26', 'C1', [asg('b1', 'p2')]),
      ],
    });
    expect(census.overParAssignmentIds).toEqual(new Set(['a3']));
  });

  it('fte coercion matches the engine: null fte → 1; providers without a profile default to 1', () => {
    // genContext coerces profile fte with `|| 1`; the census must not drift.
    const census = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1', includedProviderIds: null,
      profiles: [profile('p1', { fte_value: null })],
      slots: [slot('2026-01-05', 'C1'), slot('2026-01-06', 'C1')],
    });
    expect(census.poolFte).toBe(1);
    expect(census.fteFor('p1')).toBe(1);
    expect(census.fteFor('no-profile')).toBe(1);
    expect(census.totalExpectedFor('p1')).toBeCloseTo(2, 9);
  });
});
