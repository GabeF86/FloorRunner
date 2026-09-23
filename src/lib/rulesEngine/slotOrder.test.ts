/**
 * Commitment-order permutations (Gabriel 2026-09-22: "attack the schedule
 * from both ends").
 *
 * Every ordering must be a PERMUTATION of the call slots and nothing more —
 * it reorders when work is committed, it never adds, drops or rewrites a
 * slot. These tests pin that, plus the two properties the measurement depends
 * on: 'forward' is the untouched identity, and the same ctx always yields the
 * same order (no Math.random, no sort-stability assumptions).
 */
import { describe, it, expect } from 'vitest';
import { applySlotOrder, SLOT_ORDERS } from './slotOrder';
import { buildFixtureContext } from './__fixtures__/buildContext';
import type { SlotOrder } from './genTypes';

const NON_FORWARD: SlotOrder[] = ['reverse', 'outside-in', 'constrained'];

const ids = (slots: { slot_id: string }[]) => slots.map(s => s.slot_id);
const callDates = (slots: { slot_date: string; shift_type_category: string }[]) =>
  slots.filter(s => s.shift_type_category === 'call').map(s => s.slot_date);

describe("'forward' is the identity", () => {
  it('returns the very same array for absent and for forward', () => {
    const ctx = buildFixtureContext();
    // Identity, not a copy: the default path must be byte-identical.
    expect(applySlotOrder(ctx.slotsToFill, undefined, ctx)).toBe(ctx.slotsToFill);
    expect(applySlotOrder(ctx.slotsToFill, 'forward', ctx)).toBe(ctx.slotsToFill);
  });
});

describe('every ordering is a permutation', () => {
  for (const order of SLOT_ORDERS) {
    it(`'${order}' keeps exactly the same slots`, () => {
      const ctx = buildFixtureContext();
      const out = applySlotOrder(ctx.slotsToFill, order, ctx);
      expect(out).toHaveLength(ctx.slotsToFill.length);
      expect([...ids(out)].sort()).toEqual([...ids(ctx.slotsToFill)].sort());
      // No slot object is duplicated into two positions.
      expect(new Set(ids(out)).size).toBe(out.length);
    });
  }
});

describe('non-call slots never move', () => {
  for (const order of NON_FORWARD) {
    it(`'${order}' permutes call slots only`, () => {
      // The relief and mop-up passes rank the day pool themselves, so
      // reordering day slots here would be noise. Pinned so a future edit
      // cannot quietly widen the scope.
      const ctx = buildFixtureContext();
      const out = applySlotOrder(ctx.slotsToFill, order, ctx);
      ctx.slotsToFill.forEach((s, i) => {
        if (s.shift_type_category !== 'call') expect(out[i]).toBe(s);
        else expect(out[i].shift_type_category).toBe('call');
      });
    });
  }
});

describe("'reverse' runs the dates backwards", () => {
  it('reverses the date sequence', () => {
    const ctx = buildFixtureContext();
    const fwd = [...new Set(callDates(ctx.slotsToFill))];
    const rev = [...new Set(callDates(applySlotOrder(ctx.slotsToFill, 'reverse', ctx)))];
    expect(rev).toEqual([...fwd].reverse());
  });
});

describe("'outside-in' works both ends toward the middle", () => {
  it('alternates first, last, second, second-last', () => {
    const ctx = buildFixtureContext();
    const fwd = [...new Set(callDates(ctx.slotsToFill))];
    const out = [...new Set(callDates(applySlotOrder(ctx.slotsToFill, 'outside-in', ctx)))];
    const want: string[] = [];
    for (let lo = 0, hi = fwd.length - 1; lo <= hi; lo++, hi--) {
      want.push(fwd[lo]);
      if (lo !== hi) want.push(fwd[hi]);
    }
    expect(out).toEqual(want);
  });
});

describe('determinism', () => {
  for (const order of SLOT_ORDERS) {
    it(`'${order}' gives the same order on an identical ctx`, () => {
      const a = buildFixtureContext();
      const b = buildFixtureContext();
      expect(ids(applySlotOrder(a.slotsToFill, order, a)))
        .toEqual(ids(applySlotOrder(b.slotsToFill, order, b)));
    });
  }
});
