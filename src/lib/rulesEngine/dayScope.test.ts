// Day scope — Gabriel 2026-07-30: "Is there a way to autofill only the weekday
// calls?" (after entering the weekend schedule by hand).
//
// Kept SEPARATE from fillMode on purpose: scope and cap are orthogonal, so
// "obligatory + weekday only" is expressible. A fourth FillMode value would
// have forced a choice between uncapped and capped.
import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { buildCtx, prov, callSlot } from './__fixtures__/buildContext';

// Mon 2026-08-10 .. Sun 2026-08-16, plus Labor Day (Mon 2026-09-07).
const MON = '2026-08-10', THU = '2026-08-13';
const FRI = '2026-08-14', SAT = '2026-08-15', SUN = '2026-08-16';
const HOL = '2026-09-07';

const board = () => buildCtx(
  [
    callSlot('mon-c1', MON, 'C1'), callSlot('thu-c1', THU, 'C1'),
    callSlot('fri-c1', FRI, 'C1', 'friday'),
    callSlot('sat-c1', SAT, 'C1', 'saturday'),
    callSlot('sun-c1', SUN, 'C1', 'sunday'),
    callSlot('hol-c1', HOL, 'C1', 'major_holiday'),
  ],
  [prov('p1'), prov('p2'), prov('p3'), prov('p4'), prov('p5'), prov('p6')],
  { parLevel: 6 },
);

const filled = (opts: Parameters<typeof solve>[1]) =>
  solve(board(), opts).assignments
    .filter(a => a.shift_type_category === 'call').map(a => a.slot_id).sort();

describe('dayScope', () => {
  it('weekday scope attempts only M–Th', () => {
    expect(filled({ dayScope: 'weekday' })).toEqual(['hol-c1', 'mon-c1', 'thu-c1']);
  });

  it('weekend scope attempts only Fri/Sat/Sun', () => {
    expect(filled({ dayScope: 'weekend' })).toEqual(['fri-c1', 'sat-c1', 'sun-c1']);
  });

  it('the two scopes PARTITION the block — every call slot exactly once', () => {
    const wd = new Set(filled({ dayScope: 'weekday' }));
    const we = new Set(filled({ dayScope: 'weekend' }));
    const all = filled({});
    expect([...wd].filter(id => we.has(id))).toEqual([]);          // no overlap
    expect([...wd, ...we].sort()).toEqual(all);                     // no gap
  });

  it('a HOLIDAY belongs to weekday scope, matching where weekend-only leaves it', () => {
    // weekend-only deliberately excludes holiday day types; weekday scope is
    // its exact complement, so holidays are attempted there rather than by
    // neither.
    expect(filled({ dayScope: 'weekday' })).toContain('hol-c1');
    expect(filled({ dayScope: 'weekend' })).not.toContain('hol-c1');
  });

  it('out-of-scope slots are DEFERRED, not reported as failures', () => {
    const plan = solve(board(), { dayScope: 'weekday' });
    expect(plan.awaitingContinue?.map(s => s.slot_id).sort())
      .toEqual(['fri-c1', 'sat-c1', 'sun-c1']);
    for (const id of ['fri-c1', 'sat-c1', 'sun-c1']) {
      expect(plan.unfilled.some(u => u.slot_id === id)).toBe(false);
    }
  });

  it('composes with obligatory — the combination a fill-mode value could not express', () => {
    // par 6, six 1.0-FTE providers, six call slots ⇒ obligation 1 each. Weekday
    // scope still fills its three, and nobody exceeds their cap.
    const plan = solve(board(), { dayScope: 'weekday', fillMode: 'obligatory' });
    const calls = plan.assignments.filter(a => a.shift_type_category === 'call');
    expect(calls.map(a => a.slot_id).sort()).toEqual(['hol-c1', 'mon-c1', 'thu-c1']);
    const perProvider = new Map<string, number>();
    for (const a of calls) perProvider.set(a.provider_id, (perProvider.get(a.provider_id) ?? 0) + 1);
    for (const n of perProvider.values()) expect(n).toBeLessThanOrEqual(1);
  });

  it('absent scope is the whole block, unchanged', () => {
    expect(filled({})).toHaveLength(6);
    expect(solve(board(), {}).awaitingContinue).toBeUndefined();
  });
});
