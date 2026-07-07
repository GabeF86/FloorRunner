import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { solveLegacy } from './solveLegacy';
import { buildFixtureContext, buildCtx, prov, callSlot, dSlot } from './__fixtures__/buildContext';
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

// Legacy chainDFills treated holidays like weekdays (D-fills + next-day
// post-call block); CLASSIC_PATTERN must preserve that or holiday calls lose
// their post-call day off (clinical invariant #1). Regression for the
// Task 5 review finding.
describe('golden parity — holiday call slots', () => {
  const holidayCtx = () => {
    // Mon 2026-01-19 typed as federal_holiday, flanked by Sun 01-18 and a
    // normal Tue 01-20. Generous quotas (buildCtx default 99).
    const slots = [
      callSlot('h-c1', '2026-01-19', 'C1', 'federal_holiday'),
      callSlot('h-c2', '2026-01-19', 'C2', 'federal_holiday'),
      callSlot('t-c1', '2026-01-20', 'C1', 'weekday'),
      dSlot('s-d2', '2026-01-18', 'D2', 'sunday'),
      dSlot('s-d3', '2026-01-18', 'D3', 'sunday'),
      dSlot('t-d1', '2026-01-20', 'D1', 'weekday'),
    ];
    return buildCtx(slots, [prov('pa'), prov('pb'), prov('pc')]);
  };

  it('v2 matches legacy exactly on a holiday block', () => {
    expect(stripAdditive(solve(holidayCtx()))).toEqual(stripAdditive(solveLegacy(holidayCtx())));
  });

  it('holiday C1 gets day-before D2 fill and next-day post-call block (both engines)', () => {
    for (const engine of [solve, solveLegacy]) {
      const plan = engine(holidayCtx());
      const holidayC1 = plan.assignments.find(a => a.slot_id === 'h-c1')!;
      expect(holidayC1).toBeDefined();
      // D-fill the day before (legacy chainDFills holiday branch)
      const d2 = plan.assignments.find(a => a.slot_id === 's-d2');
      expect(d2?.provider_id).toBe(holidayC1.provider_id);
      // post-call block: the holiday C1 provider must NOT hold the Tuesday C1
      const tueC1 = plan.assignments.find(a => a.slot_id === 't-c1');
      expect(tueC1?.provider_id).not.toBe(holidayC1.provider_id);
    }
  });
});
