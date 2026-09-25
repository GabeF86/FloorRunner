// The coverage record — the single home of the "never a confident zero"
// discipline for the /me metrics. Live published data begins 2026-09-01, so a
// window reaching before it is genuinely unanswered and must say so.
import { describe, it, expect } from 'vitest';
import {
  computeCoverage, horizonWindow, intersectSpan, spanCovers, spanDays, statusFor,
} from './types';

const LIVE = { start: '2026-09-01', end: '2026-12-31' };

describe('spanDays', () => {
  it('is inclusive at both ends', () => {
    expect(spanDays({ start: '2026-09-01', end: '2026-09-01' })).toBe(1);
    expect(spanDays({ start: '2026-09-01', end: '2026-09-30' })).toBe(30);
  });
  it('crosses the year boundary', () => {
    expect(spanDays({ start: '2026-12-30', end: '2027-01-02' })).toBe(4);
  });
  it('is 0 for null or a reversed span, never negative', () => {
    expect(spanDays(null)).toBe(0);
    expect(spanDays({ start: '2026-09-30', end: '2026-09-01' })).toBe(0);
  });
});

describe('spanCovers / intersectSpan', () => {
  it('is inclusive at both ends and false for a null span', () => {
    expect(spanCovers(LIVE, '2026-09-01')).toBe(true);
    expect(spanCovers(LIVE, '2026-12-31')).toBe(true);
    expect(spanCovers(LIVE, '2026-08-31')).toBe(false);
    expect(spanCovers(null, '2026-09-15')).toBe(false);
  });

  it('intersects, and is null when disjoint', () => {
    expect(intersectSpan({ start: '2026-08-01', end: '2026-09-15' }, LIVE))
      .toEqual({ start: '2026-09-01', end: '2026-09-15' });
    expect(intersectSpan({ start: '2026-01-01', end: '2026-08-31' }, LIVE)).toBeNull();
    expect(intersectSpan(LIVE, null)).toBeNull();
  });

  it('touching by a single day is an overlap, not a miss', () => {
    expect(intersectSpan({ start: '2026-06-01', end: '2026-09-01' }, LIVE))
      .toEqual({ start: '2026-09-01', end: '2026-09-01' });
  });
});

describe('computeCoverage', () => {
  it('is FULL when the published span swallows the window', () => {
    const c = computeCoverage({ start: '2026-09-10', end: '2026-09-20' }, LIVE);
    expect(c.kind).toBe('full');
    expect(c.coversWindowStart).toBe(true);
    expect(c.coveredThrough).toBe('2026-09-20');
    expect(c.uncoveredDays).toBe(0);
  });

  it('is PARTIAL when the window reaches back before the published era', () => {
    const c = computeCoverage({ start: '2026-08-25', end: '2026-09-05' }, LIVE);
    expect(c.kind).toBe('partial');
    expect(c.span).toEqual({ start: '2026-09-01', end: '2026-09-05' });
    expect(c.coversWindowStart).toBe(false);   // an "earliest" answer may be wrong
    expect(c.uncoveredDays).toBe(7);
  });

  it('is PARTIAL when the window runs past the published end', () => {
    const c = computeCoverage({ start: '2026-12-20', end: '2027-01-10' }, LIVE);
    expect(c.kind).toBe('partial');
    expect(c.coversWindowStart).toBe(true);
    expect(c.coveredThrough).toBe('2026-12-31');
    expect(c.uncoveredDays).toBe(10);
  });

  it('is NONE when nothing is published', () => {
    const c = computeCoverage({ start: '2026-09-01', end: '2026-09-30' }, null);
    expect(c.kind).toBe('none');
    expect(c.span).toBeNull();
    expect(c.coveredThrough).toBeNull();
    expect(c.uncoveredDays).toBe(30);
  });

  it('is NONE when the window predates the published era entirely', () => {
    const c = computeCoverage({ start: '2026-01-01', end: '2026-08-31' }, LIVE);
    expect(c.kind).toBe('none');
    expect(c.uncoveredDays).toBe(243);
  });

  it('treats a reversed window as empty rather than fabricating coverage', () => {
    const c = computeCoverage({ start: '2026-09-30', end: '2026-09-01' }, LIVE);
    expect(c.kind).toBe('none');
    expect(c.uncoveredDays).toBe(0);
  });

  it('handles a single-day window on the first published day', () => {
    const c = computeCoverage({ start: '2026-09-01', end: '2026-09-01' }, LIVE);
    expect(c.kind).toBe('full');
    expect(c.uncoveredDays).toBe(0);
  });
});

describe('statusFor', () => {
  const full = computeCoverage({ start: '2026-09-10', end: '2026-09-20' }, LIVE);
  const partial = computeCoverage({ start: '2026-08-25', end: '2026-09-05' }, LIVE);
  const none = computeCoverage({ start: '2026-09-10', end: '2026-09-20' }, null);

  it('a find is a find, whatever the coverage', () => {
    expect(statusFor(true, none)).toBe('found');
    expect(statusFor(true, partial)).toBe('found');
  });

  it('only a fully covered window earns a trustworthy negative', () => {
    expect(statusFor(false, full)).toBe('none_in_window');
    expect(statusFor(false, partial)).toBe('partially_covered');
    expect(statusFor(false, none)).toBe('not_covered');
  });
});

describe('horizonWindow', () => {
  it('spans exactly N days including today', () => {
    expect(horizonWindow('2026-09-24', 30)).toEqual({ start: '2026-09-24', end: '2026-10-23' });
    expect(spanDays(horizonWindow('2026-09-24', 30))).toBe(30);
    expect(horizonWindow('2026-09-24', 1)).toEqual({ start: '2026-09-24', end: '2026-09-24' });
  });

  it('never collapses to an empty or reversed window', () => {
    expect(horizonWindow('2026-09-24', 0)).toEqual({ start: '2026-09-24', end: '2026-09-24' });
    expect(horizonWindow('2026-09-24', -5)).toEqual({ start: '2026-09-24', end: '2026-09-24' });
  });

  it('crosses the year boundary', () => {
    expect(horizonWindow('2026-12-24', 30)).toEqual({ start: '2026-12-24', end: '2027-01-22' });
  });
});
