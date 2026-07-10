import { describe, it, expect } from 'vitest';
import {
  addDays,
  dayOfWeekUTC,
  mondayOfWeek,
  thursdayBeforeWeekOf,
  datesOverlap,
  daysBetween,
  effectivePtoRange,
  normalizeWeekdays,
  dayTypeBucket,
  isBlockingAvailability,
} from './shared';

// Characterization tests pinning the hard-won date / PTO / bucket logic.
// 2026-01-01 is a Thursday; the week Mon..Sun containing it starts 2025-12-29.

describe('addDays (UTC)', () => {
  it('adds and subtracts days', () => {
    expect(addDays('2026-01-01', 1)).toBe('2026-01-02');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('dayOfWeekUTC', () => {
  it('returns 0=Sun..6=Sat', () => {
    expect(dayOfWeekUTC('2026-01-01')).toBe(4); // Thursday
    expect(dayOfWeekUTC('2026-01-03')).toBe(6); // Saturday
    expect(dayOfWeekUTC('2026-01-04')).toBe(0); // Sunday
    expect(dayOfWeekUTC('2026-01-05')).toBe(1); // Monday
  });
});

describe('mondayOfWeek', () => {
  it('returns the Monday of the Mon-Sun week', () => {
    expect(mondayOfWeek('2026-01-01')).toBe('2025-12-29'); // Thu -> prior Mon
    expect(mondayOfWeek('2026-01-05')).toBe('2026-01-05'); // Mon -> itself
  });
  it('treats Sunday as the end of the week (Monday 6 days prior)', () => {
    expect(mondayOfWeek('2026-01-04')).toBe('2025-12-29');
  });
});

describe('thursdayBeforeWeekOf', () => {
  it('returns the Thursday of the prior week (pre-PTO placement)', () => {
    // Week of Jan 8 (Thu) -> Monday Jan 5 -> minus 4 -> Thu Jan 1
    expect(thursdayBeforeWeekOf('2026-01-08')).toBe('2026-01-01');
  });
});

describe('datesOverlap', () => {
  it('is inclusive of both range ends', () => {
    expect(datesOverlap('2026-01-05', '2026-01-09', '2026-01-05')).toBe(true);
    expect(datesOverlap('2026-01-05', '2026-01-09', '2026-01-09')).toBe(true);
    expect(datesOverlap('2026-01-05', '2026-01-09', '2026-01-10')).toBe(false);
    expect(datesOverlap('2026-01-05', '2026-01-09', '2026-01-04')).toBe(false);
  });
});

describe('effectivePtoRange (weekend bookend)', () => {
  it('extends back 2 days when PTO starts Monday (captures the Saturday before)', () => {
    const r = effectivePtoRange({ start_date: '2026-01-05', end_date: '2026-01-09', availability_type: 'pto' });
    expect(r).toEqual({ start: '2026-01-03', end: '2026-01-11' }); // Sat before, Sun after
  });
  it('leaves single-day / non-bookend types alone', () => {
    const r = effectivePtoRange({ start_date: '2026-01-05', end_date: '2026-01-05', availability_type: 'sick' });
    expect(r).toEqual({ start: '2026-01-05', end: '2026-01-05' });
  });
  it('does not extend when PTO starts/ends mid-week', () => {
    const r = effectivePtoRange({ start_date: '2026-01-07', end_date: '2026-01-08', availability_type: 'pto' });
    expect(r).toEqual({ start: '2026-01-07', end: '2026-01-08' });
  });
});

describe('dayTypeBucket', () => {
  it('collapses day types into quota buckets', () => {
    expect(dayTypeBucket('weekday')).toBe('weekday');
    expect(dayTypeBucket('friday')).toBe('friday');
    expect(dayTypeBucket('saturday')).toBe('weekend');
    expect(dayTypeBucket('sunday')).toBe('weekend');
    expect(dayTypeBucket('federal_holiday')).toBe('holiday');
    expect(dayTypeBucket('major_holiday')).toBe('holiday');
  });
});

describe('normalizeWeekdays', () => {
  it('defaults null/malformed to all-true', () => {
    expect(normalizeWeekdays(null)).toEqual([true, true, true, true, true, true, true]);
    expect(normalizeWeekdays('nope')).toEqual([true, true, true, true, true, true, true]);
  });
  it('preserves a valid 7-element boolean array', () => {
    const v = [false, true, true, true, true, true, false];
    expect(normalizeWeekdays(v)).toEqual(v);
  });
});

describe('isBlockingAvailability (canonical predicate — spec §6.7)', () => {
  it('pending blocks — only denied/canceled are ignored', () => {
    expect(isBlockingAvailability({ availability_type: 'pto', approval_status: 'pending' })).toBe(true);
    expect(isBlockingAvailability({ availability_type: 'pto', approval_status: 'approved' })).toBe(true);
    expect(isBlockingAvailability({ availability_type: 'pto', approval_status: 'denied' })).toBe(false);
    expect(isBlockingAvailability({ availability_type: 'pto', approval_status: 'canceled' })).toBe(false);
  });
  it('non-blocking availability types never block', () => {
    expect(isBlockingAvailability({ availability_type: 'preference', approval_status: 'approved' })).toBe(false);
  });
});

describe('daysBetween (UTC whole days)', () => {
  it('counts forward and backward', () => {
    expect(daysBetween('2026-01-01', '2026-01-08')).toBe(7);
    expect(daysBetween('2026-01-08', '2026-01-01')).toBe(-7);
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
  });
  it('crosses month/year boundaries', () => {
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
  });
});
