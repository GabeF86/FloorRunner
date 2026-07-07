import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { solveLegacy } from './solveLegacy';
import { buildFixtureContext } from './__fixtures__/buildContext';
import type { SolutionPlan } from './genTypes';

// The deterministic 4-week fixture builder lives in __fixtures__/buildContext.ts
// (shared with patternEngine.test.ts). It builds a 4-week block at par level 4
// with C1/C2/C3 call slots, D1-D3 derived slots, D4-D6 relief slots, 10 mixed-FTE
// providers, PTO/cross-site/weekday-limited providers — mirroring production
// shape so the parity net exercises the real code paths. Measured at par level 4:
// 181 assignments, 17 weekend-chain, 1 unfilled.

// Drop fields the pattern-interpreter refactor is allowed to add/change. Only
// `explanation` (numeric decision detail) and the additive `skippedDerived[]`
// (IF-4) are stripped here; assignment identity (slot, provider, source) and the
// unfilled list must match legacy exactly.
const stripAdditive = (plan: SolutionPlan) => ({
  assignments: plan.assignments.map(a => ({ ...a, explanation: undefined })),
  unfilled: plan.unfilled,
});

describe('golden parity: v2 engine + classic pattern ≡ legacy engine', () => {
  it('produces identical assignments and unfilled on the base fixture', () => {
    const ctx = buildFixtureContext();
    const legacy = solveLegacy(ctx);
    const v2 = solve(ctx); // classic behavior is the default (no ctx.callPattern yet)
    expect(stripAdditive(v2)).toEqual(stripAdditive(legacy));
  });

  it('parity holds with PTO, cross-site, and weekday-limited providers', () => {
    const ctx = buildFixtureContext(); // builder already includes p04/p05/p06
    expect(stripAdditive(solve(ctx))).toEqual(stripAdditive(solveLegacy(ctx)));
  });

  it('parity holds under callOverrides (optimizer forcing seam)', () => {
    const ctx = buildFixtureContext();
    const anyCallSlot = ctx.slotsToFill[0];
    const overrides = new Map([[anyCallSlot.slot_id, ctx.providers[3].id]]);
    expect(stripAdditive(solve(ctx, { callOverrides: overrides })))
      .toEqual(stripAdditive(solveLegacy(ctx, { callOverrides: overrides })));
  });
});

// A parity harness on an empty plan proves nothing: assert the fixture actually
// drives assignments AND exercises the weekend-chain path specifically.
describe('golden parity fixture — sanity (not a no-op)', () => {
  it('produces assignments, including weekend-chain-sourced ones', () => {
    const plan = solve(buildFixtureContext());
    const weekendChain = plan.assignments.filter(a => a.source === 'weekend-chain');
    expect(plan.assignments.length).toBeGreaterThan(0);
    expect(weekendChain.length).toBeGreaterThan(0);
  });
});
