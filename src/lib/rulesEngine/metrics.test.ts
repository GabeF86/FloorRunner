import { describe, it, expect } from 'vitest';
import { scoreSolution } from './metrics';
import type { CallPatternDoc } from './callPattern';
import type {
  GenerationContext, CandidateProvider, SolutionPlan, PlannedAssignment,
} from './genTypes';

function prov(id: string, fte = 1): CandidateProvider {
  return {
    id, provider_type: 'physician', short_display_name: id, fte_value: fte,
    home_site_id: 'site1', available_weekdays: [true, true, true, true, true, true, true],
  };
}
function callA(over: Partial<PlannedAssignment>): PlannedAssignment {
  return {
    slot_id: 's', slot_date: '2026-01-07', shift_type_code: 'C1',
    shift_type_category: 'call', derived_day_type: 'weekday',
    provider_id: 'pA', provider_name: 'pA',
    existing_assignment_id: null, source: 'main-loop', ...over,
  };
}
function ctx(providers: CandidateProvider[],
            historical: Map<string, Map<string, number>> = new Map(),
            over: Partial<GenerationContext> = {}): GenerationContext {
  return {
    scheduleVersionId: 'v1', siteId: 'site1', parLevel: 12,
    slotsToFill: [], slotIndex: new Map(), providers,
    credByPid: new Map(), availByPid: new Map(), crossSiteByDate: new Map(),
    historicalAssignedByPid: historical, historicalTotalByBucket: new Map(),
    bucketTotals: new Map(), bucketTarget: new Map(), seedAssignments: [],
    ...over,
  };
}

describe('scoreSolution', () => {
  it('counts filled and skipped', () => {
    const plan: SolutionPlan = {
      assignments: [callA({ slot_id: 'a', provider_id: 'pA' })],
      unfilled: [{ slot_id: 'b', slot_date: '2026-01-08', shift_type_code: 'C1', reason: 'x' }],
    };
    const m = scoreSolution(plan, ctx([prov('pA'), prov('pB')]));
    expect(m.filled).toBe(1);
    expect(m.skipped).toBe(1);
    expect(m.providersUsed).toBe(1);
  });

  it('fairnessStdev is 0 when equal-FTE providers carry equal call load', () => {
    const plan: SolutionPlan = {
      assignments: [
        callA({ slot_id: 'a', slot_date: '2026-01-07', provider_id: 'pA' }),
        callA({ slot_id: 'b', slot_date: '2026-01-14', provider_id: 'pB' }),
      ],
      unfilled: [],
    };
    const m = scoreSolution(plan, ctx([prov('pA'), prov('pB')]));
    expect(m.fairnessStdev).toBeCloseTo(0);
  });

  it('fairnessStdev is positive when one provider carries all the load', () => {
    const plan: SolutionPlan = {
      assignments: [
        callA({ slot_id: 'a', slot_date: '2026-01-07', provider_id: 'pA' }),
        callA({ slot_id: 'b', slot_date: '2026-01-14', provider_id: 'pA' }),
      ],
      unfilled: [],
    };
    const m = scoreSolution(plan, ctx([prov('pA'), prov('pB')]));
    expect(m.fairnessStdev).toBeGreaterThan(0);
  });

  it('folds historical counts into the lifetime ratio', () => {
    // pB has 2 historical calls; pA has none. Give pA 2 this block -> equal lifetime.
    const hist = new Map([['pB', new Map([['weekday|C1', 2]])]]);
    const plan: SolutionPlan = {
      assignments: [
        callA({ slot_id: 'a', slot_date: '2026-01-07', provider_id: 'pA' }),
        callA({ slot_id: 'b', slot_date: '2026-01-14', provider_id: 'pA' }),
      ],
      unfilled: [],
    };
    const m = scoreSolution(plan, ctx([prov('pA'), prov('pB')], hist));
    expect(m.fairnessStdev).toBeCloseTo(0); // both at lifetime 2
  });

  it('counts a burnout when one provider has two weekday calls one day apart', () => {
    // Mon 2026-01-05 and Tue 2026-01-06, both pA, both weekday -> 1 burnout.
    const plan: SolutionPlan = {
      assignments: [
        callA({ slot_id: 'a', slot_date: '2026-01-05', provider_id: 'pA' }),
        callA({ slot_id: 'b', slot_date: '2026-01-06', provider_id: 'pA' }),
      ],
      unfilled: [],
    };
    const m = scoreSolution(plan, ctx([prov('pA')]));
    expect(m.burnout).toBe(1);
  });

  it('does NOT count a weekend Sat/Sun pair as burnout', () => {
    // Sat 2026-01-03 + Sun 2026-01-04 is the intended weekend chain, not burnout.
    const plan: SolutionPlan = {
      assignments: [
        callA({ slot_id: 'a', slot_date: '2026-01-03', derived_day_type: 'saturday', provider_id: 'pA' }),
        callA({ slot_id: 'b', slot_date: '2026-01-04', derived_day_type: 'sunday', provider_id: 'pA' }),
      ],
      unfilled: [],
    };
    const m = scoreSolution(plan, ctx([prov('pA')]));
    expect(m.burnout).toBe(0);
  });

  it('does NOT count a Fri+Sat weekend-block pair as burnout (intended chain)', () => {
    // Fri 2026-01-02 (C2) + Sat 2026-01-03 (C1) is the weekend chain, not burnout.
    const plan: SolutionPlan = {
      assignments: [
        callA({ slot_id: 'a', slot_date: '2026-01-02', derived_day_type: 'friday', provider_id: 'pA' }),
        callA({ slot_id: 'b', slot_date: '2026-01-03', derived_day_type: 'saturday', provider_id: 'pA' }),
      ],
      unfilled: [],
    };
    const m = scoreSolution(plan, ctx([prov('pA')]));
    expect(m.burnout).toBe(0);
  });
});

describe('scoreSolution — category-driven call-ness', () => {
  it("a custom call code 'NC' contributes to fairnessStdev and burnout exactly as C1", () => {
    // Two adjacent weekday calls (Mon 01-05, Tue 01-06), all on pA; pB idle.
    // Call-ness comes from the category STAMPED on the assignment (callA sets
    // 'call'); scoreSolution never reads ctx.shiftTypes.
    const mkPlan = (code: string): SolutionPlan => ({
      assignments: [
        callA({ slot_id: 'a', slot_date: '2026-01-05', shift_type_code: code, provider_id: 'pA' }),
        callA({ slot_id: 'b', slot_date: '2026-01-06', shift_type_code: code, provider_id: 'pA' }),
      ],
      unfilled: [],
    });
    const mNC = scoreSolution(mkPlan('NC'), ctx([prov('pA'), prov('pB')]));
    const mC1 = scoreSolution(mkPlan('C1'), ctx([prov('pA'), prov('pB')]));
    expect(mNC.fairnessStdev).toBeGreaterThan(0);
    expect(mNC.fairnessStdev).toBeCloseTo(mC1.fairnessStdev);
    expect(mNC.burnout).toBe(1);
    expect(mNC.burnout).toBe(mC1.burnout);
    expect(mNC.providersUsed).toBe(1);
  });
});

describe('scoreSolution — pattern-aware burnout exemption', () => {
  it('counts a Fri+Sat call pair as burnout under a pattern with NO blocks', () => {
    // Same dates the classic pattern exempts (Fri 01-02 + Sat 01-03), but the
    // site pattern has no block chains -> no exemption window -> burnout.
    const noBlocks: CallPatternDoc = {
      version: 1, blocks: [], dayChains: [], spans: [], placementPasses: [],
      reliefPass: null, optimizerMovableDayTypes: ['weekday', 'friday'],
    };
    const plan: SolutionPlan = {
      assignments: [
        callA({ slot_id: 'a', slot_date: '2026-01-02', derived_day_type: 'friday', provider_id: 'pA' }),
        callA({ slot_id: 'b', slot_date: '2026-01-03', derived_day_type: 'saturday', provider_id: 'pA' }),
      ],
      unfilled: [],
    };
    const m = scoreSolution(plan, ctx([prov('pA')], new Map(), { callPattern: noBlocks }));
    expect(m.burnout).toBe(1);
  });

  it('exempts a pair only when both dates fall in the SAME saturday-anchored window', () => {
    // Sun 01-04 + Mon 01-05 are 1 day apart, but Mon is outside the Fri-Sun
    // window anchored on Sat 01-03 -> burnout (classic parity).
    const plan: SolutionPlan = {
      assignments: [
        callA({ slot_id: 'a', slot_date: '2026-01-03', derived_day_type: 'saturday', provider_id: 'pB' }),
        callA({ slot_id: 'b', slot_date: '2026-01-04', derived_day_type: 'sunday', provider_id: 'pA' }),
        callA({ slot_id: 'c', slot_date: '2026-01-05', derived_day_type: 'weekday', provider_id: 'pA' }),
      ],
      unfilled: [],
    };
    const m = scoreSolution(plan, ctx([prov('pA'), prov('pB')]));
    expect(m.burnout).toBe(1);
  });
});
