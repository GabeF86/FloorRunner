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

// Enumerated intentional fixes: IF-1 (seed post-call block), IF-2 (relief
// reachability/rescan + overlay seed budget), IF-3 (quota relaxation), and
// IF-4 (skippedDerived recording) are behavior pins in patternEngine.test.ts.
// IF-5 (pending PTO drives the pre-PTO Thursday placement, spec §6.7) is the
// only fix that DIVERGES from legacy on same-input fixtures — it is pinned at
// the bottom of this file. The base parity fixtures contain no pending PTO,
// so the exact-equality nets below are unaffected by it.
//
// Drop fields the pattern-interpreter refactor is allowed to add/change. Only
// `explanation` (numeric decision detail), the additive `skippedDerived[]`
// (IF-4), and the additive `UnfilledSlot.shift_type_category` stamp (frozen
// legacy never sets it) are stripped here; assignment identity (slot,
// provider, source) and the rest of the unfilled list must match legacy exactly.
const stripAdditive = (plan: SolutionPlan) => ({
  assignments: plan.assignments.map(a => ({ ...a, explanation: undefined })),
  unfilled: plan.unfilled.map(u => ({ ...u, shift_type_category: undefined })),
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

// ── IF-5: pending PTO drives the pre-PTO Thursday placement (spec §6.7) ─────
// solve() builds the pre-PTO index with isBlockingAvailability (pending blocks
// everywhere ⇒ pending also EARNS the Thursday call); frozen solveLegacy only
// honors approval_status === 'approved' in its inline predicate. This test
// pins the divergence as deliberate — a pending-PTO fixture where solve()
// makes the pre-PTO placement and solveLegacy does not.
describe('golden parity — IF-5 pending-PTO pre-PTO placement divergence (spec §6.7)', () => {
  // p2 has PENDING pto over the week of Mon 2026-01-12; Thursday before = 01-08.
  const pendingCtx = () => buildCtx(
    [callSlot('thuC1', '2026-01-08', 'C1', 'weekday')],
    [prov('p1'), prov('p2')],
    {
      availByPid: new Map([['p2', [{
        availability_type: 'pto', start_date: '2026-01-13', end_date: '2026-01-15',
        approval_status: 'pending',
      }]]]),
    },
  );

  it('v2 gives the pending-PTO provider the prior Thursday via the pre-PTO pass', () => {
    const thu = solve(pendingCtx()).assignments.find(a => a.slot_id === 'thuC1');
    expect(thu?.provider_id).toBe('p2');
    expect(thu?.source).toBe('pre-pto-thursday');
  });

  it('legacy does NOT run the pre-PTO pass for a pending request (frozen behavior)', () => {
    const thu = solveLegacy(pendingCtx()).assignments.find(a => a.slot_id === 'thuC1');
    expect(thu?.source).not.toBe('pre-pto-thursday');
  });
});
