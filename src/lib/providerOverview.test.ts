/**
 * The clinician overview.
 *
 * This screen is the first thing a physician sees about their own year, so the
 * tests are mostly about not telling them something untrue: not counting leave
 * they have not been granted, not reporting hours from shifts that state none,
 * not netting an extra call against one they still owe, and never printing a
 * confident zero where the answer is "we could not read it".
 */
import { describe, it, expect } from 'vitest';
import {
  buildProviderOverview, perCategoryOwed, shiftHours, categoryLabel,
  type OverviewAssignment, type OverviewAvailability, type OwedInputs,
} from './providerOverview';

const TODAY = '2026-09-16';

const assign = (
  date: string, code: string, opts: Partial<OverviewAssignment> = {},
): OverviewAssignment => ({
  date, code, siteId: 's1',
  category: opts.category ?? 'call',
  dayType: opts.dayType ?? 'weekday',
  startTime: opts.startTime ?? '15:00',
  endTime: opts.endTime ?? '07:00',
  ...opts,
});

const build = (o: Partial<Parameters<typeof buildProviderOverview>[0]> = {}) =>
  buildProviderOverview({
    today: TODAY,
    provider: { id: 'p1', last_name: 'Farkas', provider_type: 'physician' },
    profile: { employment_status: 'full_time', fte_value: 1, pto_weeks: 9 },
    assignments: [], availability: [], credentials: [],
    sites: [{ id: 's1', name: 'Paoli Hospital', short_name: 'PH' }],
    ...o,
  });

/** The live Paoli block (2026-09-01 → 10-31), slot weight per category. Eight
 *  physician call categories plus the two neuro days. */
const PAOLI_SLOTS = new Map<string, number>([
  ['weekday|C1', 31], ['friday|C1', 8], ['saturday|C1', 11], ['sunday|C1', 8],
  ['weekday|C2', 31], ['friday|C2', 8], ['saturday|C2', 8], ['sunday|C2', 8],
  ['saturday|C3', 8], ['sunday|C3', 8],
]);

const owedFor = (fte = 1, slots = PAOLI_SLOTS): OwedInputs =>
  ({ parLevel: 12, callFte: fte, inCallPool: fte > 0, bucketSlotWeight: slots });

const BLOCK = { start: '2026-09-01', end: '2026-10-31' };

describe('call owed, per category', () => {
  it('scales EVERY category the block stands by (slots ÷ par) × FTE', () => {
    const o = build({ owed: owedFor(1), blockRange: BLOCK, neuroCode: 'C3' });
    const by = new Map(o.call.rows.map(r => [r.key, r]));

    // 31 weekday C1 slots at par 12 for a 1.0 FTE.
    expect(by.get('weekday|C1')).toMatchObject({ owed: 2.58, owedWhole: 3, slotsInBlock: 31 });
    expect(by.get('friday|C1')).toMatchObject({ owed: 0.67, owedWhole: 1 });
    expect(by.get('saturday|C1')).toMatchObject({ owed: 0.92, owedWhole: 1 });
    expect(by.get('sunday|C2')).toMatchObject({ owed: 0.67, owedWhole: 1 });
    expect(o.call.owedBasis).toBe('block-par-formula');
    expect(o.call.parLevel).toBe(12);
  });

  it('produces all eight of Fri/Sat/Sun × C1/C2 plus the weekday pair', () => {
    const o = build({ owed: owedFor(1), blockRange: BLOCK, neuroCode: 'C3' });
    expect(o.call.rows.filter(r => r.group === 'call').map(r => r.key)).toEqual([
      'weekday|C1', 'weekday|C2',
      'friday|C1', 'friday|C2',
      'saturday|C1', 'saturday|C2',
      'sunday|C1', 'sunday|C2',
    ]);
  });

  it('halves the owed for a half-time provider', () => {
    const o = build({ owed: owedFor(0.5), blockRange: BLOCK, neuroCode: 'C3' });
    expect(o.call.rows.find(r => r.key === 'weekday|C1')!.owed).toBe(1.29);
    expect(o.call.totals.owed).toBe(5.38);       // 129 ÷ 12 × 0.5 = 5.375
  });

  it('totals to the block obligation — the categories cannot drift from it', () => {
    // Linearity is the point of scaling per category: Σ (slots ÷ par × FTE)
    // IS (Σ slots ÷ par × FTE), so the table and its total always agree.
    const o = build({ owed: owedFor(1), blockRange: BLOCK, neuroCode: 'C3' });
    expect(o.call.totals.owed).toBe(10.75);      // 129 slots ÷ 12
  });

  it('keeps a stood category NOBODY filled — a missing row reads as "not mine"', () => {
    const o = build({ owed: owedFor(1), blockRange: BLOCK, neuroCode: 'C3', assignments: [] });
    const sat = o.call.rows.find(r => r.key === 'saturday|C2')!;
    expect(sat).toMatchObject({ stood: true, block: 0, owed: 0.67 });
    expect(o.call.rows).toHaveLength(10);
  });

  it('shows NULL owed — not zero — when the block could not be read', () => {
    // A zero would read as "you owe nothing"; "we have no block for you" is a
    // different and much less alarming statement.
    const o = build({ owed: null, assignments: [assign('2026-09-03', 'C1')] });
    expect(o.call.rows[0].owed).toBeNull();
    expect(o.call.rows[0].slotsInBlock).toBeNull();
    expect(o.call.totals.owed).toBeNull();
    expect(o.call.owedBasis).toBeNull();
    expect(o.call.over).toEqual([]);
  });

  it('owes a day doc zero, and SAYS it is a zero rather than a dash', () => {
    // Outside the call pool the obligation is genuinely nil — that is a real
    // number, and `inCallPool` is what keeps it from reading as missing data.
    const o = build({ owed: owedFor(0), blockRange: BLOCK, neuroCode: 'C3' });
    expect(o.call.totals.owed).toBe(0);
    expect(o.call.inCallPool).toBe(false);
    expect(o.call.callFte).toBe(0);
  });

  it('is par-authoritative — a thin roster does not lower what is owed', () => {
    // Par 12 against 8.82 FTE of roster is deliberate: the obligations
    // under-cover the block and the remainder is the paid-pickup layer.
    const owed = perCategoryOwed(new Map([['weekday|C1', 44]]), 12, 1);
    expect(owed.get('weekday|C1')).toBeCloseTo(44 / 12, 5);
  });
});

describe('call taken', () => {
  it('counts YTD, MTD and the block off the same assignments', () => {
    const o = build({
      owed: owedFor(1), blockRange: BLOCK, neuroCode: 'C3',
      assignments: [
        assign('2026-03-02', 'C1'),          // this year, previous block
        assign('2026-09-03', 'C1'),
        assign('2026-09-10', 'C1'),
      ],
    });
    expect(o.call.rows.find(r => r.key === 'weekday|C1')).toMatchObject({
      owed: 2.58, block: 2, ytd: 3, mtd: 2,
    });
  });

  it('folds a split segment under its parent call', () => {
    const o = build({
      owed: owedFor(1, new Map([['weekday|C1', 1]])),
      assignments: [
        assign('2026-09-03', 'C1N12', { parentCode: 'C1', callBurdenWeight: 0.5 }),
        assign('2026-09-03', 'C1D12', { parentCode: 'C1', callBurdenWeight: 0.5 }),
      ],
    });
    expect(o.call.rows).toHaveLength(1);
    expect(o.call.rows[0]).toMatchObject({ key: 'weekday|C1', ytd: 1 });
  });

  it('charges a holiday call to the weekday it falls on', () => {
    // Labor Day is a Monday, and a Monday call is an M–Th call.
    const o = build({
      assignments: [assign('2026-09-07', 'C1', { dayType: 'federal_holiday' })],
    });
    expect(o.call.rows[0].key).toBe('weekday|C1');
  });

  it('REPORTS a call it cannot bucket instead of dropping it', () => {
    // derived_day_type is backfilled and non-null today, but the previous
    // version of this file silently skipped these and lost a third of the
    // call slots the moment one was missing.
    const o = build({
      assignments: [assign('2026-09-03', 'C1'), assign('2026-09-04', 'C2', { dayType: null })],
    });
    expect(o.call.uncounted).toEqual({ calls: 1, weight: 1, codes: ['C2'] });
    expect(o.call.totals.ytd).toBe(1);
  });

  it('ignores day shifts and calls dated in the future', () => {
    const o = build({
      assignments: [
        assign('2026-09-03', '7-3', { category: 'regular' }),
        assign('2026-12-01', 'C1'),
      ],
    });
    expect(o.call.rows).toEqual([]);
    expect(o.call.totals.ytd).toBe(0);
  });
});

describe('the neuro weekend', () => {
  const neuroBuild = (assignments: OverviewAssignment[] = []) => build({
    owed: owedFor(1), blockRange: BLOCK, neuroCode: 'C3', assignments,
  });

  it('splits the TAKEN side into a Saturday row and a Sunday row', () => {
    const o = neuroBuild([
      assign('2026-09-05', 'C3', { dayType: 'saturday' }),
      assign('2026-09-06', 'C3', { dayType: 'sunday' }),
    ]);
    const neuroRows = o.call.rows.filter(r => r.group === 'neuro');
    expect(neuroRows.map(r => [r.label, r.block])).toEqual([['Sat C3', 1], ['Sun C3', 1]]);
  });

  it('owes ONE unit per weekend, never 0.5 against each day', () => {
    const o = neuroBuild();
    // 16 neuro day-slots = 8 weekends; 8 ÷ 12 × 1.0.
    expect(o.call.neuro).toMatchObject({
      code: 'C3', weekendsInBlock: 8, owedWeekends: 0.67,
      owedWholeWeekends: 0.5, owedBasis: 'block-par-formula',
    });
    // And the per-day rows carry NO owed, so nothing can print half a duty.
    for (const r of o.call.rows.filter(r => r.group === 'neuro')) {
      expect(r.owed).toBeNull();
      expect(r.owedWhole).toBeNull();
    }
  });

  it('takes the SITE’S stated requirement over the formula', () => {
    // Paoli's pattern still says every call taker owes one neuro weekend —
    // those bands were not deleted, and the solver still places by them. The
    // formula would call 8 weekends over a par of 12 "0.67 owed" and flag
    // everybody who worked the weekend the pattern told them to work.
    const o = build({
      owed: owedFor(1), blockRange: BLOCK, neuroCode: 'C3', neuroOwedWeekends: 1,
      assignments: [
        assign('2026-09-05', 'C3', { dayType: 'saturday' }),
        assign('2026-09-06', 'C3', { dayType: 'sunday' }),
      ],
    });
    expect(o.call.neuro).toMatchObject({
      owedWeekends: 1, owedBasis: 'stated-requirement', parFormulaWeekends: 0.67,
      takenWeekendsBlock: 1,
    });
    expect(o.call.over).toEqual([]);
    // One weekend is the two days it is stood on, so the block total carries
    // it as two calls: 113 non-neuro slots ÷ 12 + 2.
    expect(o.call.totals.owed).toBe(11.42);
  });

  it('credits a weekend pair as 1.0 and a lone neuro day as 0.5', () => {
    const paired = neuroBuild([
      assign('2026-09-05', 'C3', { dayType: 'saturday' }),
      assign('2026-09-06', 'C3', { dayType: 'sunday' }),
    ]);
    expect(paired.call.neuro!.takenWeekendsBlock).toBe(1);
    const lone = neuroBuild([assign('2026-09-05', 'C3', { dayType: 'saturday' })]);
    expect(lone.call.neuro!.takenWeekendsBlock).toBe(0.5);
  });

  it('still counts the neuro days in the block TOTAL, in calls', () => {
    const o = neuroBuild([
      assign('2026-09-05', 'C3', { dayType: 'saturday' }),
      assign('2026-09-06', 'C3', { dayType: 'sunday' }),
    ]);
    expect(o.call.totals.block).toBe(2);
    expect(o.call.totals.owed).toBe(10.75);       // neuro's two days included
  });

  it('reports a neuro overage in WEEKENDS, which is the unit it is owed in', () => {
    const o = build({
      owed: owedFor(1), neuroCode: 'C3',
      blockRange: { start: '2026-09-01', end: '2026-09-14' },   // ended
      assignments: [
        assign('2026-09-05', 'C3', { dayType: 'saturday' }),
        assign('2026-09-06', 'C3', { dayType: 'sunday' }),
        assign('2026-09-12', 'C3', { dayType: 'saturday' }),
        assign('2026-09-13', 'C3', { dayType: 'sunday' }),
      ],
    });
    expect(o.call.over).toContainEqual({ label: 'Neuro weekend', by: 1.5, unit: 'weekends' });
  });

  it('leaves a site with no stated neuro tier alone', () => {
    // Bryn Mawr's weekend NEURO is not declared in its pattern doc, so it is
    // an ordinary category and renders as Sat/Sun rows with their own owed.
    const o = build({
      owed: owedFor(1, new Map([['saturday|NEURO', 10], ['sunday|NEURO', 10]])),
      blockRange: BLOCK,
    });
    expect(o.call.neuro).toBeNull();
    expect(o.call.rows.map(r => [r.label, r.owed])).toEqual([
      ['Sat NEURO', 0.83], ['Sun NEURO', 0.83],
    ]);
  });
});

describe('over, short and still-to-come', () => {
  it('reports over and short at the SAME TIME — no netting', () => {
    // Gabriel's rule: being short somewhere else does not cancel an extra.
    // A weekday C1 pickup and a missing Sunday C2 are not the same money.
    const o = build({
      owed: owedFor(1, new Map([['weekday|C1', 12], ['sunday|C2', 12]])),
      blockRange: { start: '2026-09-01', end: '2026-09-14' },   // ended
      assignments: [
        assign('2026-09-01', 'C1'), assign('2026-09-02', 'C1'), assign('2026-09-03', 'C1'),
      ],
    });
    expect(o.call.over).toEqual([{ label: 'M–Th C1', by: 2, unit: 'calls' }]);
    expect(o.call.short).toEqual([{ label: 'Sun C2', by: 1, unit: 'calls' }]);
  });

  it('does NOT call a running block short — it reports what is still to come', () => {
    // Two weeks into a two-month block, "ten categories short" is noise that
    // trains people to ignore the panel.
    const o = build({ owed: owedFor(1), blockRange: BLOCK, neuroCode: 'C3' });
    expect(o.call.short).toEqual([]);
    expect(o.call.remaining).toBe(10.75);
    expect(o.call.blockStart).toBe('2026-09-01');
    expect(o.call.blockEnd).toBe('2026-10-31');
  });

  it('meets a fractional obligation with whole calls', () => {
    // 2.58 owed is met by 3; the 4th is the pickup. Rounding the threshold is
    // the house rule — an obligation of 2.58 calls cannot be worked exactly.
    const three = build({
      owed: owedFor(1), blockRange: BLOCK, neuroCode: 'C3',
      assignments: ['2026-09-01', '2026-09-02', '2026-09-03'].map(d => assign(d, 'C1')),
    });
    expect(three.call.over).toEqual([]);
    const four = build({
      owed: owedFor(1), blockRange: BLOCK, neuroCode: 'C3',
      assignments: ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-08']
        .map(d => assign(d, 'C1')),
    });
    expect(four.call.over).toEqual([{ label: 'M–Th C1', by: 1, unit: 'calls' }]);
  });
});

describe('additional (picked-up) calls', () => {
  const extras = new Map([
    ['weekday|C1', 2], ['saturday|C1', 1], ['friday|C2', 0.5], ['sunday|C2', 0],
  ]);

  it('splits the pickups weekday vs weekend, by code', () => {
    const o = build({
      owed: owedFor(1), blockRange: BLOCK, neuroCode: 'C3', extrasByCategory: extras,
    });
    expect(o.call.additional!.byCode).toEqual([
      { code: 'C1', weekday: 2, weekend: 1, total: 3 },
      { code: 'C2', weekday: 0, weekend: 0.5, total: 0.5 },
    ]);
    expect(o.call.additional).toMatchObject({ weekday: 2, weekend: 1.5, total: 3.5 });
  });

  it('keeps the per-day-type detail, because that is what is billable', () => {
    const o = build({
      owed: owedFor(1), blockRange: BLOCK, neuroCode: 'C3', extrasByCategory: extras,
    });
    expect(o.call.additional!.rows.map(r => [r.label, r.calls])).toEqual([
      ['M–Th C1', 2], ['Fri C2', 0.5], ['Sat C1', 1],
    ]);
    expect(o.call.rows.find(r => r.key === 'weekday|C1')!.extra).toBe(2);
    expect(o.call.totals.extra).toBe(3.5);
  });

  it('is NULL, not zero, when the extras were not computed', () => {
    const o = build({ owed: owedFor(1), blockRange: BLOCK, neuroCode: 'C3' });
    expect(o.call.additional).toBeNull();
    expect(o.call.totals.extra).toBeNull();
    expect(o.call.rows[0].extra).toBeNull();
  });
});

describe('day shifts vs call shifts', () => {
  it('counts them apart on shift_types.category', () => {
    const o = build({
      assignments: [
        assign('2026-09-01', 'C1'),
        assign('2026-09-02', '7-3', { category: 'regular' }),
        assign('2026-09-03', 'DAY', { category: 'regular' }),
      ],
    });
    expect(o.shiftMix).toMatchObject({ callShifts: 1, dayShifts: 2, otherShifts: 0 });
  });

  it('counts an LMC C2 as a call, and flags that its type exempts it', () => {
    // Lankenau's C2 is category 'call' with counts_toward_call_burden false.
    // Category wins here because the obligation census counts the SLOT on
    // category alone — dropping the taken side would stop the two halves of
    // the panel reconciling — but the disagreement is reported, not hidden.
    const o = build({
      assignments: [assign('2026-09-01', 'C2', { countsTowardCallBurden: false })],
    });
    expect(o.shiftMix.callShifts).toBe(1);
    expect(o.shiftMix.callShiftsExemptFromBurden).toBe(1);
  });

  it('flags a CRNA call code held by a physician', () => {
    const o = build({
      assignments: [
        assign('2026-09-01', 'cCall', { shiftProviderGroup: 'crna' }),
        assign('2026-09-02', 'C1', { shiftProviderGroup: 'physician' }),
        assign('2026-09-03', '7-3', { category: 'regular', shiftProviderGroup: 'both' }),
      ],
    });
    expect(o.shiftMix).toMatchObject({
      callShifts: 2, dayShifts: 1, crossDisciplineCallShifts: 1, providerType: 'physician',
    });
  });

  it('never folds an unknown category into either count', () => {
    const o = build({
      assignments: [assign('2026-09-01', 'ADMIN', { category: 'administrative' })],
    });
    expect(o.shiftMix).toMatchObject({
      callShifts: 0, dayShifts: 0, otherShifts: 1, otherCategories: ['administrative'],
    });
  });

  it('counts a shift that does not count toward HOURS — it still happened', () => {
    const o = build({
      assignments: [assign('2026-09-01', 'C1', { countsTowardHours: false })],
    });
    expect(o.shiftMix.callShifts).toBe(1);
    expect(o.hours.shiftsYtd).toBe(0);
  });
});

describe('the covered window', () => {
  it('carries the span the figures actually cover, not just "YTD"', () => {
    const o = build({
      publishedFrom: '2026-09-01',
      assignments: [assign('2026-09-03', 'C1'), assign('2026-09-10', 'C1')],
    });
    expect(o.window).toEqual({
      requestedStart: '2026-01-01',
      requestedEnd: TODAY,
      publishedFrom: '2026-09-01',
      firstAssignment: '2026-09-03',
      lastAssignment: '2026-09-10',
      complete: true,
    });
  });

  it('marks the window incomplete when a read failed', () => {
    // A zero under an incomplete window means "could not count", not "none".
    const o = build({ readsComplete: false });
    expect(o.window.complete).toBe(false);
    expect(o.window.firstAssignment).toBeNull();
  });
});

describe('hours', () => {
  it('sums scheduled hours and averages them over the year so far', () => {
    const o = build({
      assignments: [
        assign('2026-09-01', '7-3', { category: 'regular', startTime: '07:00', endTime: '15:00' }),
        assign('2026-09-02', '7-5', { category: 'regular', startTime: '07:00', endTime: '17:00' }),
      ],
    });
    expect(o.hours.totalHoursYtd).toBe(18);
    expect(o.hours.dayHoursYtd).toBe(18);
    expect(o.hours.callHoursYtd).toBe(0);
    // 2026-01-01 .. 2026-09-16 is 259 days = 37 weeks.
    expect(o.hours.averageHoursPerWeekYtd).toBeCloseTo(18 / (259 / 7), 1);
  });

  it('separates call hours from day hours', () => {
    const o = build({ assignments: [assign('2026-09-03', 'C1')] });
    expect(o.hours.callHoursYtd).toBe(16);   // 15:00 → 07:00
    expect(o.hours.dayHoursYtd).toBe(0);
  });

  it('COUNTS a shift with no times but reports it rather than under-reporting', () => {
    // Several imported shift types state no hours. Dropping them silently
    // would make a full year look part-time.
    const o = build({
      assignments: [
        assign('2026-09-01', 'X', { category: 'regular', startTime: null, endTime: null }),
        assign('2026-09-02', '7-3', { category: 'regular', startTime: '07:00', endTime: '15:00' }),
      ],
    });
    expect(o.hours.shiftsYtd).toBe(2);
    expect(o.hours.shiftsWithoutTimes).toBe(1);
    expect(o.hours.totalHoursYtd).toBe(8);
  });

  it('splits hours by site, busiest first', () => {
    const o = build({
      sites: [
        { id: 's1', name: 'Paoli Hospital', short_name: 'PH' },
        { id: 's2', name: 'Riddle Hospital', short_name: 'RH' },
      ],
      assignments: [
        assign('2026-09-01', '7-3', { category: 'regular', startTime: '07:00', endTime: '15:00' }),
        assign('2026-09-02', '7-3', { category: 'regular', siteId: 's2', startTime: '07:00', endTime: '17:00' }),
      ],
    });
    expect(o.hours.bySite.map(s => [s.label, s.hours])).toEqual([['RH', 10], ['PH', 8]]);
  });

  it('respects counts_toward_hours = false', () => {
    const o = build({
      assignments: [assign('2026-09-01', 'X', { countsTowardHours: false })],
    });
    expect(o.hours.shiftsYtd).toBe(0);
  });
});

describe('shiftHours', () => {
  it('measures a day shift', () => expect(shiftHours('07:00', '15:00')).toBe(8));
  it('wraps past midnight', () => expect(shiftHours('15:00', '07:00')).toBe(16));
  it('reads equal times as a FULL 24 h', () => expect(shiftHours('07:00', '07:00')).toBe(24));
  it('returns null rather than guessing', () => {
    expect(shiftHours(null, '15:00')).toBeNull();
    expect(shiftHours('bad', '15:00')).toBeNull();
  });
});

describe('availability', () => {
  const pto = (
    start: string, end: string, status = 'approved', type = 'pto',
  ): OverviewAvailability =>
    ({ availability_type: type, approval_status: status, start_date: start, end_date: end });

  it('counts only the part of a block already taken', () => {
    // A two-week block that started last week is one week used, not two.
    const o = build({ availability: [pto('2026-09-09', '2026-09-22')] });
    expect(o.availability.ptoDaysUsed).toBe(8);     // 9th..16th inclusive
  });

  it('does NOT count leave that has only been requested', () => {
    // Telling somebody they have spent leave they may not get is the worst
    // thing this panel could do.
    const o = build({ availability: [pto('2026-03-01', '2026-03-07', 'waitlisted')] });
    expect(o.availability.ptoDaysUsed).toBe(0);
    expect(o.availability.pendingPtoBlocks).toBe(1);
  });

  it('ignores a denied or cancelled request in both counts', () => {
    const o = build({
      availability: [pto('2026-03-01', '2026-03-07', 'denied'), pto('2026-04-01', '2026-04-07', 'canceled')],
    });
    expect(o.availability).toMatchObject({ ptoDaysUsed: 0, pendingPtoBlocks: 0 });
  });

  it('finds the next block, including one already running', () => {
    const o = build({
      availability: [pto('2026-10-13', '2026-10-17'), pto('2026-11-02', '2026-11-06')],
    });
    expect(o.availability.nextPto).toEqual({ start: '2026-10-13', end: '2026-10-17' });
  });

  it('has no next block when every one is past', () => {
    const o = build({ availability: [pto('2026-03-01', '2026-03-07')] });
    expect(o.availability.nextPto).toBeNull();
  });

  it('counts sell-back separately from leave taken', () => {
    const o = build({ availability: [pto('2026-05-04', '2026-05-10', 'approved', 'pto_sellback')] });
    expect(o.availability.sellbackWeeks).toBe(1);
    expect(o.availability.ptoDaysUsed).toBe(0);
  });

  it('counts live no-call requests, and not dismissed ones', () => {
    const o = build({
      availability: [
        pto('2026-10-01', '2026-10-01', 'pending', 'no_call_request'),
        pto('2026-10-02', '2026-10-02', 'approved', 'no_call_request'),
        pto('2026-10-03', '2026-10-03', 'denied', 'no_call_request'),
      ],
    });
    expect(o.availability.openNoCallRequests).toBe(2);
  });
});

describe('credentials', () => {
  it('lists only live credentials', () => {
    const o = build({
      credentials: [
        { site_id: 's1' },
        { site_id: 's2', is_active: false },
        { site_id: 's3', effective_end_date: '2026-01-01' },
        { site_id: 's4', effective_start_date: '2027-01-01' },
      ],
    });
    expect(o.credentialedSiteIds).toEqual(['s1']);
  });
});

describe('categoryLabel', () => {
  it('reads a bucket key as English', () => {
    expect(categoryLabel('weekday|C1')).toBe('M–Th C1');
    expect(categoryLabel('saturday|C2')).toBe('Sat C2');
  });
});
