// Stated block targets replace the FTE obligation ceiling.
//
// Gabriel 2026-08, verbatim: "I would like the ability to enter the block
// targets for that provider and have the engine fill those even if its above
// obligation, but if not entered, the engine should just fill to the
// obligation."
//
// THE TRAP THIS CLOSES. Obligatory mode caps every provider at their rounded
// FTE share (obligation.ts → capRoom). Scenario/block targets are a SECOND,
// finer ceiling (providerCaps.buildScenarioCallCaps, per bucket key, binding in
// every fill mode). With both live the LOWER one won, so a stated number above
// a provider's FTE share was silently unreachable — you could type 6 and get 4.
//
// Exempting a target-stated provider from the obligation ceiling is exact, not
// a loosening: blockTargets writes an absolute number for EVERY BUCKET_KEYS
// entry of a written provider (typed or derived), so their per-key caps already
// bound their total. There is no uncapped key to leak through.
import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { computeObligations } from './obligation';
import { buildCtx, prov, callSlot } from './__fixtures__/buildContext';
import { sp, scen } from './__fixtures__/scenarioFixtures';
import type { GenerationContext } from './genTypes';

// 8 M–Th C1 slots at par 8 ⇒ a 1.0 FTE owes exactly 1. Small numbers so the
// difference between "obligation" and "stated target" is unmistakable.
//
// NON-CONSECUTIVE dates, deliberately (Mon + Wed over four weeks). C1 blocks
// the next day (classic pattern post-call), so consecutive dates cap one
// provider at every OTHER slot and the fixture would measure post-call rest
// rather than the ceiling under test — which is exactly how the first draft of
// this file read 4 where it meant 5. A target the calendar cannot physically
// support is a real outcome, just not the one these cases are about.
const DATES = ['2026-08-10', '2026-08-12', '2026-08-17', '2026-08-19',
               '2026-08-24', '2026-08-26', '2026-08-31', '2026-09-02'];

function ctxWith(scenario: GenerationContext['scenario'] | null, fte = 1): GenerationContext {
  return buildCtx(
    DATES.map((d, i) => callSlot(`c1-${i}`, d, 'C1')),
    [prov('p1', fte)],
    { parLevel: 8, scenario: scenario ?? undefined },
  );
}

const placed = (ctx: GenerationContext) =>
  solve(ctx, { fillMode: 'obligatory' }).assignments
    .filter(a => a.shift_type_category === 'call').length;

describe('stated targets replace the obligation ceiling', () => {
  it('WITHOUT targets, obligatory mode stops at the FTE obligation', () => {
    const ctx = ctxWith(null);
    expect(computeObligations(ctx).get('p1')).toBe(1);   // 8 slots ÷ par 8 × 1.0
    expect(placed(ctx)).toBe(1);
  });

  it('WITH a stated target ABOVE the obligation, the engine fills the target', () => {
    // Obligation is 1; he typed 5. Before this change the 1 won.
    const ctx = ctxWith(scen([sp('p1', { targets: new Map([['MTH|C1', 5]]) })]));
    expect(computeObligations(ctx).get('p1')).toBe(Infinity);
    expect(placed(ctx)).toBe(5);
  });

  it('the stated target is still a CEILING — it does not become unlimited', () => {
    // Eight slots are open and only p1 can take them; the per-key cap is what
    // stops at 3. Exempting the obligation must not exempt the target.
    const ctx = ctxWith(scen([sp('p1', { targets: new Map([['MTH|C1', 3]]) })]));
    expect(placed(ctx)).toBe(3);
  });

  it('a stated target BELOW the obligation still binds', () => {
    // 8 slots at par 2 ⇒ a 1.0 FTE owes 4, but he typed 2.
    const ctx = buildCtx(
      DATES.map((d, i) => callSlot(`c1-${i}`, d, 'C1')),
      [prov('p1', 1)],
      { parLevel: 2, scenario: scen([sp('p1', { targets: new Map([['MTH|C1', 2]]) })]) },
    );
    expect(placed(ctx)).toBe(2);
  });

  it('exempts only the STATED provider — everyone else keeps their obligation', () => {
    const ctx = buildCtx(
      DATES.map((d, i) => callSlot(`c1-${i}`, d, 'C1')),
      [prov('p1', 1), prov('p2', 1)],
      { parLevel: 8, scenario: scen([sp('p1', { targets: new Map([['MTH|C1', 4]]) })]) },
    );
    const obligations = computeObligations(ctx);
    expect(obligations.get('p1')).toBe(Infinity);
    expect(obligations.get('p2')).toBe(1);
  });

  it('a neuro-only target also exempts — the manifest states SOMETHING for them', () => {
    // NEURO_FSS is a weekend-UNIT target with its own cap key, so a provider
    // whose only stated number is neuro is still fully capped.
    const ctx = ctxWith(scen([sp('p1', { neuroTarget: 1 })]));
    expect(computeObligations(ctx).get('p1')).toBe(Infinity);
  });

  it('a scenario that names the provider but states NOTHING keeps the obligation', () => {
    // The panel writes only providers with something stated, but a manifest
    // carrying an empty provider must not silently uncap them.
    const ctx = ctxWith(scen([sp('p1')]));
    expect(computeObligations(ctx).get('p1')).toBe(1);
    expect(placed(ctx)).toBe(1);
  });

  it('no scenario at all is byte-identical to before — every obligation finite', () => {
    const obligations = computeObligations(ctxWith(null, 0.5));
    for (const v of obligations.values()) expect(Number.isFinite(v)).toBe(true);
  });
});
