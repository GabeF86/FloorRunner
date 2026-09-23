/**
 * Burden metrics.
 *
 * The bug these exist to prevent: counting only the calls placed in the plan
 * and comparing that against a solver figure that includes calls the provider
 * already holds elsewhere in the block. It does not error — it quietly answers
 * a different question, and it made an engine 1.25x from optimal look 5x from
 * optimal. So the prior-call handling is pinned from both directions, and the
 * double-count trap gets its own test.
 */
import { describe, it, expect } from 'vitest';
import { callCounts, callsPerFteStdev, obligationCoverage, callsPlaced } from './burdenMetrics';
import { buildFixtureContext } from './__fixtures__/buildContext';
import { solve } from './solve';
import type { GenerationContext, SolutionPlan } from './genTypes';

/** A plan holding exactly the given (provider, slot) call assignments. */
function planOf(ctx: GenerationContext, pairs: Array<[string, string]>): SolutionPlan {
  return {
    ...solve(ctx, {}),
    assignments: pairs.map(([pid, slotId]) => ({
      slot_id: slotId,
      slot_date: '2026-01-01',
      provider_id: pid,
      shift_type_code: 'C1',
      shift_type_category: 'call',
      derived_day_type: 'weekday',
      source: 'main-loop' as const,
      provider_name: 'Test Provider',
      existing_assignment_id: null,
    })),
  } as SolutionPlan;
}

describe('prior calls', () => {
  it('are EXCLUDED when includePrior is false and INCLUDED when true', () => {
    const ctx = buildFixtureContext();
    const pid = ctx.providers[0].id;
    ctx.seedAssignments = [{
      slot_date: '2026-01-02', provider_id: pid,
      shift_type_code: 'C1', shift_type_category: 'call', derived_day_type: 'weekday',
    }];
    const plan = planOf(ctx, []);

    expect(callCounts(plan, ctx, false).get(pid)).toBe(0);
    expect(callCounts(plan, ctx, true).get(pid)).toBe(1);
  });

  it('does not double-count a seed that already occupies an open slot', () => {
    // A seed WITH an open slot is carried into the plan as an assignment.
    // Counting it again as a "prior" would inflate that provider's burden and
    // silently skew every fairness number that follows.
    const ctx = buildFixtureContext();
    const pid = ctx.providers[0].id;
    const openCall = ctx.slotsToFill.find(s => s.shift_type_category === 'call');
    expect(openCall, 'fixture has no open call slot').toBeTruthy();

    ctx.seedAssignments = [{
      slot_date: openCall!.slot_date, provider_id: pid, slot_id: openCall!.slot_id,
      shift_type_code: openCall!.shift_type_code, shift_type_category: 'call',
      derived_day_type: openCall!.derived_day_type,
    }];
    const plan = planOf(ctx, [[pid, openCall!.slot_id]]);

    expect(callCounts(plan, ctx, true).get(pid)).toBe(1);
  });

  it('ignores non-call seeds', () => {
    const ctx = buildFixtureContext();
    const pid = ctx.providers[0].id;
    ctx.seedAssignments = [{
      slot_date: '2026-01-02', provider_id: pid,
      shift_type_code: 'D1', shift_type_category: 'regular', derived_day_type: 'weekday',
    }];
    expect(callCounts(planOf(ctx, []), ctx, true).get(pid)).toBe(0);
  });
});

describe('callsPerFteStdev', () => {
  it('is zero when every provider carries the same calls-per-FTE', () => {
    const ctx = buildFixtureContext();
    // One call each for two equal-FTE providers => identical ratios.
    const equal = ctx.providers.filter(p => p.fte_value > 0);
    const a = equal[0];
    const b = equal.find(p => p.fte_value === a.fte_value && p.id !== a.id);
    if (!b) return;                       // fixture has no equal-FTE pair
    ctx.providers = [a, b];
    ctx.seedAssignments = [a, b].map(p => ({
      slot_date: '2026-01-02', provider_id: p.id,
      shift_type_code: 'C1', shift_type_category: 'call', derived_day_type: 'weekday',
    }));
    expect(callsPerFteStdev(planOf(ctx, []), ctx, true)).toBeCloseTo(0, 9);
  });

  it('scales by FTE, not by raw count', () => {
    // 2 calls at 1.0 FTE and 1 call at 0.5 FTE are the SAME burden.
    const ctx = buildFixtureContext();
    const full = ctx.providers.find(p => p.fte_value > 0)!;
    ctx.providers = [
      { ...full, id: 'full', fte_value: 1 },
      { ...full, id: 'half', fte_value: 0.5 },
    ];
    ctx.seedAssignments = [
      { slot_date: '2026-01-02', provider_id: 'full', shift_type_code: 'C1', shift_type_category: 'call', derived_day_type: 'weekday' },
      { slot_date: '2026-01-03', provider_id: 'full', shift_type_code: 'C1', shift_type_category: 'call', derived_day_type: 'weekday' },
      { slot_date: '2026-01-04', provider_id: 'half', shift_type_code: 'C1', shift_type_category: 'call', derived_day_type: 'weekday' },
    ];
    expect(callsPerFteStdev(planOf(ctx, []), ctx, true)).toBeCloseTo(0, 9);
  });

  it('excludes zero-FTE providers rather than dividing by zero', () => {
    const ctx = buildFixtureContext();
    const p = ctx.providers[0];
    ctx.providers = [{ ...p, id: 'zero', fte_value: 0 }, { ...p, id: 'one', fte_value: 1 }];
    ctx.seedAssignments = [];
    expect(Number.isFinite(callsPerFteStdev(planOf(ctx, []), ctx, true))).toBe(true);
    expect(callCounts(planOf(ctx, []), ctx, true).has('zero')).toBe(false);
  });
});

describe('obligationCoverage', () => {
  it('counts a provider at exactly their obligation as MET', () => {
    const ctx = buildFixtureContext();
    const cov = obligationCoverage(planOf(ctx, []), ctx);
    expect(cov.met + cov.short).toBe(cov.total);
    expect(cov.total).toBe(ctx.providers.filter(p => p.fte_value > 0).length);
  });

  it('reports the per-provider shortfall for exactly the short providers', () => {
    const ctx = buildFixtureContext();
    const cov = obligationCoverage(planOf(ctx, []), ctx);
    expect(cov.shortfallByPid.size).toBe(cov.short);
    for (const n of cov.shortfallByPid.values()) expect(n).toBeGreaterThan(0);
  });
});

describe('callsPlaced', () => {
  it('counts plan calls only, so it stays comparable to a solver filled count', () => {
    const ctx = buildFixtureContext();
    ctx.seedAssignments = [{
      slot_date: '2026-01-02', provider_id: ctx.providers[0].id,
      shift_type_code: 'C1', shift_type_category: 'call', derived_day_type: 'weekday',
    }];
    expect(callsPlaced(planOf(ctx, []))).toBe(0);
  });
});
