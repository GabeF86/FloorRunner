/**
 * The three gates that make a solver solution safe to apply.
 *
 * The whole safety argument for handing schedule decisions to an external
 * solver is that a wrong answer cannot survive: staleness is rejected, solve()
 * still owns structure, and anything that does not beat the incumbent on the
 * engine's own objective is discarded. If these tests go green while the gates
 * are gone, the argument is gone with them — so each gate is pinned by the
 * failure it exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import { applyCpsatSolution } from './cpsatPolish';
import { buildCpsatModel } from './cpsatModel';
import { solve } from './solve';
import { extractCallAssignment } from './optimize';
import { buildFixtureContext } from './__fixtures__/buildContext';
import type { CpsatSolution } from './cpsatPolish';

function incumbent() {
  const ctx = buildFixtureContext();
  return { ctx, plan: solve(ctx, {}) };
}

/** The incumbent's own call assignment, echoed back as a solver result. */
function echoSolution(ctx: ReturnType<typeof buildFixtureContext>, plan: ReturnType<typeof solve>): CpsatSolution {
  return {
    status: 'OPTIMAL',
    assignment: Object.fromEntries(extractCallAssignment(plan)),
  };
}

describe('gate 0 — only a usable solver result is considered', () => {
  it('rejects a missing solution', () => {
    const { ctx, plan } = incumbent();
    const r = applyCpsatSolution(ctx, plan, null);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('no-solution');
    expect(r.plan).toBe(plan);
  });

  it('rejects INFEASIBLE / UNKNOWN rather than applying a partial answer', () => {
    const { ctx, plan } = incumbent();
    for (const status of ['INFEASIBLE', 'UNKNOWN', 'MODEL_INVALID']) {
      const r = applyCpsatSolution(ctx, plan, { status, assignment: {} });
      expect(r.accepted, status).toBe(false);
      expect(r.reason, status).toBe('solver-status');
    }
  });

  it('rejects an OPTIMAL result that carries no assignment', () => {
    // model.py returns early (no `assignment` key) when it proves the fill
    // phase but never reaches the fairness phase. That is not an answer.
    const { ctx, plan } = incumbent();
    const r = applyCpsatSolution(ctx, plan, { status: 'OPTIMAL', filled: 3 });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('no-assignment');
  });
});

describe('gate 1 — staleness is rejected, never silently dropped', () => {
  it('rejects a slot id this context does not have open', () => {
    const { ctx, plan } = incumbent();
    const sol = echoSolution(ctx, plan);
    const pid = ctx.providers[0].id;
    sol.assignment = { ...sol.assignment, 'slot-that-moved': pid };

    const r = applyCpsatSolution(ctx, plan, sol);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('stale-slots');
    expect(r.unknownSlots).toContain('slot-that-moved');
    // The incumbent is handed back untouched — not a partial application.
    expect(r.plan).toBe(plan);
  });

  it('rejects a provider id outside this context pool', () => {
    const { ctx, plan } = incumbent();
    const sol = echoSolution(ctx, plan);
    const anySlot = Object.keys(sol.assignment!)[0];
    expect(anySlot, 'fixture produced no call assignment').toBeTruthy();
    sol.assignment = { ...sol.assignment, [anySlot]: 'provider-who-left' };

    const r = applyCpsatSolution(ctx, plan, sol);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('stale-providers');
    expect(r.unknownProviders).toContain('provider-who-left');
  });
});

describe('gate 3 — the solution must beat the incumbent', () => {
  it('rejects the incumbent echoed back at itself', () => {
    // The identity case: re-solving from the incumbent's own assignment
    // cannot be an improvement, so it must be refused. This also guards the
    // relocation trap the fill-monotonicity gate hit — an equal plan is not
    // a better plan and must not be written.
    const { ctx, plan } = incumbent();
    const r = applyCpsatSolution(ctx, plan, echoSolution(ctx, plan));
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('not-better');
    expect(r.plan).toBe(plan);
    expect(r.trialMetrics).not.toBeNull();
  });

  it('always reports both sides of the comparison', () => {
    const { ctx, plan } = incumbent();
    const r = applyCpsatSolution(ctx, plan, echoSolution(ctx, plan));
    expect(r.incumbentMetrics).toBeDefined();
    expect(r.detail).toMatch(/spread/);
  });
});

describe('the model the solver is given', () => {
  it('offers no provider the engine would refuse', () => {
    // The domain IS the engine's verdict. If this ever drifts, the solver can
    // "win" by breaking a rule rather than by arranging better.
    const ctx = buildFixtureContext();
    const model = buildCpsatModel(ctx);
    const known = new Set(ctx.providers.map(p => p.id));
    for (const s of model.slots) {
      for (const pid of s.eligible) expect(known.has(pid), `${s.id} → ${pid}`).toBe(true);
    }
  });

  it('covers exactly the open call slots', () => {
    const ctx = buildFixtureContext();
    const model = buildCpsatModel(ctx);
    const open = ctx.slotsToFill
      .filter(s => s.shift_type_category === 'call').map(s => s.slot_id).sort();
    expect(model.slots.map(s => s.id).sort()).toEqual(open);
    expect(model.stats.callSlots).toBe(open.length);
  });

  it('reports slots with no candidate instead of hiding them', () => {
    const ctx = buildFixtureContext();
    const model = buildCpsatModel(ctx);
    const actual = model.slots.filter(s => s.eligible.length === 0 && !s.fixedTo).length;
    expect(model.stats.noCandidateSlots).toBe(actual);
  });

  it('is deterministic for an identical context', () => {
    expect(JSON.stringify(buildCpsatModel(buildFixtureContext())))
      .toEqual(JSON.stringify(buildCpsatModel(buildFixtureContext())));
  });
});
