import { describe, it, expect } from 'vitest';
import {
  fteWeightedTarget, roundedObligation, extraCalls, selectOverParAssignmentIds,
  selectOverParCover, callOverageWeight, MAX_COVER_COMBINATIONS,
  computeCallObligationCensus, overParBucketKey,
  type CensusProfile, type CensusSlot, type OverParCall,
} from './fteTarget';
import { dayTypeBucketOn } from './rulesEngine/shared';

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

// WITHOUT BUCKET DATA (the shape every caller had before 2026-07-29, and the
// shape the census degrades to when a call slot carries no derived_day_type):
// the selection is minimal-weight-then-later-dates, which with uniform weights
// is the last N. The bucket-fairness rule below RE-RANKS these same covers
// when bucket targets are available — see the 'bucket fairness' describe.
describe('selectOverParAssignmentIds — with NO bucket data, the LAST N calls carry the OVER treatment', () => {
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

  // RE-SCOPED 2026-07-29 (bucket fairness). This used to be pinned as THE
  // load-bearing property, unconditionally: "with every weight 1 this selects
  // exactly the last N — the pre-split behavior, byte for byte". That
  // guarantee is RETIRED. Bucket fairness now outranks recency, so with bucket
  // targets available an all-weight-1 provider can have earlier calls flagged
  // (see 'ALL WEIGHT 1 + buckets' below — the case Gabriel reported). What
  // survives, and is what this test now pins, is the DEGRADED path: no bucket
  // data (no `bucketTargetFor`, or calls carrying no `bucket`) → minimal
  // weight + later dates → the last N, for every N. Assertions unchanged; only
  // the claim they stand for is narrower.
  it('ALL WEIGHT 1, no buckets: exactly the last N = actual − obligation, for every N', () => {
    const dates = Array.from({ length: 12 }, (_, i) =>
      `2026-03-${String(1 + i).padStart(2, '0')}`);
    const calls = dates.map((d, i) => call(`w${i}`, 'p1', d, 'C1'));
    for (let obligation = 0; obligation <= 12; obligation++) {
      const n = 12 - obligation;
      const expected = new Set(calls.slice(12 - n).map(c => c.id)); // the LAST n
      expect(selectOverParAssignmentIds(calls, () => obligation)).toEqual(expected);
    }
  });

  it('ALL WEIGHT 1: an explicit weight-1 field behaves as an absent one', () => {
    const calls = [
      { ...call('a1', 'p1', '2026-01-05', 'C1'), weight: 1 },
      { ...call('a2', 'p1', '2026-01-12', 'C2'), weight: 1 },
      { ...call('a3', 'p1', '2026-01-20', 'C1'), weight: 1 },
    ];
    expect(selectOverParAssignmentIds(calls, () => 2)).toEqual(new Set(['a3']));
    expect(selectOverParAssignmentIds(calls, () => 1)).toEqual(new Set(['a2', 'a3']));
  });
});

// ── Minimal-weight cover (Gabriel 2026-07-29) ────────────────────────────────
// "I dont want the Weekday C1 flagged on the schedule as over, since he isnt
// over his weekday c1 obligations. The 12 hr shift on the saturday should be
// the one that is flagged." The flagged set is now the SMALLEST-total-weight
// set of assignments that brings the remainder back to the obligation, later
// dates winning a tie — so what is flagged is what caused the overage.
describe('selectOverParAssignmentIds — the flagged set is the MINIMAL cover of the overage', () => {
  const wcall = (id: string, date: string, code: string, weight?: number): OverParCall =>
    ({ id, provider_id: 'p1', slot_date: date, shift_type_code: code, weight });

  // Horan, live draft: 0.5 FTE, site par 11, block call weight 176 →
  // 176 ÷ 11 × 0.5 = 8.0 → obligation 8. He holds 8.5 (eight whole calls plus
  // one 12h Saturday half), so he is 0.5 over — and that 0.5 IS the split.
  const horan: OverParCall[] = [
    wcall('h-0905', '2026-09-05', 'C1'),          // Sat
    wcall('h-0906', '2026-09-06', 'C2'),          // Sun
    wcall('h-0909', '2026-09-09', 'C2'),          // Wed
    wcall('h-0919', '2026-09-19', 'C3'),          // Sat
    wcall('h-0920', '2026-09-20', 'C3'),          // Sun
    wcall('h-0923', '2026-09-23', 'C2'),          // Wed
    wcall('h-1003', '2026-10-03', 'C1D12', 0.5),  // Sat 12h split
    wcall('h-1014', '2026-10-14', 'C1'),          // Wed
    wcall('h-1019', '2026-10-19', 'C1'),          // Mon — chronologically LAST
  ];
  const horanExpected = () => (176 / 11) * 0.5; // 8.0

  it('HORAN: the 0.5 Saturday split is the only flagged call — his weekday C1s are not', () => {
    expect(roundedObligation(horanExpected())).toBe(8);
    const over = selectOverParAssignmentIds(horan, horanExpected);
    expect(over).toEqual(new Set(['h-1003']));
    // The two weekday C1s (his weekday-C1 count is exactly his 2.0 target) and
    // the chronologically last call the old rule flagged are all clean.
    expect(over.has('h-1014')).toBe(false);
    expect(over.has('h-1019')).toBe(false);
  });

  it('HORAN: the remainder lands EXACTLY on the obligation, not 0.5 under it', () => {
    const over = selectOverParAssignmentIds(horan, horanExpected);
    const remainder = horan
      .filter(c => !over.has(c.id))
      .reduce((s, c) => s + (c.weight ?? 1), 0);
    expect(remainder).toBeCloseTo(8, 9);
    const cover = selectOverParCover(horan, 8);
    expect(cover.coveredWeight).toBeCloseTo(0.5, 9);
    expect(cover.method).toBe('minimal-weight');
  });

  it('prefers a small combination over one whole call when it fits exactly', () => {
    // Obligation 1, holdings 1.0 + 0.5 + 0.5 = 2.0 → 1.0 over. Two covers weigh
    // 1.0: the single whole call, or both halves. The halves are LATER → they
    // win the tie-break.
    const calls = [
      wcall('whole', '2026-01-05', 'C1'),
      wcall('half-a', '2026-01-12', 'C1D12', 0.5),
      wcall('half-b', '2026-01-19', 'C1N12', 0.5),
    ];
    expect(selectOverParAssignmentIds(calls, () => 1)).toEqual(new Set(['half-a', 'half-b']));
  });

  it('the later-dates tie-break survives when the whole call is the LATER one', () => {
    // Same weights, whole call last → the single whole call now wins the tie.
    const calls = [
      wcall('half-a', '2026-01-05', 'C1D12', 0.5),
      wcall('half-b', '2026-01-12', 'C1N12', 0.5),
      wcall('whole', '2026-01-19', 'C1'),
    ];
    expect(selectOverParAssignmentIds(calls, () => 1)).toEqual(new Set(['whole']));
  });

  it('no exact cover: the minimal cover OVERSHOOTS, and the overage stays fractional', () => {
    // Obligation 4, holdings 1.0 + 1.0 + 1.0 + 0.65 + 0.65 + 0.4 = 4.7 → 0.7
    // over. The fractional weights are deliberately built so NO subset of them
    // lands in [0.7, 1.0): 0.65 and 0.4 are each short, 0.65+0.4 = 1.05 and
    // 0.65+0.65 = 1.3 both overshoot further. The cheapest cover is therefore
    // one whole call — the LATEST one — even though he is only 0.7 over.
    const calls = [
      wcall('w1', '2026-01-05', 'C1'),
      wcall('w2', '2026-01-12', 'C1'),
      wcall('w3', '2026-01-19', 'C1'),
      wcall('f1', '2026-01-06', 'CX', 0.65),
      wcall('f2', '2026-01-13', 'CX', 0.65),
      wcall('f3', '2026-01-20', 'CY', 0.4),
    ];
    const cover = selectOverParCover(calls, 4);
    expect(cover.ids).toEqual(['w3']);
    expect(cover.coveredWeight).toBeCloseTo(1.0, 9);
    expect(cover.method).toBe('minimal-weight');
    // The REPORTED overage is the real 0.7 — never the 1.0 that got flagged.
    const held = calls.reduce((s, c) => s + (c.weight ?? 1), 0);
    expect(callOverageWeight(held, 4)).toBeCloseTo(0.7, 9);
  });

  it('EPSILON: three 0.3333 thirds are not over a 1.0 obligation — nothing is flagged', () => {
    const calls = [
      wcall('t1', '2026-01-05', 'C1D8', 0.3333),
      wcall('t2', '2026-01-06', 'C1E8', 0.3333),
      wcall('t3', '2026-01-07', 'C1N8', 0.3333),
    ];
    expect(selectOverParAssignmentIds(calls, () => 1)).toEqual(new Set());
    expect(selectOverParCover(calls, 1).ids).toEqual([]);
    expect(callOverageWeight(0.9999, 1)).toBe(0);
  });

  it('EPSILON: stored-fraction noise must not push the cover past the exact one', () => {
    // 1 + 1 + 0.5×4 + 0.3333 = 4.3333 against obligation 1 → 3.3333 over. The
    // exact cover (1 whole + all four halves + the third = 3.3333) sums, in
    // floating point, a hair BELOW the overage it is meant to clear
    // (3.3333 vs 3.3333000000000004), so a zero-tolerance feasibility test
    // rejects it and takes 3.5 instead — flagging 0.1667 of a call more than
    // he is over and dropping the remainder UNDER the obligation. The house
    // WEIGHT_EPSILON is what keeps the exact cover reachable.
    const calls = [
      wcall('w1', '2026-01-05', 'C1'),
      wcall('w2', '2026-01-06', 'C1'),
      wcall('h1', '2026-01-07', 'C1D12', 0.5),
      wcall('h2', '2026-01-08', 'C1N12', 0.5),
      wcall('h3', '2026-01-09', 'C1D12', 0.5),
      wcall('h4', '2026-01-10', 'C1N12', 0.5),
      wcall('t1', '2026-01-11', 'C1D8', 0.3333),
    ];
    const cover = selectOverParCover(calls, 1);
    expect(cover.coveredWeight).toBeCloseTo(3.3333, 9);
    expect(new Set(cover.ids)).toEqual(new Set(['w2', 'h1', 'h2', 'h3', 'h4', 't1']));
    // The single unflagged call is exactly the 1.0 obligation.
    const remainder = calls
      .filter(c => !cover.ids.includes(c.id))
      .reduce((s, c) => s + (c.weight ?? 1), 0);
    expect(remainder).toBeCloseTo(1, 9);
  });

  it('EPSILON: a fourth third IS over, and only that third is flagged', () => {
    const calls = [
      wcall('t1', '2026-01-05', 'C1D8', 0.3333),
      wcall('t2', '2026-01-06', 'C1E8', 0.3333),
      wcall('t3', '2026-01-07', 'C1N8', 0.3333),
      wcall('t4', '2026-01-08', 'C1D8', 0.3333),
    ];
    expect(selectOverParAssignmentIds(calls, () => 1)).toEqual(new Set(['t4']));
  });

  it('BOUNDED SEARCH: past MAX_COVER_COMBINATIONS it falls back to the chronological tail, observably', () => {
    // 13 assignments, each a DIFFERENT stored weight → 2^13 = 8192 count
    // vectors, past the 4096 cap. The fallback is the pre-2026-07-29 rule and
    // says so in `method` rather than pretending it searched.
    const calls = Array.from({ length: 13 }, (_, i) =>
      wcall(`v${i}`, `2026-01-${String(1 + i).padStart(2, '0')}`, 'C1', 0.5 + i * 0.01));
    // Σ(0.5 + 0.01i), i = 0…12 = 6.5 + 0.78 = 7.28; against obligation 6 that
    // is 1.28 over, and the tail takes 0.62 + 0.61 + 0.60 = 1.83 to clear it.
    const cover = selectOverParCover(calls, 6);
    expect(cover.method).toBe('chronological-tail');
    expect(cover.ids).toEqual(['v12', 'v11', 'v10']);
    // Under the cap the same holdings would have been searched; the fallback is
    // the ONLY reason this is a tail. (Not over at all → no search, no tail.)
    expect(selectOverParCover(calls, 8).ids).toEqual([]);
  });

  it('BOUNDED SEARCH: the live weight vocabulary stays well inside the cap', () => {
    // 40 whole + 8 halves + 6 thirds = 41 × 9 × 7 = 2583 count vectors.
    expect(41 * 9 * 7).toBeLessThan(MAX_COVER_COMBINATIONS);
    const calls = [
      ...Array.from({ length: 40 }, (_, i) =>
        wcall(`w${i}`, `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`, 'C1')),
      ...Array.from({ length: 8 }, (_, i) =>
        wcall(`h${i}`, `2026-02-${String(1 + i).padStart(2, '0')}`, 'C1D12', 0.5)),
      ...Array.from({ length: 6 }, (_, i) =>
        wcall(`t${i}`, `2026-03-${String(1 + i).padStart(2, '0')}`, 'C1D8', 0.3333)),
    ];
    expect(selectOverParCover(calls, 40).method).toBe('minimal-weight');
  });
});

// ── Bucket fairness (Gabriel 2026-07-29, second report the same day) ─────────
// "she is listed as over on C1 weekday calls, she is supposed to have 3 weekday
// calls, why is it showing as over?" Among covers that TIE on weight, the one
// drawing the least weight out of buckets the provider is at-or-under target
// in wins — ranked ABOVE the later-dates tie-break and BELOW minimal weight.
describe('selectOverParCover — bucket fairness re-ranks equal-weight covers', () => {
  // A call that knows its fairness bucket. `bucket` is always what
  // dayTypeBucketOn would return for the slot (weekday/friday/saturday/sunday).
  const bcall = (
    id: string, date: string, code: string, bucket: string, weight?: number,
  ): OverParCall =>
    ({ id, provider_id: 'p1', slot_date: date, shift_type_code: code, bucket, weight });
  /** Targets stated per bucket key, defaulting to 0 (= "over on anything"). */
  const targets = (t: Record<string, number>) => (key: string) => t[key] ?? 0;

  it('OVER IN ONE BUCKET ONLY: the flag lands there, even though the on-target bucket holds the LATER calls', () => {
    // 5 whole calls against obligation 4 → 1.0 over. Weekday C1 target 3.0 and
    // she holds exactly 3; Saturday C1 target 1.0 and she holds 2. Every
    // one-call cover ties on weight, so bucket fairness decides — and it must
    // pick a Saturday even though all three weekday calls are chronologically
    // later than both Saturdays. (Under the old rule this flagged w3.)
    const calls = [
      bcall('sat1', '2026-03-07', 'C1', 'saturday'),
      bcall('sat2', '2026-03-14', 'C1', 'saturday'),
      bcall('w1', '2026-03-16', 'C1', 'weekday'),
      bcall('w2', '2026-03-17', 'C1', 'weekday'),
      bcall('w3', '2026-03-18', 'C1', 'weekday'),
    ];
    const t = targets({ 'weekday|C1': 3, 'saturday|C1': 1 });
    const cover = selectOverParCover(calls, 4, t);
    expect(cover.ids).toEqual(['sat2']);       // the LATER of the two over-bucket calls
    expect(cover.method).toBe('minimal-weight');
    // Same holdings with no bucket data → the old answer, the last call.
    expect(selectOverParCover(calls, 4).ids).toEqual(['w3']);
  });

  it('RANK: bucket fairness outranks the later-dates tie-break, but NOT minimal weight', () => {
    // Over by 0.5. The only 0.5 he holds sits in a bucket he is UNDER in
    // (0.5 held against a 0.75 target); every over-bucket call is a whole 1.0.
    // Minimal weight still wins: flagging the 0.5 is the only cover that lands
    // the remainder exactly on the obligation. Bucket fairness never gets to
    // overrule that — it only reorders covers of EQUAL weight.
    const calls: OverParCall[] = [
      bcall('sun-c1', '2026-03-08', 'C1', 'sunday'),          // 1.0, over bucket
      bcall('sun-c2', '2026-03-15', 'C2', 'sunday'),          // 1.0, over bucket
      // The half folds to saturday|C1 through parent_code — WITHOUT that fold
      // it would key on its segment code, find no target, and read as an
      // over-target bucket, quietly inverting what this test is about.
      { id: 'sat-half', provider_id: 'p1', slot_date: '2026-03-21', shift_type_code: 'C1N12', bucket: 'saturday', parent_code: 'C1', weight: 0.5 },
    ];
    const t = targets({ 'sunday|C1': 0.75, 'sunday|C2': 0.75, 'saturday|C1': 0.75 });
    const cover = selectOverParCover(calls, 2, t);
    expect(cover.ids).toEqual(['sat-half']);
    expect(cover.coveredWeight).toBeCloseTo(0.5, 9);
  });

  it('RANK: two DIFFERENT covers of the same weight — the one blaming the over bucket wins, later dates or not', () => {
    // Over by 1.0, and two covers weigh exactly 1.0: the single weekday call
    // (bucket target 3, she holds 1 → she is UNDER there), or both Saturday
    // halves (saturday|C1 target 0.5, she holds 1.0 → OVER). The weekday call
    // is the LATEST assignment, so the date tie-break alone picks it; bucket
    // fairness must overrule that and flag the two halves.
    // This is the pair-of-count-vectors case: the two covers differ in how many
    // members they take from each weight class, so the ORDERING inside a class
    // cannot decide it — only the at-or-under weight each cover spends can.
    const calls: OverParCall[] = [
      { id: 'h1', provider_id: 'p1', slot_date: '2026-03-07', shift_type_code: 'C1D12', bucket: 'saturday', parent_code: 'C1', weight: 0.5 },
      { id: 'h2', provider_id: 'p1', slot_date: '2026-03-14', shift_type_code: 'C1N12', bucket: 'saturday', parent_code: 'C1', weight: 0.5 },
      { id: 'wk', provider_id: 'p1', slot_date: '2026-03-25', shift_type_code: 'C1', bucket: 'weekday', parent_code: 'C1' },
    ];
    const t = targets({ 'weekday|C1': 3, 'saturday|C1': 0.5 });
    const cover = selectOverParCover(calls, 1, t);
    expect(new Set(cover.ids)).toEqual(new Set(['h1', 'h2']));
    expect(cover.coveredWeight).toBeCloseTo(1, 9);
    // Without targets the later single call wins — the pre-bucket answer.
    expect(selectOverParCover(calls, 1).ids).toEqual(['wk']);
  });

  it('DEGRADES: every bucket at-or-under target → the weight-then-date rule, unchanged', () => {
    // Targets so generous that nothing is over: the preference is a constant
    // and the selection is byte-identical to the no-bucket-data one.
    const calls = [
      bcall('a', '2026-03-01', 'C1', 'weekday'),
      bcall('b', '2026-03-08', 'C1', 'saturday'),
      bcall('c', '2026-03-15', 'C1', 'sunday'),
    ];
    const cover = selectOverParCover(calls, 2, () => 99);
    expect(cover.ids).toEqual(['c']); // latest, exactly as with no targets
    expect(cover.ids).toEqual(selectOverParCover(calls, 2).ids);
  });

  it('DEGRADES: calls carrying no bucket are never preferred, and never crash the search', () => {
    // A mixed payload (some calls bucketed, some not). The unbucketed ones
    // count as "not over" — unknown is not evidence — so the bucketed
    // over-target call is flagged instead of the later unbucketed one.
    const calls = [
      bcall('sat', '2026-03-07', 'C1', 'saturday'),
      { id: 'nob', provider_id: 'p1', slot_date: '2026-03-20', shift_type_code: 'C1' },
      bcall('wk', '2026-03-25', 'C1', 'weekday'),
    ];
    const t = targets({ 'weekday|C1': 3, 'saturday|C1': 0.5 });
    expect(selectOverParCover(calls, 2, t).ids).toEqual(['sat']);
  });

  it('SPLIT SEGMENTS fold into their PARENT code bucket (parent_code, never the code name)', () => {
    // He holds BOTH halves of one Saturday C1 (0.5 + 0.5) and one Sunday C1.
    // Folded to parents: saturday|C1 holds exactly its 1.0 target — ON target —
    // while sunday|C1 holds 1.0 against 0.5 — over. Over by 1.0, and the two
    // covers weighing 1.0 are {the Sunday call} and {both halves}. Fairness
    // picks the Sunday one even though BOTH halves are chronologically later.
    // Read on the SEGMENT codes instead, saturday|C1D12 and saturday|C1N12
    // would each hold 0.5 against a target of nothing, both covers would look
    // equally guilty, and the later halves would take the flag — which is the
    // regression this pins.
    const calls: OverParCall[] = [
      { id: 'sun', provider_id: 'p1', slot_date: '2026-03-08', shift_type_code: 'C1', bucket: 'sunday', parent_code: 'C1' },
      { id: 'h1', provider_id: 'p1', slot_date: '2026-03-14', shift_type_code: 'C1D12', bucket: 'saturday', parent_code: 'C1', weight: 0.5 },
      { id: 'h2', provider_id: 'p1', slot_date: '2026-03-21', shift_type_code: 'C1N12', bucket: 'saturday', parent_code: 'C1', weight: 0.5 },
    ];
    const t = targets({ 'saturday|C1': 1, 'sunday|C1': 0.5 });
    const cover = selectOverParCover(calls, 1, t);
    expect(cover.ids).toEqual(['sun']);
    expect(overParBucketKey('saturday', 'C1')).toBe('saturday|C1');
  });

  it('ALL WEIGHT 1 + buckets: the retired last-N guarantee — recency loses to fairness', () => {
    // The property the doc comment used to promise unconditionally ("with every
    // weight 1 this selects exactly the last N, byte for byte") is RETIRED as
    // of 2026-07-29. Four whole calls, obligation 2 → 2 over. The last two
    // chronologically are weekday C1s she is exactly on target for; the two
    // weekend calls she is over on come first. Bucket fairness flags the
    // WEEKEND pair; the old rule flagged the weekday pair.
    const calls = [
      bcall('sat', '2026-03-07', 'C1', 'saturday'),
      bcall('sun', '2026-03-08', 'C1', 'sunday'),
      bcall('wk1', '2026-03-16', 'C1', 'weekday'),
      bcall('wk2', '2026-03-17', 'C1', 'weekday'),
    ];
    const t = targets({ 'weekday|C1': 2, 'saturday|C1': 0.5, 'sunday|C1': 0.5 });
    expect(new Set(selectOverParCover(calls, 2, t).ids)).toEqual(new Set(['sat', 'sun']));
    expect(new Set(selectOverParCover(calls, 2).ids)).toEqual(new Set(['wk1', 'wk2'])); // the retired answer
  });

  it('INVARIANT: the preference never changes HOW MUCH weight is flagged, only which calls carry it', () => {
    // Rule 1 (minimal total weight) is untouched, so `coveredWeight` — and
    // therefore the Over By / extras TOTALS — is identical with and without
    // bucket targets, for every holding. What moves is the attribution: which
    // cells go red, and which (bucket, code) column the extras land in. Swept
    // over deterministic pseudo-random holdings so the claim is not pinned to
    // one lucky fixture.
    const BUCKETS = ['weekday', 'friday', 'saturday', 'sunday'];
    const WEIGHTS = [1, 1, 1, 0.5, 0.3333];
    // minstd (Lehmer): stays inside 2^53 at every step, so the stream is a real
    // spread rather than float noise — a bigger multiplier silently degenerates
    // here and would leave this sweep testing one repeated holding.
    let seed = 20260729;
    const rnd = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    let overTrials = 0;
    let reordered = 0;
    for (let trial = 0; trial < 400; trial++) {
      const calls: OverParCall[] = Array.from({ length: 4 + rnd(9) }, (_, i) => ({
        id: `c${i}`, provider_id: 'p1',
        slot_date: `2026-0${1 + rnd(9)}-${String(1 + rnd(28)).padStart(2, '0')}`,
        shift_type_code: `C${1 + rnd(3)}`,
        bucket: BUCKETS[rnd(BUCKETS.length)],
        weight: WEIGHTS[rnd(WEIGHTS.length)],
      }));
      const t = () => 0.75 * (1 + rnd(3)); // arbitrary per-bucket targets
      const obligation = rnd(6);
      const withBuckets = selectOverParCover(calls, obligation, t);
      const without = selectOverParCover(calls, obligation);
      expect(withBuckets.coveredWeight).toBeCloseTo(without.coveredWeight, 6);
      expect(withBuckets.method).toBe(without.method);
      if (withBuckets.ids.length > 0) overTrials++;
      if (withBuckets.ids.join() !== without.ids.join()) reordered++;
    }
    // The sweep must actually exercise over-par holdings, and the preference
    // must actually move some of them — otherwise this passes on vacuum.
    expect(overTrials).toBeGreaterThan(100);
    expect(reordered).toBeGreaterThan(10);
  });

  it('HORAN with buckets: unchanged — the 0.5 Saturday split is still the only flag', () => {
    // Same live holdings as the minimal-cover describe, now with his real
    // per-bucket targets at 0.5 FTE on the 176-weight block (weekday 44/11×0.5
    // = 2.0, every Fri/Sat/Sun bucket 11/11×0.5 = 0.5). Bucket fairness cannot
    // move this one: minimal weight already picks the only 0.5 he holds.
    const horanBuckets: OverParCall[] = [
      bcall('h-0905', '2026-09-05', 'C1', 'saturday'),
      bcall('h-0906', '2026-09-06', 'C2', 'sunday'),
      bcall('h-0909', '2026-09-09', 'C2', 'weekday'),
      bcall('h-0919', '2026-09-19', 'C3', 'saturday'),
      bcall('h-0920', '2026-09-20', 'C3', 'sunday'),
      bcall('h-0923', '2026-09-23', 'C2', 'weekday'),
      { id: 'h-1003', provider_id: 'p1', slot_date: '2026-10-03', shift_type_code: 'C1D12', bucket: 'saturday', parent_code: 'C1', weight: 0.5 },
      bcall('h-1014', '2026-10-14', 'C1', 'weekday'),
      bcall('h-1019', '2026-10-19', 'C1', 'weekday'),
    ];
    const t = (key: string) => {
      const slots: Record<string, number> = {
        'weekday|C1': 44, 'weekday|C2': 44,
        'friday|C1': 11, 'friday|C2': 11,
        'saturday|C1': 11, 'saturday|C2': 11, 'saturday|C3': 11,
        'sunday|C1': 11, 'sunday|C2': 11, 'sunday|C3': 11,
      };
      return fteWeightedTarget(slots[key] ?? 0, 11, 0.5);
    };
    expect(t('weekday|C1')).toBe(2);
    expect(t('saturday|C1')).toBe(0.5);
    expect(selectOverParCover(horanBuckets, 8, t).ids).toEqual(['h-1003']);
  });
});

// ── HAVILDAR, live block (Gabriel 2026-07-29) ────────────────────────────────
// 0.75 FTE, site par 11, an 11-week block standing 176 weighted call slots:
// 44 weekday dates × C1,C2 + 11 Fri × C1,C2 + 11 Sat × C1,C2,C3 + 11 Sun ×
// C1,C2,C3. Obligation 176 ÷ 11 × 0.75 = 12.0 → 12; she holds 13.5.
// Her per-bucket position (this is the table the fix was built from, asserted
// below rather than trusted):
//   weekday C1  3.00 target / 3   held   exactly on
//   weekday C2  3.00 target / 3   held   exactly on
//   friday C1   0.75 / 1   ·  friday C2   0.75 / 1     +0.25 each
//   saturday C2 0.75 / 1   ·  saturday C3 0.75 / 1     +0.25 each
//   sunday C1   0.75 / 1   ·  sunday C2   0.75 / 1     +0.25 each
//   sunday C3   0.75 / 1                                +0.25
//   saturday C1 0.75 / 0.5 (a 12h half)                 −0.25  (UNDER)
// Seven buckets +0.25, one −0.25 → exactly her 1.5 overage, ALL of it in the
// Friday/weekend buckets where a 0.75 target can only be met by a whole call.
describe('computeCallObligationCensus — HAVILDAR: the flags follow the buckets she is over in', () => {
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
  // 11 weeks, Monday 2026-08-24 → Sunday 2026-11-08: 44 Mon–Thu, 11 Fri/Sat/Sun.
  const BLOCK = Array.from({ length: 77 }, (_, i) => iso(Date.UTC(2026, 7, 24) + i * 86400000));
  // Two MONDAY holidays inside the block (the live ones). Their stored day type
  // says nothing about the day of week — dayTypeBucketOn must still charge them
  // to the weekday bucket, which is what keeps weekday|C1 at 44 slots and her
  // weekday target at a whole 3.00.
  const HOLIDAYS = new Set(['2026-09-07', '2026-10-12']);
  const dayTypeOf = (d: string) => {
    if (HOLIDAYS.has(d)) return 'federal_holiday';
    const n = dow(d);
    return n === 0 ? 'sunday' : n === 5 ? 'friday' : n === 6 ? 'saturday' : 'weekday';
  };
  const SPLIT_SAT = '2026-10-03'; // the Saturday whose C1 is stood as two 12h halves

  // Her 14 assignments — 13.5 weighted.
  const HELD: Array<[string, string]> = [
    ['2026-09-01', 'C1'], ['2026-09-22', 'C1'], ['2026-10-06', 'C1'], // weekday C1 ×3 — ON target
    ['2026-09-02', 'C2'], ['2026-09-16', 'C2'], ['2026-09-29', 'C2'], // weekday C2 ×3 — ON target
    ['2026-08-28', 'C1'],                                             // friday C1
    ['2026-09-11', 'C2'],                                             // friday C2
    ['2026-09-05', 'C2'], ['2026-09-19', 'C3'],                       // saturday C2, C3
    ['2026-09-06', 'C1'], ['2026-09-13', 'C2'],                       // sunday C1, C2
    ['2026-09-27', 'C3'],                                             // sunday C3 — her LATEST over-bucket 1.0
    [SPLIT_SAT, 'C1N12'],                                             // saturday C1 half (0.5) — UNDER there
  ];
  const heldKey = new Set(HELD.map(([d, c]) => `${d}|${c}`));
  const havId = (d: string, c: string) => `hav-${d}-${c}`;

  const slots: CensusSlot[] = [];
  for (const date of BLOCK) {
    const dayType = dayTypeOf(date);
    const bucket = dayTypeBucketOn(dayType, date);
    const codes = bucket === 'saturday' || bucket === 'sunday' ? ['C1', 'C2', 'C3'] : ['C1', 'C2'];
    for (const code of codes) {
      // The one split call in the block: Sat 10/03's C1 stands as a 12h day
      // half + a 12h night half, so saturday|C1 still totals 11 across 11
      // Saturdays and the block total still comes to 176.
      const segments = date === SPLIT_SAT && code === 'C1'
        ? [{ code: 'C1D12', weight: 0.5 }, { code: 'C1N12', weight: 0.5 }]
        : [{ code, weight: 1 }];
      for (const seg of segments) {
        const held = heldKey.has(`${date}|${seg.code}`);
        slots.push({
          slot_date: date,
          derived_day_type: dayType,
          shift_types: {
            category: 'call', code: seg.code,
            call_burden_weight: seg.weight,
            parent_call_code: seg.weight === 1 ? null : 'C1',
          },
          assignments: held ? [{ id: havId(date, seg.code), provider_id: 'hav' }] : [],
        });
      }
    }
  }
  const profiles: CensusProfile[] = [
    { provider_id: 'hav', home_site_id: 'site1', call_taker: true, partial_call_taker: false, fte_value: 0.75 },
    { provider_id: 'other', home_site_id: 'site1', call_taker: true, partial_call_taker: false, fte_value: 1 },
  ];
  const census = () => computeCallObligationCensus({
    storedParLevel: 11, siteId: 'site1', includedProviderIds: null, profiles, slots,
  });

  it('the block and her holdings are the live ones: 176 weighted slots, obligation 12, holds 13.5', () => {
    const c = census();
    expect(c.totalCallSlots).toBeCloseTo(176, 9);
    expect(c.totalExpectedFor('hav')).toBeCloseTo(12, 9);
    expect(roundedObligation(c.totalExpectedFor('hav'))).toBe(12);
    expect(c.actualCallsFor('hav')).toBeCloseTo(13.5, 9);
    expect(c.overageFor('hav')).toBeCloseTo(1.5, 9);
    expect(HELD.length).toBe(14);
  });

  it('her per-bucket targets are the ones the fix was built from — weekday whole, weekend 0.75', () => {
    const c = census();
    const target = c.bucketTargetFor!;
    // Whole-number weekday targets: 44 weekday slots (the two Monday holidays
    // INCLUDED, via dayTypeBucketOn) ÷ 11 × 0.75 = 3.00 exactly.
    expect(target('hav', 'weekday|C1')).toBeCloseTo(3, 9);
    expect(target('hav', 'weekday|C2')).toBeCloseTo(3, 9);
    // Fri/Sat/Sun: 11 slots ÷ 11 × 0.75 = 0.75 — unreachable with whole calls.
    for (const key of ['friday|C1', 'friday|C2', 'saturday|C1', 'saturday|C2',
      'saturday|C3', 'sunday|C1', 'sunday|C2', 'sunday|C3']) {
      expect(target('hav', key)).toBeCloseTo(0.75, 9);
    }
    // No holiday bucket exists at all — a Monday holiday IS a weekday call.
    expect(target('hav', 'holiday|C1')).toBe(0);
    // She is over in seven buckets by 0.25 and UNDER saturday|C1 by 0.25.
    expect(target('hav', 'saturday|C1') - 0.5).toBeCloseTo(0.25, 9);
  });

  it('FLAGS: the Saturday 12h half and her latest weekend whole call — no weekday call is red', () => {
    const c = census();
    expect(c.overParAssignmentIds).toEqual(new Set([
      havId(SPLIT_SAT, 'C1N12'), // the forced 0.5 — the only one that exists
      havId('2026-09-27', 'C3'), // her LATEST call in a bucket she is over in
    ]));
    // The call the weight-only rule blamed: her chronologically last whole
    // call, a weekday C1 she is exactly on target for. This is the report.
    expect(c.overParAssignmentIds.has(havId('2026-10-06', 'C1'))).toBe(false);
    for (const [d, code] of HELD) {
      if (dayTypeBucketOn(dayTypeOf(d), d) !== 'weekday') continue;
      expect(c.overParAssignmentIds.has(havId(d, code))).toBe(false);
    }
    // And the remainder lands EXACTLY on her 12.0 obligation.
    const flagged = [...c.overParAssignmentIds];
    const flaggedWeight = c.callRecords
      .filter(r => flagged.includes(r.id))
      .reduce((s, r) => s + (r.weight ?? 1), 0);
    expect(c.actualCallsFor('hav') - flaggedWeight).toBeCloseTo(12, 9);
  });
});

describe('computeCallObligationCensus — bucket data is all-or-nothing', () => {
  const profile = (pid: string, fte = 1): CensusProfile =>
    ({ provider_id: pid, home_site_id: 'site1', call_taker: true, partial_call_taker: false, fte_value: fte });

  it('one call slot with no derived_day_type turns the bucket preference OFF for the census', () => {
    // Partial bucket totals would understate a bucket's target and invent an
    // over-target bucket out of missing data, so the census reports
    // bucketTargetFor: null and the selection degrades to weight-then-date.
    const bucketed: CensusSlot = {
      slot_date: '2026-03-07', derived_day_type: 'saturday',
      shift_types: { category: 'call', code: 'C1' }, assignments: [],
    };
    const bare: CensusSlot = {
      slot_date: '2026-03-08', shift_types: { category: 'call', code: 'C1' }, assignments: [],
    };
    expect(computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1', profiles: [profile('p1')], slots: [bucketed],
    }).bucketTargetFor).not.toBeNull();
    expect(computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1', profiles: [profile('p1')], slots: [bucketed, bare],
    }).bucketTargetFor).toBeNull();
    // No call slots at all → nothing to bucket → null (the planner's roster-only
    // census, which never touches the over-par selection).
    expect(computeCallObligationCensus({
      storedParLevel: 11, siteId: 'site1', profiles: [profile('p1')], slots: [],
    }).bucketTargetFor).toBeNull();
  });

  it('FALLBACK: every bucket at-or-under target yet the total is over (rounding) — weight rule, no crash', () => {
    // Day types are stated by the fixture, not derived from the calendar — the
    // census reads derived_day_type, and only holiday types consult the date.
    // par 20, FTE 1. weekday|C1 = 41 slots → target 2.05, she holds 2.0 (UNDER);
    // saturday|C1 = 7 wholes + 3 thirds = 7.9999 → target 0.39999, she holds one
    // third 0.3333 (UNDER). Σ slots 48.9999 → expected 2.44999 → obligation 2,
    // yet she holds 2.3333: the rounding-DOWN of the total is what puts her over
    // while every bucket is clean. Nothing earns the bucket preference, so the
    // minimal-weight rule alone answers: the 0.3333 third.
    const slots: CensusSlot[] = [];
    for (let i = 0; i < 41; i++) {
      const date = `2026-04-${String(1 + (i % 30)).padStart(2, '0')}`;
      slots.push({
        slot_date: date, derived_day_type: 'weekday',
        shift_types: { category: 'call', code: 'C1' },
        assignments: i < 2 ? [{ id: `wk${i}`, provider_id: 'p1' }] : [],
      });
    }
    for (let i = 0; i < 7; i++) {
      slots.push({
        slot_date: `2026-05-${String(1 + i).padStart(2, '0')}`, derived_day_type: 'saturday',
        shift_types: { category: 'call', code: 'C1' }, assignments: [],
      });
    }
    for (let i = 0; i < 3; i++) {
      slots.push({
        slot_date: `2026-05-${String(20 + i).padStart(2, '0')}`, derived_day_type: 'saturday',
        shift_types: { category: 'call', code: `C1S${i}`, call_burden_weight: 0.3333, parent_call_code: 'C1' },
        assignments: i === 0 ? [{ id: 'third', provider_id: 'p1' }] : [],
      });
    }
    const c = computeCallObligationCensus({
      storedParLevel: 20, siteId: 'site1', profiles: [profile('p1')], slots,
    });
    const target = c.bucketTargetFor!;
    expect(target('p1', 'weekday|C1')).toBeCloseTo(2.05, 9);
    expect(c.actualCallsFor('p1')).toBeCloseTo(2.3333, 9);
    expect(roundedObligation(c.totalExpectedFor('p1'))).toBe(2);
    // Both buckets at-or-under: 2.0 ≤ 2.05 and 0.3333 ≤ 0.39999.
    expect(c.actualCallsFor('p1') - 0.3333).toBeLessThanOrEqual(target('p1', 'weekday|C1'));
    expect(0.3333).toBeLessThanOrEqual(target('p1', 'saturday|C1'));
    expect(c.overParAssignmentIds).toEqual(new Set(['third']));
  });
});

describe('callOverageWeight — the FRACTIONAL size of the overage', () => {
  it('is held weight minus the rounded obligation', () => {
    expect(callOverageWeight(8.5, 8)).toBeCloseTo(0.5, 9);
    expect(callOverageWeight(4.7, 4)).toBeCloseTo(0.7, 9);
  });
  it('is 0 at or under the obligation, and inside the house tolerance', () => {
    expect(callOverageWeight(8, 8)).toBe(0);
    expect(callOverageWeight(7.5, 8)).toBe(0);
    expect(callOverageWeight(0.9999, 1)).toBe(0);
    expect(callOverageWeight(1.005, 1)).toBe(0); // < WEIGHT_EPSILON
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

// ── per-bucket blame is QUANTITY-capped (Gabriel 2026-07-30) ────────────────
// "can you tell me why the call count isnt showing the additional sunday C1
// that jones is taking" — it was: the sunday|C1 COLUMN read 2. What was wrong
// was the EXTRA-CALL attribution, which priced all three of his extras as
// weekday. Day type is exactly what that breakout exists to report.
describe('over-par selection — a bucket absorbs only its own overage', () => {
  // Jones's live shape on "Final Weekends": 19 calls against an obligation of
  // 16, exactly 1 over in each of THREE buckets.
  const HELD: Array<[string, string, string]> = [
    // weekday|C1 — 5 held vs target 4
    ['2026-08-12', 'C1', 'weekday'], ['2026-09-02', 'C1', 'weekday'],
    ['2026-09-22', 'C1', 'weekday'], ['2026-10-06', 'C1', 'weekday'],
    ['2026-10-22', 'C1', 'weekday'],
    // weekday|C2 — 5 held vs target 4
    ['2026-08-19', 'C2', 'weekday'], ['2026-09-09', 'C2', 'weekday'],
    ['2026-09-30', 'C2', 'weekday'], ['2026-10-13', 'C2', 'weekday'],
    ['2026-09-07', 'C2', 'weekday'],
    // sunday|C1 — 2 held vs target 1  ← the one that was never blamed
    ['2026-08-23', 'C1', 'sunday'], ['2026-09-06', 'C1', 'sunday'],
    // exactly on target everywhere else
    ['2026-08-28', 'C1', 'friday'], ['2026-08-21', 'C2', 'friday'],
    ['2026-09-26', 'C1', 'saturday'], ['2026-09-05', 'C2', 'saturday'],
    ['2026-09-19', 'C3', 'saturday'],
    ['2026-08-30', 'C2', 'sunday'], ['2026-09-20', 'C3', 'sunday'],
  ];
  const calls = HELD.map(([d, code, bucket]) => ({
    id: `${d}|${code}`, provider_id: 'jones', slot_date: d,
    shift_type_code: code, parent_code: code, bucket, weight: 1,
  }));
  const TARGET: Record<string, number> = {
    'weekday|C1': 4, 'weekday|C2': 4,
    'friday|C1': 1, 'friday|C2': 1,
    'saturday|C1': 1, 'saturday|C2': 1, 'saturday|C3': 1,
    'sunday|C1': 1, 'sunday|C2': 1, 'sunday|C3': 1,
  };

  const cover = () => selectOverParCover(calls, 16, key => TARGET[key] ?? 0);

  it('flags exactly one call from each over-target bucket', () => {
    const flagged = cover().ids.map(id => id.split('|')[0]).sort();
    // Latest in each: weekday|C1 → 10/22, weekday|C2 → 10/13, sunday|C1 → 9/06.
    expect(flagged).toEqual(['2026-09-06', '2026-10-13', '2026-10-22']);
  });

  it('the extra SUNDAY C1 is among them — it is priced as a Sunday', () => {
    expect(cover().ids).toContain('2026-09-06|C1');
  });

  it('no bucket is blamed more than it is over', () => {
    const byBucket = new Map<string, number>();
    for (const id of cover().ids) {
      const c = calls.find(x => x.id === id)!;
      const key = `${c.bucket}|${c.parent_code}`;
      byBucket.set(key, (byBucket.get(key) ?? 0) + 1);
    }
    for (const [key, n] of byBucket) {
      const heldN = calls.filter(c => `${c.bucket}|${c.parent_code}` === key).length;
      expect(n).toBeLessThanOrEqual(heldN - TARGET[key]);
    }
  });

  it('still covers the whole overage — three flags for three over', () => {
    expect(cover().ids).toHaveLength(3);
    expect(cover().method).toBe('minimal-weight');
  });
});
