import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { solve } from './solve';
import { computeRequestGrants } from './requestGrants';
import { buildFixtureContext, buildCtx, prov, callSlot } from './__fixtures__/buildContext';
import type { AvailabilityEntry, SolutionPlan } from './genTypes';

// ── No-call request soft avoidance (2026-07-17) ─────────────────────────────
// A non-dismissed no_call_request covering a call slot's date drops the
// candidate a SORT TIER in scoreCall — never a gate: a penalized candidate is
// still chosen when no unpenalized candidate passes the safety gates
// (Gabriel: "grant the request if possible" — explicitly SOFT). Denials are
// spread fairly: among penalized candidates the one with the FEWEST requests
// already violated in this run wins; existing scoring breaks ties. With zero
// request rows every tier is 0 and the plan is byte-identical to the
// pre-change engine (pinned below against fillAllPlan.golden.json).

const req = (start: string, end = start, approval_status = 'approved'): AvailabilityEntry => ({
  availability_type: 'no_call_request', start_date: start, end_date: end, approval_status,
});

const byId = (plan: SolutionPlan) => new Map(plan.assignments.map(a => [a.slot_id, a.provider_id]));

// ── penalty tier ────────────────────────────────────────────────────────────
describe('scoreCall penalty tier — requesters avoided when anyone else can take the slot', () => {
  const slots = [callSlot('mon', '2026-01-05', 'C1')];

  it('control: without a request, p1 wins on the id tiebreak', () => {
    const plan = solve(buildCtx(slots, [prov('p1'), prov('p2')]));
    expect(byId(plan).get('mon')).toBe('p1');
  });

  it('an active request on the slot date hands the slot to the non-requester', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p1', [req('2026-01-05')]]]),
    });
    const plan = solve(ctx);
    expect(byId(plan).get('mon')).toBe('p2');
    expect(plan.unfilled).toHaveLength(0);
  });

  it('a PENDING request penalizes (non-dismissed); denied/canceled do not', () => {
    const pending = solve(buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p1', [req('2026-01-05', '2026-01-05', 'pending')]]]),
    }));
    expect(byId(pending).get('mon')).toBe('p2');

    const denied = solve(buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p1', [req('2026-01-05', '2026-01-05', 'denied')]]]),
    }));
    expect(byId(denied).get('mon')).toBe('p1'); // dismissed — no penalty

    const canceled = solve(buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p1', [req('2026-01-05', '2026-01-05', 'canceled')]]]),
    }));
    expect(byId(canceled).get('mon')).toBe('p1');
  });

  it('a request on a DIFFERENT date does not penalize', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p1', [req('2026-01-06')]]]),
    });
    expect(byId(solve(ctx)).get('mon')).toBe('p1');
  });

  it('SOFT, never a gate: the requester is chosen when everyone else is hard-blocked', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([
        ['p1', [req('2026-01-05')]],
        ['p2', [{
          availability_type: 'pto', start_date: '2026-01-05', end_date: '2026-01-05',
          approval_status: 'approved',
        }]],
      ]),
    });
    const plan = solve(ctx);
    expect(byId(plan).get('mon')).toBe('p1'); // avoid but allow
    expect(plan.unfilled).toHaveLength(0);
    expect(plan.assignments.find(a => a.slot_id === 'mon')?.source).toBe('main-loop');
  });

  it('the penalty also orders the quota-relaxation sweep (shared tuple)', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      bucketTarget: new Map([['p1|weekday|C1', 0], ['p2|weekday|C1', 0]]),
      availByPid: new Map([['p1', [req('2026-01-05')]]]),
    });
    const plan = solve(ctx);
    const a = plan.assignments.find(x => x.slot_id === 'mon');
    expect(a?.source).toBe('quota-relaxed');
    expect(a?.provider_id).toBe('p2'); // p2 would lose the id tiebreak without the tier
  });
});

// ── fairness of denial ──────────────────────────────────────────────────────
describe('fair denial — among penalized candidates, fewest already-violated requests wins', () => {
  // Both providers request both dates, so BOTH slots must violate someone.
  // p2 carries heavy history (ratio 5 vs 0) — plain scoring would deny p1
  // twice. The violated-count comparison spreads the denials 1/1.
  const slots = [
    callSlot('mon', '2026-01-05', 'C1'),
    callSlot('wed', '2026-01-07', 'C1'),
  ];
  const both = new Map([
    ['p1', [req('2026-01-05', '2026-01-07')]],
    ['p2', [req('2026-01-05', '2026-01-07')]],
  ]);

  it('the second violation goes to the not-yet-violated requester', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: both,
      historicalAssignedByPid: new Map([['p2', new Map([['weekday|C1', 5]])]]),
    });
    const plan = solve(ctx);
    expect(byId(plan).get('mon')).toBe('p1'); // ratio 0 vs 5 — p1 eats the first denial
    expect(byId(plan).get('wed')).toBe('p2'); // p1 already violated once — p2 despite ratio
  });

  it('a seeded call on a requested date counts as an already-absorbed denial', () => {
    // p1 has a manual call seeded on their requested Mon — the fair-denial
    // counter starts at 1, so the open Wed slot goes to p2 even though p1
    // wins every other key.
    const ctx = buildCtx([callSlot('wed', '2026-01-07', 'C1')], [prov('p1'), prov('p2')], {
      availByPid: both,
      seedAssignments: [{
        slot_date: '2026-01-05', provider_id: 'p1',
        shift_type_code: 'C1', shift_type_category: 'call', derived_day_type: 'weekday',
      }],
      historicalAssignedByPid: new Map([['p2', new Map([['weekday|C1', 5]])]]),
    });
    expect(byId(solve(ctx)).get('wed')).toBe('p2');
  });
});

// ── obligatory-mode interaction ─────────────────────────────────────────────
describe('obligatory mode — penalty applies; violated placements consume the cap', () => {
  // 2 weekday C1 slots, ΣFTE 2, par clamps to 2 → obligation 1 each.
  const slots = [
    callSlot('mon', '2026-01-05', 'C1'),
    callSlot('wed', '2026-01-07', 'C1'),
  ];

  it("the penalty tier orders candidates in fillMode 'obligatory' too", () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p1', [req('2026-01-05')]]]),
    });
    const plan = solve(ctx, { fillMode: 'obligatory' });
    expect(byId(plan).get('mon')).toBe('p2'); // avoided (p1 would win the id tiebreak)
    expect(byId(plan).get('wed')).toBe('p1'); // p2 at cap
    expect(plan.unfilled).toHaveLength(0);
  });

  it('an unavoidable violation still counts toward the cap', () => {
    // p2 is on PTO Mon → p1 must violate their own request; that call
    // consumes p1's 1-call obligation, so Wed falls to p2.
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([
        ['p1', [req('2026-01-05')]],
        ['p2', [{
          availability_type: 'pto', start_date: '2026-01-05', end_date: '2026-01-05',
          approval_status: 'approved',
        }]],
      ]),
    });
    const plan = solve(ctx, { fillMode: 'obligatory' });
    expect(byId(plan).get('mon')).toBe('p1'); // violated, soft
    expect(byId(plan).get('wed')).toBe('p2'); // p1's cap was consumed by the violation
    expect(plan.unfilled).toHaveLength(0);
  });
});

// ── zero-requests byte-identity ─────────────────────────────────────────────
describe('absence of live requests — byte-identical to the pinned pre-change plan', () => {
  const golden = readFileSync(
    join(__dirname, '__fixtures__', 'fillAllPlan.golden.json'), 'utf8',
  ).trimEnd();

  it('dismissed (denied/canceled) request rows do not perturb the plan', () => {
    const ctx = buildFixtureContext();
    const p3 = ctx.availByPid.get('p03') ?? [];
    p3.push(req('2026-01-12', '2026-01-12', 'denied'));
    p3.push(req('2026-01-20', '2026-01-22', 'canceled'));
    ctx.availByPid.set('p03', p3);
    expect(JSON.stringify(solve(ctx), null, 2)).toBe(golden);
  });

  it('control: a LIVE request row changes the plan (the tier is real)', () => {
    // 2026-01-15 is a main-loop C1 that p03 wins in the golden plan — a live
    // request there must steer that call to someone else.
    const ctx = buildFixtureContext();
    ctx.availByPid.set('p03', [req('2026-01-15')]);
    const plan = solve(ctx);
    expect(JSON.stringify(plan, null, 2)).not.toBe(golden);
    const jan15C1 = plan.assignments.find(
      a => a.slot_date === '2026-01-15' && a.shift_type_code === 'C1');
    expect(jan15C1?.provider_id).not.toBe('p03');
  });
});

// ── grant report ────────────────────────────────────────────────────────────
describe('computeRequestGrants — per-provider requested/granted/violated dates', () => {
  const slots = [
    callSlot('mon', '2026-01-05', 'C1'),
    callSlot('wed', '2026-01-07', 'C1'),
  ];
  const planWith = (assignments: Array<{ slot_id: string; slot_date: string; provider_id: string; category?: string }>): SolutionPlan => ({
    assignments: assignments.map(a => ({
      slot_id: a.slot_id, slot_date: a.slot_date, shift_type_code: 'C1',
      shift_type_category: a.category ?? 'call', derived_day_type: 'weekday',
      provider_id: a.provider_id, provider_name: a.provider_id,
      existing_assignment_id: null, source: 'main-loop' as const,
    })),
    unfilled: [],
  });

  it('partitions requested block dates into granted and violated', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p1', [req('2026-01-05', '2026-01-07')]]]),
    });
    const grants = computeRequestGrants(ctx, planWith([
      { slot_id: 'mon', slot_date: '2026-01-05', provider_id: 'p1' },
      { slot_id: 'wed', slot_date: '2026-01-07', provider_id: 'p2' },
    ]));
    expect(grants).toEqual([{
      provider_id: 'p1', provider_name: 'p1',
      requested_dates: ['2026-01-05', '2026-01-07'],
      granted: ['2026-01-07'],
      violated: ['2026-01-05'],
    }]);
  });

  it('request dates outside the block are not counted; fully-outside requesters are omitted', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([
        ['p1', [req('2026-01-04', '2026-01-05')]], // 01-04 outside the block
        ['p2', [req('2026-02-01')]],               // entirely outside
      ]),
    });
    const grants = computeRequestGrants(ctx, planWith([]));
    expect(grants).toEqual([{
      provider_id: 'p1', provider_name: 'p1',
      requested_dates: ['2026-01-05'],
      granted: ['2026-01-05'],
      violated: [],
    }]);
  });

  it('seeded calls violate; non-call assignments and dismissed requests never do', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2'), prov('p3')], {
      availByPid: new Map([
        ['p1', [req('2026-01-05')]],
        ['p2', [req('2026-01-07')]],
        ['p3', [req('2026-01-05', '2026-01-05', 'denied')]], // dismissed — omitted
      ]),
      seedAssignments: [{
        slot_date: '2026-01-05', provider_id: 'p1',
        shift_type_code: 'C1', shift_type_category: 'call', derived_day_type: 'weekday',
      }],
    });
    const grants = computeRequestGrants(ctx, planWith([
      { slot_id: 'wed', slot_date: '2026-01-07', provider_id: 'p2', category: 'regular' },
    ]));
    expect(grants).toEqual([
      {
        provider_id: 'p1', provider_name: 'p1',
        requested_dates: ['2026-01-05'], granted: [], violated: ['2026-01-05'],
      },
      {
        provider_id: 'p2', provider_name: 'p2',
        requested_dates: ['2026-01-07'], granted: ['2026-01-07'], violated: [],
      },
    ]);
  });

  it('returns [] when no provider has a live request in the block', () => {
    const ctx = buildCtx(slots, [prov('p1')]);
    expect(computeRequestGrants(ctx, planWith([]))).toEqual([]);
  });
});
