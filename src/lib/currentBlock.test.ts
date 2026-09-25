/**
 * "Which block is the current one?"
 *
 * Gabriel 2026-09-24 asked for a navy ring around any schedule whose dates
 * include today. The whole feature is one date comparison, and the two ways it
 * can be wrong are both silent: an off-by-one at the block boundary rings the
 * wrong card, and reading `today` in UTC rings the wrong card for several
 * hours every evening east of GMT. Both are pinned here.
 */
import { describe, it, expect } from 'vitest';
import { isCurrentBlock, todayLocalISO } from './scheduleBoard';

const block = (date_start: string, date_end: string) => ({ date_start, date_end });

describe('isCurrentBlock', () => {
  it('is true inside the block', () => {
    expect(isCurrentBlock(block('2026-09-01', '2026-10-31'), '2026-09-24')).toBe(true);
  });

  it('INCLUDES both end days — the last day of a block is still the block', () => {
    expect(isCurrentBlock(block('2026-09-01', '2026-10-31'), '2026-09-01')).toBe(true);
    expect(isCurrentBlock(block('2026-09-01', '2026-10-31'), '2026-10-31')).toBe(true);
  });

  it('is false one day outside either end', () => {
    expect(isCurrentBlock(block('2026-09-01', '2026-10-31'), '2026-08-31')).toBe(false);
    expect(isCurrentBlock(block('2026-09-01', '2026-11-01'), '2026-11-02')).toBe(false);
  });

  it('handles a single-day block', () => {
    expect(isCurrentBlock(block('2026-09-24', '2026-09-24'), '2026-09-24')).toBe(true);
    expect(isCurrentBlock(block('2026-09-24', '2026-09-24'), '2026-09-25')).toBe(false);
  });

  it('compares across a year boundary', () => {
    // The live Paoli block is 2026-10-26 → 2027-01-04. A numeric or
    // month/day compare would get this wrong; a zero-padded ISO string
    // compare does not.
    const b = block('2026-10-26', '2027-01-04');
    expect(isCurrentBlock(b, '2026-12-31')).toBe(true);
    expect(isCurrentBlock(b, '2027-01-01')).toBe(true);
    expect(isCurrentBlock(b, '2027-01-05')).toBe(false);
  });
});

describe('todayLocalISO', () => {
  it('returns the LOCAL calendar day, not the UTC one', () => {
    // 2026-09-24 21:30 in a UTC+0 reading is already the 25th east of GMT.
    // A slot_date carries no timezone, so the comparison must use the day the
    // user is actually living in — toISOString() on a raw Date would not.
    const evening = new Date('2026-09-24T23:30:00');
    expect(todayLocalISO(evening)).toBe('2026-09-24');
  });

  it('returns a zero-padded YYYY-MM-DD, so string compare is safe', () => {
    expect(todayLocalISO(new Date('2026-01-05T09:00:00'))).toBe('2026-01-05');
    expect(todayLocalISO(new Date('2026-12-31T09:00:00'))).toBe('2026-12-31');
  });

  it('agrees with isCurrentBlock on a block that ends today', () => {
    const today = todayLocalISO();
    expect(isCurrentBlock(block('2000-01-01', today))).toBe(true);
  });
});
