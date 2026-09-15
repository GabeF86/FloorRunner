/**
 * formatFte — the FTE label on the dashboard staffing chips.
 *
 * Pure-function test (node environment, zero new deps): the chips render a
 * contract value a chief recognises, so a rounding slip is a wrong number on
 * screen, not a cosmetic one.
 */
import { describe, it, expect } from 'vitest';
import { formatFte } from './DashboardView';

describe('formatFte', () => {
  it('keeps one decimal for whole and tenth values', () => {
    expect(formatFte(1)).toBe('1.0');
    expect(formatFte(0.5)).toBe('0.5');
    expect(formatFte(0.7)).toBe('0.7');
    expect(formatFte(0.6)).toBe('0.6');
    expect(formatFte(0)).toBe('0.0');
  });

  it('keeps two decimals for hundredth values', () => {
    expect(formatFte(0.75)).toBe('0.75');
    expect(formatFte(0.25)).toBe('0.25');
    expect(formatFte(0.85)).toBe('0.85');
  });

  it('does not round 0.55 up to 0.6 (float 0.55 * 100 = 55.00000000000001)', () => {
    expect(formatFte(0.55)).toBe('0.55');
  });

  it('survives the other values whose n * 100 is inexact', () => {
    // 0.29 * 100 === 28.999999999999996, 0.57 * 100 === 56.99999999999999.
    expect(formatFte(0.29)).toBe('0.29');
    expect(formatFte(0.57)).toBe('0.57');
  });
});
