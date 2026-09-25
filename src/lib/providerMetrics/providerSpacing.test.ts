// One physician's call spacing — the adapter over lib/callSpacing.ts.
//
// The tests that matter most are the ones pinning the DESIGNED-ADJACENCY
// exemption: a Sat C1 → Sun C1 pair is the weekend block chain doing its job,
// and a dashboard that shows it as "your calls are too close together" teaches
// the physician to distrust the page.
import { describe, it, expect } from 'vitest';
import {
  computeProviderSpacing, medianOf, toSpacingSlots, DEFAULT_TIGHT_GAP_DAYS,
} from './providerSpacing';
import type { SpacingSlot } from '../callSpacing';
import type { MetricAssignment } from './types';

const SEPT = { start: '2026-09-01', end: '2026-09-30' };
const PUBLISHED = { start: '2026-09-01', end: '2026-09-30' };

const call = (
  date: string, code = 'C1', over: Partial<MetricAssignment> = {},
): MetricAssignment => ({ date, code, category: 'call', ...over });

/** The provider's own calls, in the shape lib/callSpacing wants. */
const slotsFor = (assignments: MetricAssignment[]): SpacingSlot[] =>
  toSpacingSlots('me', assignments);

const spacing = (
  assignments: MetricAssignment[],
  over: Partial<Parameters<typeof computeProviderSpacing>[0]> = {},
) => computeProviderSpacing({
  providerId: 'me', code: 'C1', slots: slotsFor(assignments),
  window: SEPT, published: PUBLISHED, ...over,
});

describe('medianOf', () => {
  it('is null for no values — there is no middle of nothing', () => {
    expect(medianOf([])).toBeNull();
  });
  it('is the value itself for one', () => {
    expect(medianOf([7])).toBe(7);
  });
  it('is the middle for an odd count, regardless of input order', () => {
    expect(medianOf([9, 2, 4])).toBe(4);
  });
  it('averages the two middles for an even count', () => {
    expect(medianOf([2, 4])).toBe(3);
    expect(medianOf([2, 3, 4, 9])).toBe(3.5);
  });
});

describe('toSpacingSlots', () => {
  it('derives a day type from the date when the caller has none', () => {
    // An empty derived_day_type would bucket to '' and silently disable the
    // chain exemption, so the DOW fallback is load-bearing.
    const [sat] = toSpacingSlots('me', [call('2026-09-05')]);
    expect(sat.derived_day_type).toBe('saturday');
    expect(toSpacingSlots('me', [call('2026-09-07')])[0].derived_day_type).toBe('weekday');
    expect(toSpacingSlots('me', [call('2026-09-04')])[0].derived_day_type).toBe('friday');
  });

  it('keeps a stored day type — a holiday must stay a holiday', () => {
    const [s] = toSpacingSlots('me', [call('2026-09-07', 'C1', { dayType: 'federal_holiday' })]);
    expect(s.derived_day_type).toBe('federal_holiday');
  });

  it('produces stable ids without a random source', () => {
    const once = toSpacingSlots('me', [call('2026-09-05'), call('2026-09-05', 'C2')]);
    const twice = toSpacingSlots('me', [call('2026-09-05'), call('2026-09-05', 'C2')]);
    expect(once.map(s => s.id)).toEqual(twice.map(s => s.id));
    expect(new Set(once.map(s => s.id)).size).toBe(2);
  });
});

describe('computeProviderSpacing — gap statistics', () => {
  it('measures consecutive gaps in date order', () => {
    const r = spacing([
      call('2026-09-01'), call('2026-09-08'), call('2026-09-10'), call('2026-09-24'),
    ]);
    expect(r.callCount).toBe(4);
    expect(r.gaps).toEqual([7, 2, 14]);
    expect(r.shortestGap).toBe(2);
    expect(r.longestGap).toBe(14);
    expect(r.medianGap).toBe(7);
    expect(r.status).toBe('found');
  });

  it('averages the two middle gaps for an even gap count', () => {
    const r = spacing([
      call('2026-09-01'), call('2026-09-03'), call('2026-09-07'), call('2026-09-21'),
    ]);
    expect(r.gaps).toEqual([2, 4, 14]);
    expect(r.medianGap).toBe(4);
    const even = spacing([call('2026-09-01'), call('2026-09-03'), call('2026-09-07')]);
    expect(even.gaps).toEqual([2, 4]);
    expect(even.medianGap).toBe(3);
  });

  it('sorts out-of-order input before measuring', () => {
    const r = spacing([call('2026-09-24'), call('2026-09-01'), call('2026-09-08')]);
    expect(r.calls.map(c => c.date)).toEqual(['2026-09-01', '2026-09-08', '2026-09-24']);
    expect(r.gaps).toEqual([7, 16]);
  });

  it('crosses the year boundary', () => {
    const r = spacing(
      [call('2026-12-30'), call('2027-01-02')],
      {
        window: { start: '2026-12-01', end: '2027-01-31' },
        published: { start: '2026-12-01', end: '2027-01-31' },
        slots: slotsFor([call('2026-12-30'), call('2027-01-02')]),
      });
    expect(r.gaps).toEqual([3]);
    expect(r.shortestGap).toBe(3);
  });
});

describe('computeProviderSpacing — never a confident zero', () => {
  it('reports nulls, not zeros, for a single call', () => {
    const r = spacing([call('2026-09-08')]);
    expect(r.callCount).toBe(1);
    expect(r.shortestGap).toBeNull();
    expect(r.medianGap).toBeNull();
    expect(r.longestGap).toBeNull();
    expect(r.tightPairs).toBeNull();
    expect(r.chainExemptPairs).toBeNull();
    expect(r.status).toBe('none_in_window');
  });

  it('reports nulls for no calls at all', () => {
    const r = spacing([]);
    expect(r.callCount).toBe(0);
    expect(r.shortestGap).toBeNull();
    expect(r.tightPairs).toBeNull();
    expect(r.status).toBe('none_in_window');   // the window IS published
  });

  it('says NOT COVERED when nothing is published for the window', () => {
    const r = spacing([], { published: null });
    expect(r.status).toBe('not_covered');
    expect(r.coverage.kind).toBe('none');
    expect(r.tightPairs).toBeNull();
  });

  it('says PARTIALLY COVERED when only part of the window is published', () => {
    const r = spacing([], { published: { start: '2026-09-15', end: '2026-09-30' } });
    expect(r.status).toBe('partially_covered');
    expect(r.coverage.coversWindowStart).toBe(false);
    expect(r.coverage.coveredThrough).toBe('2026-09-30');
  });

  it('a real 0 tight pairs is distinguishable from an unknown one', () => {
    const wide = spacing([call('2026-09-01'), call('2026-09-20')]);
    expect(wide.tightPairs).toBe(0);
    expect(wide.status).toBe('found');
    const unknown = spacing([], { published: null });
    expect(unknown.tightPairs).toBeNull();
    expect(unknown.status).toBe('not_covered');
  });
});

describe('computeProviderSpacing — tight pairs and the chain exemption', () => {
  it('defaults to Gabriel\'s 3-day review threshold', () => {
    expect(spacing([]).tightThresholdDays).toBe(DEFAULT_TIGHT_GAP_DAYS);
    expect(DEFAULT_TIGHT_GAP_DAYS).toBe(3);
  });

  it('counts a weekday adjacency as a real tight pair', () => {
    // Fri 09-04 → Mon 09-07: the Monday carries no chain and can be moved.
    const r = spacing([call('2026-09-04'), call('2026-09-07')]);
    expect(r.gaps).toEqual([3]);
    expect(r.tightPairs).toBe(1);
    expect(r.chainExemptPairs).toBe(0);
    expect(r.tightPairDetail[0].swappable.map(c => c.date)).toEqual(['2026-09-07']);
  });

  it('EXEMPTS a Sat → Sun same-code pair: that is the block chain, by design', () => {
    const r = spacing([call('2026-09-05'), call('2026-09-06')]);
    expect(r.gaps).toEqual([1]);          // the distribution still tells the truth
    expect(r.shortestGap).toBe(1);
    expect(r.tightPairs).toBe(0);         // … but it is not a complaint
    expect(r.chainExemptPairs).toBe(1);   // … and it is never silently dropped
  });

  it('exempts a Fri → Sat pair too — every weekend bucket is chain-locked', () => {
    const r = spacing([call('2026-09-04'), call('2026-09-05')]);
    expect(r.tightPairs).toBe(0);
    expect(r.chainExemptPairs).toBe(1);
  });

  it('never pairs different parent codes — a Sat C2 → Sun C1 is the pattern', () => {
    const r = spacing([call('2026-09-05', 'C2'), call('2026-09-06', 'C1')]);
    expect(r.callCount).toBe(1);          // only the C1 is in scope
    expect(r.gaps).toEqual([]);
    expect(r.tightPairs).toBeNull();
  });

  it('folds a split segment under its PARENT code', () => {
    // A Saturday C1 served as C1D12 + C1N12 is one C1 for spacing purposes.
    const r = spacing([
      call('2026-09-05', 'C1D12', { parentCode: 'C1' }),
      call('2026-09-08', 'C1'),
    ]);
    expect(r.callCount).toBe(2);
    expect(r.calls[0].code).toBe('C1D12');   // display keeps the real code
    expect(r.gaps).toEqual([3]);
    expect(r.tightPairs).toBe(1);            // the Tuesday end is movable
  });

  it('reports each adjacency in a run of three, not just one', () => {
    const r = spacing([call('2026-09-07'), call('2026-09-09'), call('2026-09-11')]);
    expect(r.gaps).toEqual([2, 2]);
    expect(r.tightPairs).toBe(2);
  });

  it('honours a caller-supplied threshold', () => {
    const calls = [call('2026-09-07'), call('2026-09-10')];
    expect(spacing(calls).tightPairs).toBe(1);
    expect(spacing(calls, { tightThresholdDays: 2 }).tightPairs).toBe(0);
  });

  it('keeps tightPairs + chainExemptPairs equal to every pair inside the threshold', () => {
    // The invariant that proves nothing is lost between the two counters.
    const r = spacing([
      call('2026-09-05'), call('2026-09-06'),   // exempt (Sat → Sun)
      call('2026-09-08'),                       // 2 days on from the Sunday
      call('2026-09-20'),
    ]);
    const insideThreshold = r.gaps.filter(g => g <= r.tightThresholdDays).length;
    expect(insideThreshold).toBe(2);
    expect((r.tightPairs ?? 0) + (r.chainExemptPairs ?? 0)).toBe(insideThreshold);
    expect(r.tightPairs).toBe(1);
    expect(r.chainExemptPairs).toBe(1);
  });
});

describe('computeProviderSpacing — scoping', () => {
  it('clips to the window', () => {
    const r = spacing([call('2026-08-30'), call('2026-09-08'), call('2026-10-02')]);
    expect(r.calls.map(c => c.date)).toEqual(['2026-09-08']);
    expect(r.gaps).toEqual([]);
  });

  it('ignores calls other providers hold, including on a shared slot', () => {
    const slots: SpacingSlot[] = [
      {
        id: 's1', slot_date: '2026-09-07', derived_day_type: 'weekday',
        shift_types: { code: 'C1', category: 'call', parent_call_code: null },
        assignments: [{ id: 'a1', provider_id: 'me' }, { id: 'a2', provider_id: 'other' }],
      },
      {
        id: 's2', slot_date: '2026-09-09', derived_day_type: 'weekday',
        shift_types: { code: 'C1', category: 'call', parent_call_code: null },
        assignments: [{ id: 'a3', provider_id: 'other' }],
      },
    ];
    const r = computeProviderSpacing({
      providerId: 'me', code: 'C1', slots, window: SEPT, published: PUBLISHED,
    });
    expect(r.callCount).toBe(1);
    expect(r.tightPairs).toBeNull();
    expect(r.tightPairDetail).toEqual([]);
  });

  it('ignores unfilled slots', () => {
    const slots: SpacingSlot[] = [{
      id: 's1', slot_date: '2026-09-07', derived_day_type: 'weekday',
      shift_types: { code: 'C1', category: 'call', parent_call_code: null },
      assignments: [{ id: 'a1', provider_id: null }],
    }];
    const r = computeProviderSpacing({
      providerId: 'me', code: 'C1', slots, window: SEPT, published: PUBLISHED,
    });
    expect(r.callCount).toBe(0);
  });

  it('ignores day shifts', () => {
    const r = spacing([
      call('2026-09-07'),
      { date: '2026-09-08', code: '7-3', category: 'day' },
      call('2026-09-21'),
    ]);
    expect(r.callCount).toBe(2);
    expect(r.gaps).toEqual([14]);
  });
});
