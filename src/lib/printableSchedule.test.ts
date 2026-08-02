// Printable schedule layout — Gabriel 2026-08-02.
import { describe, it, expect } from 'vitest';
import { mondayOf, weeksOf, printRows, weekLabel } from './printableSchedule';

// 2026-08-10 is a Monday; 08-16 the Sunday that closes that week.
describe('mondayOf', () => {
  it('returns the date itself for a Monday', () => {
    expect(mondayOf('2026-08-10')).toBe('2026-08-10');
  });

  it('walks BACK from any other day, Sunday included', () => {
    expect(mondayOf('2026-08-13')).toBe('2026-08-10');   // Thu
    expect(mondayOf('2026-08-15')).toBe('2026-08-10');   // Sat
    expect(mondayOf('2026-08-16')).toBe('2026-08-10');   // Sun — the one a
    // Sunday-start week would push into the NEXT page, splitting the weekend.
  });

  it('is DST-safe — every date is anchored at UTC midnight', () => {
    expect(mondayOf('2026-11-01')).toBe('2026-10-26');   // fall-back Sunday
    expect(mondayOf('2026-03-08')).toBe('2026-03-02');   // spring-forward Sunday
  });
});

describe('weeksOf', () => {
  const range = (from: string, days: number) =>
    Array.from({ length: days }, (_, i) =>
      new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

  it('cuts an 11-week block into 11 pages', () => {
    expect(weeksOf(range('2026-08-10', 77))).toHaveLength(11);
  });

  it('keeps every weekend whole', () => {
    for (const w of weeksOf(range('2026-08-10', 77))) {
      const dows = w.dates.map(d => new Date(`${d}T00:00:00Z`).getUTCDay());
      // Saturday(6) and Sunday(0) are adjacent at the END of a Monday week,
      // never split across the page boundary.
      if (dows.includes(6) && dows.includes(0)) {
        expect(dows.indexOf(0)).toBe(dows.indexOf(6) + 1);
      }
    }
  });

  it('does not pad a short first or last week with blanks', () => {
    // A block starting midweek yields a short page, not one with empty columns
    // that read as unstaffed days.
    const weeks = weeksOf(range('2026-08-13', 9));   // Thu → the following Fri
    expect(weeks[0].dates).toEqual(['2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16']);
    expect(weeks).toHaveLength(2);
  });

  it('is order-independent', () => {
    const shuffled = ['2026-08-16', '2026-08-10', '2026-08-13'];
    expect(weeksOf(shuffled)[0].dates).toEqual(['2026-08-10', '2026-08-13', '2026-08-16']);
  });

  it('empty in, empty out', () => {
    expect(weeksOf([])).toEqual([]);
  });
});

describe('printRows', () => {
  const s = (code: string, display_order: number | null, category = 'regular') =>
    ({ shift_types: { code, display_order, category } });

  it('keeps the grid’s own row order', () => {
    expect(printRows([s('D1', 3), s('C1', 1, 'call'), s('C2', 2, 'call')]).map(r => r.code))
      .toEqual(['C1', 'C2', 'D1']);
  });

  it('orders by display_order, NOT alphabetically', () => {
    // The real board discriminates these: 7-3/7-5 carry display_order 12-13 but
    // sort BEFORE C1 alphabetically. An earlier version of the test above used
    // C1/C2/D1, whose two orderings coincide, so it passed with the comparator
    // neutered.
    expect(printRows([s('7-5', 13), s('7-3', 12), s('C1', 1, 'call'), s('D8', 10)])
      .map(r => r.code)).toEqual(['C1', 'D8', '7-3', '7-5']);
  });

  it('lists each code ONCE however many dates it spans', () => {
    // Uniqueness is the Map's, not the early-continue's — that skip only avoids
    // rebuilding an object per duplicate slot (~660 of them on a real block)
    // and no input can distinguish its absence.
    expect(printRows([s('C1', 1, 'call'), s('C1', 1, 'call'), s('C1', 1, 'call')]))
      .toHaveLength(1);
  });

  it('omits a code the block stands no slot for', () => {
    // A permanently empty row costs a line on every one of 11 pages.
    expect(printRows([s('C1', 1, 'call')]).map(r => r.code)).toEqual(['C1']);
  });

  it('sorts an unordered code last but keeps it', () => {
    const rows = printRows([s('C1', 1, 'call'), s('X', null)]);
    expect(rows.map(r => r.code)).toEqual(['C1', 'X']);
  });

  it('ignores slots with no shift type', () => {
    expect(printRows([{ shift_types: null }, s('C1', 1, 'call')]).map(r => r.code))
      .toEqual(['C1']);
  });
});

describe('weekLabel', () => {
  it('reads as a range with the year once', () => {
    expect(weekLabel({ start: '2026-08-10', dates: ['2026-08-10', '2026-08-16'] }))
      .toBe('Aug 10 – Aug 16, 2026');
  });

  it('collapses a one-day week', () => {
    expect(weekLabel({ start: '2026-10-19', dates: ['2026-10-25'] })).toBe('Oct 25, 2026');
  });

  it('formats in UTC — a local-timezone render would slip a day westward', () => {
    expect(weekLabel({ start: '2026-01-05', dates: ['2026-01-05'] })).toBe('Jan 5, 2026');
  });
});
