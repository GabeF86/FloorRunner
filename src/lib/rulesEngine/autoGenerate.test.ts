import { describe, it, expect } from 'vitest';
import { toResultAssignment, resolveOptimizeEnabled } from './autoGenerate';
import type { PlannedAssignment } from './genTypes';

describe('resolveOptimizeEnabled', () => {
  it('defaults to true when unset', () => {
    expect(resolveOptimizeEnabled(undefined)).toBe(true);
  });
  it('honors an explicit false (disable optimization)', () => {
    expect(resolveOptimizeEnabled(false)).toBe(false);
  });
  it('honors an explicit true', () => {
    expect(resolveOptimizeEnabled(true)).toBe(true);
  });
});

describe('toResultAssignment', () => {
  it('maps a planned assignment to the API shape including explanation + source', () => {
    const pa: PlannedAssignment = {
      slot_id: 's1', slot_date: '2026-01-07', shift_type_code: 'C1',
      shift_type_category: 'call', derived_day_type: 'weekday',
      provider_id: 'p1', provider_name: 'DOCA', existing_assignment_id: null,
      source: 'main-loop',
      explanation: { ratioAtAssignment: 1.5, daysSinceLastCall: 7, competingCandidates: 3 },
    };
    expect(toResultAssignment(pa)).toEqual({
      slot_id: 's1', slot_date: '2026-01-07', shift_type_code: 'C1',
      provider_id: 'p1', provider_name: 'DOCA',
      source: 'main-loop',
      explanation: { ratioAtAssignment: 1.5, daysSinceLastCall: 7, competingCandidates: 3 },
    });
  });
});
