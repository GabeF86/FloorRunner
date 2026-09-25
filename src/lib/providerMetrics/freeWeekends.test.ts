// Free weekends — the outcome-based weekend-equity measure.
//
// September 2026 is the fixture calendar throughout, because that is where the
// live published data starts:
//   Fri 09-04  Sat 09-05  Sun 09-06
//   Fri 09-11  Sat 09-12  Sun 09-13
//   Fri 09-18  Sat 09-19  Sun 09-20
//   Fri 09-25  Sat 09-26  Sun 09-27
import { describe, it, expect } from 'vitest';
import {
  computeFreeWeekends, postCallRestDays, weekendOccupancy, weekendSaturdaysIn,
  MAX_WEEKENDS,
} from './freeWeekends';
import type { MetricAssignment } from './types';

const SEPT = { start: '2026-09-01', end: '2026-09-30' };

const a = (
  date: string, code = 'C1', over: Partial<MetricAssignment> = {},
): MetricAssignment => ({
  date, code, category: 'call', ...over,
});
const day = (date: string, code = '7-3'): MetricAssignment =>
  ({ date, code, category: 'day' });

describe('weekendSaturdaysIn', () => {
  it('lists the Saturday naming every weekend in the window', () => {
    expect(weekendSaturdaysIn(SEPT)).toEqual([
      '2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26',
    ]);
  });

  it('starts on the window start when that IS a Saturday', () => {
    expect(weekendSaturdaysIn({ start: '2026-09-05', end: '2026-09-11' }))
      .toEqual(['2026-09-05']);
  });

  it('is empty for a Mon–Fri window — there is no weekend to be free', () => {
    expect(weekendSaturdaysIn({ start: '2026-09-07', end: '2026-09-11' })).toEqual([]);
  });

  it('is empty for a reversed window rather than walking forever', () => {
    expect(weekendSaturdaysIn({ start: '2026-09-30', end: '2026-09-01' })).toEqual([]);
  });

  it('crosses the year boundary', () => {
    expect(weekendSaturdaysIn({ start: '2026-12-25', end: '2027-01-10' })).toEqual([
      '2026-12-26', '2027-01-02', '2027-01-09',
    ]);
  });

  it('throws rather than silently truncating an absurd window', () => {
    expect(() => weekendSaturdaysIn({ start: '2020-01-01', end: '2031-01-01' }))
      .toThrow(new RegExp(String(MAX_WEEKENDS)));
  });
});

describe('postCallRestDays', () => {
  it('is the day after a requires_post_call_rule call — UNCLIPPED', () => {
    // Thursday call → FRIDAY rest. The working-day-clipped helpers in
    // plannerMath would keep this one and drop the Friday/Saturday cases
    // below, which is exactly why this module walks its own.
    expect(postCallRestDays([
      a('2026-09-10', 'C1', { requiresPostCall: true }),   // Thu → Fri
      a('2026-09-11', 'C2', { requiresPostCall: true }),   // Fri → Sat
      a('2026-09-12', 'C3', { requiresPostCall: true }),   // Sat → Sun
    ])).toEqual([
      { date: '2026-09-11', sourceDate: '2026-09-10', sourceCode: 'C1' },
      { date: '2026-09-12', sourceDate: '2026-09-11', sourceCode: 'C2' },
      { date: '2026-09-13', sourceDate: '2026-09-12', sourceCode: 'C3' },
    ]);
  });

  it('ignores calls whose type confers no rest', () => {
    expect(postCallRestDays([a('2026-09-10', 'CB')])).toEqual([]);
    expect(postCallRestDays([a('2026-09-10', 'CB', { requiresPostCall: false })])).toEqual([]);
  });

  it('is empty for empty input', () => {
    expect(postCallRestDays([])).toEqual([]);
  });
});

describe('weekendOccupancy', () => {
  it('keys by the SATURDAY — the app\'s one weekend definition', () => {
    const map = weekendOccupancy([a('2026-09-04')]);   // a Friday
    expect([...map.keys()]).toEqual(['2026-09-05']);
  });

  it('ignores Mon–Thu entirely', () => {
    expect(weekendOccupancy([a('2026-09-07'), a('2026-09-10')]).size).toBe(0);
  });

  it('folds every day of one weekend into one entry, date-ascending', () => {
    const map = weekendOccupancy([a('2026-09-06', 'C1'), a('2026-09-04', 'C2')]);
    expect(map.get('2026-09-05')?.map(r => [r.date, r.code]))
      .toEqual([['2026-09-04', 'C2'], ['2026-09-06', 'C1']]);
  });

  it('counts a post-call day landing in the weekend, naming the call', () => {
    const map = weekendOccupancy([a('2026-09-10', 'C1', { requiresPostCall: true })]);
    expect(map.get('2026-09-05')).toBeUndefined();
    expect(map.get('2026-09-12')).toEqual([{
      date: '2026-09-11', kind: 'post_call', code: 'C1', sourceDate: '2026-09-10',
    }]);
  });

  it('does NOT reach the next weekend from a Sunday call', () => {
    // Sunday C1 → post-call MONDAY, which belongs to no weekend.
    const map = weekendOccupancy([a('2026-09-06', 'C1', { requiresPostCall: true })]);
    expect([...map.keys()]).toEqual(['2026-09-05']);
    expect(map.get('2026-09-05')?.map(r => r.kind)).toEqual(['assignment']);
  });
});

describe('computeFreeWeekends', () => {
  const published = { start: '2026-09-01', end: '2026-09-30' };

  it('counts the weekends with nothing in them', () => {
    const r = computeFreeWeekends({
      window: SEPT, published,
      assignments: [a('2026-09-05'), a('2026-09-19')],
    });
    expect(r.freeWeekends).toBe(2);
    expect(r.free.map(w => w.saturday)).toEqual(['2026-09-12', '2026-09-26']);
    expect(r.occupied.map(w => w.saturday)).toEqual(['2026-09-05', '2026-09-19']);
    expect(r.weekendsEvaluated).toBe(4);
    expect(r.complete).toBe(true);
    expect(r.coverage.kind).toBe('full');
  });

  it('spends the weekend on ANY category, not just call', () => {
    const r = computeFreeWeekends({
      window: SEPT, published, assignments: [day('2026-09-12', 'OB')],
    });
    expect(r.freeWeekends).toBe(3);
    expect(r.occupied[0].reasons[0].kind).toBe('assignment');
  });

  it('a Thursday 24h call spends the weekend through its Friday post-call day', () => {
    // THE case the clipped working-day helpers get wrong in the other
    // direction: the Friday is a working day, so they keep it — but a Friday
    // or Saturday rest day would vanish, and those are the ones that matter.
    const r = computeFreeWeekends({
      window: SEPT, published,
      assignments: [a('2026-09-10', 'C1', { requiresPostCall: true })],
    });
    expect(r.freeWeekends).toBe(3);
    expect(r.occupied.map(w => w.saturday)).toEqual(['2026-09-12']);
    expect(r.occupied[0].reasons).toEqual([
      { date: '2026-09-11', kind: 'post_call', code: 'C1', sourceDate: '2026-09-10' },
    ]);
  });

  it('a Thursday call with no post-call rule leaves the weekend free', () => {
    const r = computeFreeWeekends({
      window: SEPT, published, assignments: [a('2026-09-10', 'CB')],
    });
    expect(r.freeWeekends).toBe(4);
  });

  it('a Mon–Thu week of work leaves every weekend free', () => {
    const r = computeFreeWeekends({
      window: SEPT, published,
      assignments: ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'].map(d => day(d)),
    });
    expect(r.freeWeekends).toBe(4);
  });

  it('reports a real 0 when every weekend is spent', () => {
    const r = computeFreeWeekends({
      window: SEPT, published,
      assignments: ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26'].map(d => a(d)),
    });
    expect(r.freeWeekends).toBe(0);          // a real zero …
    expect(r.weekendsEvaluated).toBe(4);     // … because four were evaluated
    expect(r.complete).toBe(true);
  });

  it('returns NULL, never 0, when nothing is published', () => {
    const r = computeFreeWeekends({ window: SEPT, published: null, assignments: [] });
    expect(r.freeWeekends).toBeNull();
    expect(r.weekendsEvaluated).toBe(0);
    expect(r.coverage.kind).toBe('none');
    expect(r.coverage.uncoveredDays).toBe(30);
    expect(r.uncovered.map(w => w.saturday)).toEqual([
      '2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26',
    ]);
    expect(r.complete).toBe(false);
  });

  it('will not count a weekend whose Friday is unpublished', () => {
    // Published data starts on the SATURDAY: nobody knows what the Friday
    // holds, so the weekend is unknown — counting it free would inflate the
    // fairness number.
    const r = computeFreeWeekends({
      window: SEPT,
      published: { start: '2026-09-05', end: '2026-09-30' },
      assignments: [],
    });
    expect(r.freeWeekends).toBe(3);
    expect(r.weekendsEvaluated).toBe(3);
    expect(r.uncovered).toEqual([{
      saturday: '2026-09-05',
      dates: ['2026-09-04', '2026-09-05', '2026-09-06'],
      missing: ['2026-09-04'],
    }]);
    expect(r.complete).toBe(false);
    expect(r.coverage.kind).toBe('partial');
    expect(r.coverage.coversWindowStart).toBe(false);
  });

  it('will not count a weekend whose Sunday is past the published end', () => {
    const r = computeFreeWeekends({
      window: SEPT,
      published: { start: '2026-09-01', end: '2026-09-26' },
      assignments: [],
    });
    expect(r.freeWeekends).toBe(3);
    expect(r.uncovered[0].missing).toEqual(['2026-09-27']);
  });

  it('a window before the published era evaluates nothing', () => {
    // The whole of August 2026 predates the live data — the honest answer is
    // "unknown", not "you had five free weekends".
    const r = computeFreeWeekends({
      window: { start: '2026-08-01', end: '2026-08-31' },
      published: { start: '2026-09-01', end: '2026-12-31' },
      assignments: [],
    });
    expect(r.freeWeekends).toBeNull();
    expect(r.coverage.kind).toBe('none');
    expect(r.uncovered).toHaveLength(5);
  });

  it('handles a one-Saturday window', () => {
    const r = computeFreeWeekends({
      window: { start: '2026-09-12', end: '2026-09-12' },
      published: { start: '2026-09-01', end: '2026-09-30' },
      assignments: [],
    });
    expect(r.freeWeekends).toBe(1);
    expect(r.free[0].dates).toEqual(['2026-09-11', '2026-09-12', '2026-09-13']);
  });

  it('returns null for a window containing no weekend at all', () => {
    const r = computeFreeWeekends({
      window: { start: '2026-09-07', end: '2026-09-11' },
      published: { start: '2026-09-01', end: '2026-09-30' },
      assignments: [],
    });
    expect(r.freeWeekends).toBeNull();
    expect(r.weekendsEvaluated).toBe(0);
    expect(r.uncovered).toEqual([]);
  });

  it('returns null for a reversed window', () => {
    const r = computeFreeWeekends({
      window: { start: '2026-09-30', end: '2026-09-01' },
      published: { start: '2026-09-01', end: '2026-09-30' },
      assignments: [],
    });
    expect(r.freeWeekends).toBeNull();
    expect(r.coverage.kind).toBe('none');
  });

  it('crosses the year boundary without losing the split weekend', () => {
    // Sat 2027-01-02's weekend starts on Fri 2027-01-01 — New Year's Day.
    const r = computeFreeWeekends({
      window: { start: '2026-12-20', end: '2027-01-10' },
      published: { start: '2026-12-01', end: '2027-01-31' },
      assignments: [a('2027-01-01', 'C1')],
    });
    expect(r.free.map(w => w.saturday)).toEqual(['2026-12-26', '2027-01-09']);
    expect(r.occupied.map(w => w.saturday)).toEqual(['2027-01-02']);
    expect(r.freeWeekends).toBe(2);
  });

  it('does not double-count a weekend worked on all three days', () => {
    const r = computeFreeWeekends({
      window: SEPT, published,
      assignments: [a('2026-09-04'), a('2026-09-05'), a('2026-09-06')],
    });
    expect(r.occupied).toHaveLength(1);
    expect(r.occupied[0].reasons).toHaveLength(3);
    expect(r.freeWeekends).toBe(3);
  });

  it('ignores an empty assignment list without pretending coverage', () => {
    const r = computeFreeWeekends({ window: SEPT, published, assignments: [] });
    expect(r.freeWeekends).toBe(4);
    expect(r.occupied).toEqual([]);
  });
});
