// Call-split grid helpers (2026-07-22) — pure functions for rendering split
// calls STACKED inside the parent call's row cell (parent_call_code lookup —
// no new grid rows). Kept out of the page monolith so vitest covers them.
import { describe, it, expect } from 'vitest';
import { isSegmentType, segmentKey, groupSegmentSlots, segmentTag } from './gridSegments';

const seg = (id: string, date: string, code: string, parent: string, order: number | null = null) => ({
  id, slot_date: date,
  shift_types: { code, parent_call_code: parent, display_order: order },
});
const whole = (id: string, date: string, code: string) => ({
  id, slot_date: date,
  shift_types: { code, parent_call_code: null, display_order: 0 },
});

describe('isSegmentType — keyed on parent_call_code, never code names', () => {
  it('true only when a parent code is stored', () => {
    expect(isSegmentType({ code: 'C1N12', parent_call_code: 'C1' })).toBe(true);
    expect(isSegmentType({ code: 'C1', parent_call_code: null })).toBe(false);
    expect(isSegmentType({ code: 'C1', parent_call_code: '' })).toBe(false);
    expect(isSegmentType({ code: 'WEIRD-N12' })).toBe(false); // name pattern proves nothing
    expect(isSegmentType(null)).toBe(false);
    expect(isSegmentType(undefined)).toBe(false);
  });
});

describe('groupSegmentSlots — parent|date grouping for the stacked cell', () => {
  it('groups segment slots under segmentKey(parent, date), ordered by display_order', () => {
    const slots = [
      whole('w1', '2026-02-06', 'C1'),
      seg('n', '2026-02-07', 'C1N12', 'C1', 21),
      seg('d', '2026-02-07', 'C1D12', 'C1', 20),
      seg('other', '2026-02-08', 'C2N12', 'C2', 26),
    ];
    const grouped = groupSegmentSlots(slots);
    expect(grouped.get(segmentKey('C1', '2026-02-07'))!.map(s => s.id)).toEqual(['d', 'n']);
    expect(grouped.get(segmentKey('C2', '2026-02-08'))!.map(s => s.id)).toEqual(['other']);
    // Whole slots never enter the segment map.
    expect(grouped.get(segmentKey('C1', '2026-02-06'))).toBeUndefined();
  });

  it('falls back to code ordering when display_order is missing', () => {
    const grouped = groupSegmentSlots([
      seg('b', '2026-02-07', 'C1E8', 'C1'),
      seg('a', '2026-02-07', 'C1D8', 'C1'),
      seg('c', '2026-02-07', 'C1N8', 'C1'),
    ]);
    expect(grouped.get(segmentKey('C1', '2026-02-07'))!.map(s => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('slots without a shift type are ignored', () => {
    const grouped = groupSegmentSlots([{ id: 'x', slot_date: '2026-02-07', shift_types: null }]);
    expect(grouped.size).toBe(0);
  });
});

describe('segmentTag — compact mini-cell label (display only)', () => {
  it('strips the parent prefix when present', () => {
    expect(segmentTag('C1N12', 'C1')).toBe('N12');
    expect(segmentTag('C2D8', 'C2')).toBe('D8');
  });
  it('falls back to the full code when it does not share the parent prefix', () => {
    expect(segmentTag('NIGHT', 'C1')).toBe('NIGHT');
    expect(segmentTag('C1', 'C1')).toBe('C1'); // never an empty tag
  });
});
