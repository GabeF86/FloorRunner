import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { solve } from './solve';
import { computeCallRequestGrants } from './requestGrants';
import { buildFixtureContext, buildCtx, prov, callSlot } from './__fixtures__/buildContext';
import type { AvailabilityEntry, SolutionPlan } from './genTypes';

// ── Call-request soft preference (2026-07-22) ───────────────────────────────
// MIRROR IMAGE of the no-call soft avoidance (noCallRequests.test.ts): a
// non-dismissed call_request covering a call slot's date LIFTS the candidate
// a SORT TIER in scoreCall (preferred — sorts BEFORE every neutral candidate;
// penalized no-call requesters still sort after) — never a gate: every safety
// check, quota, workdays cap, provider cap and fill-mode rule still applies,
// a request only reorders candidates. Grants are spread fairly: among
// preferred candidates the one with the FEWEST requests already granted this
// run wins; existing scoring breaks ties. A provider with BOTH a call request
// and a no-call request on one date is contradictory — treated as NEITHER,
// warned once on the plan. With zero call_request rows every tier is
// unchanged and the plan is byte-identical to the pre-change engine (pinned
// below against fillAllPlan.golden.json).

const creq = (start: string, end = start, approval_status = 'approved'): AvailabilityEntry => ({
  availability_type: 'call_request', start_date: start, end_date: end, approval_status,
});
const nreq = (start: string, end = start, approval_status = 'approved'): AvailabilityEntry => ({
  availability_type: 'no_call_request', start_date: start, end_date: end, approval_status,
});
const pto = (start: string, end = start): AvailabilityEntry => ({
  availability_type: 'pto', start_date: start, end_date: end, approval_status: 'approved',
});

const byId = (plan: SolutionPlan) => new Map(plan.assignments.map(a => [a.slot_id, a.provider_id]));

// ── preferred tier ──────────────────────────────────────────────────────────
describe('scoreCall preferred tier — requesters win a call slot they are eligible for', () => {
  const slots = [callSlot('mon', '2026-01-05', 'C1')];

  it('control: without a request, p1 wins on the id tiebreak', () => {
    const plan = solve(buildCtx(slots, [prov('p1'), prov('p2')]));
    expect(byId(plan).get('mon')).toBe('p1');
  });

  it('an active call request on the slot date hands the slot to the requester', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p2', [creq('2026-01-05')]]]),
    });
    const plan = solve(ctx);
    expect(byId(plan).get('mon')).toBe('p2'); // p1 would win the id tiebreak
    expect(plan.unfilled).toHaveLength(0);
  });

  it('a PENDING request prefers (non-dismissed); denied/canceled do not', () => {
    const pending = solve(buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p2', [creq('2026-01-05', '2026-01-05', 'pending')]]]),
    }));
    expect(byId(pending).get('mon')).toBe('p2');

    const denied = solve(buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p2', [creq('2026-01-05', '2026-01-05', 'denied')]]]),
    }));
    expect(byId(denied).get('mon')).toBe('p1'); // dismissed — no preference

    const canceled = solve(buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p2', [creq('2026-01-05', '2026-01-05', 'canceled')]]]),
    }));
    expect(byId(canceled).get('mon')).toBe('p1');
  });

  it('a request on a DIFFERENT date does not prefer', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p2', [creq('2026-01-06')]]]),
    });
    expect(byId(solve(ctx)).get('mon')).toBe('p1');
  });

  it('NEVER a gate: a requester blocked by PTO is still refused', () => {
    // p2 requested the date AND is on PTO that date — the request must not
    // override the hard availability gate (clinical invariant 2).
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p2', [creq('2026-01-05'), pto('2026-01-05')]]]),
    });
    const plan = solve(ctx);
    expect(byId(plan).get('mon')).toBe('p1');
    expect(plan.unfilled).toHaveLength(0);
  });

  it('NEVER a gate: a cross-site-booked requester is still refused', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p2', [creq('2026-01-05')]]]),
      crossSiteByDate: new Map([['p2', new Set(['2026-01-05'])]]),
    });
    expect(byId(solve(ctx)).get('mon')).toBe('p1');
  });

  it('the preference also orders the quota-relaxation sweep (shared tuple)', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      bucketTarget: new Map([['p1|weekday|C1', 0], ['p2|weekday|C1', 0]]),
      availByPid: new Map([['p2', [creq('2026-01-05')]]]),
    });
    const plan = solve(ctx);
    const a = plan.assignments.find(x => x.slot_id === 'mon');
    expect(a?.source).toBe('quota-relaxed');
    expect(a?.provider_id).toBe('p2'); // p2 would lose the id tiebreak without the tier
  });

  it('a preferred requester still sorts before a penalized no-call requester', () => {
    // p1 requested NO call, p2 requested call: tier order preferred < neutral
    // < penalized must put p2 first and p1 last.
    const twoSlots = [callSlot('mon', '2026-01-05', 'C1'), callSlot('mon2', '2026-01-05', 'C2')];
    const ctx = buildCtx(twoSlots, [prov('p1'), prov('p2'), prov('p3')], {
      availByPid: new Map([
        ['p1', [nreq('2026-01-05')]],
        ['p2', [creq('2026-01-05')]],
      ]),
    });
    const plan = solve(ctx);
    expect(byId(plan).get('mon')).toBe('p2');  // preferred first
    expect(byId(plan).get('mon2')).toBe('p3'); // neutral before penalized p1
  });
});

// ── fairness of grant ───────────────────────────────────────────────────────
describe('fair grant spread — among preferred candidates, fewest already-granted requests wins', () => {
  // Both providers request both dates, so BOTH slots go to requesters.
  // p1 wins the first on the id tiebreak and STAYS the lower-ratio candidate
  // (0+1 vs p2's heavy history 5) — plain scoring would grant p1 twice. The
  // granted-count comparison spreads the grants 1/1.
  const slots = [
    callSlot('mon', '2026-01-05', 'C1'),
    callSlot('wed', '2026-01-07', 'C1'),
  ];
  const both = new Map([
    ['p1', [creq('2026-01-05', '2026-01-07')]],
    ['p2', [creq('2026-01-05', '2026-01-07')]],
  ]);

  it('the second grant goes to the not-yet-granted requester', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: both,
      historicalAssignedByPid: new Map([['p2', new Map([['weekday|C1', 5]])]]),
    });
    const plan = solve(ctx);
    expect(byId(plan).get('mon')).toBe('p1'); // ratio 0 vs 5 — p1 takes the first grant
    expect(byId(plan).get('wed')).toBe('p2'); // p1 already granted once — p2 despite ratio
  });

  it('a seeded call on a requested date counts as an already-received grant', () => {
    // p1 has a manual call seeded on their requested Mon — the fair-grant
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

// ── contradictory requests ──────────────────────────────────────────────────
describe('contradictory requests — call + no-call on one date is treated as neither', () => {
  const slots = [callSlot('mon', '2026-01-05', 'C1')];

  it('a provider with both types on the slot date is neither preferred nor penalized', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p1', [creq('2026-01-05'), nreq('2026-01-05')]]]),
    });
    const plan = solve(ctx);
    // Neither: p1 wins on the id tiebreak exactly like the request-free control.
    expect(byId(plan).get('mon')).toBe('p1');
  });

  it('warns ONCE per provider on the plan, listing the contradictory dates', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p1', [creq('2026-01-05', '2026-01-06'), nreq('2026-01-05', '2026-01-06')]]]),
    });
    const plan = solve(ctx);
    expect(plan.requestWarnings).toHaveLength(1);
    expect(plan.requestWarnings![0]).toMatch(/p1/);
    expect(plan.requestWarnings![0]).toMatch(/2026-01-05/);
    expect(plan.requestWarnings![0]).toMatch(/contradictory/i);
  });

  it('only the overlapping date is neutralized — the rest of each request still applies', () => {
    // p1: call request Mon+Wed, no-call Mon only → Mon contradictory (neither),
    // Wed still a live call request (preferred).
    const twoSlots = [
      callSlot('mon', '2026-01-05', 'C1'),
      callSlot('wed', '2026-01-07', 'C1'),
    ];
    const ctx = buildCtx(twoSlots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p2', [creq('2026-01-05', '2026-01-07'), nreq('2026-01-05')]]]),
    });
    const plan = solve(ctx);
    expect(byId(plan).get('mon')).toBe('p1'); // contradictory Mon: p2 not preferred
    expect(byId(plan).get('wed')).toBe('p2'); // Wed request still live
  });

  it('no warning key on the plan when no contradiction exists (lazy materialization)', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p1', [creq('2026-01-05')]]]),
    });
    expect('requestWarnings' in solve(ctx)).toBe(false);
  });
});

// ── obligatory-mode interaction ─────────────────────────────────────────────
describe('obligatory mode — preference applies; granted placements consume the cap', () => {
  // 2 weekday C1 slots, ΣFTE 2, par clamps to 2 → obligation 1 each.
  const slots = [
    callSlot('mon', '2026-01-05', 'C1'),
    callSlot('wed', '2026-01-07', 'C1'),
  ];

  it("the preferred tier orders candidates in fillMode 'obligatory' too", () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p2', [creq('2026-01-05')]]]),
    });
    const plan = solve(ctx, { fillMode: 'obligatory' });
    expect(byId(plan).get('mon')).toBe('p2'); // preferred (p1 would win the id tiebreak)
    expect(byId(plan).get('wed')).toBe('p1'); // p2 at cap — the request never lifts a cap
    expect(plan.unfilled).toHaveLength(0);
  });

  it('a requester at their obligation cap gets no further slots (request never a gate-waiver)', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p2', [creq('2026-01-05', '2026-01-07')]]]),
    });
    const plan = solve(ctx, { fillMode: 'obligatory' });
    expect(byId(plan).get('mon')).toBe('p2'); // first requested date granted
    expect(byId(plan).get('wed')).toBe('p1'); // cap consumed — p2 refused despite request
  });
});

// ── zero-requests byte-identity ─────────────────────────────────────────────
describe('absence of live call requests — byte-identical to the pinned pre-change plan', () => {
  const golden = readFileSync(
    join(__dirname, '__fixtures__', 'fillAllPlan.golden.json'), 'utf8',
  ).trimEnd();

  it('dismissed (denied/canceled) call_request rows do not perturb the plan', () => {
    const ctx = buildFixtureContext();
    const p3 = ctx.availByPid.get('p03') ?? [];
    p3.push(creq('2026-01-12', '2026-01-12', 'denied'));
    p3.push(creq('2026-01-20', '2026-01-22', 'canceled'));
    ctx.availByPid.set('p03', p3);
    expect(JSON.stringify(solve(ctx), null, 2)).toBe(golden);
  });

  it('control: a LIVE call_request row changes the plan (the tier is real)', () => {
    // In the golden plan 2026-01-15's calls go to p10 (C2) and p03 (C1); p06
    // has nothing that day until the relief pass. A live call request from
    // p06 must hand p06 one of that date's calls.
    const ctx = buildFixtureContext();
    ctx.availByPid.set('p06', [creq('2026-01-15')]);
    const plan = solve(ctx);
    expect(JSON.stringify(plan, null, 2)).not.toBe(golden);
    const p06Call = plan.assignments.find(
      a => a.slot_date === '2026-01-15' && a.shift_type_category === 'call'
        && a.provider_id === 'p06');
    expect(p06Call).toBeDefined();
  });
});

// ── grant report ────────────────────────────────────────────────────────────
describe('computeCallRequestGrants — per-provider requested/granted/not-granted dates', () => {
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

  it('partitions requested block dates into granted and not granted', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p1', [creq('2026-01-05', '2026-01-07')]]]),
    });
    const grants = computeCallRequestGrants(ctx, planWith([
      { slot_id: 'mon', slot_date: '2026-01-05', provider_id: 'p1' },
      { slot_id: 'wed', slot_date: '2026-01-07', provider_id: 'p2' },
    ]));
    expect(grants).toEqual([{
      provider_id: 'p1', provider_name: 'p1',
      requested_dates: ['2026-01-05', '2026-01-07'], // block dates only (no 01-06 slot)
      granted: ['2026-01-05'],
      not_granted: ['2026-01-07'],
    }]);
  });

  it('request dates outside the block are not counted; fully-outside requesters are omitted', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([
        ['p1', [creq('2026-01-04', '2026-01-05')]], // 01-04 outside the block
        ['p2', [creq('2026-02-01')]],               // entirely outside
      ]),
    });
    const grants = computeCallRequestGrants(ctx, planWith([]));
    expect(grants).toEqual([{
      provider_id: 'p1', provider_name: 'p1',
      requested_dates: ['2026-01-05'],
      granted: [],
      not_granted: ['2026-01-05'],
    }]);
  });

  it('seeded calls grant; non-call assignments and dismissed requests never do', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2'), prov('p3')], {
      availByPid: new Map([
        ['p1', [creq('2026-01-05')]],
        ['p2', [creq('2026-01-07')]],
        ['p3', [creq('2026-01-05', '2026-01-05', 'denied')]], // dismissed — omitted
      ]),
      seedAssignments: [{
        slot_date: '2026-01-05', provider_id: 'p1',
        shift_type_code: 'C1', shift_type_category: 'call', derived_day_type: 'weekday',
      }],
    });
    const grants = computeCallRequestGrants(ctx, planWith([
      { slot_id: 'wed', slot_date: '2026-01-07', provider_id: 'p2', category: 'regular' },
    ]));
    expect(grants).toEqual([
      {
        provider_id: 'p1', provider_name: 'p1',
        requested_dates: ['2026-01-05'], granted: ['2026-01-05'], not_granted: [],
      },
      {
        provider_id: 'p2', provider_name: 'p2',
        requested_dates: ['2026-01-07'], granted: [], not_granted: ['2026-01-07'],
      },
    ]);
  });

  it('contradictory dates (call + no-call both live) are excluded from the report', () => {
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      availByPid: new Map([['p1', [creq('2026-01-05', '2026-01-07'), nreq('2026-01-05')]]]),
    });
    const grants = computeCallRequestGrants(ctx, planWith([]));
    expect(grants).toEqual([{
      provider_id: 'p1', provider_name: 'p1',
      requested_dates: ['2026-01-07'], // Mon excluded (contradictory)
      granted: [],
      not_granted: ['2026-01-07'],
    }]);
  });

  it('returns [] when no provider has a live call request in the block', () => {
    const ctx = buildCtx(slots, [prov('p1')]);
    expect(computeCallRequestGrants(ctx, planWith([]))).toEqual([]);
  });
});
