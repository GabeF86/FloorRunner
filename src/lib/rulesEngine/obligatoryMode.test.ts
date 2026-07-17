import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { solve } from './solve';
import { computeObligations } from './obligation';
import { buildFixtureContext, buildCtx, prov, callSlot, dSlot } from './__fixtures__/buildContext';
import { CLASSIC_PATTERN, type CallPatternDoc } from './callPattern';
import type { GenerationContext } from './genTypes';

// ── Generation fill modes (2026-07-17) ───────────────────────────────────────
// fillMode 'all' (default) = the pre-change engine, byte for byte. fillMode
// 'obligatory' = each provider receives AT MOST their rounded TOTAL obligation
// (computeObligations) in call assignments; chain links count toward it (the
// whole block is charged against the cap upfront — an anchor is eligible only
// when cap-room >= 1 + its live call-category links); NO quota-relaxation
// sweep; remaining call slots stay open, reported with reason 'obligation-cap'.
// Non-call placements (d-chains, relief, mop-up) are never capped.

const callCountsByPid = (plan: ReturnType<typeof solve>) => {
  const out = new Map<string, number>();
  for (const a of plan.assignments) {
    if (a.shift_type_category !== 'call') continue;
    out.set(a.provider_id, (out.get(a.provider_id) || 0) + 1);
  }
  return out;
};

// ── fill-all mode is BYTE-IDENTICAL to the pre-change engine ────────────────
describe("fillMode 'all' — byte-identical to the pre-change plan (pinned)", () => {
  const golden = readFileSync(
    join(__dirname, '__fixtures__', 'fillAllPlan.golden.json'), 'utf8',
  ).trimEnd();

  it('default (no opts) reproduces the pinned pre-change plan byte for byte', () => {
    expect(JSON.stringify(solve(buildFixtureContext()), null, 2)).toBe(golden);
  });

  it("explicit fillMode 'all' is the identical plan", () => {
    expect(JSON.stringify(solve(buildFixtureContext(), { fillMode: 'all' }), null, 2)).toBe(golden);
  });
});

// ── main-loop cap ───────────────────────────────────────────────────────────
describe("fillMode 'obligatory' — rounded total obligation caps call assignments", () => {
  // 4 weekday C1 slots, pool ΣFTE 3 → effectivePar 3 → obligation 4/3 = 1.33 → 1 each.
  const slots = [
    callSlot('mon', '2026-01-05', 'C1'),
    callSlot('tue', '2026-01-06', 'C1'),
    callSlot('wed', '2026-01-07', 'C1'),
    callSlot('thu', '2026-01-08', 'C1'),
  ];
  const providers = [prov('p1'), prov('p2'), prov('p3')];

  it('every provider stays at or under their rounded obligation', () => {
    const ctx = buildCtx(slots, providers);
    const obligations = computeObligations(ctx);
    expect(obligations.get('p1')).toBe(1); // 1.33 → 1 (sanity)
    const plan = solve(ctx, { fillMode: 'obligatory' });
    for (const [pid, n] of callCountsByPid(plan)) {
      expect(n).toBeLessThanOrEqual(obligations.get(pid)!);
    }
    expect(plan.assignments.filter(a => a.shift_type_category === 'call')).toHaveLength(3);
  });

  it("the un-fillable slot is reported with reason 'obligation-cap' and per-candidate reasons", () => {
    const plan = solve(buildCtx(slots, providers), { fillMode: 'obligatory' });
    expect(plan.unfilled).toHaveLength(1);
    const u = plan.unfilled[0];
    expect(u.slot_id).toBe('thu');
    expect(u.reason).toBe('obligation-cap');
    const reasonByPid = new Map(u.candidates!.map(c => [c.provider_id, c.reason]));
    expect(reasonByPid.get('p1')).toBe('obligation-cap');
    expect(reasonByPid.get('p2')).toBe('obligation-cap');
    expect(reasonByPid.get('p3')).toBe('same-date'); // post-call block after Wed C1
  });

  it("fillMode 'all' on the same ctx fills every slot (control)", () => {
    const plan = solve(buildCtx(slots, providers), { fillMode: 'all' });
    expect(plan.unfilled).toHaveLength(0);
    expect(plan.assignments.filter(a => a.shift_type_category === 'call')).toHaveLength(4);
  });
});

// ── chain-block atomicity ───────────────────────────────────────────────────
describe("fillMode 'obligatory' — chain blocks are charged against the cap upfront", () => {
  // Classic Saturday chain: Sat C1 anchor → links Sun C2 + Fri C2 (both call).
  // Anchor needs cap-room >= 3 (1 + 2 live call links). parLevel 1 clamps
  // effectivePar to 1 → obligations: p1 (0.5 FTE) = 3×0.5 = 1.5 → 2 (room 2);
  // p2 (1.0 FTE) = 3 → 3 (room 3).
  const slots = [
    callSlot('satC1', '2026-01-10', 'C1', 'saturday'),
    callSlot('friC2', '2026-01-09', 'C2', 'friday'),
    callSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
  ];
  const providers = [prov('p1', 0.5), prov('p2', 1)];
  const mkCtx = () => buildCtx(slots, providers, { parLevel: 1 });

  it('an anchor whose whole block exceeds cap-room goes to a provider who can absorb the block', () => {
    const ctx = mkCtx();
    expect(computeObligations(ctx).get('p1')).toBe(2);
    expect(computeObligations(ctx).get('p2')).toBe(3);
    const plan = solve(ctx, { fillMode: 'obligatory' });
    // p1 would win the anchor on score (id tiebreak) but has room for only 2
    // of the 3 block calls — the whole block goes to p2.
    const byId = new Map(plan.assignments.map(a => [a.slot_id, a.provider_id]));
    expect(byId.get('satC1')).toBe('p2');
    expect(byId.get('friC2')).toBe('p2');
    expect(byId.get('sunC2')).toBe('p2');
    // Chain links counted toward the cap: p2 is now exactly at obligation.
    expect(callCountsByPid(plan).get('p2')).toBe(3);
    expect(plan.unfilled).toHaveLength(0);
  });

  it("fillMode 'all' hands the same anchor to the score winner p1 (control)", () => {
    const plan = solve(mkCtx(), { fillMode: 'all' });
    const byId = new Map(plan.assignments.map(a => [a.slot_id, a.provider_id]));
    expect(byId.get('satC1')).toBe('p1');
    expect(byId.get('friC2')).toBe('p1');
    expect(byId.get('sunC2')).toBe('p1');
  });
});

// ── no quota-relaxation sweep ───────────────────────────────────────────────
describe("fillMode 'obligatory' — quota relaxation never runs", () => {
  const slot = callSlot('mon', '2026-01-05', 'C1');
  const mkCtx = () => buildCtx([slot], [prov('p1')], {
    bucketTarget: new Map([['p1|weekday|C1', 0]]), // quota-blocked, NOT cap-blocked
  });

  it("fillMode 'all' relaxes the quota and fills (control)", () => {
    const plan = solve(mkCtx(), { fillMode: 'all' });
    expect(plan.assignments.find(a => a.slot_id === 'mon')?.source).toBe('quota-relaxed');
  });

  it("fillMode 'obligatory' leaves the slot open with the provider's REAL blocker", () => {
    const ctx = mkCtx();
    expect(computeObligations(ctx).get('p1')).toBe(1); // cap has room — quota is the blocker
    const plan = solve(ctx, { fillMode: 'obligatory' });
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unfilled).toHaveLength(1);
    expect(plan.unfilled[0].reason).toBe('No eligible providers');
    expect(plan.unfilled[0].candidates).toEqual([
      { provider_id: 'p1', provider_name: 'p1', reason: 'bucket-quota' },
    ]);
  });
});

// ── non-call placements are never capped ────────────────────────────────────
describe("fillMode 'obligatory' — the cap binds CALL assignments only", () => {
  it('a provider at cap still receives their derived (non-call) d-chain fill', () => {
    // 2 C2 slots, pool ΣFTE 2 → obligation 1 each. Each C2 chains a D1 the
    // day after — placed for the SAME provider even though they just hit cap.
    const slots = [
      callSlot('monC2', '2026-01-05', 'C2'),
      callSlot('tueC2', '2026-01-06', 'C2'),
      dSlot('tueD1', '2026-01-06', 'D1'),
      dSlot('wedD1', '2026-01-07', 'D1'),
    ];
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')]);
    expect(computeObligations(ctx).get('p1')).toBe(1);
    const plan = solve(ctx, { fillMode: 'obligatory' });
    const byId = new Map(plan.assignments.map(a => [a.slot_id, a.provider_id]));
    expect(byId.get('monC2')).toBe('p1');
    expect(byId.get('tueD1')).toBe('p1'); // derived fill lands despite p1 being at cap
    expect(byId.get('tueC2')).toBe('p2');
    expect(byId.get('wedD1')).toBe('p2');
    expect(callCountsByPid(plan).get('p1')).toBe(1);
    expect(callCountsByPid(plan).get('p2')).toBe(1);
  });
});

// ── pre-PTO placement pass respects the cap ─────────────────────────────────
describe("fillMode 'obligatory' — pre-PTO Thursday pass respects the cap", () => {
  // p1 (0.1 FTE): obligation round(1/1.1 × 0.1) = 0 — no call may be placed.
  const slots = [callSlot('thuC1', '2026-01-08', 'C1')];
  const providers = [prov('p1', 0.1), prov('p2', 1)];
  const availByPid = new Map([['p1', [{
    availability_type: 'pto', start_date: '2026-01-12', end_date: '2026-01-16',
    approval_status: 'approved',
  }]]]);
  const mkCtx = () => buildCtx(slots, providers, { availByPid });

  it("fillMode 'all' gives PTO-bound p1 the pre-PTO Thursday (control)", () => {
    const plan = solve(mkCtx(), { fillMode: 'all' });
    const a = plan.assignments.find(x => x.slot_id === 'thuC1');
    expect(a?.provider_id).toBe('p1');
    expect(a?.source).toBe('pre-pto-thursday');
  });

  it("fillMode 'obligatory' skips the zero-obligation provider; main loop fills instead", () => {
    const ctx = mkCtx();
    expect(computeObligations(ctx).get('p1')).toBe(0);
    const plan = solve(ctx, { fillMode: 'obligatory' });
    const a = plan.assignments.find(x => x.slot_id === 'thuC1');
    expect(a?.provider_id).toBe('p2');
    expect(a?.source).toBe('main-loop');
  });
});

// ── seeded/manual calls count toward the cap ────────────────────────────────
describe("fillMode 'obligatory' — seeded call assignments consume the cap", () => {
  const mkCtx = (): GenerationContext => buildCtx(
    [callSlot('wedC1', '2026-01-07', 'C1')],
    [prov('p1'), prov('p2')],
    {
      seedAssignments: [{
        slot_date: '2026-01-05', provider_id: 'p1',
        shift_type_code: 'C1', shift_type_category: 'call', derived_day_type: 'weekday',
      }],
      availByPid: new Map([['p2', [{
        availability_type: 'pto', start_date: '2026-01-07', end_date: '2026-01-07',
        approval_status: 'approved',
      }]]]),
    },
  );

  it('a provider whose seed already meets the obligation gets no further call', () => {
    const ctx = mkCtx();
    // totalCallSlots = 1 open + 1 seed = 2 → obligation 1 each; p1's seed fills it.
    expect(computeObligations(ctx).get('p1')).toBe(1);
    const plan = solve(ctx, { fillMode: 'obligatory' });
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unfilled).toHaveLength(1);
    expect(plan.unfilled[0].reason).toBe('obligation-cap');
    const reasonByPid = new Map(plan.unfilled[0].candidates!.map(c => [c.provider_id, c.reason]));
    expect(reasonByPid.get('p1')).toBe('obligation-cap');
    expect(reasonByPid.get('p2')).toBe('availability-blocked');
  });

  it("fillMode 'all' hands p1 the second call (control)", () => {
    const plan = solve(mkCtx(), { fillMode: 'all' });
    expect(plan.assignments.find(a => a.slot_id === 'wedC1')?.provider_id).toBe('p1');
  });
});

// ── spans are charged atomically too ────────────────────────────────────────
describe("fillMode 'obligatory' — spans respect the cap atomically", () => {
  const spanDoc: CallPatternDoc = {
    ...CLASSIC_PATTERN,
    blocks: [],
    spans: [{ code: 'C1', anchorDayType: 'friday', offsets: [0, 1] }],
  };
  const slots = [
    callSlot('friC1', '2026-01-09', 'C1', 'friday'),
    callSlot('satC1', '2026-01-10', 'C1', 'saturday'),
  ];

  it('the span goes to a provider with room for every call slot in it', () => {
    // parLevel 1 → obligations: p1 (0.5) = 1, p2 (1.0) = 2. Span needs 2.
    const ctx = buildCtx(slots, [prov('p1', 0.5), prov('p2', 1)],
      { parLevel: 1, callPattern: spanDoc });
    const plan = solve(ctx, { fillMode: 'obligatory' });
    const byId = new Map(plan.assignments.map(a => [a.slot_id, a.provider_id]));
    expect(byId.get('friC1')).toBe('p2');
    expect(byId.get('satC1')).toBe('p2');
    expect(callCountsByPid(plan).get('p2')).toBe(2); // span counted toward the cap
  });

  it('when nobody has room for the whole span it severs to capped individual fills', () => {
    // Both 0.5 FTE → obligations 1 each < span size 2. The span is reported
    // 'obligation-cap'; the main loop then fills each slot within caps.
    const ctx = buildCtx(slots, [prov('p1', 0.5), prov('p2', 0.5)],
      { parLevel: 1, callPattern: spanDoc });
    const plan = solve(ctx, { fillMode: 'obligatory' });
    const spanUnfilled = plan.unfilled.filter(u => u.reason === 'obligation-cap');
    expect(spanUnfilled.map(u => u.slot_id).sort()).toEqual(['friC1', 'satC1']);
    const byId = new Map(plan.assignments.map(a => [a.slot_id, a.provider_id]));
    expect(byId.get('friC1')).toBe('p1');
    expect(byId.get('satC1')).toBe('p2'); // p1 at cap (and post-call blocked)
    for (const [pid, n] of callCountsByPid(plan)) {
      expect(n).toBeLessThanOrEqual(computeObligations(ctx).get(pid)!);
    }
  });
});
