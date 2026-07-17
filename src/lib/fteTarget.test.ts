import { describe, it, expect } from 'vitest';
import {
  fteWeightedTarget, roundedObligation, extraCalls, selectOverParAssignmentIds,
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
