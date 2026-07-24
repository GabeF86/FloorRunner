import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { solve } from './solve';
import { computeObligations } from './obligation';
import { computeBucketTargets, floorBucketTargets } from './genContext';
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
// (2026-07-24 par-authoritative fixture note: tests in this file that leaned
// on the deleted pool clamp — buildCtx's default parLevel 12 over a small
// pool — now pin parLevel explicitly at the value the clamp used to produce,
// preserving each test's cap-mechanics intent byte for byte.)
describe("fillMode 'obligatory' — rounded total obligation caps call assignments", () => {
  // 4 weekday C1 slots at par 3 → obligation 4/3 = 1.33 → 1 each.
  const slots = [
    callSlot('mon', '2026-01-05', 'C1'),
    callSlot('tue', '2026-01-06', 'C1'),
    callSlot('wed', '2026-01-07', 'C1'),
    callSlot('thu', '2026-01-08', 'C1'),
  ];
  const providers = [prov('p1'), prov('p2'), prov('p3')];

  it('every provider stays at or under their rounded obligation', () => {
    const ctx = buildCtx(slots, providers, { parLevel: 3 });
    const obligations = computeObligations(ctx);
    expect(obligations.get('p1')).toBe(1); // 1.33 → 1 (sanity)
    const plan = solve(ctx, { fillMode: 'obligatory' });
    for (const [pid, n] of callCountsByPid(plan)) {
      expect(n).toBeLessThanOrEqual(obligations.get(pid)!);
    }
    expect(plan.assignments.filter(a => a.shift_type_category === 'call')).toHaveLength(3);
  });

  it("the un-fillable slot is reported with reason 'obligation-cap' and per-candidate reasons", () => {
    const plan = solve(buildCtx(slots, providers, { parLevel: 3 }), { fillMode: 'obligatory' });
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
    const plan = solve(buildCtx(slots, providers, { parLevel: 3 }), { fillMode: 'all' });
    expect(plan.unfilled).toHaveLength(0);
    expect(plan.assignments.filter(a => a.shift_type_category === 'call')).toHaveLength(4);
  });
});

// ── chain-block atomicity ───────────────────────────────────────────────────
describe("fillMode 'obligatory' — chain blocks are charged against the cap upfront", () => {
  // Classic Saturday chain: Sat C1 anchor → links Sun C2 + Fri C2 (both call).
  // Anchor needs cap-room >= 3 (1 + 2 live call links). At par 1 the
  // obligations are: p1 (0.5 FTE) = 3×0.5 = 1.5 → 2 (room 2);
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
    parLevel: 1, // par-authoritative pin (old clamp: pool ΣFTE 1) → obligation 1
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
    // 2 C2 slots at par 2 → obligation 1 each. Each C2 chains a D1 the
    // day after — placed for the SAME provider even though they just hit cap.
    const slots = [
      callSlot('monC2', '2026-01-05', 'C2'),
      callSlot('tueC2', '2026-01-06', 'C2'),
      dSlot('tueD1', '2026-01-06', 'D1'),
      dSlot('wedD1', '2026-01-07', 'D1'),
    ];
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], { parLevel: 2 });
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
  // p1 (0.1 FTE) at par 1.1: obligation round(1/1.1 × 0.1) = 0 — no call may
  // be placed. (Par pinned at the old clamped value, pool ΣFTE 1.1.)
  const slots = [callSlot('thuC1', '2026-01-08', 'C1')];
  const providers = [prov('p1', 0.1), prov('p2', 1)];
  const availByPid = new Map([['p1', [{
    availability_type: 'pto', start_date: '2026-01-12', end_date: '2026-01-16',
    approval_status: 'approved',
  }]]]);
  const mkCtx = () => buildCtx(slots, providers, { parLevel: 1.1, availByPid });

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
      parLevel: 2, // par-authoritative pin (old clamp: pool ΣFTE 2) → obligation 1 each
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

// ── Par-authoritative (Gabriel 2026-07-24): par 11 over a smaller pool ───────
// The live Paoli shape — stored par 11, pool ΣFTE 8.5 (8 × 1.0 + 0.5). The
// stored par is the denominator: obligations deliberately UNDER-COVER the
// block, obligatory mode leaves the remainder OPEN (the paid-pickup layer,
// taken after the schedule is made), and fill-all mode STILL fills everything
// ("quota never blocks fills" — relaxation/mop-up cover the shrunken targets).
describe('par 11 over pool ΣFTE 8.5 — obligations under-cover; fill-all is unaffected', () => {
  // 15 weekdays (2026-01-05..23, Mon–Fri) × (C1 + C2) = 30 call slots.
  const weekdays = [
    '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09',
    '2026-01-12', '2026-01-13', '2026-01-14', '2026-01-15', '2026-01-16',
    '2026-01-19', '2026-01-20', '2026-01-21', '2026-01-22', '2026-01-23',
  ];
  const providers = [
    ...Array.from({ length: 8 }, (_, i) => prov(`p${i}`)),
    prov('ph', 0.5),
  ];
  // Production-path targets (loadGenerationContext post-change): raw stored-par
  // denominator through computeBucketTargets, then the ≥1 floor. `denom`
  // parametrizes the control below (the old clamp's pool value 8.5).
  const mkCtx = (par: number, denom = par) => {
    const slots = weekdays.flatMap(d => [
      callSlot(`${d}|C1`, d, 'C1'),
      callSlot(`${d}|C2`, d, 'C2'),
    ]);
    const ctx = buildCtx(slots, providers, { parLevel: par });
    ctx.bucketTarget = floorBucketTargets(
      computeBucketTargets(ctx.bucketTotals, new Map(), new Map(), providers, denom),
      providers,
    );
    return ctx;
  };
  const filledCallSlotIds = (plan: ReturnType<typeof solve>) =>
    plan.assignments.filter(a => a.shift_type_category === 'call').map(a => a.slot_id).sort();

  it('obligations divide by 11: 30/11 → 3 per 1.0 FTE, 1 for the 0.5 — Σ 25 of 30 (5 paid pickups)', () => {
    const obligations = computeObligations(mkCtx(11));
    expect(obligations.get('p0')).toBe(3);  // 30/11 × 1.0 = 2.73 → 3
    expect(obligations.get('ph')).toBe(1);  // 30/11 × 0.5 = 1.36 → 1
    const total = [...obligations.values()].reduce((s, n) => s + n, 0);
    expect(total).toBe(25); // the old clamp (÷8.5) said 4×8 + 2 = 34
    expect(total).toBeLessThan(30);
  });

  it("fillMode 'all' fills the IDENTICAL slot set as the old pool-clamped targets (quota never blocks fills)", () => {
    const at11 = solve(mkCtx(11), { fillMode: 'all' });
    const atPool = solve(mkCtx(11, 8.5), { fillMode: 'all' }); // pre-change denominator
    expect(filledCallSlotIds(at11)).toEqual(filledCallSlotIds(atPool));
    expect(at11.unfilled).toHaveLength(0); // every slot fills — relaxation/mop-up cover
    expect(filledCallSlotIds(at11)).toHaveLength(30);
  });

  it("fillMode 'obligatory' leaves the uncovered remainder OPEN as ordinary 'obligation-cap' slots — honestly counted, never dropped", () => {
    const ctx = mkCtx(11);
    const obligations = computeObligations(ctx);
    const plan = solve(ctx, { fillMode: 'obligatory' });
    const filled = filledCallSlotIds(plan).length;
    // Honest accounting: every one of the 30 slots is either filled or
    // reported open — nothing silently vanishes.
    expect(filled + plan.unfilled.length).toBe(30);
    expect(plan.unfilled.length).toBeGreaterThanOrEqual(5); // ≥ 30 − Σ obligations
    // The leftovers are ordinary open call slots with the cap reason — the
    // pickup layer, not errors.
    expect(plan.unfilled.every(u => u.reason === 'obligation-cap' || u.reason === 'No eligible providers')).toBe(true);
    expect(plan.unfilled.some(u => u.reason === 'obligation-cap')).toBe(true);
    for (const [pid, n] of callCountsByPid(plan)) {
      expect(n).toBeLessThanOrEqual(obligations.get(pid)!);
    }
  });
});
