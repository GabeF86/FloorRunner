/**
 * The picked-up-call arithmetic behind the clinician overview.
 *
 * The loader itself is six reads and a hand-off, but WHICH calls count as
 * picked up is a rule, and the rule is the one Gabriel stated: each category
 * is judged on its own, nothing nets, and the day type is the price. These
 * tests drive it with plain records — no database.
 */
import { describe, it, expect } from 'vitest';
import { computeExtrasByCategory } from './providerOverviewQuery';
import type { CensusSlot, OverParCall } from '@/lib/fteTarget';
import type { OwedInputs } from '@/lib/providerOverview';

const PID = 'p1';

const slot = (
  date: string, code: string, dayType: string, assignments: Array<{ id: string; provider_id: string | null }> = [],
): CensusSlot => ({
  slot_date: date,
  derived_day_type: dayType,
  shift_types: { category: 'call', code },
  assignments,
});

const rec = (
  id: string, date: string, code: string, bucket: string, extra: Partial<OverParCall> = {},
): OverParCall => ({
  id, provider_id: PID, slot_date: date, shift_type_code: code, bucket, ...extra,
});

const owedInputs = (slots: Array<[string, number]>, fte = 1): OwedInputs => ({
  parLevel: 12, callFte: fte, inCallPool: fte > 0, bucketSlotWeight: new Map(slots),
});

describe('picked-up calls, per category', () => {
  it('charges nothing until the whole-call obligation is passed', () => {
    // 31 weekday C1 slots ÷ par 12 = 2.58 owed, met by 3 calls.
    const owed = owedInputs([['weekday|C1', 31]]);
    const slots = [
      slot('2026-09-01', 'C1', 'weekday', [{ id: 'a1', provider_id: PID }]),
      slot('2026-09-02', 'C1', 'weekday', [{ id: 'a2', provider_id: PID }]),
      slot('2026-09-03', 'C1', 'weekday', [{ id: 'a3', provider_id: PID }]),
    ];
    const records = [
      rec('a1', '2026-09-01', 'C1', 'weekday'),
      rec('a2', '2026-09-02', 'C1', 'weekday'),
      rec('a3', '2026-09-03', 'C1', 'weekday'),
    ];
    expect([...computeExtrasByCategory(PID, records, slots, owed).byCategory]).toEqual([]);
  });

  it('prices the fourth one, and says which day type it was', () => {
    const owed = owedInputs([['weekday|C1', 31]]);
    const dates = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-08'];
    const slots = dates.map((d, i) =>
      slot(d, 'C1', 'weekday', [{ id: `a${i}`, provider_id: PID }]));
    const records = dates.map((d, i) => rec(`a${i}`, d, 'C1', 'weekday'));
    const { byCategory } = computeExtrasByCategory(PID, records, slots, owed);
    expect(byCategory.get('weekday|C1')).toBe(1);
  });

  it('does NOT let a shortfall in one category pay for an extra in another', () => {
    // One Saturday C1 owed and none held, two M–Th C1 owed and three held.
    // The extra is real; the shortfall does not cancel it.
    const owed = owedInputs([['weekday|C1', 24], ['saturday|C1', 12]]);
    const dates = ['2026-09-01', '2026-09-02', '2026-09-03'];
    const slots = dates.map((d, i) =>
      slot(d, 'C1', 'weekday', [{ id: `a${i}`, provider_id: PID }]));
    const records = dates.map((d, i) => rec(`a${i}`, d, 'C1', 'weekday'));
    const { byCategory } = computeExtrasByCategory(PID, records, slots, owed);
    expect(byCategory.get('weekday|C1')).toBe(1);
    expect(byCategory.has('saturday|C1')).toBe(false);
  });

  it('prices a split segment at its own weight, under the parent call', () => {
    const owed = owedInputs([['saturday|C1', 12]]);   // 1 owed
    const slots = [
      slot('2026-09-05', 'C1', 'saturday', [{ id: 'a1', provider_id: PID }]),
      slot('2026-09-12', 'C1D12', 'saturday', [{ id: 'a2', provider_id: PID }]),
    ];
    const records = [
      rec('a1', '2026-09-05', 'C1', 'saturday'),
      rec('a2', '2026-09-12', 'C1D12', 'saturday', { weight: 0.5, parent_code: 'C1' }),
    ];
    const { byCategory } = computeExtrasByCategory(PID, records, slots, owed);
    expect(byCategory.get('saturday|C1')).toBe(0.5);
  });

  it('ignores everybody else’s calls', () => {
    const owed = owedInputs([['weekday|C1', 12]]);
    const slots = [
      slot('2026-09-01', 'C1', 'weekday', [{ id: 'a1', provider_id: PID }]),
      slot('2026-09-02', 'C1', 'weekday', [{ id: 'b1', provider_id: 'p2' }]),
      slot('2026-09-03', 'C1', 'weekday', [{ id: 'b2', provider_id: 'p2' }]),
    ];
    const records = [
      rec('a1', '2026-09-01', 'C1', 'weekday'),
      { ...rec('b1', '2026-09-02', 'C1', 'weekday'), provider_id: 'p2' },
      { ...rec('b2', '2026-09-03', 'C1', 'weekday'), provider_id: 'p2' },
    ];
    expect([...computeExtrasByCategory(PID, records, slots, owed).byCategory]).toEqual([]);
  });

  it('REPORTS a call it cannot bucket rather than pricing it wrong', () => {
    const owed = owedInputs([['weekday|C1', 12]]);
    const slots = [slot('2026-09-01', 'C1', 'weekday', [{ id: 'a1', provider_id: PID }])];
    const records = [
      rec('a1', '2026-09-01', 'C1', 'weekday'),
      { ...rec('a2', '2026-09-02', 'C1', 'weekday'), bucket: undefined },
    ];
    const { unbucketed } = computeExtrasByCategory(PID, records, slots, owed);
    expect(unbucketed).toBe(1);
  });

  it('judges the neuro tier by the weekend the site STATED, not by the formula', () => {
    // Paoli stands 8 neuro weekends against a par of 12, so the formula owes
    // 0.67 of a weekend — take the one the pattern told you to take and you
    // would be billed a pickup for it. The stated requirement is one call on
    // each neuro day, and the second weekend is where the pickup starts.
    const owed = owedInputs([['saturday|C3', 8], ['sunday|C3', 8]]);
    const dates = ['2026-09-05', '2026-09-06', '2026-09-12', '2026-09-13'];
    const days = ['saturday', 'sunday', 'saturday', 'sunday'];
    const slots = dates.map((d, i) =>
      slot(d, 'C3', days[i], [{ id: `a${i}`, provider_id: PID }]));
    const records = dates.map((d, i) => rec(`a${i}`, d, 'C3', days[i]));
    const stated = { code: 'C3', owedPerDay: 1 };

    const one = computeExtrasByCategory(
      PID, records.slice(0, 2), slots.slice(0, 2), owed, stated);
    expect([...one.byCategory]).toEqual([]);

    const two = computeExtrasByCategory(PID, records, slots, owed, stated);
    expect(two.byCategory.get('saturday|C3')).toBe(1);
    expect(two.byCategory.get('sunday|C3')).toBe(1);
  });

  it('charges a holiday pickup to the weekday it fell on', () => {
    // Labor Day is a Monday: an M–Th call, priced as one.
    const owed = owedInputs([['weekday|C1', 12]]);   // 1 owed
    const slots = [
      slot('2026-09-01', 'C1', 'weekday', [{ id: 'a1', provider_id: PID }]),
      slot('2026-09-07', 'C1', 'federal_holiday', [{ id: 'a2', provider_id: PID }]),
    ];
    const records = [
      rec('a1', '2026-09-01', 'C1', 'weekday'),
      rec('a2', '2026-09-07', 'C1', 'weekday'),   // the census already bucketed it
    ];
    const { byCategory } = computeExtrasByCategory(PID, records, slots, owed);
    expect(byCategory.get('weekday|C1')).toBe(1);
  });
});
