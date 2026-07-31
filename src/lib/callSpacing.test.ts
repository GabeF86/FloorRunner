// Call spacing review — Gabriel 2026-07-31: "identify providers with C1 calls
// that are spaced too close together and options to swap with them other call
// takers that are available".
//
// The fixture is the live "Final Weekends" C1 board, so the numbers are
// checkable: four pairs at 2 days, three at 3, none at 1 (post-call rest makes
// gap 1 impossible for a rest-requiring code).
import { describe, it, expect } from 'vitest';
import {
  findTightPairs, reviewTightPairs, callsByProvider, gapHistogram,
  tightestGapIfAdded, rankSwapCandidates, daysBetweenDates, type SpacingSlot,
} from './callSpacing';

const call = (
  id: string, date: string, code: string, pid: string | null,
  parent?: string, dayType = 'weekday',
): SpacingSlot => ({
  id, slot_date: date, derived_day_type: dayType,
  shift_types: { code, category: 'call', parent_call_code: parent ?? null },
  assignments: pid ? [{ id: `a-${id}`, provider_id: pid }] : [{ id: `a-${id}`, provider_id: null }],
});

describe('findTightPairs', () => {
  it('finds same-code adjacencies at or under the threshold, tightest first', () => {
    const slots = [
      call('s1', '2026-08-24', 'C1', 'amusa'),
      call('s2', '2026-08-26', 'C1', 'amusa'),   // gap 2
      call('s3', '2026-09-08', 'C1', 'havildar'),
      call('s4', '2026-09-11', 'C1', 'havildar'), // gap 3
    ];
    const pairs = findTightPairs(slots, 'C1', 3);
    expect(pairs.map(p => [p.providerId, p.gap])).toEqual([['amusa', 2], ['havildar', 3]]);
  });

  it('respects the threshold', () => {
    const slots = [
      call('s1', '2026-08-24', 'C1', 'amusa'),
      call('s2', '2026-08-26', 'C1', 'amusa'),   // 2
      call('s3', '2026-09-08', 'C1', 'havildar'),
      call('s4', '2026-09-11', 'C1', 'havildar'), // 3
    ];
    expect(findTightPairs(slots, 'C1', 2).map(p => p.providerId)).toEqual(['amusa']);
  });

  it('NEVER pairs different codes — a Sat C2 → Sun C1 is the pattern, not a defect', () => {
    // The weekend block chain puts these on the same doc one day apart ON
    // PURPOSE. Reporting it would flag the design as a problem.
    const slots = [
      call('sat', '2026-09-19', 'C2', 'jones'),
      call('sun', '2026-09-20', 'C1', 'jones'),
    ];
    expect(findTightPairs(slots, 'C1', 5)).toEqual([]);
    expect(findTightPairs(slots, 'C2', 5)).toEqual([]);
  });

  it('folds a split segment under its PARENT code', () => {
    // A Saturday C1 served as C1D12 + C1N12 is one C1 for spacing purposes.
    const slots = [
      call('a', '2026-09-05', 'C1D12', 'horan', 'C1', 'saturday'),
      call('b', '2026-09-07', 'C1', 'horan'),   // weekday ⇒ the pair is swappable
    ];
    const pairs = findTightPairs(slots, 'C1', 3);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].earlier.code).toBe('C1D12');   // display keeps the real code
  });

  it('reports EACH adjacency in a run of three, not just one', () => {
    const slots = [
      call('a', '2026-08-10', 'C1', 'p1'),
      call('b', '2026-08-12', 'C1', 'p1'),
      call('c', '2026-08-14', 'C1', 'p1'),
    ];
    // Two separately fixable adjacencies; collapsing would hide one.
    expect(findTightPairs(slots, 'C1', 2)).toHaveLength(2);
  });

  it('ignores unfilled slots', () => {
    const slots = [call('a', '2026-08-10', 'C1', null), call('b', '2026-08-12', 'C1', null)];
    expect(findTightPairs(slots, 'C1', 5)).toEqual([]);
  });

  it('never pairs two providers with each other', () => {
    const slots = [
      call('a', '2026-08-10', 'C1', 'p1'),
      call('b', '2026-08-11', 'C1', 'p2'),
    ];
    expect(findTightPairs(slots, 'C1', 5)).toEqual([]);
  });
});

describe('gapHistogram', () => {
  it('reports the distribution so a threshold is chosen from the board', () => {
    const slots = [
      call('a', '2026-08-10', 'C1', 'p1'), call('b', '2026-08-12', 'C1', 'p1'),  // 2
      call('c', '2026-09-01', 'C1', 'p2'), call('d', '2026-09-03', 'C1', 'p2'),  // 2
      call('e', '2026-10-01', 'C1', 'p3'), call('f', '2026-10-04', 'C1', 'p3'),  // 3
    ];
    expect([...gapHistogram(slots, 'C1', 5)].sort()).toEqual([[2, 2], [3, 1]]);
  });
});

describe('tightestGapIfAdded', () => {
  const held = [
    { date: '2026-08-10', slotId: 's1', assignmentId: null, code: 'C1', bucket: 'weekday' },
    { date: '2026-08-20', slotId: 's2', assignmentId: null, code: 'C1', bucket: 'weekday' },
  ];

  it('is the distance to their NEAREST other call, either direction', () => {
    expect(tightestGapIfAdded(held, '2026-08-12')).toBe(2);
    expect(tightestGapIfAdded(held, '2026-08-18')).toBe(2);
    expect(tightestGapIfAdded(held, '2026-08-15')).toBe(5);
  });

  it('Infinity when they hold no other call — nothing to be close to', () => {
    expect(tightestGapIfAdded([], '2026-08-12')).toBe(Infinity);
  });

  it('skips a call they already hold on that date — never measured against itself', () => {
    // Covers the current holder appearing among the candidates: their gap is
    // measured against their OTHER calls.
    expect(tightestGapIfAdded(held, '2026-08-10')).toBe(10);
  });
});

describe('rankSwapCandidates', () => {
  const byProvider = new Map([
    ['far', [{ date: '2026-07-01', slotId: 'x', assignmentId: null, code: 'C1', bucket: 'weekday' }]],
    ['near', [{ date: '2026-08-11', slotId: 'y', assignmentId: null, code: 'C1', bucket: 'weekday' }]],
    ['none', []],
  ]);

  it('ranks the provider who ends up FURTHEST from their own calls first', () => {
    const ranked = rankSwapCandidates(['near', 'far', 'none'], byProvider, '2026-08-12', 2);
    expect(ranked.map(r => r.providerId)).toEqual(['none', 'far', 'near']);
  });

  it('flags who would actually improve on the current gap', () => {
    const ranked = rankSwapCandidates(['near', 'far'], byProvider, '2026-08-12', 2);
    const near = ranked.find(r => r.providerId === 'near')!;
    // 'near' would sit 1 day away — worse than the 2 being fixed. Shown, not
    // recommended: moving the problem is not solving it.
    expect(near.resultingGap).toBe(1);
    expect(near.improves).toBe(false);
    expect(ranked.find(r => r.providerId === 'far')!.improves).toBe(true);
  });

  it('takes eligibility from the CALLER — it never re-derives who is available', () => {
    // The picker owns PTO / post-call / cross-site / credentials. Passing a
    // short list must yield a short list.
    expect(rankSwapCandidates(['far'], byProvider, '2026-08-12', 2)
      .map(r => r.providerId)).toEqual(['far']);
  });
});

describe('daysBetweenDates', () => {
  it('counts whole days across DST transitions', () => {
    // Documents the expected values across both US transitions. NOT a pin on
    // the explicit UTC parse: JS parses a date-only ISO string as UTC by spec,
    // so `new Date(iso)` and `Date.parse(iso + 'T00:00:00Z')` agree here and no
    // input distinguishes them. The explicit form stays for the codebase's
    // stated date-math convention, not because a test could catch its loss.
    expect(daysBetweenDates('2026-10-31', '2026-11-02')).toBe(2);
    expect(daysBetweenDates('2026-03-07', '2026-03-09')).toBe(2);
  });
});

// ── only a weekday call can actually move (Gabriel 2026-07-31) ──────────────
// "i cant swap weekday calls because they are fixed chains, I want to focus
// only on Weekday C1 calls that are too close in proximity to either weekend
// C1's or other weekday C1's."
//
// Every weekend-bucket C1 is chain-locked: a Friday C1 anchors the Sunday C2,
// and the Sat/Sun C1s ride the weekend block chains. A weekday C1 carries no
// call chain — only a −1 D2 pre-fill and its rest day.
describe('swappable end', () => {
  const wd = (id: string, date: string, pid: string) => call(id, date, 'C1', pid);
  const we = (id: string, date: string, pid: string, dt: string) =>
    call(id, date, 'C1', pid, undefined, dt);

  it('a weekend C1 next to a WEEKDAY C1 is reported, and only the weekday end is offered', () => {
    // Kalawadia's live shape: Sat 9/19 → Mon 9/21.
    const pairs = findTightPairs(
      [we('sat', '2026-09-19', 'kal', 'saturday'), wd('mon', '2026-09-21', 'kal')], 'C1', 3);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].swappable.map(c => c.slotId)).toEqual(['mon']);
  });

  it('two weekday C1s offer BOTH ends', () => {
    // Amusa's live shape: Mon 8/24 → Wed 8/26, both movable.
    const pairs = findTightPairs(
      [wd('a', '2026-08-24', 'amusa'), wd('b', '2026-08-26', 'amusa')], 'C1', 3);
    expect(pairs[0].swappable.map(c => c.slotId)).toEqual(['a', 'b']);
  });

  it('a weekend-to-weekend pair is NOT reported — nothing can move', () => {
    const review = reviewTightPairs(
      [we('fri', '2026-09-18', 'p1', 'friday'), we('sun', '2026-09-20', 'p1', 'sunday')], 'C1', 3);
    expect(review.pairs).toEqual([]);
    expect(review.excludedChainLocked).toBe(1);   // counted, not silent
  });

  it('a FRIDAY C1 is weekend-side — it anchors the Sunday C2 two days later', () => {
    // Havildar's live shape: Tue 9/8 → Fri 9/11. The Friday cannot move.
    const pairs = findTightPairs(
      [wd('tue', '2026-09-08', 'hav'), we('fri', '2026-09-11', 'hav', 'friday')], 'C1', 3);
    expect(pairs[0].swappable.map(c => c.slotId)).toEqual(['tue']);
  });

  it('a HOLIDAY counts as the day it lands on', () => {
    // Labor Day 2026-09-07 is a Monday ⇒ weekday bucket ⇒ swappable.
    const pairs = findTightPairs(
      [we('sat', '2026-09-05', 'p1', 'saturday'),
       call('hol', '2026-09-07', 'C1', 'p1', undefined, 'major_holiday')], 'C1', 3);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].swappable.map(c => c.slotId)).toEqual(['hol']);
  });

  it('every returned pair has at least one swappable end', () => {
    const review = reviewTightPairs([
      wd('a', '2026-08-24', 'amusa'), wd('b', '2026-08-26', 'amusa'),
      we('f', '2026-09-18', 'p1', 'friday'), we('s', '2026-09-20', 'p1', 'sunday'),
    ], 'C1', 3);
    for (const p of review.pairs) expect(p.swappable.length).toBeGreaterThan(0);
  });
});
