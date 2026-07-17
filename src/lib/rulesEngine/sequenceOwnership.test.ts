// computeSequenceOwnedSlotIds — the single-homed "could the ACTIVE pattern doc
// target this slot as a chain link?" predicate. A slot (date, code) is
// sequence-owned when some potential anchor/trigger date maps to it:
//   anchorDate + link.offset === slot date
//   AND link.code === slot code
//   AND anchorDate's day type matches the chain's trigger dayTypes
//       (dayChains) / the block's anchorDayType (blocks).
// Anchor-slot EXISTENCE is deliberately not required, and out-of-block anchors
// still own in-block targets (see the boundary tests below): ownership is a
// clinical fact about the slot (D1 belongs to yesterday's C2 person), not a
// generation-scoped one — over-exclusion leaves a slot open and reported;
// under-exclusion hands it to the wrong provider.
import { describe, it, expect } from 'vitest';
import { computeSequenceOwnedSlotIds } from './sequenceOwnership';
import { CLASSIC_PATTERN } from './callPattern';
import { WEEKEND_V2_PATTERN } from './patterns/weekendV2';
import { callSlot, dSlot } from './__fixtures__/buildContext';
import type { SlotToFill } from './genTypes';

function indexOf(slots: SlotToFill[]): Map<string, Map<string, SlotToFill>> {
  const idx = new Map<string, Map<string, SlotToFill>>();
  for (const s of slots) {
    if (!idx.has(s.slot_date)) idx.set(s.slot_date, new Map());
    idx.get(s.slot_date)!.set(s.shift_type_code, s);
  }
  return idx;
}

describe('computeSequenceOwnedSlotIds — dayChain targets (classic)', () => {
  it('owns Tue D1 (post Mon C2), Mon D2 (pre Tue C1), Mon D3 (pre Tue C2)', () => {
    const slots = [
      dSlot('monD2', '2026-01-05', 'D2'), // pre-fill for Tue C1 (−1 link → anchor Tue, weekday)
      dSlot('monD3', '2026-01-05', 'D3'), // pre-fill for Tue C2
      dSlot('tueD1', '2026-01-06', 'D1'), // post-fill for Mon C2 (+1 link → anchor Mon, weekday)
    ];
    const owned = computeSequenceOwnedSlotIds(CLASSIC_PATTERN, indexOf(slots));
    expect(owned.has('monD2')).toBe(true);
    expect(owned.has('monD3')).toBe(true);
    expect(owned.has('tueD1')).toBe(true);
  });

  it('owns Mon D1 via the sunday C2 chain and Sat D1 via the friday C2 chain', () => {
    const slots = [
      dSlot('satD1', '2026-01-10', 'D1', 'saturday'), // anchor Fri (friday ∈ C2 chain dayTypes)
      dSlot('monD1', '2026-01-12', 'D1'),             // anchor Sun (sunday C2 chain, +1 D1)
    ];
    const owned = computeSequenceOwnedSlotIds(CLASSIC_PATTERN, indexOf(slots));
    expect(owned.has('satD1')).toBe(true);
    expect(owned.has('monD1')).toBe(true);
  });

  it('does not own Sat D2 (its anchor Sunday matches no D2-linking chain) nor any D4', () => {
    const slots = [
      dSlot('satD2', '2026-01-10', 'D2', 'saturday'), // anchor Sun: C1 sunday chain has blocks only
      dSlot('wedD4', '2026-01-07', 'D4'),             // D4 is never a classic chain target
      dSlot('friD4', '2026-01-09', 'D4', 'friday'),
    ];
    const owned = computeSequenceOwnedSlotIds(CLASSIC_PATTERN, indexOf(slots));
    expect(owned.has('satD2')).toBe(false);
    expect(owned.has('wedD4')).toBe(false);
    expect(owned.has('friD4')).toBe(false);
  });
});

describe('computeSequenceOwnedSlotIds — block-chain targets', () => {
  it('classic saturday block owns Fri C2 / Sun C2 (C1 anchor), Sun C1 + Fri D2 (C2 anchor), Sun C3', () => {
    const slots = [
      callSlot('friC2', '2026-01-09', 'C2', 'friday'),
      dSlot('friD2', '2026-01-09', 'D2', 'friday'),
      callSlot('sunC1', '2026-01-11', 'C1', 'sunday'),
      callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
      callSlot('sunC3', '2026-01-11', 'C3', 'sunday'),
    ];
    const owned = computeSequenceOwnedSlotIds(CLASSIC_PATTERN, indexOf(slots));
    for (const id of ['friC2', 'friD2', 'sunC1', 'sunC2', 'sunC3']) {
      expect(owned.has(id), id).toBe(true);
    }
  });

  it("weekend v2 owns Doc C's Friday D4 (Sat C3 anchor, −1 link) but not a weekday D4", () => {
    const slots = [
      dSlot('friD4', '2026-01-09', 'D4', 'friday'),  // anchor Sat 01-10
      dSlot('wedD4', '2026-01-07', 'D4'),            // anchor Thu — not saturday
    ];
    const owned = computeSequenceOwnedSlotIds(WEEKEND_V2_PATTERN, indexOf(slots));
    expect(owned.has('friD4')).toBe(true);
    expect(owned.has('wedD4')).toBe(false);
  });

  it('weekend v2 owns Sun C2 via the friday C1 anchor (+2 link)', () => {
    const slots = [callSlot('sunC2', '2026-01-11', 'C2', 'sunday')]; // anchor Fri 01-09
    const owned = computeSequenceOwnedSlotIds(WEEKEND_V2_PATTERN, indexOf(slots));
    expect(owned.has('sunC2')).toBe(true);
  });
});

describe('computeSequenceOwnedSlotIds — boundary dates (out-of-block anchors)', () => {
  it('a D1 on the first block day is still owned by the (out-of-block) prior-day C2 anchor', () => {
    // Block starts Tue 01-06: Monday has no slots at all, yet Tue D1 belongs
    // to Monday's C2 person (previous block / manual seed). Out-of-block
    // anchor day types are derived from the day of week (weekday here).
    const slots = [dSlot('tueD1', '2026-01-06', 'D1')];
    const owned = computeSequenceOwnedSlotIds(CLASSIC_PATTERN, indexOf(slots));
    expect(owned.has('tueD1')).toBe(true);
  });

  it('an out-of-block SATURDAY anchor owns an in-block Friday D4 (weekend v2)', () => {
    // Block ends Friday 01-09; Saturday 01-10 (the C3 anchor day) is outside.
    const slots = [dSlot('friD4', '2026-01-09', 'D4', 'friday')];
    const owned = computeSequenceOwnedSlotIds(WEEKEND_V2_PATTERN, indexOf(slots));
    expect(owned.has('friD4')).toBe(true);
  });

  it('day-of-week fallback still distinguishes non-matching anchors out of block', () => {
    // Wed D4 alone: its would-be anchor Thu 01-08 has no slots; DOW says
    // weekday, the weekend-v2 D4 link needs saturday → not owned.
    const slots = [dSlot('wedD4', '2026-01-07', 'D4')];
    const owned = computeSequenceOwnedSlotIds(WEEKEND_V2_PATTERN, indexOf(slots));
    expect(owned.has('wedD4')).toBe(false);
  });

  it('uses the real derived day type for in-block anchor dates (holiday-typed anchors)', () => {
    // Mon 01-05 is typed major_holiday in this version. The classic C2 chain
    // includes major_holiday, so Tue D1 is owned via the REAL slot day type
    // (a DOW fallback would call it weekday — also matching here, but the
    // slotIndex type must win when present).
    const slots = [
      callSlot('monC2', '2026-01-05', 'C2', 'major_holiday'),
      dSlot('tueD1', '2026-01-06', 'D1'),
    ];
    const owned = computeSequenceOwnedSlotIds(CLASSIC_PATTERN, indexOf(slots));
    expect(owned.has('tueD1')).toBe(true);
    // The trigger call slot itself is not a link target of any chain here.
    expect(owned.has('monC2')).toBe(false);
  });
});
