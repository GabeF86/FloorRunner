import { describe, it, expect } from 'vitest';
import { optimize, extractCallAssignment, compareMetrics, movableCallSlotIds } from './optimize';
import { solve } from './solve';
import { scoreSolution } from './metrics';
import { CLASSIC_PATTERN } from './callPattern';
import { WEEKEND_V2_PATTERN } from './patterns/weekendV2';
import {
  buildCtx as buildFxCtx, prov as fxProv, callSlot as fxCallSlot, shiftInfo,
} from './__fixtures__/buildContext';
import type { GenerationContext, SlotToFill, CandidateProvider } from './genTypes';

function prov(id: string, fte = 1, over: Partial<CandidateProvider> = {}): CandidateProvider {
  return {
    id, provider_type: 'physician', short_display_name: id, fte_value: fte,
    home_site_id: 'site1', available_weekdays: [true, true, true, true, true, true, true],
    ...over,
  };
}
function callSlot(id: string, date: string, code: string, dt = 'weekday'): SlotToFill {
  return {
    slot_id: id, slot_date: date, shift_type_id: 'st-' + code,
    shift_type_code: code, shift_type_category: 'call',
    derived_day_type: dt, provider_group: 'physician',
    required_count: 1, existing_assignment_id: null,
  };
}
function buildCtx(slots: SlotToFill[], providers: CandidateProvider[],
                  over: Partial<GenerationContext> = {}): GenerationContext {
  const slotIndex = new Map<string, Map<string, SlotToFill>>();
  for (const s of slots) {
    if (!slotIndex.has(s.slot_date)) slotIndex.set(s.slot_date, new Map());
    slotIndex.get(s.slot_date)!.set(s.shift_type_code, s);
  }
  const bucketTarget = new Map<string, number>();
  for (const s of slots) for (const p of providers) {
    bucketTarget.set(`${p.id}|weekday|${s.shift_type_code}`, 99);
  }
  return {
    scheduleVersionId: 'v1', siteId: 'site1', parLevel: 12,
    slotsToFill: slots, slotIndex, providers,
    credByPid: new Map(), availByPid: new Map(), crossSiteByDate: new Map(),
    historicalAssignedByPid: new Map(), historicalTotalByBucket: new Map(),
    bucketTotals: new Map(), bucketTarget, seedAssignments: [],
    ...over,
  };
}

describe('extractCallAssignment', () => {
  it('maps each filled call slot to its provider', () => {
    const slots = [callSlot('s1', '2026-01-06', 'C1')];
    const plan = solve(buildCtx(slots, [prov('pA')]));
    const ca = extractCallAssignment(plan);
    expect(ca.get('s1')).toBe('pA');
  });
});

describe('compareMetrics (lexicographic: skipped, fairnessStdev, burnout)', () => {
  it('fewer skips wins regardless of fairness', () => {
    expect(compareMetrics(
      { filled: 5, skipped: 0, fairnessStdev: 9, burnout: 9, providersUsed: 1 },
      { filled: 4, skipped: 1, fairnessStdev: 0, burnout: 0, providersUsed: 1 },
    )).toBeLessThan(0); // first is better
  });
  it('on equal skips, lower fairnessStdev wins', () => {
    expect(compareMetrics(
      { filled: 5, skipped: 0, fairnessStdev: 0.1, burnout: 5, providersUsed: 2 },
      { filled: 5, skipped: 0, fairnessStdev: 0.2, burnout: 0, providersUsed: 2 },
    )).toBeLessThan(0);
  });
});

describe('optimize — eviction fills a skip greedy left behind', () => {
  it('fills a stranded slot via local search', () => {
    // The optimizer (eviction or fairness swap) fills a slot greedy stranded.
    // pX is the ONLY one eligible for slot s2 (pY is Wed-unavailable), but
    // greedy uses pX on s1 first, leaving s2 unfillable. pY can cover s1.
    // s1 Tue 2026-01-06, s2 Wed 2026-01-07.
    const pX = prov('pX');
    // pY only available Tue (not Wed) -> pY can't take s2, only s1.
    const pY = prov('pY', 1, { available_weekdays: [true, true, true, false, true, true, true] }); // Wed(3) off
    const slots = [callSlot('s1', '2026-01-06', 'C1'), callSlot('s2', '2026-01-07', 'C1')];
    const ctx = buildCtx(slots, [pX, pY]);

    const seed = solve(ctx);
    const seedScore = scoreSolution(seed, ctx);

    const optimized = optimize(ctx).plan;
    const optScore = scoreSolution(optimized, ctx);

    // Optimizer must do at least as well on skips, and ideally fill both.
    expect(optScore.skipped).toBeLessThanOrEqual(seedScore.skipped);
    expect(optimized.assignments.filter(a => ['s1', 's2'].includes(a.slot_id)).length)
      .toBeGreaterThanOrEqual(seed.assignments.filter(a => ['s1', 's2'].includes(a.slot_id)).length);
    // Both slots filled in the optimized result.
    expect(optimized.assignments.some(a => a.slot_id === 's1')).toBe(true);
    expect(optimized.assignments.some(a => a.slot_id === 's2')).toBe(true);
  });

  it('eviction: frees a quota-blocked specialist to cover their unique slot', () => {
    // pX: eligible Tue + Wed, weekday|C1 quota = 1 (can take only ONE).
    // pY: eligible Tue only (Wed-unavailable), quota = 1.
    // Greedy takes Tue with pX (quota full) -> Wed stranded (pX over quota, pY Wed-off).
    // Eviction: Tue -> pY, frees pX -> pX covers Wed. Both filled.
    const pX = prov('pX');
    const pY = prov('pY', 1, { available_weekdays: [true, true, true, false, true, true, true] }); // Wed(3) off
    const s1 = callSlot('s1', '2026-01-06', 'C1'); // Tue
    const s2 = callSlot('s2', '2026-01-07', 'C1'); // Wed
    const ctx = buildCtx([s1, s2], [pX, pY], {
      // quota 1 each so pX can't hold both Tue and Wed
      bucketTarget: new Map([['pX|weekday|C1', 1], ['pY|weekday|C1', 1]]),
    });
    const seed = solve(ctx);
    const opt = optimize(ctx).plan;
    expect(scoreSolution(opt, ctx).skipped).toBeLessThan(scoreSolution(seed, ctx).skipped);
    expect(opt.assignments.some(a => a.slot_id === 's1')).toBe(true);
    expect(opt.assignments.some(a => a.slot_id === 's2')).toBe(true);
  });

  it('never produces more skips than the seed (never-worse guarantee)', () => {
    const slots = [
      callSlot('s1', '2026-01-06', 'C1'), callSlot('s2', '2026-01-13', 'C1'),
      callSlot('s3', '2026-01-20', 'C1'),
    ];
    const ctx = buildCtx(slots, [prov('pA'), prov('pB'), prov('pC')]);
    const seed = solve(ctx);
    const optimized = optimize(ctx).plan;
    expect(scoreSolution(optimized, ctx).skipped)
      .toBeLessThanOrEqual(scoreSolution(seed, ctx).skipped);
  });

  it('is deterministic: two runs give identical assignments', () => {
    const mk = () => buildCtx(
      [callSlot('s1', '2026-01-06', 'C1'), callSlot('s2', '2026-01-13', 'C1')],
      [prov('pB'), prov('pA')],
    );
    const a = optimize(mk()).plan;
    const b = optimize(mk()).plan;
    expect(a.assignments.map(x => `${x.slot_id}:${x.provider_id}`).sort())
      .toEqual(b.assignments.map(x => `${x.slot_id}:${x.provider_id}`).sort());
  });

  it('fairness swap lowers stdev when one provider is overloaded', () => {
    // Two weekday C1 slots, generous quota. Greedy id-tiebreak may load pA twice
    // (ratio 2 vs 0). A fairness swap to pB lowers the stdev. Either way the
    // optimizer must not leave fairness worse than the seed.
    const s1 = callSlot('s1', '2026-01-06', 'C1');
    const s2 = callSlot('s2', '2026-01-13', 'C1');
    const ctx = buildCtx([s1, s2], [prov('pA'), prov('pB')]); // generous quota (buildCtx sets 99)
    const seed = solve(ctx);
    const opt = optimize(ctx).plan;
    const seedM = scoreSolution(seed, ctx);
    const optM = scoreSolution(opt, ctx);
    expect(optM.fairnessStdev).toBeLessThanOrEqual(seedM.fairnessStdev + 1e-9);
  });
});

describe('optimize — eligibility pre-gate, wall-clock budget, movable day types', () => {
  it('spends no resolve on a provider who is on PTO for the whole block (pre-gate)', () => {
    // pA takes Tue s1; its post-call block strands Wed s2 (pZ is on PTO all
    // month). EVERY candidate move involves pZ -> all trials gate out:
    // eviction (s2<-pA, s1<-pZ) and swap (s1->pZ). Zero resolves spent.
    const pA = prov('pA');
    const pZ = prov('pZ');
    const slots = [callSlot('s1', '2026-01-06', 'C1'), callSlot('s2', '2026-01-07', 'C1')];
    const ctx = buildCtx(slots, [pA, pZ], {
      availByPid: new Map([['pZ', [{
        availability_type: 'pto', start_date: '2026-01-01', end_date: '2026-01-31',
        approval_status: 'approved',
      }]]]),
    });
    const seed = solve(ctx);
    expect(seed.unfilled.map(u => u.slot_id)).toEqual(['s2']); // scenario sanity
    const { plan, stats } = optimize(ctx);
    expect(stats.resolves).toBe(0);
    expect(stats.gatedSkips).toBeGreaterThan(0);
    expect(typeof stats.wallMs).toBe('number');
    // Gating skipped only no-improvement trials: outcome matches the seed.
    expect(plan.assignments.map(a => `${a.slot_id}:${a.provider_id}`).sort())
      .toEqual(seed.assignments.map(a => `${a.slot_id}:${a.provider_id}`).sort());
  });

  it('a wallClockMs budget of 0 returns the seed plan unchanged', () => {
    // Same fixture as the stranded-slot test: normal optimize DOES improve it
    // (existing test above), so an unchanged result proves the budget bit.
    const pX = prov('pX');
    const pY = prov('pY', 1, { available_weekdays: [true, true, true, false, true, true, true] });
    const slots = [callSlot('s1', '2026-01-06', 'C1'), callSlot('s2', '2026-01-07', 'C1')];
    const ctx = buildCtx(slots, [pX, pY]);
    const seed = solve(ctx);
    const { plan, stats } = optimize(ctx, { wallClockMs: 0 });
    expect(stats.resolves).toBe(0);
    expect(plan.assignments.map(a => `${a.slot_id}:${a.provider_id}`).sort())
      .toEqual(seed.assignments.map(a => `${a.slot_id}:${a.provider_id}`).sort());
    expect(plan.unfilled.map(u => u.slot_id)).toEqual(seed.unfilled.map(u => u.slot_id));
  });

  it('does not move a saturday placement under the classic pattern (quota-relaxed included)', () => {
    // Two Saturday C1 slots, weekend quota 1 each. Greedy: s1->pX (main-loop),
    // then s2->pX via UNCONDITIONAL quota relaxation (pY is on PTO that day, so
    // the sweep is pX bucket-quota + pY availability — the relax sweep fires
    // and pX is the only legal fill). Fairness would improve by handing s1 to
    // pY, but classic optimizerMovableDayTypes is weekday+friday: saturday
    // placements — main-loop AND quota-relaxed — must not move.
    const mkCtx = (over: Partial<GenerationContext> = {}) => buildCtx(
      [callSlot('s1', '2026-01-03', 'C1', 'saturday'), callSlot('s2', '2026-01-10', 'C1', 'saturday')],
      [prov('pX'), prov('pY')],
      {
        bucketTarget: new Map([['pX|saturday|C1', 1], ['pY|saturday|C1', 1]]),
        availByPid: new Map([['pY', [{
          availability_type: 'pto', start_date: '2026-01-10', end_date: '2026-01-10',
          approval_status: 'approved',
        }]]]),
        ...over,
      },
    );
    const classic = optimize(mkCtx()).plan;
    expect(classic.unfilled).toEqual([]);
    expect(classic.assignments.find(a => a.slot_id === 's1')?.provider_id).toBe('pX');
    const s2Classic = classic.assignments.find(a => a.slot_id === 's2');
    expect(s2Classic?.provider_id).toBe('pX');
    expect(s2Classic?.source).toBe('quota-relaxed');

    // Control (proves the fairness swap exists): a pattern that DOES allow
    // moving saturday slots lets the swap hand s1 to pY. blocks: [] because
    // chain ANCHORS are immovable regardless of day type (2026-07-16 defect-2
    // fix) — classic saturday C1 triggers the weekend chain, so the control
    // drops the blocks to isolate the day-type gate this test pins.
    const saturdayMovable = optimize(mkCtx({
      callPattern: { ...CLASSIC_PATTERN, blocks: [], optimizerMovableDayTypes: ['weekday', 'friday', 'saturday'] },
    })).plan;
    expect(saturdayMovable.unfilled).toEqual([]);
    expect(saturdayMovable.assignments.find(a => a.slot_id === 's1')?.provider_id).toBe('pY');
    expect(saturdayMovable.assignments.find(a => a.slot_id === 's2')?.provider_id).toBe('pX');
  });

  // 2026-07-16 optimizer/greedy parity: greedy may relax quotas; the optimizer
  // must (a) treat 'quota-relaxed' placements as movable, (b) not gate eviction
  // moves into quota-starved slots dead-on-arrival, and (c) re-validate pinned
  // providers WITHOUT the quota (a pin re-asserts an already-made placement).
  // Any of the three missing leaves the eviction unreachable or self-rejecting
  // ('Forced provider ineligible').
  it('quota starvation: eviction fills a hard-blocked slot without unfilling relaxed placements', () => {
    const pX = prov('pX');
    const pY = prov('pY', 1, { available_weekdays: [true, true, true, false, true, true, true] }); // Wed off
    const s1 = callSlot('s1', '2026-01-06', 'C1'); // Tue
    const s2 = callSlot('s2', '2026-01-07', 'C1'); // Wed
    const ctx = buildCtx([s1, s2], [pX, pY], {
      bucketTarget: new Map(), // quota-exhausted: every target 0
    });
    const seed = solve(ctx);
    // Greedy: s1 relax-fills with pX (id tie); pX's post-call block + pY's
    // Wednesday unavailability then hard-block s2.
    expect(seed.assignments.find(a => a.slot_id === 's1')?.source).toBe('quota-relaxed');
    expect(seed.unfilled.map(u => u.slot_id)).toEqual(['s2']);

    const opt = optimize(ctx).plan;
    // Eviction (s1->pY frees pX for s2) requires all three fixes above.
    expect(opt.assignments.some(a => a.slot_id === 's1')).toBe(true);
    expect(opt.assignments.some(a => a.slot_id === 's2')).toBe(true);
    expect(opt.unfilled).toEqual([]);
    expect(opt.unfilled.some(u => u.reason === 'Forced provider ineligible')).toBe(false);
  });
});

// ── per-slot fill monotonicity (2026-07-16 PROOF defect 1) ───────────────────
// Accepted trials used to trade FILLED slots for HOLES at equal-or-better
// aggregate skip counts: a pinned provider made ineligible by cascaded shifts
// dropped its slot ('Forced provider ineligible') without re-opening it to the
// pool. A trial is now acceptable ONLY if every slot filled in the incumbent
// stays filled (fill-set superset-or-equal), making optimizer holes
// structurally impossible.
describe('optimize — per-slot fill monotonicity (never trades holes)', () => {
  it('final fill set ⊇ greedy fill set on a quota-starved block', () => {
    // Quota-starved (every target 0): greedy relax-fills s1 (Tue) + s3 (Thu)
    // with pX; s2 (Wed) is a hole (pX post-call-blocked, pY Wed-off). The
    // eviction trial {s1→pY, s2→pX, s3 pinned→pX} cascades pX's Wed post-call
    // block onto Thursday, self-rejecting the pinned s3 — equal aggregate
    // skips (1), better fairness stdev. Accepting it TRADES the s3 fill for
    // the s2 hole. Monotonicity must reject the trade.
    const pX = prov('pX');
    // pY: Wed(3) + Thu(4) off — only ever a candidate for Tuesday.
    const pY = prov('pY', 1, { available_weekdays: [true, true, true, false, false, true, true] });
    const s1 = callSlot('s1', '2026-01-06', 'C1'); // Tue
    const s2 = callSlot('s2', '2026-01-07', 'C1'); // Wed
    const s3 = callSlot('s3', '2026-01-08', 'C1'); // Thu
    const ctx = buildCtx([s1, s2, s3], [pX, pY], {
      bucketTarget: new Map(), // quota-starved: every target 0
    });

    const greedy = solve(ctx);
    const greedyFilled = greedy.assignments.map(a => a.slot_id).sort();
    expect(greedyFilled).toEqual(['s1', 's3']); // scenario sanity: s2 is the hole

    const opt = optimize(ctx).plan;
    const optFilled = new Set(opt.assignments.map(a => a.slot_id));
    for (const id of greedyFilled) {
      expect(optFilled.has(id), `slot ${id} filled by greedy must stay filled`).toBe(true);
    }
    // No slot may be dropped via a self-rejecting pin.
    expect(opt.unfilled.some(u => u.reason === 'Forced provider ineligible')).toBe(false);
    // And the optimizer still never worsens the aggregate.
    expect(scoreSolution(opt, ctx).skipped)
      .toBeLessThanOrEqual(scoreSolution(greedy, ctx).skipped);
  });
});

// ── chain anchors are immovable (2026-07-16 PROOF defect 2) ──────────────────
// optimize() moved Friday C1 anchors (source 'main-loop', friday in
// optimizerMovableDayTypes) while the +2 Sunday C2 chain partner stayed pinned
// via the override path — severing the designed same-provider pairing. Slots
// whose placement triggered block-chain links are now excluded from the
// movable set; the pairing cannot be severed by optimize().
describe('movableCallSlotIds — chain anchors are immovable', () => {
  it('friday C1 anchor (chains Sun C2) is excluded; a plain friday main-loop fill stays movable', () => {
    const slots = [
      fxCallSlot('friC1', '2026-01-09', 'C1', 'friday'),
      fxCallSlot('friC2', '2026-01-09', 'C2', 'friday'),
      fxCallSlot('sunC2', '2026-01-11', 'C2', 'sunday'),
    ];
    const shiftTypes = new Map([
      ['C1', shiftInfo('C1', { category: 'call', call_rank: 0 })],
      ['C2', shiftInfo('C2', { category: 'call', call_rank: 1 })],
    ]);
    const ctx = buildFxCtx(slots, [fxProv('p1'), fxProv('p2')], {
      callPattern: WEEKEND_V2_PATTERN, shiftTypes,
    });
    const plan = solve(ctx);
    const byId = Object.fromEntries(plan.assignments.map(a => [a.slot_id, a]));
    // Scenario sanity: friC1 is a main-loop anchor whose chain claimed sunC2;
    // friC2 is a plain main-loop friday fill with no block chain.
    expect(byId['friC1']?.source).toBe('main-loop');
    expect(byId['friC2']?.source).toBe('main-loop');
    expect(byId['sunC2']?.source).toBe('weekend-chain');
    expect(byId['sunC2']?.provider_id).toBe(byId['friC1']?.provider_id);

    // The anchor is NOT movable; the plain friday fill still is; the chained
    // sunday partner never was (source + day type).
    expect(movableCallSlotIds(plan, WEEKEND_V2_PATTERN)).toEqual(['friC2']);
  });
});

describe('golden-master / equivalence', () => {
  // A richer block: 4 weeks of weekday C1 + C2, 5 providers of mixed FTE.
  function richCtx() {
    const slots: SlotToFill[] = [];
    const dates = ['2026-01-06', '2026-01-13', '2026-01-20', '2026-01-27']; // Tuesdays
    for (const d of dates) {
      slots.push(callSlot(`c1-${d}`, d, 'C1'));
      slots.push(callSlot(`c2-${d}`, d, 'C2'));
    }
    const providers = [
      prov('pA', 1), prov('pB', 1), prov('pC', 0.5), prov('pD', 0.5), prov('pE', 1),
    ];
    return buildCtx(slots, providers);
  }

  it('full-seed override re-solve reproduces the seed exactly (equivalence)', () => {
    const ctx = richCtx();
    const seed = solve(ctx);
    const seedAssign = extractCallAssignment(seed);
    const replay = solve(ctx, { callOverrides: seedAssign });
    const key = (p: typeof seed) => p.assignments
      .map(a => `${a.slot_id}:${a.provider_id}`).sort();
    expect(key(replay)).toEqual(key(seed));
  });

  it('optimize never increases skips or fairness stdev vs the greedy seed', () => {
    const ctx = richCtx();
    const seed = solve(ctx);
    const seedM = scoreSolution(seed, ctx);
    const opt = optimize(ctx).plan;
    const optM = scoreSolution(opt, ctx);
    expect(optM.skipped).toBeLessThanOrEqual(seedM.skipped);
    // On equal skips, fairness must not get worse.
    if (optM.skipped === seedM.skipped) {
      expect(optM.fairnessStdev).toBeLessThanOrEqual(seedM.fairnessStdev + 1e-9);
    }
  });
});
