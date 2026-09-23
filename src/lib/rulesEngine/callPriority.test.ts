/**
 * Candidate ordering: burden-first vs spacing-first.
 *
 * Gabriel 2026-09-23: "I want longest gap first to outrank lifetime fairness
 * ratio and neuro shortfall" AND "burden should always outrank spacing". Those
 * apply to different layers — the first to PLACEMENT (who do we try first),
 * the second to the OBJECTIVE (is this schedule better). These tests pin that
 * separation, because collapsing the two is the easy mistake: the objective
 * lives in optimize's compareMetrics and must stay burden-first no matter what
 * the placement heuristic is set to.
 */
import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { compareMetrics } from './optimize';
import { buildFixtureContext } from './__fixtures__/buildContext';
import type { CallPriority, SolutionMetrics } from './genTypes';

const callPlacements = (p: ReturnType<typeof solve>) => p.assignments
  .filter(a => a.provider_id && a.shift_type_category === 'call')
  .map(a => `${a.slot_date}|${a.shift_type_code}|${a.provider_id}`);

describe("'fairness-first' is the untouched default", () => {
  it('absent and explicit produce the identical plan', () => {
    const absent = solve(buildFixtureContext(), {});
    const explicit = solve(buildFixtureContext(), { callPriority: 'fairness-first' });
    expect(callPlacements(explicit)).toEqual(callPlacements(absent));
  });
});

describe('every mode is deterministic', () => {
  for (const mode of ['fairness-first', 'spacing-first', 'balanced'] as CallPriority[]) {
    it(`'${mode}' gives the same plan twice on an identical context`, () => {
      // No Math.random anywhere in the engine — a plan must be reproducible
      // from the same DB state, which is what makes a reported bug findable.
      const a = solve(buildFixtureContext(), { callPriority: mode });
      const b = solve(buildFixtureContext(), { callPriority: mode });
      expect(callPlacements(a)).toEqual(callPlacements(b));
    });
  }
});

describe('every mode still produces a legal plan', () => {
  for (const mode of ['spacing-first', 'balanced'] as CallPriority[]) {
    it(`'${mode}' accounts for every open call slot`, () => {
      // Reordering candidates may legitimately change WHICH slots end up
      // reported unfilled — a different chain fires, so a different link falls
      // through to the main loop. What it must never do is lose one silently.
      // So the invariant is per-mode, not a comparison between modes: every
      // open call slot is either assigned or reported.
      const ctx = buildFixtureContext();
      const plan = solve(ctx, { callPriority: mode });
      const seen = new Set([
        ...plan.assignments.filter(a => a.provider_id).map(a => a.slot_id),
        ...plan.unfilled.map(u => u.slot_id),
      ]);
      for (const s of ctx.slotsToFill) {
        if (s.shift_type_category !== 'call') continue;
        expect(seen.has(s.slot_id), `call slot ${s.slot_id} neither filled nor reported`).toBe(true);
      }
    });
  }
});

describe('the OBJECTIVE stays burden-first regardless of placement order', () => {
  // The guarantee behind "burden should always outrank spacing": whatever the
  // placement heuristic does, a plan with better fairness beats one with worse
  // fairness and better burnout. compareMetrics is skipped → fairness →
  // burnout, and nothing about callPriority may reach it.
  const m = (skipped: number, fairnessStdev: number, burnout: number): SolutionMetrics =>
    ({ skipped, fairnessStdev, burnout } as SolutionMetrics);

  it('fairness beats burnout', () => {
    expect(compareMetrics(m(0, 0.30, 99), m(0, 0.90, 0))).toBeLessThan(0);
  });

  it('coverage beats both', () => {
    expect(compareMetrics(m(0, 9.0, 99), m(1, 0.0, 0))).toBeLessThan(0);
  });

  it('burnout only breaks a tie on coverage AND fairness', () => {
    expect(compareMetrics(m(0, 0.5, 1), m(0, 0.5, 4))).toBeLessThan(0);
  });
});
