// Scenario layer in the ENGINE (Paoli phase 2): per-(bucket,code) hard
// ceilings via the generalized providerCaps machinery, prohibition gates,
// hard linkage gates, either-or group caps, NEURO pair-unit counting,
// preference soft tier, target-ratio steering, and tie-break-seed
// determinism. All fixtures are pure GenerationContexts — no DB.
import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { evaluateEligibility } from './eligibility';
import { emptySolveState, addCallDate } from './solveState';
import { buildCtx, prov, callSlot } from './__fixtures__/buildContext';
import { sp, scen } from './__fixtures__/scenarioFixtures';
import type { GenerationContext } from './genTypes';

const T = (pairs: Array<[string, number]>) => new Map(pairs);

// 2026-08 block: Mon 08-10, Tue 08-11, Wed 08-12, Fri 08-14, Sat 08-15,
// Sun 08-16; next weekend Sat 08-22 / Sun 08-23.

describe('scenario per-(bucket,code) hard ceilings', () => {
  it('caps a provider at ceil(target) for a dow bucket — even under quota relaxation', () => {
    // Only p1 can take call; MTH|C1 target 1 with two weekday C1 slots (a day
    // apart so the post-call block isn't the binding gate): the second stays
    // OPEN with 'provider-cap' — a stated maximum, never relax-filled past it.
    const slots = [
      callSlot('mon', '2026-08-10', 'C1', 'weekday'),
      callSlot('wed', '2026-08-12', 'C1', 'weekday'),
    ];
    const ctx = buildCtx(slots, [prov('p1')], {
      scenario: scen([sp('p1', { targets: T([['MTH|C1', 1]]) })]),
    });
    const plan = solve(ctx);
    expect(plan.assignments).toHaveLength(1);
    expect(plan.unfilled).toHaveLength(1);
    expect(plan.unfilled[0].reason).toBe('provider-cap');
  });

  it('a stated ZERO target is a hard exclusion for that (bucket,code)', () => {
    const slots = [callSlot('fri', '2026-08-14', 'C2', 'friday')];
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      scenario: scen([sp('p1', { targets: T([['FRI|C2', 0]]) })]),
    });
    const plan = solve(ctx);
    expect(plan.assignments[0].provider_id).toBe('p2'); // p1 capped out at 0
  });

  it('fractional 0.5 target: a whole call fits under ceil (1); a seeded 0.5 split segment consumes half, so a further whole call is refused', () => {
    const mkCtx = (seeded: boolean): GenerationContext => buildCtx(
      [callSlot('sat2', '2026-08-22', 'C1', 'saturday')],
      [prov('p1'), prov('p2')],
      {
        scenario: scen([
          sp('p1', { targets: T([['SAT|C1', 0.5], ['SUN|C2', 9], ['FRI|C2', 9]]) }),
          // p2 exists so the capped slot has a fallback taker.
        ]),
        shiftTypes: new Map([
          ['C1N12', { code: 'C1N12', category: 'call', call_rank: 0, relief_rank: null,
            is_overlay: false, generation_engine: 'call' as const, requires_post_call_rule: true,
            call_coverage_type: null, manual_only: true, call_burden_weight: 0.5, parent_call_code: 'C1' }],
        ]),
        seedAssignments: seeded ? [{
          slot_date: '2026-08-15', provider_id: 'p1', shift_type_code: 'C1N12',
          shift_type_category: 'call', derived_day_type: 'saturday',
        }] : [],
      },
    );
    // No seed: p1's 0.5 target admits ONE whole Sat C1 (ceil(0.5) = 1) and p1
    // wins on the target-ratio steering (p2 has no stated targets).
    const clean = solve(mkCtx(false));
    expect(clean.assignments.find(a => a.slot_id === 'sat2')!.provider_id).toBe('p1');
    // Seeded 0.5 segment: usage 0.5 + a whole 1.0 = 1.5 > ceil(0.5) = 1 → p1
    // refused; p2 takes it. The seeded segment counted toward the target at
    // its fractional weight (the split machinery, pinned here for scenarios).
    const seeded = solve(mkCtx(true));
    expect(seeded.assignments.find(a => a.slot_id === 'sat2')!.provider_id).toBe('p2');
  });

  it('whole-block admission counts chain links per (bucket,code): an anchor is refused when a LINK bucket is capped', () => {
    // Classic pattern: Sat C1 anchor chains Sun C2 (+1) and Fri C2 (−1).
    // p1 has Sat C1 room but SUN|C2 stated 0 → the whole weekend block must
    // not be admitted to p1; p2 takes the anchor and the designed pairing.
    const slots = [
      callSlot('sat', '2026-08-15', 'C1', 'saturday'),
      callSlot('sun', '2026-08-16', 'C2', 'sunday'),
      callSlot('fri', '2026-08-14', 'C2', 'friday'),
    ];
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      scenario: scen([sp('p1', { targets: T([['SAT|C1', 1], ['SUN|C2', 0], ['FRI|C2', 1]]) })]),
    });
    const plan = solve(ctx);
    const sat = plan.assignments.find(a => a.slot_id === 'sat')!;
    const sun = plan.assignments.find(a => a.slot_id === 'sun')!;
    expect(sat.provider_id).toBe('p2');
    expect(sun.provider_id).toBe('p2');
  });
});

describe('scenario NEURO pair-unit counting', () => {
  it('a Sat-anchored C3 chain (Sat+Sun) counts ONE unit toward the NEURO target; a second weekend is refused', () => {
    // Classic pattern chains Sat C3 → Sun C3. neuroTarget 1: weekend 1 is one
    // unit; the second weekend's Sat C3 must NOT go to p1 (unit cap) — p2
    // takes it even though p1 "only" holds 2 C3 days.
    const slots = [
      callSlot('sat1c3', '2026-08-15', 'C3', 'saturday'),
      callSlot('sun1c3', '2026-08-16', 'C3', 'sunday'),
      callSlot('sat2c3', '2026-08-22', 'C3', 'saturday'),
      callSlot('sun2c3', '2026-08-23', 'C3', 'sunday'),
    ];
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      scenario: scen([
        sp('p1', { neuroTarget: 1 }),
        sp('p2', { neuroTarget: 1 }),
      ]),
    });
    const plan = solve(ctx);
    const holder = (id: string) => plan.assignments.find(a => a.slot_id === id)!.provider_id;
    // Weekend 1 pair lands on one provider (chain), weekend 2 on the OTHER.
    expect(holder('sat1c3')).toBe(holder('sun1c3'));
    expect(holder('sat2c3')).toBe(holder('sun2c3'));
    expect(holder('sat1c3')).not.toBe(holder('sat2c3'));
  });
});

describe('scenario prohibitions', () => {
  const mondayC1 = callSlot('mon', '2026-08-10', 'C1', 'weekday');

  it('date-specific per-code prohibition gates exactly that (date, code)', () => {
    const scenario = scen([sp('p1', {
      prohibitedDatesByCode: new Map([['C1', new Set(['2026-08-10'])]]),
    })]);
    const ctx = buildCtx([mondayC1], [prov('p1')], { scenario });
    const state = emptySolveState();
    expect(evaluateEligibility(mondayC1, ctx.providers[0], state, ctx, 'call').reason)
      .toBe('scenario-prohibited');
    // The same date, different code, is untouched.
    const monC2 = callSlot('monc2', '2026-08-10', 'C2', 'weekday');
    const ctx2 = buildCtx([monC2], [prov('p1')], { scenario });
    expect(evaluateEligibility(monC2, ctx2.providers[0], emptySolveState(), ctx2, 'call').eligible).toBe(true);
  });

  it('a general no-call date prohibits all call codes, and binds on EVERY gate set (chains, relaxation, pins)', () => {
    const scenario = scen([sp('p1', { prohibitedAllDates: new Set(['2026-08-10']) })]);
    const ctx = buildCtx([mondayC1], [prov('p1')], { scenario });
    const state = emptySolveState();
    for (const gate of ['call', 'call-no-quota', 'derived'] as const) {
      expect(evaluateEligibility(mondayC1, ctx.providers[0], state, ctx, gate).reason)
        .toBe('scenario-prohibited');
    }
    // Sole-provider solve: the slot stays open — relaxation never overrides.
    const plan = solve(ctx);
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unfilled[0].candidates?.[0].reason).toBe('scenario-prohibited');
  });

  it('Kalawadia recurring Monday-C1: every Monday C1 is gated, Tuesday is untouched', () => {
    const scenario = scen([sp('p1', {
      prohibitedDowsByCode: new Map([['C1', new Set([1])]]), // 1 = Monday
    })]);
    const slots = [
      callSlot('mon', '2026-08-10', 'C1', 'weekday'),
      callSlot('mon2', '2026-08-17', 'C1', 'weekday'),
      callSlot('tue', '2026-08-11', 'C1', 'weekday'),
    ];
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], { scenario });
    const plan = solve(ctx);
    const holder = (id: string) => plan.assignments.find(a => a.slot_id === id)!.provider_id;
    expect(holder('mon')).toBe('p2');
    expect(holder('mon2')).toBe('p2');
    expect(holder('tue')).toBe('p1'); // Tuesday legal (and p1 is behind on ratio)
  });

  it('a chain link never lands on a prohibited date: candidates with a prohibited link are steered away at the anchor', () => {
    // Classic Sat C1 anchor chains Sun C2. p1 prohibited on the Sunday: the
    // anchor prefers chain-clean p2 so the designed pairing survives.
    const slots = [
      callSlot('sat', '2026-08-15', 'C1', 'saturday'),
      callSlot('sun', '2026-08-16', 'C2', 'sunday'),
    ];
    const scenario = scen([sp('p1', { prohibitedAllDates: new Set(['2026-08-16']) })]);
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], { scenario });
    const plan = solve(ctx);
    expect(plan.assignments.find(a => a.slot_id === 'sat')!.provider_id).toBe('p2');
    expect(plan.assignments.find(a => a.slot_id === 'sun')!.provider_id).toBe('p2');
  });

  it('when ONLY prohibited-link candidates exist, the anchor still fills and the severed link is recorded', () => {
    const slots = [
      callSlot('sat', '2026-08-15', 'C1', 'saturday'),
      callSlot('sun', '2026-08-16', 'C2', 'sunday'),
    ];
    const scenario = scen([sp('p1', { prohibitedAllDates: new Set(['2026-08-16']) })]);
    const ctx = buildCtx(slots, [prov('p1')], { scenario });
    const plan = solve(ctx);
    expect(plan.assignments.find(a => a.slot_id === 'sat')!.provider_id).toBe('p1');
    // The Sun C2 link severed on the prohibition — recorded (invariant 4),
    // slot left to the main loop, where p1 is still prohibited → open.
    expect(plan.skippedDerived).toContainEqual(
      expect.objectContaining({ date: '2026-08-16', code: 'C2', provider_id: 'p1' }));
    expect(plan.assignments.find(a => a.slot_id === 'sun')).toBeUndefined();
  });
});

describe('scenario hard linkages', () => {
  it('same-weekend: placing a member in a different weekend than an already-realized member is refused', () => {
    // Simon rule: SAT:C1 + SUN:C2 same weekend. Sat C1 seeded on 08-15; a Sun
    // C2 slot on 08-23 (NEXT weekend) must refuse him; 08-16 is legal.
    const linkage = {
      kind: 'same-weekend' as const,
      members: [
        { dow: 6, date: null, code: 'C1' },
        { dow: 0, date: null, code: 'C2' },
      ],
      rawMembers: ['SAT:C1', 'SUN:C2'], source: 'test',
    };
    const scenario = scen([sp('p1', { linkages: [linkage] })]);
    const sunFar = callSlot('sun2', '2026-08-23', 'C2', 'sunday');
    const sunNear = callSlot('sun1', '2026-08-16', 'C2', 'sunday');
    const ctx = buildCtx([sunFar, sunNear], [prov('p1')], {
      scenario,
      seedAssignments: [{
        slot_date: '2026-08-15', provider_id: 'p1', shift_type_code: 'C1',
        shift_type_category: 'call', derived_day_type: 'saturday',
      }],
    });
    const state = emptySolveState();
    addCallDate(state, 'p1', '2026-08-15', 'C1');
    expect(evaluateEligibility(sunFar, ctx.providers[0], state, ctx, 'call').reason)
      .toBe('scenario-linkage');
    expect(evaluateEligibility(sunNear, ctx.providers[0], state, ctx, 'call').eligible).toBe(true);
  });

  it('either-or: one weekend-day call is admitted past zero bucket targets, a second is refused', () => {
    const eitherOr = {
      kind: 'either-or' as const,
      members: [
        { dow: 6, date: null, code: 'ANY' },
        { dow: 0, date: null, code: 'ANY' },
      ],
      rawMembers: ['SAT:ANY', 'SUN:ANY'], source: 'test',
    };
    const slots = [
      callSlot('sat1', '2026-08-15', 'C1', 'saturday'),
      callSlot('sat2', '2026-08-22', 'C1', 'saturday'),
    ];
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      scenario: scen([sp('p1', {
        targets: T([['SAT|C1', 0], ['SAT|C2', 0], ['SUN|C1', 0], ['SUN|C2', 0]]),
        linkages: [eitherOr],
      })]),
    });
    const plan = solve(ctx);
    const holders = ['sat1', 'sat2'].map(id => plan.assignments.find(a => a.slot_id === id)!.provider_id);
    // p1 may take exactly ONE of the two Saturdays (either-or group cap 1);
    // the other goes to p2.
    expect(holders.filter(h => h === 'p1')).toHaveLength(1);
    expect(holders.filter(h => h === 'p2')).toHaveLength(1);
  });
});

describe('scenario soft preference tier + steering', () => {
  it('a weekday preference wins the preferred slot among fairness-equal candidates and never gates', () => {
    const slots = [
      callSlot('tue', '2026-08-11', 'C1', 'weekday'),
      callSlot('wed', '2026-08-12', 'C1', 'weekday'),
    ];
    const pref = { kind: 'weekday' as const, weekday: 2, codes: ['C1'], members: [], source: 'Prefers Tuesday for C1' };
    const withPref = buildCtx(slots, [prov('pa'), prov('pb')], {
      scenario: scen([
        sp('pa', { targets: T([['MTH|C1', 2]]) }),
        sp('pb', { targets: T([['MTH|C1', 2]]), preferences: [pref] }),
      ]),
    });
    const plan = solve(withPref);
    expect(plan.assignments.find(a => a.slot_id === 'tue')!.provider_id).toBe('pb');
    expect(plan.assignments.find(a => a.slot_id === 'wed')!.provider_id).toBe('pa');
  });

  it('target-ratio steering: the greedy tracks stated targets (2 vs 1 over three weekday C1s)', () => {
    const slots = [
      callSlot('c1a', '2026-08-10', 'C1', 'weekday'),
      callSlot('c1b', '2026-08-12', 'C1', 'weekday'),
      callSlot('c1c', '2026-08-17', 'C1', 'weekday'),
    ];
    const ctx = buildCtx(slots, [prov('pa'), prov('pb')], {
      scenario: scen([
        sp('pa', { targets: T([['MTH|C1', 2]]) }),
        sp('pb', { targets: T([['MTH|C1', 1]]) }),
      ]),
    });
    const plan = solve(ctx);
    const byPid = new Map<string, number>();
    for (const a of plan.assignments) byPid.set(a.provider_id, (byPid.get(a.provider_id) || 0) + 1);
    expect(byPid.get('pa')).toBe(2);
    expect(byPid.get('pb')).toBe(1);
  });
});

describe('determinism + byte identity', () => {
  it('tieBreakSeed 0 (and absent) is byte-identical to a plain solve', () => {
    const slots = [
      callSlot('mon', '2026-08-10', 'C1', 'weekday'),
      callSlot('tue', '2026-08-11', 'C1', 'weekday'),
    ];
    const ctx = buildCtx(slots, [prov('p1'), prov('p2'), prov('p3')]);
    const base = JSON.stringify(solve(ctx));
    expect(JSON.stringify(solve(ctx, { tieBreakSeed: 0 }))).toBe(base);
    expect(JSON.stringify(solve(ctx, {}))).toBe(base);
  });

  it('the same nonzero seed twice produces identical JSON; the shuffle only permutes the FINAL id tiebreak', () => {
    const slots = [
      callSlot('mon', '2026-08-10', 'C1', 'weekday'),
      callSlot('tue', '2026-08-11', 'C1', 'weekday'),
      callSlot('wed', '2026-08-12', 'C1', 'weekday'),
    ];
    const ctx = buildCtx(slots, [prov('p1'), prov('p2'), prov('p3'), prov('p4')]);
    const s3a = JSON.stringify(solve(ctx, { tieBreakSeed: 3 }));
    const s3b = JSON.stringify(solve(ctx, { tieBreakSeed: 3 }));
    expect(s3a).toBe(s3b);
    // Different seeds are ALLOWED to differ (id-tie rotation) — and every
    // seed still fills every slot (clinical keys untouched).
    for (const seed of [1, 2, 3, 4, 5]) {
      const p = solve(ctx, { tieBreakSeed: seed });
      expect(p.assignments).toHaveLength(3);
      expect(p.unfilled).toHaveLength(0);
    }
  });
});
