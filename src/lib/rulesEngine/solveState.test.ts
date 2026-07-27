import { describe, it, expect } from 'vitest';
import { emptySolveState } from './solveState';

describe('emptySolveState', () => {
  it('starts with an empty neuro remainder set', () => {
    expect(emptySolveState().neuroRemainderSlotIds.size).toBe(0);
  });
});
