/**
 * The availability-aware candidate tier.
 *
 * The property that matters most is the FIRST one: under 'none' the term is
 * 0 for everybody, which is what keeps the comparator — and therefore every
 * golden-parity pin — byte-identical.
 */
import { describe, it, expect } from 'vitest';
import {
  tierKeyFor, remainingEligibleDates, daysToNearestLeave,
} from './candidateTier';
import type { AvailabilityEntry } from './genTypes';

const DATES = Array.from({ length: 14 }, (_, i) =>
  `2026-10-${String(i + 5).padStart(2, '0')}`);        // Mon 5 Oct → Sun 18 Oct

const pto = (start: string, end: string): AvailabilityEntry => ({
  provider_id: 'p1', availability_type: 'pto', approval_status: 'approved',
  start_date: start, end_date: end,
} as AvailabilityEntry);

describe("'none' is inert", () => {
  it('returns 0 whatever the availability', () => {
    expect(tierKeyFor('none', [], DATES, DATES[0])).toBe(0);
    expect(tierKeyFor('none', [pto('2026-10-06', '2026-10-10')], DATES, DATES[0])).toBe(0);
  });
});

describe('scarcity — fewest chances left sorts first', () => {
  it('counts only dates from the slot date FORWARD', () => {
    // "How many chances do you have left", not how many you had.
    expect(remainingEligibleDates([], DATES, DATES[0])).toBe(14);
    expect(remainingEligibleDates([], DATES, DATES[10])).toBe(4);
  });

  it('subtracts blocked dates', () => {
    const away = [pto('2026-10-12', '2026-10-16')];     // 5 days
    const n = remainingEligibleDates(away, DATES, DATES[0]);
    expect(n).toBeLessThan(14);
    // A provider with leave has strictly fewer chances than one without.
    expect(n).toBeLessThan(remainingEligibleDates([], DATES, DATES[0]));
  });

  it('gives the heavier-PTO provider the LOWER key, so they sort first', () => {
    const light = tierKeyFor('scarcity', [pto('2026-10-17', '2026-10-18')], DATES, DATES[0]);
    const heavy = tierKeyFor('scarcity', [pto('2026-10-08', '2026-10-18')], DATES, DATES[0]);
    expect(heavy).toBeLessThan(light);
  });
});

describe('pto_distance — furthest from your own leave sorts first', () => {
  it('measures the nearest leave in EITHER direction', () => {
    // Leave that just ended constrains as much as leave about to start, so a
    // provider equidistant either side scores the same.
    // Sat 10 Oct and Wed 14 Oct — neither starts a Monday nor ends a Friday,
    // so neither bookends and the two sit an equal two days from Mon 12 Oct.
    const after = daysToNearestLeave([pto('2026-10-14', '2026-10-14')], DATES, '2026-10-12');
    const before = daysToNearestLeave([pto('2026-10-10', '2026-10-10')], DATES, '2026-10-12');
    expect(after).toBe(2);
    expect(before).toBe(2);
  });

  it('counts the days a PTO block BOOKENDS into as blocked too', () => {
    // effectivePtoRange reaches 2 days back from a Monday start and 2 forward
    // from a Friday end. Those days are not chances either, so the distance
    // must shrink — measuring the raw stored range would over-state how far a
    // provider is from their own leave.
    const raw = daysToNearestLeave(
      [{ provider_id: 'p1', availability_type: 'sick', approval_status: 'approved',
         start_date: '2026-10-12', end_date: '2026-10-12' }] as never, DATES, '2026-10-08');
    const bookended = daysToNearestLeave([pto('2026-10-12', '2026-10-16')], DATES, '2026-10-08');
    expect(bookended).toBeLessThan(raw);
  });

  it('is Infinity with no leave in the window', () => {
    expect(daysToNearestLeave([], DATES, DATES[0])).toBe(Infinity);
  });

  it('sorts the far-from-leave provider ahead of the near one', () => {
    const near = tierKeyFor('pto_distance', [pto('2026-10-06', '2026-10-07')], DATES, '2026-10-05');
    const far = tierKeyFor('pto_distance', [pto('2026-10-17', '2026-10-18')], DATES, '2026-10-05');
    expect(far).toBeLessThan(near);
  });

  it('lets a NO-LEAVE provider dominate — the known asymmetry, pinned', () => {
    // Stated rather than smoothed over: this is the literal reading of the
    // rule, and it is the exact behaviour 'scarcity' exists to avoid. The
    // capped variant is the alternative.
    const none = tierKeyFor('pto_distance', [], DATES, DATES[0]);
    const some = tierKeyFor('pto_distance', [pto('2026-10-17', '2026-10-18')], DATES, DATES[0]);
    expect(none).toBe(-Infinity);
    expect(none).toBeLessThan(some);
  });

  it('capped keeps a no-leave provider FINITE so they do not dominate', () => {
    const none = tierKeyFor('pto_distance_capped', [], DATES, DATES[0]);
    expect(Number.isFinite(none)).toBe(true);
    expect(none).toBe(-DATES.length);
  });
});

describe('every strategy is a pure function of its inputs', () => {
  it('returns the same key for the same inputs', () => {
    const away = [pto('2026-10-12', '2026-10-16')];
    for (const s of ['none', 'scarcity', 'pto_distance', 'pto_distance_capped'] as const) {
      expect(tierKeyFor(s, away, DATES, DATES[3]))
        .toBe(tierKeyFor(s, away, DATES, DATES[3]));
    }
  });
});
