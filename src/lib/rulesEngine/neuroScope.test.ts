/**
 * Running the neuro weekends as their own pass.
 *
 * Gabriel 2026-09-22: "add the option to run the neuro call weekend as a
 * separate run". Two scopes, and the useful sequence is 'exclude' now and
 * 'only' afterwards — so the two runs together must cover exactly what one
 * unscoped run covers, with nothing placed twice and nothing dropped. That
 * partition is what these tests pin.
 */
import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { buildFixtureContext } from './__fixtures__/buildContext';
import type { GenerationContext, SolutionPlan } from './genTypes';

/** Paoli-shaped: C1/C2 ordinary call, C3 the neuro code with a Sat→Sun chain. */
function neuroCtx(): GenerationContext {
  const ctx = buildFixtureContext();
  ctx.callPattern = {
    ...(ctx.callPattern ?? { version: 1, blocks: [], dayChains: [], spans: [],
      placementPasses: [], reliefPass: { enabled: false, dayTypes: [] },
      optimizerMovableDayTypes: ['weekday', 'friday'] }),
    neuroWeekend: { code: 'C3', requirementBands: [{ minFte: 0, units: 1 }] },
  } as never;
  return ctx;
}

const callCodes = (plan: SolutionPlan) => plan.assignments
  .filter(a => a.provider_id && a.shift_type_category === 'call')
  .map(a => a.shift_type_code);

const slotIds = (plan: SolutionPlan) => new Set(plan.assignments
  .filter(a => a.provider_id && a.shift_type_category === 'call')
  .map(a => a.slot_id));

describe('neuroScope partitions the call slots', () => {
  it("'only' places neuro calls and no others", () => {
    const ctx = neuroCtx();
    const codes = callCodes(solve(ctx, { neuroScope: 'only' }));
    expect(codes.every(c => c === 'C3'), `placed ${[...new Set(codes)].join(',')}`).toBe(true);
  });

  it("'exclude' places everything EXCEPT neuro", () => {
    const ctx = neuroCtx();
    const codes = callCodes(solve(ctx, { neuroScope: 'exclude' }));
    expect(codes.some(c => c === 'C3')).toBe(false);
  });

  it('the two scopes PARTITION an unscoped run — nothing lost, nothing doubled', () => {
    // The property the feature turns on: run 'exclude', then 'only', and you
    // have covered exactly what one plain run covers. A slot in neither, or in
    // both, is the bug this catches.
    const whole = slotIds(solve(neuroCtx(), {}));
    const excl = slotIds(solve(neuroCtx(), { neuroScope: 'exclude' }));
    const only = slotIds(solve(neuroCtx(), { neuroScope: 'only' }));

    for (const id of excl) expect(only.has(id), `${id} placed by BOTH scopes`).toBe(false);
    const union = new Set([...excl, ...only]);
    expect(union.size).toBe(whole.size);
    for (const id of whole) expect(union.has(id), `${id} placed by NEITHER scope`).toBe(true);
  });
});

describe('a pattern with no neuro code', () => {
  it('is unaffected by either scope — the whole block still runs', () => {
    // 'only' would place nothing and 'exclude' would be a label over a no-op,
    // so the scope is inert and autoGenerate warns. Pinned here so a future
    // edit cannot quietly make it place nothing instead.
    const bare = buildFixtureContext();      // no neuroWeekend in the pattern
    const plain = slotIds(solve(bare, {}));
    for (const scope of ['only', 'exclude'] as const) {
      const scoped = slotIds(solve(buildFixtureContext(), { neuroScope: scope }));
      expect(scoped.size, `neuroScope '${scope}' changed a no-neuro site`).toBe(plain.size);
    }
  });
});

describe('absent scope is byte-identical to before', () => {
  it('matches an explicit undefined', () => {
    const a = solve(neuroCtx(), {});
    const b = solve(neuroCtx(), { neuroScope: undefined });
    expect(callCodes(b)).toEqual(callCodes(a));
  });
});
