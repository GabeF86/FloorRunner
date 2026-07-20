import { describe, it, expect } from 'vitest';
import { collapseDatesToRanges, countDaysInYear } from './dateRanges';

describe('collapseDatesToRanges', () => {
  it('returns empty for empty input', () => {
    expect(collapseDatesToRanges([])).toEqual([]);
  });

  it('single day becomes a single-day range', () => {
    expect(collapseDatesToRanges(['2026-07-20'])).toEqual([
      { start: '2026-07-20', end: '2026-07-20' },
    ]);
  });

  it('contiguous run collapses to one range', () => {
    expect(collapseDatesToRanges(['2026-07-20', '2026-07-21', '2026-07-22'])).toEqual([
      { start: '2026-07-20', end: '2026-07-22' },
    ]);
  });

  it('gaps split runs; isolated days stay single-day', () => {
    expect(collapseDatesToRanges(['2026-07-20', '2026-07-21', '2026-07-23', '2026-07-27'])).toEqual([
      { start: '2026-07-20', end: '2026-07-21' },
      { start: '2026-07-23', end: '2026-07-23' },
      { start: '2026-07-27', end: '2026-07-27' },
    ]);
  });

  it('unsorted input with duplicates still produces minimal sorted ranges', () => {
    expect(collapseDatesToRanges(['2026-07-22', '2026-07-20', '2026-07-21', '2026-07-21'])).toEqual([
      { start: '2026-07-20', end: '2026-07-22' },
    ]);
  });

  it('collapses across a month boundary', () => {
    expect(collapseDatesToRanges(['2026-07-31', '2026-08-01'])).toEqual([
      { start: '2026-07-31', end: '2026-08-01' },
    ]);
  });

  it('collapses across a year boundary', () => {
    expect(collapseDatesToRanges(['2026-12-31', '2027-01-01'])).toEqual([
      { start: '2026-12-31', end: '2027-01-01' },
    ]);
  });
});

describe('countDaysInYear', () => {
  it('counts calendar days including weekends', () => {
    // Mon Jul 20 – Sun Jul 26 2026 = 7 calendar days.
    expect(countDaysInYear([{ start_date: '2026-07-20', end_date: '2026-07-26' }], 2026)).toBe(7);
  });

  it('clips a range straddling the year start', () => {
    // Dec 29 2025 – Jan 3 2026 → 3 days inside 2026 (Jan 1–3).
    expect(countDaysInYear([{ start_date: '2025-12-29', end_date: '2026-01-03' }], 2026)).toBe(3);
    expect(countDaysInYear([{ start_date: '2025-12-29', end_date: '2026-01-03' }], 2025)).toBe(3);
  });

  it('a range entirely outside the year contributes 0', () => {
    expect(countDaysInYear([{ start_date: '2025-06-01', end_date: '2025-06-05' }], 2026)).toBe(0);
  });

  it('overlapping ranges never double-count', () => {
    expect(countDaysInYear([
      { start_date: '2026-03-02', end_date: '2026-03-06' },
      { start_date: '2026-03-05', end_date: '2026-03-09' },
    ], 2026)).toBe(8); // Mar 2–9 distinct
  });

  it('malformed row (end < start) counts nothing', () => {
    expect(countDaysInYear([{ start_date: '2026-03-06', end_date: '2026-03-02' }], 2026)).toBe(0);
  });

  it('empty input counts 0', () => {
    expect(countDaysInYear([], 2026)).toBe(0);
  });
});
