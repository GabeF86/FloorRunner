import { describe, it, expect } from 'vitest';
import { collapseDatesToRanges, countDaysInYear, countWeekdays, ptoCounterStats } from './dateRanges';

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

describe('countWeekdays', () => {
  it('counts Mon–Fri only', () => {
    // Mon Jul 20 – Sun Jul 26 2026: 5 weekdays.
    const days = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25', '2026-07-26'];
    expect(countWeekdays(days)).toBe(5);
  });
  it('a weekend-only set counts 0', () => {
    expect(countWeekdays(['2026-07-25', '2026-07-26'])).toBe(0);
  });
});

describe('ptoCounterStats', () => {
  // Judge case (round 2): Sat Jun 6 – Sun Jun 14 2026 is 9 calendar days but
  // debits 5 from a physician's PTO bank — the counter's headline must be the
  // weekday number so it can be compared to the annual entitlement.
  it('Sat–Sun PTO week: 5 weekdays booked, 9 calendar days', () => {
    const s = ptoCounterStats([{ start_date: '2026-06-06', end_date: '2026-06-14' }], [], 2026);
    expect(s).toEqual({ weekdaysBooked: 5, weekdaysSold: 0, weekdaysNet: 5, calendarBooked: 9, calendarNet: 9 });
  });

  // Sell-back semantics (Gabriel 2026-07-20): sold-back days are STILL
  // DEDUCTED from the pool — weekdaysBooked (the headline) includes them;
  // weekdaysSold/weekdaysNet are the informational breakdown.
  it('sell-back overlapping PTO: pool debit unchanged, sold reported alongside', () => {
    // PTO Mon Jun 8 – Fri Jun 12; provider sells back Thu–Fri (works them).
    const s = ptoCounterStats(
      [{ start_date: '2026-06-08', end_date: '2026-06-12' }],
      [{ start_date: '2026-06-11', end_date: '2026-06-12' }],
      2026,
    );
    expect(s).toEqual({ weekdaysBooked: 5, weekdaysSold: 2, weekdaysNet: 3, calendarBooked: 5, calendarNet: 3 });
  });

  it('standalone sell-back (no PTO underneath) changes nothing', () => {
    const s = ptoCounterStats(
      [{ start_date: '2026-06-08', end_date: '2026-06-12' }],
      [{ start_date: '2026-09-01', end_date: '2026-09-03' }],
      2026,
    );
    expect(s).toEqual({ weekdaysBooked: 5, weekdaysSold: 0, weekdaysNet: 5, calendarBooked: 5, calendarNet: 5 });
  });

  it('sell-back covering a PTO weekend day nets the calendar count but not weekdays', () => {
    // PTO Sat Jun 6 – Sun Jun 14; sell back Sat Jun 6 (e.g. a weekend call).
    const s = ptoCounterStats(
      [{ start_date: '2026-06-06', end_date: '2026-06-14' }],
      [{ start_date: '2026-06-06', end_date: '2026-06-06' }],
      2026,
    );
    expect(s).toEqual({ weekdaysBooked: 5, weekdaysSold: 0, weekdaysNet: 5, calendarBooked: 9, calendarNet: 8 });
  });

  it('clips to the requested year', () => {
    const s = ptoCounterStats([{ start_date: '2025-12-29', end_date: '2026-01-02' }], [], 2026);
    // Jan 1 (Thu) + Jan 2 (Fri) 2026.
    expect(s.weekdaysBooked).toBe(2);
    expect(s.calendarNet).toBe(2);
  });
});
