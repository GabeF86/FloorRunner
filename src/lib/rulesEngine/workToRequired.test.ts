import { describe, it, expect } from 'vitest';
import { solve } from './solve';
import { computeWorkDayReport } from './workDayReport';
import { buildCtx, prov, callSlot, dSlot, cred, shiftInfo } from './__fixtures__/buildContext';
import type { WorkDayBudget, ShiftTypeInfo, SeedAssignment, SolutionPlan } from './genTypes';
import type { CallPatternDoc } from './callPattern';

// ── work-to-required (2026-07-24) ────────────────────────────────────────────
// Gabriel: "make sure the scheduler checks to make sure everyone is working
// the maximum number of obligatory work days." Required working days
// (round(FTE × WD) − PTO, workDays.ts — untouched) become a target to REACH,
// not only a ceiling:
//   1. ROOT CAUSE: the relief pass pre-filtered the whole date's candidate
//      pool against ONE sample code, so a provider ineligible for the sample
//      (per-code credential exclude) was dropped for EVERY code that date —
//      contradicting the documented per-code rescan. An under-required
//      provider idled while relief inventory sat open.
//   2. Relief + mop-up ranking gain a workday-DEFICIT factor. Design:
//      the FIRST existing relief slot per date is the "early-out" position —
//      its holder leaves first, so next-call adjacency stays PRIMARY there
//      (deficit only breaks exact clinical ties). Every later relief position
//      and every mop-up orphan is pure inventory: deficit (required − credited,
//      descending) is the PRIMARY tier, the clinical next-call tuple preserved
//      within a tier.
//   3. The workdays CAP is unchanged: target ≤ credited ≤ cap.
//   4. Completeness (workDayReport.shortfall): every under-required provider is
//      named with the count and their idle working days classified
//      engine-gap (an open compatible slot remained) vs staffing reality
//      (no open compatible slot) — never silent, never conflated.

const RELIEF_PATTERN: CallPatternDoc = {
  version: 1, blocks: [], dayChains: [], spans: [], placementPasses: [],
  reliefPass: { enabled: true, dayTypes: ['weekday', 'friday'] },
  optimizerMovableDayTypes: [],
};
const NO_RELIEF_PATTERN: CallPatternDoc = {
  version: 1, blocks: [], dayChains: [], spans: [], placementPasses: [],
  reliefPass: { enabled: false, dayTypes: [] }, optimizerMovableDayTypes: [],
};

const ST = new Map<string, ShiftTypeInfo>([
  ['C1', shiftInfo('C1', { category: 'call', call_rank: 0, generation_engine: 'call' })],
  ['C2', shiftInfo('C2', { category: 'call', call_rank: 1, generation_engine: 'call' })],
  ['D1', shiftInfo('D1', { generation_engine: 'call' })],
  ['D4', shiftInfo('D4', { relief_rank: 1, generation_engine: 'call' })],
  ['D5', shiftInfo('D5', { relief_rank: 2, generation_engine: 'call' })],
  ['D6', shiftInfo('D6', { relief_rank: 3, generation_engine: 'call' })],
]);

function mkBudget(workingDates: string[], required: Record<string, number>): WorkDayBudget {
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

const seed = (
  pid: string, date: string, code: string, category = 'call', dt = 'weekday',
): SeedAssignment => ({
  slot_date: date, provider_id: pid, shift_type_code: code,
  shift_type_category: category, derived_day_type: dt,
});

const emptyPlan = (): SolutionPlan => ({
  assignments: [], unfilled: [], skippedDerived: [], chainAnchorSlotIds: [],
});

// Week of Mon 2026-01-05 .. Fri 2026-01-09 (all weekdays; 01-09 is a Friday).
const MON = '2026-01-05', TUE = '2026-01-06', WED = '2026-01-07',
  THU = '2026-01-08', FRI = '2026-01-09';

// ── 1. ROOT CAUSE: the sample-code prefilter dropped whole-date candidates ──
describe('relief pass — per-code eligibility (sample-code prefilter defect)', () => {
  it('a provider credential-excluded from the sample code is still placed on a later code that date', () => {
    const slots = [dSlot('d4', WED, 'D4'), dSlot('d5', WED, 'D5')];
    const ctx = buildCtx(slots, [prov('pA')], {
      callPattern: RELIEF_PATTERN, shiftTypes: ST,
      credByPid: new Map([['pA', cred({ excluded_shift_types: ['D4'] })]]),
    });
    const plan = solve(ctx);
    // pA is excluded from D4 (the sample code) but fully eligible for D5.
    const d5 = plan.assignments.find(a => a.slot_id === 'd5');
    expect(d5?.provider_id).toBe('pA');
    expect(d5?.source).toBe('relief-order');
    // D4 stays honestly open (credential), reported exactly once.
    expect(plan.unfilled.map(u => u.slot_id)).toEqual(['d4']);
  });
});

// ── 2. Deficit-preference ordering (relief) ─────────────────────────────────
describe('relief ranking — workday deficit factor', () => {
  // pB: seeded call Thu (next-call distance 1 from Wed, credited Thu → deficit 1)
  // pC: seeded call Fri (distance 2, credited Fri → deficit 1)
  // pA: no calls (distance ∞), nothing credited.
  const orderingCtx = (requiredA: number) => buildCtx(
    [dSlot('d4', WED, 'D4'), dSlot('d5', WED, 'D5')],
    [prov('pA'), prov('pB'), prov('pC')],
    {
      callPattern: RELIEF_PATTERN, shiftTypes: ST,
      seedAssignments: [seed('pB', THU, 'C1'), seed('pC', FRI, 'C2', 'call', 'friday')],
      workDayBudget: mkBudget([MON, TUE, WED, THU, FRI], { pA: requiredA, pB: 2, pC: 2 }),
    },
  );

  it('the FIRST relief position (early-out) keeps clinical next-call order even against a larger deficit', () => {
    const plan = solve(orderingCtx(4)); // pA deficit 4
    // D4 = early-out: pB (call tomorrow) wins despite pA's larger deficit.
    expect(plan.assignments.find(a => a.slot_id === 'd4')?.provider_id).toBe('pB');
  });

  it('later relief positions are inventory: the larger workday deficit wins', () => {
    const plan = solve(orderingCtx(4)); // pA deficit 4 vs pC deficit 1
    expect(plan.assignments.find(a => a.slot_id === 'd5')?.provider_id).toBe('pA');
  });

  it('within an equal-deficit tier the clinical next-call order is preserved', () => {
    const plan = solve(orderingCtx(1)); // pA deficit 1 == pC deficit 1
    // pC (next call in 2 days) beats pA (no future call) at equal deficit.
    expect(plan.assignments.find(a => a.slot_id === 'd5')?.provider_id).toBe('pC');
  });
});

// ── 3. Mojica shape: under-required provider + open block-end inventory ─────
describe('relief — under-required provider works the open inventory until required or exhaustion', () => {
  // pB/pC reach required (2) via seeded Mon+Tue calls → workdays-capped from
  // Wed. pA (credential-excluded from D4 — the live per-code shape) is the
  // only remaining taker for the block-end D5 inventory.
  const mojicaCtx = (requiredA: number) => buildCtx(
    [
      dSlot('d4w', WED, 'D4'), dSlot('d5w', WED, 'D5'),
      dSlot('d4t', THU, 'D4'), dSlot('d5t', THU, 'D5'),
      dSlot('d4f', FRI, 'D4', 'friday'), dSlot('d5f', FRI, 'D5', 'friday'),
    ],
    [prov('pA'), prov('pB'), prov('pC')],
    {
      callPattern: RELIEF_PATTERN, shiftTypes: ST,
      credByPid: new Map([['pA', cred({ excluded_shift_types: ['D4'] })]]),
      seedAssignments: [
        seed('pB', MON, 'C1'), seed('pB', TUE, 'C1'),
        seed('pC', MON, 'C2'), seed('pC', TUE, 'C2'),
      ],
      workDayBudget: mkBudget([MON, TUE, WED, THU, FRI], { pA: requiredA, pB: 2, pC: 2 }),
    },
  );

  it('places the under-required provider on every compatible open slot until inventory exhausts', () => {
    const plan = solve(mojicaCtx(4));
    const aFills = plan.assignments.filter(a => a.provider_id === 'pA');
    expect(aFills.map(a => a.slot_id).sort()).toEqual(['d5f', 'd5t', 'd5w']);
    expect(aFills.every(a => a.source === 'relief-order')).toBe(true);
    // The D4s stay honestly open: pA excluded, pB/pC at cap.
    expect(plan.unfilled.map(u => u.slot_id).sort()).toEqual(['d4f', 'd4t', 'd4w']);
    for (const u of plan.unfilled) expect(u.reason).toBe('No eligible relief provider');
  });

  it('reports the residual shortfall with idle days classified (staffing reality — no open compatible slots)', () => {
    const ctx = mojicaCtx(4);
    const rows = computeWorkDayReport(ctx, solve(ctx));
    const a = rows.find(r => r.provider_id === 'pA')!;
    expect(a.credited.total).toBe(3);
    expect(a.required).toBe(4);
    expect(a.delta).toBe(-1);
    // Idle Mon+Tue had no slots at all → staffing reality, not an engine gap.
    expect(a.shortfall).toEqual({
      days: 1, engineGapDates: [], noSlotDates: [MON, TUE],
    });
    // At-required providers carry NO shortfall (never conflated).
    expect(rows.find(r => r.provider_id === 'pB')!.shortfall).toBeUndefined();
    expect(rows.find(r => r.provider_id === 'pC')!.shortfall).toBeUndefined();
  });

  it('the workdays cap still binds: credited never exceeds required', () => {
    const plan = solve(mojicaCtx(2)); // pA required 2 < 3 open D5s
    const aFills = plan.assignments.filter(a => a.provider_id === 'pA');
    expect(aFills).toHaveLength(2);
    expect(aFills.map(a => a.slot_id).sort()).toEqual(['d5t', 'd5w']);
    // Friday's D5 is refused at the cap and reported, never silently dropped.
    expect(plan.unfilled.map(u => u.slot_id)).toContain('d5f');
    const ctx = mojicaCtx(2);
    const a = computeWorkDayReport(ctx, solve(ctx)).find(r => r.provider_id === 'pA')!;
    expect(a.delta).toBe(0);
    expect(a.shortfall).toBeUndefined();
  });

  it('keeps placing on one date while eligible under-required providers and open slots remain', () => {
    const slots = [dSlot('x4', WED, 'D4'), dSlot('x5', WED, 'D5'), dSlot('x6', WED, 'D6')];
    const ctx = buildCtx(slots, [prov('pA'), prov('pB'), prov('pC')], {
      callPattern: RELIEF_PATTERN, shiftTypes: ST,
      workDayBudget: mkBudget([WED, THU, FRI], { pA: 2, pB: 2, pC: 2 }),
    });
    const plan = solve(ctx);
    expect(plan.assignments).toHaveLength(3);
    expect(new Set(plan.assignments.map(a => a.provider_id)).size).toBe(3);
    expect(plan.unfilled).toHaveLength(0);
  });
});

// ── 4. Mop-up sweep uses the deficit factor (pure inventory) ────────────────
describe('mop-up — deficit-preferred inventory ranking', () => {
  it('an orphan call-engine day slot goes to the larger-deficit provider', () => {
    // D5 here has NO relief_rank (not relief inventory) → mop-up owns it.
    const st = new Map<string, ShiftTypeInfo>([
      ['C1', shiftInfo('C1', { category: 'call', call_rank: 0, generation_engine: 'call' })],
      ['D5', shiftInfo('D5', { generation_engine: 'call' })],
    ]);
    const ctx = buildCtx([dSlot('d5', WED, 'D5')], [prov('pA'), prov('pB')], {
      callPattern: NO_RELIEF_PATTERN, shiftTypes: st,
      seedAssignments: [seed('pB', THU, 'C1')], // pB: next call in 1 day, credited Thu
      workDayBudget: mkBudget([MON, TUE, WED, THU, FRI], { pA: 2, pB: 2 }),
    });
    const plan = solve(ctx);
    const d5 = plan.assignments.find(a => a.slot_id === 'd5');
    // pA deficit 2 beats pB deficit 1 — next-call adjacency is not the primary
    // key for orphaned inventory.
    expect(d5?.provider_id).toBe('pA');
    expect(d5?.source).toBe('day-mop-up');
  });
});

// ── 5. Completeness report: engine gap vs staffing reality ──────────────────
describe('workDayReport.shortfall — under-required providers are named, dates classified', () => {
  const budget = () => mkBudget([MON, TUE, WED], { pA: 3 });

  it('an idle day with an open compatible slot is an ENGINE GAP', () => {
    const ctx = buildCtx([dSlot('d5', WED, 'D5')], [prov('pA')], {
      callPattern: NO_RELIEF_PATTERN, shiftTypes: ST,
      seedAssignments: [seed('pA', MON, 'D1', 'regular'), seed('pA', TUE, 'D1', 'regular')],
      workDayBudget: budget(),
    });
    const a = computeWorkDayReport(ctx, emptyPlan()).find(r => r.provider_id === 'pA')!;
    expect(a.delta).toBe(-1);
    expect(a.shortfall).toEqual({ days: 1, engineGapDates: [WED], noSlotDates: [] });
  });

  it('an idle day with no open compatible slot is STAFFING REALITY', () => {
    const ctx = buildCtx([], [prov('pA')], {
      callPattern: NO_RELIEF_PATTERN, shiftTypes: ST,
      seedAssignments: [seed('pA', MON, 'D1', 'regular'), seed('pA', TUE, 'D1', 'regular')],
      workDayBudget: budget(),
    });
    const a = computeWorkDayReport(ctx, emptyPlan()).find(r => r.provider_id === 'pA')!;
    expect(a.shortfall).toEqual({ days: 1, engineGapDates: [], noSlotDates: [WED] });
  });

  it('the delete-cascade shape (open call + open companion) surfaces as engine gaps', () => {
    // A C2 delete cascade re-opened the call AND its D-companion; the provider
    // now idles both days while both slots sit open — both engine-addressable.
    const ctx = buildCtx(
      [callSlot('c2', TUE, 'C2'), dSlot('d1', WED, 'D1')],
      [prov('pA')],
      {
        callPattern: NO_RELIEF_PATTERN, shiftTypes: ST,
        seedAssignments: [seed('pA', MON, 'D1', 'regular')],
        workDayBudget: budget(),
      },
    );
    const a = computeWorkDayReport(ctx, emptyPlan()).find(r => r.provider_id === 'pA')!;
    expect(a.shortfall).toEqual({ days: 2, engineGapDates: [TUE, WED], noSlotDates: [] });
  });

  it('a slot already filled by the plan is not an open slot', () => {
    const slot = dSlot('d5', WED, 'D5');
    const ctx = buildCtx([slot], [prov('pA'), prov('pB')], {
      callPattern: NO_RELIEF_PATTERN, shiftTypes: ST,
      seedAssignments: [seed('pA', MON, 'D1', 'regular'), seed('pA', TUE, 'D1', 'regular')],
      workDayBudget: mkBudget([MON, TUE, WED], { pA: 3, pB: 3 }),
    });
    const plan = emptyPlan();
    plan.assignments.push({
      slot_id: 'd5', slot_date: WED, shift_type_code: 'D5', shift_type_category: 'regular',
      derived_day_type: 'weekday', provider_id: 'pB', provider_name: 'pB',
      existing_assignment_id: null, source: 'relief-order',
    });
    const a = computeWorkDayReport(ctx, plan).find(r => r.provider_id === 'pA')!;
    expect(a.shortfall).toEqual({ days: 1, engineGapDates: [], noSlotDates: [WED] });
  });

  it('sequence-owned slots are NOT engine-addressable inventory (chain-owned, reported elsewhere)', () => {
    const chainDoc: CallPatternDoc = {
      ...NO_RELIEF_PATTERN,
      dayChains: [{ trigger: 'C2', dayTypes: ['weekday'], links: [{ offset: 1, code: 'D1' }] }],
    };
    // The Wed D1 is owned by Tuesday's (absent) C2 anchor — a permanent orphan
    // the mop-up reports; it is never direct-fill inventory, so pA's idle Wed
    // is a staffing reality, not an engine gap.
    const ctx = buildCtx([dSlot('d1', WED, 'D1')], [prov('pA')], {
      callPattern: chainDoc, shiftTypes: ST,
      seedAssignments: [seed('pA', MON, 'D1', 'regular'), seed('pA', TUE, 'D2', 'regular')],
      workDayBudget: budget(),
    });
    const a = computeWorkDayReport(ctx, emptyPlan()).find(r => r.provider_id === 'pA')!;
    expect(a.shortfall).toEqual({ days: 1, engineGapDates: [], noSlotDates: [WED] });
  });

  it('a provider on netting PTO is not "idle" on those days (they reduced required already)', () => {
    const ctx = buildCtx([], [prov('pA')], {
      callPattern: NO_RELIEF_PATTERN, shiftTypes: ST,
      availByPid: new Map([['pA', [{
        availability_type: 'pto', start_date: WED, end_date: WED, approval_status: 'approved',
      }]]]),
      seedAssignments: [seed('pA', MON, 'D1', 'regular')],
      // required already netted by the budget builder: 3 WD − 1 PTO = 2.
      workDayBudget: (() => {
        const b = mkBudget([MON, TUE, WED], { pA: 2 });
        b.byProvider.get('pA')!.ptoWeekdays = 1;
        return b;
      })(),
    });
    const a = computeWorkDayReport(ctx, emptyPlan()).find(r => r.provider_id === 'pA')!;
    // Under by 1 (Tue idle); Wed is PTO — excluded from both lists.
    expect(a.shortfall).toEqual({ days: 1, engineGapDates: [], noSlotDates: [TUE] });
  });
});
