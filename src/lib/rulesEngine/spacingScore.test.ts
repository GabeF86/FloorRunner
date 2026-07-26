// Spacing score (Paoli phase 2): call BLOCKS (chain/linkage-joined runs are
// single units), the 9-key lexicographic score tuple, and the comparator.
// Pure functions over (ctx, plan) — no DB, no solve needed for most cases.
import { describe, it, expect } from 'vitest';
import {
  computeCallBlocks, spacingScore, compareSpacingScores, SPACING_SCORE_KEYS,
} from './spacingScore';
import { buildCtx, prov, callSlot } from './__fixtures__/buildContext';
import { sp, scen } from './__fixtures__/scenarioFixtures';
import type { SolutionPlan, PlannedAssignment } from './genTypes';

function asn(pid: string, date: string, code: string, dt: string, source: PlannedAssignment['source'] = 'main-loop'): PlannedAssignment {
  return {
    slot_id: `${date}|${code}`, slot_date: date, shift_type_code: code,
    shift_type_category: 'call', derived_day_type: dt,
    provider_id: pid, provider_name: pid, existing_assignment_id: null, source,
  };
}
const planOf = (assignments: PlannedAssignment[]): SolutionPlan => ({ assignments, unfilled: [] });

// A tiny ctx spanning August 2026 (classic pattern by default).
const baseCtx = () => buildCtx(
  [callSlot('a', '2026-08-10', 'C1', 'weekday'), callSlot('z', '2026-10-23', 'C1', 'friday')],
  [prov('p1'), prov('p2')],
);

describe('computeCallBlocks', () => {
  it('a classic weekend chain (Fri C2 + Sat C1 + Sun C2) is ONE block', () => {
    // Classic Sat C1 anchor links Sun C2 (+1) and Fri C2 (−1).
    const plan = planOf([
      asn('p1', '2026-08-14', 'C2', 'friday', 'weekend-chain'),
      asn('p1', '2026-08-15', 'C1', 'saturday'),
      asn('p1', '2026-08-16', 'C2', 'sunday', 'weekend-chain'),
    ]);
    const blocks = computeCallBlocks(baseCtx(), plan);
    expect(blocks.get('p1')).toHaveLength(1);
    expect(blocks.get('p1')![0]).toMatchObject({ start: '2026-08-14', end: '2026-08-16' });
  });

  it('two independent adjacent weekday calls are TWO blocks (accidental clustering is visible)', () => {
    const plan = planOf([
      asn('p1', '2026-08-11', 'C1', 'weekday'),
      asn('p1', '2026-08-12', 'C2', 'weekday'),
    ]);
    const blocks = computeCallBlocks(baseCtx(), plan);
    expect(blocks.get('p1')).toHaveLength(2);
  });

  it('a hard same-weekend scenario linkage joins its members into one block', () => {
    // Simon rule: Sat C1 + Sun C2 same weekend — NOT a classic chain pair
    // (classic pairs Sat C1 with Sun C2 via the anchor, but here we join via
    // the LINKAGE for a pattern that would not, using a doc with no blocks).
    const ctx = buildCtx(
      [callSlot('a', '2026-08-10', 'C1', 'weekday')],
      [prov('p1')],
      {
        callPattern: {
          version: 1, blocks: [], dayChains: [], spans: [], placementPasses: [],
          reliefPass: null, optimizerMovableDayTypes: [],
        },
        scenario: scen([sp('p1', {
          linkages: [{
            kind: 'same-weekend',
            members: [{ dow: 6, date: null, code: 'C1' }, { dow: 0, date: null, code: 'C2' }],
            rawMembers: ['SAT:C1', 'SUN:C2'], source: 'test',
          }],
        })]),
      },
    );
    const plan = planOf([
      asn('p1', '2026-08-15', 'C1', 'saturday'),
      asn('p1', '2026-08-16', 'C2', 'sunday'),
    ]);
    expect(computeCallBlocks(ctx, plan).get('p1')).toHaveLength(1);
  });

  it('seeded calls join the block computation (segments under their parent code)', () => {
    const ctx = buildCtx(
      [callSlot('a', '2026-08-10', 'C1', 'weekday')],
      [prov('p1')],
      {
        seedAssignments: [{
          slot_date: '2026-08-15', provider_id: 'p1', shift_type_code: 'C1',
          shift_type_category: 'call', derived_day_type: 'saturday',
        }],
      },
    );
    const plan = planOf([asn('p1', '2026-08-16', 'C2', 'sunday')]);
    // Classic chain Sat C1 → Sun C2 joins the seed to the placement.
    expect(computeCallBlocks(ctx, plan).get('p1')).toHaveLength(1);
  });
});

describe('spacingScore', () => {
  it('emits the 9 documented keys in lexicographic order', () => {
    expect(SPACING_SCORE_KEYS).toEqual([
      'targetVariance', 'workdayShortfall', 'negMinGap', 'gapsLe2',
      'consecutiveWeekends', 'gapVariance', 'spreadDeviation',
      'rolling7Multi', 'softPrefViolations',
    ]);
    const score = spacingScore(baseCtx(), planOf([]));
    expect(score).toHaveLength(9);
  });

  it('target variance is exact-fractional (a whole call against a 0.5 target scores 0.5, never rounded)', () => {
    const ctx = buildCtx(
      [callSlot('sat', '2026-08-15', 'C1', 'saturday')],
      [prov('p1')],
      { scenario: scen([sp('p1', { targets: new Map([['SAT|C1', 0.5]]) })]) },
    );
    const score = spacingScore(ctx, planOf([asn('p1', '2026-08-15', 'C1', 'saturday')]));
    expect(score[0]).toBeCloseTo(0.5, 9);
    // Unplaced: |0 − 0.5| = 0.5 too — the exact-fraction symmetric variance.
    expect(spacingScore(ctx, planOf([]))[0]).toBeCloseTo(0.5, 9);
  });

  it('an unsatisfied scenario fixed assignment counts into the mandatory+target variance key', () => {
    const ctx = buildCtx([callSlot('mon', '2026-08-10', 'C1', 'weekday')], [prov('p1')], {
      scenario: scen([sp('p1', { fixedAssignments: [{ date: '2026-08-10', code: 'C1' }] })]),
    });
    expect(spacingScore(ctx, planOf([]))[0]).toBe(1);
    expect(spacingScore(ctx, planOf([asn('p1', '2026-08-10', 'C1', 'weekday')]))[0]).toBe(0);
  });

  it('near-adjacent independent blocks are penalized: gapsLe2 counts, min gap is maximized (negated)', () => {
    const clustered = planOf([
      asn('p1', '2026-08-11', 'C1', 'weekday'),
      asn('p1', '2026-08-13', 'C1', 'weekday'),
    ]);
    const spread = planOf([
      asn('p1', '2026-08-11', 'C1', 'weekday'),
      asn('p1', '2026-09-15', 'C1', 'weekday'),
    ]);
    const sClustered = spacingScore(baseCtx(), clustered);
    const sSpread = spacingScore(baseCtx(), spread);
    expect(sClustered[3]).toBe(1); // one gap ≤ 2
    expect(sSpread[3]).toBe(0);
    expect(sSpread[2]).toBeLessThan(sClustered[2]); // −minGap: bigger gap = smaller key
    expect(compareSpacingScores(sSpread, sClustered)).toBeLessThan(0);
  });

  it('consecutive weekends count (two adjacent weekends with calls = 1)', () => {
    const plan = planOf([
      asn('p1', '2026-08-15', 'C1', 'saturday'),
      asn('p1', '2026-08-22', 'C1', 'saturday'),
    ]);
    expect(spacingScore(baseCtx(), plan)[4]).toBe(1);
    const skipWeek = planOf([
      asn('p1', '2026-08-15', 'C1', 'saturday'),
      asn('p1', '2026-08-29', 'C1', 'saturday'),
    ]);
    expect(spacingScore(baseCtx(), skipWeek)[4]).toBe(0);
  });

  it('weekday-preference violations count calls of the preferred code on OTHER days of the same bucket', () => {
    const pref = { kind: 'weekday' as const, weekday: 2, codes: ['C1'], members: [], source: 'Prefers Tuesday' };
    const ctx = buildCtx([callSlot('a', '2026-08-10', 'C1', 'weekday')], [prov('p1')], {
      scenario: scen([sp('p1', { preferences: [pref] })]),
    });
    const tue = planOf([asn('p1', '2026-08-11', 'C1', 'weekday')]);
    const wed = planOf([asn('p1', '2026-08-12', 'C1', 'weekday')]);
    expect(spacingScore(ctx, tue)[8]).toBe(0);
    expect(spacingScore(ctx, wed)[8]).toBe(1);
  });

  it('compareSpacingScores is lexicographic with an epsilon on floats', () => {
    expect(compareSpacingScores([0, 0, -5, 0, 0, 0, 0, 0, 0], [0, 0, -3, 0, 0, 0, 0, 0, 0])).toBeLessThan(0);
    expect(compareSpacingScores([1, 0, -9, 0, 0, 0, 0, 0, 0], [0, 0, -3, 0, 0, 0, 0, 0, 0])).toBeGreaterThan(0);
    expect(compareSpacingScores([0.1 + 0.2, 0, 0, 0, 0, 0, 0, 0, 0], [0.3, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(0);
  });
});
