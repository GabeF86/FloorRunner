/**
 * The clinician overview.
 *
 * This screen is the first thing a physician sees about their own year, so the
 * tests are mostly about not telling them something untrue: not counting leave
 * they have not been granted, not reporting hours from shifts that state none,
 * and not netting an extra call against one they still owe.
 */
import { describe, it, expect } from 'vitest';
import {
  buildProviderOverview, shiftHours, categoryLabel,
  type OverviewAssignment, type OverviewAvailability,
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
    provider: { id: 'p1', last_name: 'Farkas' },
    profile: { employment_status: 'full_time', fte_value: 1, pto_weeks: 9 },
    assignments: [], availability: [], credentials: [],
    sites: [{ id: 's1', name: 'Paoli Hospital', short_name: 'PH' }],
    owedByCategory: null,
    ...o,
  });

describe('call owed vs taken', () => {
  const OWED = new Map([['weekday|C1', 4], ['weekday|C2', 4], ['sunday|C2', 1]]);

  it('counts YTD and MTD off the same assignments', () => {
    const o = build({
      owedByCategory: OWED,
      assignments: [
        assign('2026-03-02', 'C1'),          // this year, not this month
        assign('2026-09-03', 'C1'),          // this month
        assign('2026-09-10', 'C1'),
      ],
    });
    const c1 = o.call.rows.find(r => r.key === 'weekday|C1')!;
    expect(c1).toMatchObject({ owed: 4, ytd: 3, mtd: 2 });
  });

  it('keeps a stated category nobody filled — that IS the shortfall', () => {
    // Block already over, so the shortfall is itemised.
    const o = build({
      owedByCategory: OWED, assignments: [],
      blockRange: { start: '2026-06-01', end: '2026-07-31' },
    });
    expect(o.call.rows.map(r => r.key).sort())
      .toEqual(['sunday|C2', 'weekday|C1', 'weekday|C2']);
    expect(o.call.short).toEqual([
      { label: 'M–Th C1', by: 4 },
      { label: 'M–Th C2', by: 4 },
      { label: 'Sun C2', by: 1 },
    ]);
    expect(o.call.totals).toMatchObject({ owed: 9, block: 0, ytd: 0 });
  });

  it('does NOT call a running block short — it reports what is still to come', () => {
    // Two weeks into a two-month block, "10 categories short" is noise that
    // trains people to ignore the panel. Nothing is short until the block ends.
    const o = build({
      owedByCategory: OWED, assignments: [],
      blockRange: { start: '2026-09-01', end: '2026-11-01' },
    });
    expect(o.call.short).toEqual([]);
    expect(o.call.remaining).toBe(9);
    expect(o.call.blockEnd).toBe('2026-11-01');
  });

  it('measures OWED against the block, not the calendar year', () => {
    // A call taken in a previous block is in YTD but must not count toward
    // this block's obligation.
    const o = build({
      owedByCategory: new Map([['weekday|C1', 4]]),
      blockRange: { start: '2026-09-01', end: '2026-11-01' },
      assignments: [assign('2026-03-02', 'C1'), assign('2026-09-03', 'C1')],
    });
    const row = o.call.rows[0];
    expect(row).toMatchObject({ block: 1, ytd: 2 });
    expect(o.call.remaining).toBe(3);
  });

  it('reports over and short at the SAME TIME — no netting', () => {
    // The rule Gabriel stated: being short somewhere else does not cancel an
    // extra. A row of "+1 Sat C1" and "−1 M–Th C2" are both true.
    const o = build({
      owedByCategory: new Map([['weekday|C2', 4], ['saturday|C1', 1]]),
      blockRange: { start: '2026-09-01', end: '2026-09-14' },   // ended
      assignments: [
        assign('2026-09-01', 'C2'), assign('2026-09-02', 'C2'), assign('2026-09-03', 'C2'),
        assign('2026-09-05', 'C1', { dayType: 'saturday' }),
        assign('2026-09-12', 'C1', { dayType: 'saturday' }),
      ],
    });
    expect(o.call.over).toEqual([{ label: 'Sat C1', by: 1 }]);
    expect(o.call.short).toEqual([{ label: 'M–Th C2', by: 1 }]);
  });

  it('shows NULL owed — not zero — when the site states no bands', () => {
    // A zero would read as "you owe nothing", which is a different and wrong
    // statement from "this site does not state per-category obligations".
    const o = build({ owedByCategory: null, assignments: [assign('2026-09-03', 'C1')] });
    expect(o.call.rows[0].owed).toBeNull();
    expect(o.call.totals.owed).toBeNull();
    expect(o.call.over).toEqual([]);
    expect(o.call.short).toEqual([]);
  });

  it('folds a split segment under its parent call', () => {
    const o = build({
      owedByCategory: new Map([['weekday|C1', 1]]),
      assignments: [
        assign('2026-09-03', 'C1N12', { parentCode: 'C1', callBurdenWeight: 0.5 }),
        assign('2026-09-03', 'C1D12', { parentCode: 'C1', callBurdenWeight: 0.5 }),
      ],
    });
    expect(o.call.rows).toHaveLength(1);
    expect(o.call.rows[0]).toMatchObject({ key: 'weekday|C1', ytd: 1 });
  });

  it('folds the neuro weekend into ONE row, not a Saturday and a Sunday', () => {
    // Sat C3 and Sun C3 are one service written on two days. Two rows both
    // labelled "Neuro weekend" read as two separate obligations — which is
    // exactly what the live data produced before this fold.
    const o = build({
      neuroCode: 'C3',
      owedByCategory: new Map([['saturday|C3', 1], ['sunday|C3', 1]]),
      blockRange: { start: '2026-09-01', end: '2026-11-01' },
      assignments: [
        assign('2026-09-05', 'C3', { dayType: 'saturday' }),
        assign('2026-09-06', 'C3', { dayType: 'sunday' }),
      ],
    });
    const neuro = o.call.rows.filter(r => r.label === 'Neuro weekend');
    expect(neuro).toHaveLength(1);
    expect(neuro[0]).toMatchObject({ owed: 2, block: 2, ytd: 2 });
  });

  it('ignores day shifts entirely', () => {
    const o = build({ assignments: [assign('2026-09-03', '7-3', { category: 'regular' })] });
    expect(o.call.rows).toEqual([]);
  });

  it('ignores a call dated in the future', () => {
    const o = build({ assignments: [assign('2026-12-01', 'C1')] });
    expect(o.call.totals.ytd).toBe(0);
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
  it('names the neuro code as a weekend service', () => {
    expect(categoryLabel('sunday|C3', 'C3')).toBe('Neuro weekend');
  });
});
