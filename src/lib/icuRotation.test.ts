// ICU rotation entry helpers — week + post-call-Monday pairing.
// Convention (Gabriel, 2026-07-17): entering an ICU week creates TWO
// provider_availability rows — type 'blocked' reason 'icu_week' for the week
// itself, and type 'blocked' reason 'icu_post_call' for the Monday
// immediately AFTER the week's end. If a row already covers that Monday
// (e.g. two back-to-back ICU weeks), the Monday row is skipped, never duped.
import { describe, it, expect } from 'vitest';
import {
  icuWeekEnd,
  icuMondayAfter,
  planIcuEntry,
  pairIcuRows,
  type IcuAvailabilityRow,
} from './icuRotation';

describe('icuWeekEnd', () => {
  it('is start + 6 days', () => {
    expect(icuWeekEnd('2026-08-03')).toBe('2026-08-09'); // Mon → Sun
    expect(icuWeekEnd('2026-08-05')).toBe('2026-08-11'); // Wed → Tue
  });

  it('crosses month boundaries', () => {
    expect(icuWeekEnd('2026-08-28')).toBe('2026-09-03');
  });
});

describe('icuMondayAfter', () => {
  it('Sunday end → next day', () => {
    expect(icuMondayAfter('2026-08-09')).toBe('2026-08-10'); // Sun → Mon
  });

  it('mid-week end → following Monday', () => {
    expect(icuMondayAfter('2026-08-11')).toBe('2026-08-17'); // Tue → next Mon
    expect(icuMondayAfter('2026-08-08')).toBe('2026-08-10'); // Sat → Mon
  });

  it('Monday end → the NEXT Monday (strictly after)', () => {
    expect(icuMondayAfter('2026-08-10')).toBe('2026-08-17');
  });
});

const mkRow = (over: Partial<IcuAvailabilityRow>): IcuAvailabilityRow => ({
  id: 'row-1',
  availability_type: 'blocked',
  reason_code: null,
  start_date: '2026-08-03',
  end_date: '2026-08-09',
  ...over,
});

describe('planIcuEntry', () => {
  it('builds the week row and its Monday row', () => {
    const plan = planIcuEntry('2026-08-03', '2026-08-09', []);
    expect(plan.week).toEqual({
      availability_type: 'blocked',
      reason_code: 'icu_week',
      start_date: '2026-08-03',
      end_date: '2026-08-09',
    });
    expect(plan.monday).toEqual({
      availability_type: 'blocked',
      reason_code: 'icu_post_call',
      start_date: '2026-08-10',
      end_date: '2026-08-10',
    });
  });

  it('defaults end to start + 6 when end is omitted', () => {
    const plan = planIcuEntry('2026-08-03', undefined, []);
    expect(plan.week.end_date).toBe('2026-08-09');
    expect(plan.monday?.start_date).toBe('2026-08-10');
  });

  it('skips the Monday row when an icu_post_call row already covers it', () => {
    const existing = [mkRow({
      reason_code: 'icu_post_call',
      start_date: '2026-08-10',
      end_date: '2026-08-10',
    })];
    const plan = planIcuEntry('2026-08-03', '2026-08-09', existing);
    expect(plan.monday).toBeNull();
  });

  it('skips the Monday row when a blocked range covers it (back-to-back weeks)', () => {
    const existing = [mkRow({
      reason_code: 'icu_week',
      start_date: '2026-08-10',
      end_date: '2026-08-16',
    })];
    const plan = planIcuEntry('2026-08-03', '2026-08-09', existing);
    expect(plan.monday).toBeNull();
  });

  it('does NOT skip for non-blocked rows on that Monday (e.g. PTO)', () => {
    const existing = [mkRow({
      availability_type: 'pto',
      start_date: '2026-08-10',
      end_date: '2026-08-10',
    })];
    const plan = planIcuEntry('2026-08-03', '2026-08-09', existing);
    expect(plan.monday).not.toBeNull();
  });

  it('rejects end before start', () => {
    expect(() => planIcuEntry('2026-08-09', '2026-08-03', [])).toThrow();
  });
});

describe('pairIcuRows', () => {
  it('pairs each icu_week row with the icu_post_call row on its Monday', () => {
    const week = mkRow({ id: 'w1', reason_code: 'icu_week' });
    const monday = mkRow({
      id: 'm1', reason_code: 'icu_post_call',
      start_date: '2026-08-10', end_date: '2026-08-10',
    });
    const pairs = pairIcuRows([week, monday]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].week.id).toBe('w1');
    expect(pairs[0].monday?.id).toBe('m1');
  });

  it('leaves monday null when no matching post-call row exists', () => {
    const week = mkRow({ id: 'w1', reason_code: 'icu_week' });
    const pairs = pairIcuRows([week]);
    expect(pairs[0].monday).toBeNull();
  });

  it('never pairs the same Monday row twice (back-to-back weeks share none)', () => {
    const w1 = mkRow({ id: 'w1', reason_code: 'icu_week', start_date: '2026-08-03', end_date: '2026-08-09' });
    const w2 = mkRow({ id: 'w2', reason_code: 'icu_week', start_date: '2026-08-10', end_date: '2026-08-16' });
    const m2 = mkRow({ id: 'm2', reason_code: 'icu_post_call', start_date: '2026-08-17', end_date: '2026-08-17' });
    const pairs = pairIcuRows([w1, w2, m2]);
    expect(pairs).toHaveLength(2);
    // w1's Monday (08-10) is covered by w2's week row, not an icu_post_call row.
    expect(pairs.find(p => p.week.id === 'w1')?.monday).toBeNull();
    expect(pairs.find(p => p.week.id === 'w2')?.monday?.id).toBe('m2');
  });

  it('ignores rows that are not ICU rows', () => {
    const pto = mkRow({ id: 'p1', availability_type: 'pto' });
    expect(pairIcuRows([pto])).toHaveLength(0);
  });
});
