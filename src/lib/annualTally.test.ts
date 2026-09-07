// Annual tally math. Fixtures mirror the live Paoli roster shape: a 1.0 FTE
// with a stated allotment, a partial-call doc whose WORKING-days FTE is 1.00
// (Hussain), and a call taker with no allotment stated at all.
import { describe, it, expect } from 'vitest';
import { ptoFiguresFor, offDayBudgetFor, type TallyProfile } from './annualTally';
import type { PlannerAvailabilityRow } from './plannerMath';

const profile = (over: Partial<TallyProfile> = {}): TallyProfile => ({
  provider_id: 'p1',
  fte_value: 1,
  work_days_fte: null,
  pto_weeks: 4,
  ...over,
});

const pto = (start: string, end: string, over: Partial<PlannerAvailabilityRow> = {}): PlannerAvailabilityRow => ({
  provider_id: 'p1',
  availability_type: 'pto',
  start_date: start,
  end_date: end,
  approval_status: 'approved',
  ...over,
});

describe('ptoFiguresFor', () => {
  it('counts weekdays used and subtracts them from the allotment', () => {
    // Mon 2026-06-08 .. Fri 2026-06-12 = 5 weekdays.
    const f = ptoFiguresFor(profile({ pto_weeks: 4 }), [pto('2026-06-08', '2026-06-12')], 2026);
    expect(f.usedWeekdays).toBe(5);
    expect(f.allotmentDays).toBe(20);
    expect(f.remainingDays).toBe(15);
  });

  it('counts sold-back days as USED — selling back never refunds the pool', () => {
    const rows = [
      pto('2026-06-08', '2026-06-12'),
      { ...pto('2026-06-08', '2026-06-09'), availability_type: 'pto_sellback' },
    ];
    const f = ptoFiguresFor(profile({ pto_weeks: 4 }), rows, 2026);
    expect(f.usedWeekdays).toBe(5);
    expect(f.soldWeekdays).toBe(2);
    expect(f.remainingDays).toBe(15);
  });

  it('reports NO remaining figure when the allotment is unstated', () => {
    const f = ptoFiguresFor(profile({ pto_weeks: null }), [pto('2026-06-08', '2026-06-12')], 2026);
    expect(f.usedWeekdays).toBe(5);
    expect(f.allotmentDays).toBeNull();
    expect(f.remainingDays).toBeNull();
  });

  it('treats a stated zero as a real zero, not as unstated', () => {
    const f = ptoFiguresFor(profile({ pto_weeks: 0 }), [], 2026);
    expect(f.allotmentDays).toBe(0);
    expect(f.remainingDays).toBe(0);
  });

  it('ignores denied and canceled rows', () => {
    const rows = [pto('2026-06-08', '2026-06-12', { approval_status: 'denied' })];
    expect(ptoFiguresFor(profile(), rows, 2026).usedWeekdays).toBe(0);
  });

  it('counts only the requested year for a range that straddles New Year', () => {
    // 2026-12-30..2027-01-02: 2026 weekdays are Wed 30 + Thu 31 = 2.
    const f = ptoFiguresFor(profile(), [pto('2026-12-30', '2027-01-02')], 2026);
    expect(f.usedWeekdays).toBe(2);
  });
});

describe('offDayBudgetFor', () => {
  it('gives a full-timer zero off days', () => {
    expect(offDayBudgetFor(profile({ fte_value: 1 }), 250)).toBe(0);
  });

  it('gives a 0.75 FTE a quarter of the working days', () => {
    // 250 - round(187.5) = 250 - 188 = 62. entitledOffDays rounds half UP, and
    // that rounding is the engine's — match it, never "fix" it here.
    expect(offDayBudgetFor(profile({ fte_value: 0.75 }), 250)).toBe(62);
  });

  it('keys off WORKING-days FTE, not call FTE (the Hussain case)', () => {
    // Call FTE 0.70 but work_days_fte 1.00 — he works full days, so zero off days.
    expect(offDayBudgetFor(profile({ fte_value: 0.7, work_days_fte: 1 }), 250)).toBe(0);
  });

  it('treats a null FTE as zero rather than throwing', () => {
    expect(offDayBudgetFor(profile({ fte_value: null }), 250)).toBe(250);
  });
});
