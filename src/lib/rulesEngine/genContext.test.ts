import { describe, it, expect } from 'vitest';
import { emptySolveState } from './genTypes';
import { computeBucketTargets } from './genContext';
import type { CandidateProvider } from './genTypes';

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

function prov(id: string, fte: number): CandidateProvider {
  return {
    id, provider_type: 'physician', short_display_name: id, fte_value: fte,
    home_site_id: 'site1', available_weekdays: [true, true, true, true, true, true, true],
  };
}

describe('computeBucketTargets', () => {
  it('computes FTE-weighted base share with par level', () => {
    const targets = computeBucketTargets(
      new Map([['weekday|C1', 12]]),
      new Map(),
      new Map(),
      [prov('p1', 1), prov('p2', 0.5)],
      12,
    );
    expect(targets.get('p1|weekday|C1')).toBeCloseTo(1.0);
    expect(targets.get('p2|weekday|C1')).toBeCloseTo(0.5);
  });

  it('adds historical deficit so under-allocated part-timers catch up', () => {
    const targets = computeBucketTargets(
      new Map([['weekday|C1', 12]]),
      new Map([['weekday|C1', 24]]),
      new Map([['p1', new Map([['weekday|C1', 0]])]]),
      [prov('p1', 0.5)],
      12,
    );
    expect(targets.get('p1|weekday|C1')).toBeCloseTo(1.5);
  });

  it('never lets historical over-allocation shrink the base', () => {
    const targets = computeBucketTargets(
      new Map([['weekday|C1', 12]]),
      new Map([['weekday|C1', 12]]),
      new Map([['p1', new Map([['weekday|C1', 99]])]]),
      [prov('p1', 1)],
      12,
    );
    expect(targets.get('p1|weekday|C1')).toBeCloseTo(1.0);
  });
});
