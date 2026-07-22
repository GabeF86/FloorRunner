import { describe, it, expect } from 'vitest';
import { callBurdenWeight, parentCallCodeOf, formatCallWeight, WEIGHT_EPSILON } from './callBurden';

describe('callBurdenWeight — fractional call credit, default 1 (unsplit pin)', () => {
  it('returns the stored weight for a segment shift type', () => {
    expect(callBurdenWeight({ call_burden_weight: 0.5 })).toBe(0.5);
    expect(callBurdenWeight({ call_burden_weight: 0.3333 })).toBeCloseTo(0.3333, 9);
  });
  it('defaults to 1 on every pre-patch35 / absent shape (the byte-identity pin)', () => {
    expect(callBurdenWeight(undefined)).toBe(1);
    expect(callBurdenWeight(null)).toBe(1);
    expect(callBurdenWeight({})).toBe(1);
    expect(callBurdenWeight({ call_burden_weight: null })).toBe(1);
    expect(callBurdenWeight({ call_burden_weight: undefined })).toBe(1);
  });
  it('rejects degenerate stored values (0, negative, NaN, non-number) back to 1', () => {
    expect(callBurdenWeight({ call_burden_weight: 0 })).toBe(1);
    expect(callBurdenWeight({ call_burden_weight: -0.5 })).toBe(1);
    expect(callBurdenWeight({ call_burden_weight: NaN })).toBe(1);
    expect(callBurdenWeight({ call_burden_weight: '0.5' as unknown as number })).toBe(1);
  });
});

describe('parentCallCodeOf — the segment→parent grouping key (never code-name patterns)', () => {
  it('returns the stored parent for a segment', () => {
    expect(parentCallCodeOf('C1N12', { parent_call_code: 'C1' })).toBe('C1');
  });
  it('falls back to the own code when no parent is stored (whole calls, pre-patch35)', () => {
    expect(parentCallCodeOf('C1', undefined)).toBe('C1');
    expect(parentCallCodeOf('C1', null)).toBe('C1');
    expect(parentCallCodeOf('C1', {})).toBe('C1');
    expect(parentCallCodeOf('C1', { parent_call_code: null })).toBe('C1');
    expect(parentCallCodeOf('C1', { parent_call_code: '' })).toBe('C1');
  });
});

describe('formatCallWeight — one decimal only when fractional', () => {
  it('integers render bare', () => {
    expect(formatCallWeight(0)).toBe('0');
    expect(formatCallWeight(3)).toBe('3');
  });
  it('fractional sums render with one decimal', () => {
    expect(formatCallWeight(0.5)).toBe('0.5');
    expect(formatCallWeight(1.5)).toBe('1.5');
    expect(formatCallWeight(0.3333)).toBe('0.3');
  });
  it('near-integer float noise (three 0.3333 segments) renders as the integer', () => {
    expect(formatCallWeight(0.3333 * 3)).toBe('1');
    expect(formatCallWeight(2 + 0.3333 * 3)).toBe('3');
  });
});

describe('WEIGHT_EPSILON — comparison slack for stored-fraction sums', () => {
  it('absorbs the 3×0.3333 shortfall against a whole obligation', () => {
    // 0.9999 must not read as "over" a 1-call obligation…
    expect(0.3333 * 3 > 1 + WEIGHT_EPSILON).toBe(false);
    // …but a genuine extra half-call must.
    expect(1.5 > 1 + WEIGHT_EPSILON).toBe(true);
  });
});
