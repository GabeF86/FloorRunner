import { describe, it, expect } from 'vitest';
import {
  fteWeightedTarget, roundedObligation, extraCalls, selectOverParAssignmentIds,
  computeCallObligationCensus,
  type CensusProfile, type CensusSlot,
} from './fteTarget';

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

// ── Par-authoritative (Gabriel 2026-07-24, SUPERSEDES the 2026-07-16 clamp) ──
// The stored sites.call_par_level is THE obligation denominator, never clamped
// to the pool's ΣFTE. When pool ΣFTE < par, obligations deliberately UNDER-
// COVER the schedule — the uncovered remainder is the paid-pickup layer,
// filled after the schedule is built.
describe('par-authoritative effective par — stored par is the denominator, unconditionally', () => {
  const profile = (pid: string, fte = 1): CensusProfile => ({
    provider_id: pid, home_site_id: 'site1',
    call_taker: true, partial_call_taker: false, fte_value: fte,
  });
  const openCall = (date: string): CensusSlot =>
    ({ slot_date: date, shift_types: { category: 'call', code: 'C1' }, assignments: [] });

  it('pool ΣFTE below the stored par NO LONGER clamps (live: par 11, pool 8.75)', () => {
    // Pool = 8 × 1.0 + 0.75 = 8.75 < stored par 11 → effectivePar stays 11.
    const census = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1', includedProviderIds: null,
      profiles: [...Array.from({ length: 8 }, (_, i) => profile(`p${i}`)), profile('pt', 0.75)],
      slots: [],
    });
    expect(census.poolFte).toBeCloseTo(8.75, 9);
    expect(census.effectivePar).toBe(11);
  });

  it("Gabriel's worked example: 42 call slots ÷ par 11 × FTE 1.0 = 3.82 → obligation 4; assignment #5 is a paid extra (OVER)", () => {
    // 42 weekday C1s over a pool whose ΣFTE (8.75) is BELOW the par — the
    // denominator stays 11: 42/11 × 1.0 = 3.818… → rounds to 4. A 5th call is
    // past the obligation → exactly the LAST one gets the OVER treatment.
    const slots = Array.from({ length: 42 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 5 + i));
      const date = d.toISOString().slice(0, 10);
      const held = i < 5 ? [{ id: `a${i}`, provider_id: 'p0' }] : [];
      return { slot_date: date, shift_types: { category: 'call', code: 'C1' }, assignments: held } as CensusSlot;
    });
    const census = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1', includedProviderIds: null,
      profiles: [...Array.from({ length: 8 }, (_, i) => profile(`p${i}`)), profile('pt', 0.75)],
      slots,
    });
    expect(census.effectivePar).toBe(11);
    expect(census.totalExpectedFor('p0')).toBeCloseTo(42 / 11, 9); // 3.818…
    expect(roundedObligation(census.totalExpectedFor('p0'))).toBe(4);
    expect(census.overParAssignmentIds).toEqual(new Set(['a4'])); // 5 held − 4 owed = last 1
  });

  it('his "11/11 is 1": 11 call slots ÷ par 11 × FTE 1.0 = exactly 1 expected', () => {
    const census = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1', includedProviderIds: null,
      profiles: [profile('p1')],
      slots: Array.from({ length: 11 }, (_, i) =>
        openCall(`2026-01-${String(2 + i).padStart(2, '0')}`)),
    });
    expect(census.totalExpectedFor('p1')).toBeCloseTo(1, 9);
    expect(roundedObligation(census.totalExpectedFor('p1'))).toBe(1);
  });

  it('a par BELOW pool ΣFTE also stays authoritative (legitimate spread-thinner, unchanged)', () => {
    // Par 2, pool 3 × 1.0 = 3 → denominator stays 2 (this direction never clamped).
    const census = computeCallObligationCensus({
      storedParLevel: 2, siteId: 'site1', includedProviderIds: null,
      profiles: [profile('p1'), profile('p2'), profile('p3')],
      slots: [openCall('2026-01-05'), openCall('2026-01-06')],
    });
    expect(census.effectivePar).toBe(2);
    expect(census.totalExpectedFor('p1')).toBeCloseTo(1, 9); // 2/2 × 1.0
  });

  it('obligations deliberately UNDER-COVER when pool < par: Σ expected = slots × poolFte/par — the remainder is the pickup layer', () => {
    // 22 slots, par 11, pool 2 → Σ expected = 22 × 2/11 = 4; 18 slots' worth
    // of coverage is left to paid pickups after the schedule is built.
    const census = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1', includedProviderIds: null,
      profiles: [profile('p1'), profile('p2')],
      slots: Array.from({ length: 22 }, (_, i) =>
        openCall(`2026-02-${String(1 + i).padStart(2, '0')}`)),
    });
    const sumExpected = ['p1', 'p2'].reduce((s, pid) => s + census.totalExpectedFor(pid), 0);
    expect(sumExpected).toBeCloseTo(22 * 2 / 11, 9); // 4 — NOT 22
    expect(sumExpected).toBeLessThan(census.totalCallSlots);
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

  it('default pool = home-site call/partial-call takers; effectivePar stays the STORED par (par-authoritative 2026-07-24)', () => {
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
    // Re-pinned 2026-07-24: was 2.25 (clamped to pool ΣFTE); par is authoritative now.
    expect(census.effectivePar).toBe(11);
  });

  it('override pool (included_provider_ids) INTERSECTS the call-taker criterion — narrowing, never widening (Gabriel 2026-07-21; mirrors loadGenerationContext)', () => {
    const census = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1',
      includedProviderIds: ['p4', 'p5'],
      profiles: [
        profile('p1'),                                // taker but NOT in override → out
        profile('p4', { call_taker: false }),          // non-taker in override → OUT (a day doc never becomes call-eligible)
        profile('p5', { home_site_id: 'site2', fte_value: 0.5 }), // taker at another site, in override → in (home-site gate is skipped; role gate is not)
      ],
      slots: [],
    });
    expect(census.poolFte).toBeCloseTo(0.5, 9);
    // Re-pinned 2026-07-24 (par-authoritative): was 0.5 (clamped to the pool).
    expect(census.effectivePar).toBe(11);
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

  it('expected + obligation use the STORED par even when the pool ΣFTE is smaller (par-authoritative 2026-07-24)', () => {
    // Re-pinned (was: effectivePar clamped to pool 2 → p1 expected 3).
    // storedPar 11, pool ΣFTE 2, six call slots: p1 (1.0) = 6/11 ≈ 0.545 →
    // obligation 1. The other 6 − 2×0.545 ≈ 4.9 slots' worth of coverage is
    // the paid-pickup layer, filled after the schedule is built — the engine's
    // obligatory-mode cap uses the same denominator so the two still agree.
    const slots: CensusSlot[] = [];
    for (let d = 5; d <= 10; d++) slots.push(slot(`2026-01-${String(d).padStart(2, '0')}`, 'C1'));
    const census = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1', includedProviderIds: null,
      profiles: [profile('p1'), profile('p2')],
      slots,
    });
    expect(census.effectivePar).toBe(11);
    expect(census.totalExpectedFor('p1')).toBeCloseTo(6 / 11, 9);
    expect(roundedObligation(census.totalExpectedFor('p1'))).toBe(1);
  });

  it('over-par selection runs on the FULL census — a holiday call is selectable and counted', () => {
    // p1 owes 2 (4 slots ÷ par 2 × 1.0), holds 3 → last 1 chronological is
    // OVER, and that latest call sits on a holiday date the modal used to drop.
    // (storedParLevel 11→2, 2026-07-24: par is authoritative now — pinning it
    // at the pool ΣFTE the old clamp produced keeps the obligation at 2.)
    const census = computeCallObligationCensus({
      storedParLevel: 2, siteId: 'site1', includedProviderIds: null,
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
    // (storedParLevel 11→1, 2026-07-24 par-authoritative: pinned at the old
    // clamped value — pool ΣFTE 1 — so expected stays 2/1×1 = 2.)
    const census = computeCallObligationCensus({
      storedParLevel: 1, siteId: 'site1', includedProviderIds: null,
      profiles: [profile('p1', { fte_value: null })],
      slots: [slot('2026-01-05', 'C1'), slot('2026-01-06', 'C1')],
    });
    expect(census.poolFte).toBe(1);
    expect(census.fteFor('p1')).toBe(1);
    expect(census.fteFor('no-profile')).toBe(1);
    expect(census.totalExpectedFor('p1')).toBeCloseTo(2, 9);
  });

  it('poolFteFor: real FTE for pool members, 0 outside the pool; fteFor stays real for everyone (Gabriel 2026-07-22, the 53.3-expected report)', () => {
    // A day doc owes zero calls. Weighting expected by REAL FTE summed 42
    // slots × (11.1 ΣFTE ÷ 8.75 pool FTE) = 53.3 in the live modal — every
    // non-pool physician phantom-contributed a share. Obligation weights must
    // be pool-scoped; workday math keeps real FTE (day docs work weekdays).
    const census = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1', includedProviderIds: null,
      profiles: [
        profile('p1'),                                                    // 1.0 taker → in pool
        profile('dd', { call_taker: false, fte_value: 0.5 }),              // day doc → out
        profile('p5', { home_site_id: 'site2', fte_value: 0.75 }),         // other-site taker → out
      ],
      slots: [slot('2026-01-05', 'C1'), slot('2026-01-06', 'C1')],
    });
    expect(census.poolFteFor('p1')).toBe(1);
    expect(census.poolFteFor('dd')).toBe(0);
    expect(census.poolFteFor('p5')).toBe(0);
    expect(census.poolFteFor('no-profile')).toBe(0);
    // Real FTE is untouched — the workday columns rely on it.
    expect(census.fteFor('dd')).toBe(0.5);
    expect(census.fteFor('p5')).toBe(0.75);
    // Obligation-derived numbers ride the pool weight: non-pool expected = 0.
    expect(census.totalExpectedFor('dd')).toBe(0);
    expect(census.totalExpectedFor('p5')).toBe(0);
    // Re-pinned 2026-07-24 (par-authoritative): the sum of expected is now
    // slots × poolFte/par = 2 × 1/11, NOT the full slot count — with pool ΣFTE
    // (1) below the stored par (11) the shortfall is the deliberate paid-
    // pickup layer. (Old clamp made poolFte/effectivePar = 1 → sum = 2.)
    const sum = ['p1', 'dd', 'p5'].reduce((s, pid) => s + census.totalExpectedFor(pid), 0);
    expect(sum).toBeCloseTo(census.totalCallSlots * census.poolFte / 11, 9);
  });

  it('WEIGHTED census (call splits, 2026-07-22): totalCallSlots and actualCallsFor are weight sums; segments group under the parent code', () => {
    // A split Sat C1: day 0.5 + night 0.5 held by two different docs. The
    // schedule still contains exactly ONE call's worth of C1 that day.
    const segSlot = (date: string, code: string, weight: number, a: Array<{ id: string; provider_id: string | null }>): CensusSlot => ({
      slot_date: date,
      shift_types: { category: 'call', code, call_burden_weight: weight, parent_call_code: 'C1' },
      assignments: a,
    });
    const census = computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1', includedProviderIds: null,
      profiles: [profile('p1'), profile('p2')],
      slots: [
        slot('2026-01-05', 'C1', [asg('a1', 'p1')]),                 // whole call, weight 1
        segSlot('2026-01-10', 'C1D12', 0.5, [asg('s1', 'p1')]),      // day half
        segSlot('2026-01-10', 'C1N12', 0.5, [asg('s2', 'p2')]),      // night half
        segSlot('2026-01-11', 'C1D12', 0.5, [asg('s3', null)]),      // open half still counts its weight
      ],
    });
    expect(census.totalCallSlots).toBeCloseTo(2.5, 9); // 1 + 0.5 + 0.5 + 0.5
    expect(census.actualCallsFor('p1')).toBeCloseTo(1.5, 9);
    expect(census.actualCallsFor('p2')).toBeCloseTo(0.5, 9);
    // callRecords carry weight + parent for downstream (modal) aggregation.
    const s1 = census.callRecords.find(r => r.id === 's1')!;
    expect(s1.weight).toBe(0.5);
    expect(s1.parent_code).toBe('C1');
    const a1 = census.callRecords.find(r => r.id === 'a1')!;
    expect(a1.weight).toBe(1);
    expect(a1.parent_code).toBe('C1');
  });

  it('WEIGHTED over-par selection: whole assignments from the chronological end whose cumulative weight exceeds the rounded obligation', () => {
    // Obligation 1 (2 weighted slots ÷ par 2 × 1.0 = 1). p1 holds a whole
    // call + a later 0.5 night segment → total 1.5 > 1 → exactly the LAST
    // assignment (the segment) is OVER; the whole call within obligation is not.
    // (storedParLevel 11→2, 2026-07-24 par-authoritative: pinned at the old
    // clamped value — pool ΣFTE 2 — to keep the obligation at 1.)
    const census = computeCallObligationCensus({
      storedParLevel: 2, siteId: 'site1', includedProviderIds: null,
      profiles: [profile('p1'), profile('p2')],
      slots: [
        slot('2026-01-05', 'C1', [asg('a1', 'p1')]),
        { slot_date: '2026-01-12', shift_types: { category: 'call', code: 'C1N12', call_burden_weight: 0.5, parent_call_code: 'C1' }, assignments: [asg('s1', 'p1')] },
        { slot_date: '2026-01-12', shift_types: { category: 'call', code: 'C1D12', call_burden_weight: 0.5, parent_call_code: 'C1' }, assignments: [asg('s2', 'p2')] },
      ],
    });
    expect(roundedObligation(census.totalExpectedFor('p1'))).toBe(1);
    expect(census.overParAssignmentIds).toEqual(new Set(['s1']));
  });

  it('WEIGHTED over-par: two 0.5 segments summing to exactly one call are NOT over a 1-call obligation', () => {
    // (storedParLevel 11→2, 2026-07-24 par-authoritative: pinned at the old
    // clamped value — pool ΣFTE 2 — to keep the obligation at 1.)
    const census = computeCallObligationCensus({
      storedParLevel: 2, siteId: 'site1', includedProviderIds: null,
      profiles: [profile('p1'), profile('p2')],
      slots: [
        { slot_date: '2026-01-05', shift_types: { category: 'call', code: 'C1D12', call_burden_weight: 0.5, parent_call_code: 'C1' }, assignments: [asg('s1', 'p1')] },
        { slot_date: '2026-01-06', shift_types: { category: 'call', code: 'C1N12', call_burden_weight: 0.5, parent_call_code: 'C1' }, assignments: [asg('s2', 'p1')] },
        slot('2026-01-07', 'C1', [asg('b1', 'p2')]),
      ],
    });
    // 2 weighted slots ÷ pool 2 × 1.0 = 1 → obligation 1; p1 holds exactly 1.0.
    expect(census.overParAssignmentIds).toEqual(new Set());
  });

  it('WEIGHTED over-par: three 0.3333 thirds (0.9999 stored sum) are NOT over a 1-call obligation', () => {
    const third = (id: string, date: string, code: string) => ({
      slot_date: date,
      shift_types: { category: 'call', code, call_burden_weight: 0.3333, parent_call_code: 'C1' },
      assignments: [asg(id, 'p1')],
    });
    // (storedParLevel 11→2, 2026-07-24 par-authoritative: pinned at the old
    // clamped value — pool ΣFTE 2 — to keep the obligation at 1.)
    const census = computeCallObligationCensus({
      storedParLevel: 2, siteId: 'site1', includedProviderIds: null,
      profiles: [profile('p1'), profile('p2')],
      slots: [
        third('t1', '2026-01-05', 'C1D8'), third('t2', '2026-01-06', 'C1E8'), third('t3', '2026-01-07', 'C1N8'),
        slot('2026-01-08', 'C1', [asg('b1', 'p2')]),
      ],
    });
    // ~2 weighted slots ÷ par 2 × 1.0 ≈ 1 → obligation 1; p1 holds 0.9999.
    expect(census.overParAssignmentIds).toEqual(new Set());
  });

  it('a non-pool provider holding calls has obligation 0 — every one of their calls is over-par', () => {
    // Out-of-pool call coverage is beyond obligation by definition: the OVER
    // treatment shows it as extra rather than crediting a phantom fair share.
    // (storedParLevel 11→1, 2026-07-24 par-authoritative: pinned at the old
    // clamped value — pool ΣFTE 1 (p1 only) — so p1's obligation stays 3 and
    // a1 stays within it.)
    const census = computeCallObligationCensus({
      storedParLevel: 1, siteId: 'site1', includedProviderIds: null,
      profiles: [profile('p1'), profile('dd', { call_taker: false, fte_value: 0.5 })],
      slots: [
        slot('2026-01-05', 'C1', [asg('a1', 'p1')]),
        slot('2026-01-06', 'C1', [asg('d1', 'dd')]),
        slot('2026-01-07', 'C1', [asg('d2', 'dd')]),
      ],
    });
    expect(census.overParAssignmentIds.has('d1')).toBe(true);
    expect(census.overParAssignmentIds.has('d2')).toBe(true);
    expect(census.overParAssignmentIds.has('a1')).toBe(false); // pool member within obligation
  });
});
