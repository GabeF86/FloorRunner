import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { evaluateEligibility } from './eligibility';
import { emptySolveState } from './genTypes';
import { computeWorkDayReport } from './workDayReport';
import { buildCtx, prov, callSlot, dSlot, shiftInfo } from './__fixtures__/buildContext';
import type { WorkDayBudget, ShiftTypeInfo, AvailabilityEntry } from './genTypes';
import type { CallPatternDoc } from './callPattern';

// A pattern with NO chains/relief/passes — isolates the workdays cap from the
// classic post-call/D-fill machinery.
const MINIMAL_PATTERN: CallPatternDoc = {
  version: 1, blocks: [], dayChains: [], spans: [], placementPasses: [],
  reliefPass: { enabled: false, dayTypes: [] }, optimizerMovableDayTypes: [],
};
// Only a post-call BLOCK on +1 for weekday C1 — isolates post-call crediting.
const POST_CALL_PATTERN: CallPatternDoc = {
  version: 1, blocks: [],
  dayChains: [{ trigger: 'C1', dayTypes: ['weekday'], blocks: [{ offset: 1 }] }],
  spans: [], placementPasses: [],
  reliefPass: { enabled: false, dayTypes: [] }, optimizerMovableDayTypes: [],
};

function mkBudget(
  workingDates: string[], required: Record<string, number>,
): WorkDayBudget {
  const byProvider = new Map();
  for (const pid of Object.keys(required)) {
    byProvider.set(pid, {
      fte: 1, workingDays: workingDates.length, ptoWeekdays: 0,
      required: required[pid], entitledOff: 0,
    });
  }
  return {
    workingDays: workingDates.length,
    workingDaySet: new Set(workingDates),
    majorHolidayDates: new Set(),
    byProvider,
  };
}

// ── eligibility: the 'workdays-cap' gate ─────────────────────────────────────
describe('evaluateEligibility — workdays-cap gate', () => {
  const budget = mkBudget(['2026-01-06', '2026-01-07'], { p1: 1 });
  const slot = callSlot('c', '2026-01-07', 'C1'); // weekday, in workingDaySet
  const ctx = buildCtx([slot], [prov('p1')], { workDayBudget: budget, callPattern: MINIMAL_PATTERN });

  it('passes when credited count is below required', () => {
    const state = emptySolveState();
    expect(evaluateEligibility(slot, prov('p1'), state, ctx, 'call').eligible).toBe(true);
  });

  it("rejects with 'workdays-cap' once credited reaches required (call gate)", () => {
    const state = emptySolveState();
    state.creditedWorkDays.set('p1', new Set(['2026-01-06'])); // size 1 == required
    const r = evaluateEligibility(slot, prov('p1'), state, ctx, 'call');
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('workdays-cap');
  });

  it('applies to the derived gate too (relief / mop-up / d-chains)', () => {
    const dslot = dSlot('d', '2026-01-07', 'D4');
    const state = emptySolveState();
    state.creditedWorkDays.set('p1', new Set(['2026-01-06']));
    expect(evaluateEligibility(dslot, prov('p1'), state, ctx, 'derived').reason).toBe('workdays-cap');
  });

  it('is WAIVED under call-no-quota (optimizer pins / chain links never self-reject)', () => {
    const state = emptySolveState();
    state.creditedWorkDays.set('p1', new Set(['2026-01-06']));
    expect(evaluateEligibility(slot, prov('p1'), state, ctx, 'call-no-quota').eligible).toBe(true);
  });

  it('exempts weekend / non-working-day slots (no credit consumed there)', () => {
    const satSlot = callSlot('s', '2026-01-10', 'C1', 'saturday'); // not in workingDaySet
    // Include the Saturday slot so its bucket target exists (else quota, not the
    // cap, would reject) — isolates the weekend cap-exemption.
    const satCtx = buildCtx([satSlot], [prov('p1')], { workDayBudget: budget, callPattern: MINIMAL_PATTERN });
    const state = emptySolveState();
    state.creditedWorkDays.set('p1', new Set(['2026-01-06']));
    expect(evaluateEligibility(satSlot, prov('p1'), state, satCtx, 'call').eligible).toBe(true);
  });

  it('never fires without a budget on ctx (byte-identical no-cap path)', () => {
    const noBudget = buildCtx([slot], [prov('p1')], { callPattern: MINIMAL_PATTERN });
    const state = emptySolveState();
    state.creditedWorkDays.set('p1', new Set(['2026-01-06', '2026-01-05']));
    expect(evaluateEligibility(slot, prov('p1'), state, noBudget, 'call').eligible).toBe(true);
  });
});

// ── solve: weekday placements consume credits; cap leaves slots open ──────────
describe('solve — workdays cap on call placements', () => {
  it('caps weekday call placements at required and leaves the rest open (workdays-cap)', () => {
    const slots = [
      callSlot('mon', '2026-01-05', 'C1'),
      callSlot('tue', '2026-01-06', 'C1'),
      callSlot('wed', '2026-01-07', 'C1'),
    ];
    const ctx = buildCtx(slots, [prov('p1')], {
      callPattern: MINIMAL_PATTERN,
      workDayBudget: mkBudget(['2026-01-05', '2026-01-06', '2026-01-07'], { p1: 2 }),
    });
    const plan = solve(ctx);
    const p1Dates = plan.assignments.filter(a => a.provider_id === 'p1').map(a => a.slot_date).sort();
    expect(p1Dates).toEqual(['2026-01-05', '2026-01-06']);
    const wed = plan.unfilled.find(u => u.slot_date === '2026-01-07');
    expect(wed?.reason).toBe('workdays-cap');
  });

  it('weekend call placements are exempt (consume no weekday credit)', () => {
    const slots = [
      callSlot('mon', '2026-01-05', 'C1'),
      callSlot('tue', '2026-01-06', 'C1'),
      callSlot('sat', '2026-01-10', 'C1', 'saturday'),
    ];
    const ctx = buildCtx(slots, [prov('p1')], {
      callPattern: MINIMAL_PATTERN,
      workDayBudget: mkBudget(['2026-01-05', '2026-01-06', '2026-01-07'], { p1: 2 }),
    });
    const plan = solve(ctx);
    const p1Dates = plan.assignments.filter(a => a.provider_id === 'p1').map(a => a.slot_date).sort();
    // Both weekdays (2 credits) AND the Saturday (exempt) fill.
    expect(p1Dates).toEqual(['2026-01-05', '2026-01-06', '2026-01-10']);
  });

  it('a post-call rest day on a weekday consumes a credit (marked at block time)', () => {
    const slots = [
      callSlot('mon', '2026-01-05', 'C1'), // → post-call block Tue (weekday) credits
      callSlot('wed', '2026-01-07', 'C1'),
    ];
    const ctx = buildCtx(slots, [prov('p1')], {
      callPattern: POST_CALL_PATTERN,
      workDayBudget: mkBudget(['2026-01-05', '2026-01-06', '2026-01-07'], { p1: 2 }),
    });
    const plan = solve(ctx);
    // Mon call (credit Mon) + Tue post-call block (credit Tue) = 2 = required,
    // so Wed is capped.
    expect(plan.assignments.filter(a => a.provider_id === 'p1').map(a => a.slot_date)).toEqual(['2026-01-05']);
    expect(plan.unfilled.find(u => u.slot_date === '2026-01-07')?.reason).toBe('workdays-cap');
  });

  it('ICU-week weekdays credit as worked and count toward the cap', () => {
    const icu: AvailabilityEntry[] = [{
      availability_type: 'blocked', reason_code: 'icu_week',
      start_date: '2026-01-05', end_date: '2026-01-07', approval_status: 'approved',
    }];
    const slots = [callSlot('thu', '2026-01-08', 'C1')]; // free of ICU
    const ctx = buildCtx(slots, [prov('p1')], {
      callPattern: MINIMAL_PATTERN,
      availByPid: new Map([['p1', icu]]),
      workDayBudget: mkBudget(['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'], { p1: 2 }),
    });
    const plan = solve(ctx);
    // ICU credited Mon/Tue/Wed (3) already ≥ required 2 → Thu capped.
    expect(plan.assignments.filter(a => a.provider_id === 'p1')).toHaveLength(0);
    expect(plan.unfilled.find(u => u.slot_date === '2026-01-08')?.reason).toBe('workdays-cap');
  });

  it('a second uncapped provider still fills a slot the capped one cannot (relaxation respects the cap)', () => {
    const slots = [
      callSlot('mon', '2026-01-05', 'C1'),
      callSlot('tue', '2026-01-06', 'C1'),
    ];
    // p1 required 1 (caps after Mon); p2 required 5 (roomy). Quota target 99 so
    // fairness never blocks — this isolates the cap → relaxation interaction.
    const ctx = buildCtx(slots, [prov('p1'), prov('p2')], {
      callPattern: MINIMAL_PATTERN,
      workDayBudget: mkBudget(['2026-01-05', '2026-01-06'], { p1: 1, p2: 5 }),
    });
    const plan = solve(ctx);
    expect(plan.unfilled).toHaveLength(0);
    // Tue must NOT go to the capped p1.
    const tue = plan.assignments.find(a => a.slot_date === '2026-01-06');
    expect(tue?.provider_id).toBe('p2');
  });

  it('relief pass respects the cap (a capped provider is not relief-ranked in)', () => {
    const shiftTypes = new Map<string, ShiftTypeInfo>([
      ['C1', shiftInfo('C1', { category: 'call', call_rank: 0, generation_engine: 'call' })],
      ['D4', shiftInfo('D4', { category: 'regular', relief_rank: 1, generation_engine: 'call' })],
    ]);
    const slots = [
      callSlot('mon', '2026-01-05', 'C1'),
      dSlot('reliefTue', '2026-01-06', 'D4'),
    ];
    const reliefPat: CallPatternDoc = {
      ...MINIMAL_PATTERN, reliefPass: { enabled: true, dayTypes: ['weekday'] },
    };
    const ctx = buildCtx(slots, [prov('p1')], {
      callPattern: reliefPat, shiftTypes,
      workDayBudget: mkBudget(['2026-01-05', '2026-01-06'], { p1: 1 }),
    });
    const plan = solve(ctx);
    // Mon C1 caps p1 at 1; the Tue relief slot cannot be filled by p1.
    expect(plan.assignments.some(a => a.slot_date === '2026-01-06')).toBe(false);
    expect(plan.unfilled.find(u => u.slot_date === '2026-01-06')?.reason).toBe('No eligible relief provider');
  });
});

// ── report ───────────────────────────────────────────────────────────────────
describe('computeWorkDayReport', () => {
  it('returns [] with no budget on ctx', () => {
    const ctx = buildCtx([callSlot('c', '2026-01-05', 'C1')], [prov('p1')]);
    expect(computeWorkDayReport(ctx, solve(ctx))).toEqual([]);
  });

  it('reports fte/workingDays/pto/required/credited/entitledOff/delta per provider', () => {
    const slots = [
      callSlot('mon', '2026-01-05', 'C1'),
      callSlot('tue', '2026-01-06', 'C1'),
    ];
    const budget = mkBudget(['2026-01-05', '2026-01-06', '2026-01-07'], { p1: 2 });
    const ctx = buildCtx(slots, [prov('p1')], { callPattern: MINIMAL_PATTERN, workDayBudget: budget });
    const plan = solve(ctx);
    const rows = computeWorkDayReport(ctx, plan);
    const r = rows.find(x => x.provider_id === 'p1')!;
    expect(r.fte).toBe(1);
    expect(r.workingDays).toBe(3);
    expect(r.required).toBe(2);
    expect(r.credited.assignments).toBe(2);
    expect(r.credited.total).toBe(2);
    expect(r.delta).toBe(0);
  });

  it('splits credited into assignments / postCall / icu (under-delta when required is roomy)', () => {
    const icu: AvailabilityEntry[] = [{
      availability_type: 'blocked', reason_code: 'icu_week',
      start_date: '2026-01-08', end_date: '2026-01-08', approval_status: 'approved',
    }];
    const slots = [callSlot('mon', '2026-01-05', 'C1')]; // → post-call block Tue
    // required 5 so the ICU pre-credit (Thu) does not cap the Monday call.
    const budget = mkBudget(['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'], { p1: 5 });
    const ctx = buildCtx(slots, [prov('p1')], {
      callPattern: POST_CALL_PATTERN, workDayBudget: budget,
      availByPid: new Map([['p1', icu]]),
    });
    const plan = solve(ctx);
    const r = computeWorkDayReport(ctx, plan).find(x => x.provider_id === 'p1')!;
    expect(r.credited.assignments).toBe(1); // Mon call
    expect(r.credited.postCall).toBe(1);    // Tue post-call rest
    expect(r.credited.icu).toBe(1);         // Thu ICU
    expect(r.credited.total).toBe(3);
    expect(r.required).toBe(5);
    expect(r.delta).toBe(-2); // under by 2
  });

  it('mandated post-call rest can push credited OVER required (over-delta)', () => {
    // required 1: the Monday call reaches the cap; the +1 post-call block on Tue
    // is marked regardless (invariant 1, bypasses the cap) → credited 2, over 1.
    const slots = [callSlot('mon', '2026-01-05', 'C1')];
    const budget = mkBudget(['2026-01-05', '2026-01-06', '2026-01-07'], { p1: 1 });
    const ctx = buildCtx(slots, [prov('p1')], { callPattern: POST_CALL_PATTERN, workDayBudget: budget });
    const r = computeWorkDayReport(ctx, solve(ctx)).find(x => x.provider_id === 'p1')!;
    expect(r.credited.assignments).toBe(1);
    expect(r.credited.postCall).toBe(1);
    expect(r.credited.icu).toBe(0);
    expect(r.credited.total).toBe(2);
    expect(r.required).toBe(1);
    expect(r.delta).toBe(1); // over by 1
  });
});
