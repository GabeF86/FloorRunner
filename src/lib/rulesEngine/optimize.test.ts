import { describe, it, expect } from 'vitest';
import { optimize, extractCallAssignment, compareMetrics } from './optimize';
import { solve } from './solve';
import { scoreSolution } from './metrics';
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

    const optimized = optimize(ctx);
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
    const opt = optimize(ctx);
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
    const optimized = optimize(ctx);
    expect(scoreSolution(optimized, ctx).skipped)
      .toBeLessThanOrEqual(scoreSolution(seed, ctx).skipped);
  });

  it('is deterministic: two runs give identical assignments', () => {
    const mk = () => buildCtx(
      [callSlot('s1', '2026-01-06', 'C1'), callSlot('s2', '2026-01-13', 'C1')],
      [prov('pB'), prov('pA')],
    );
    const a = optimize(mk());
    const b = optimize(mk());
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
    const opt = optimize(ctx);
    const seedM = scoreSolution(seed, ctx);
    const optM = scoreSolution(opt, ctx);
    expect(optM.fairnessStdev).toBeLessThanOrEqual(seedM.fairnessStdev + 1e-9);
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
    const opt = optimize(ctx);
    const optM = scoreSolution(opt, ctx);
    expect(optM.skipped).toBeLessThanOrEqual(seedM.skipped);
    // On equal skips, fairness must not get worse.
    if (optM.skipped === seedM.skipped) {
      expect(optM.fairnessStdev).toBeLessThanOrEqual(seedM.fairnessStdev + 1e-9);
    }
  });
});
