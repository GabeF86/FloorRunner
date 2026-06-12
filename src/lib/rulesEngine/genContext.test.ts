import { describe, it, expect } from 'vitest';
import { emptySolveState } from './genTypes';

describe('emptySolveState', () => {
  it('creates independent empty state', () => {
    const a = emptySolveState();
    const b = emptySolveState();
    a.bucketAssigned.set('x', 1);
    expect(b.bucketAssigned.size).toBe(0);
    expect(a.assignedOnDate.size).toBe(0);
    expect(a.handledSlotIds.size).toBe(0);
    expect(a.callDatesByProvider.size).toBe(0);
  });
});
