import { describe, it, expect } from 'vitest';
import {
  isWorkingDay,
  workingDaysInRange,
  requiredWorkDays,
  entitledOffDays,
  ptoWeekdaysCovered,
  creditsAsWorkedAvailability,
  exceedsWorkDayCap,
  PTO_NETTING_TYPES,
} from './workDays';

// enumerate calendar dates [start, end] inclusive
function range(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe('isWorkingDay — weekdays minus MAJOR holidays', () => {
  it('true for a plain weekday', () => {
    expect(isWorkingDay('2026-01-06', new Set())).toBe(true); // Tue
  });
  it('false for Saturday and Sunday', () => {
    expect(isWorkingDay('2026-01-10', new Set())).toBe(false); // Sat
    expect(isWorkingDay('2026-01-11', new Set())).toBe(false); // Sun
  });
  it('false for a MAJOR holiday that falls on a weekday', () => {
    // Independence Day observed on the real day; here use a weekday major.
    expect(isWorkingDay('2026-05-25', new Set(['2026-05-25']))).toBe(false); // Memorial Day (Mon)
  });
  it('minor federal holidays are NOT excluded (still working days)', () => {
    // MLK Jr Day 2026-01-19 (Mon) is a MINOR federal holiday: not in the major
    // set, so it stays a working day.
    expect(isWorkingDay('2026-01-19', new Set(['2026-05-25']))).toBe(true);
  });
});

describe('workingDaysInRange — count of working days', () => {
  it('counts weekdays, excluding weekends', () => {
    // 2026-01-05 (Mon) .. 2026-01-11 (Sun): 5 weekdays.
    expect(workingDaysInRange(range('2026-01-05', '2026-01-11'), new Set())).toBe(5);
  });
  it('excludes a MAJOR holiday weekday but keeps minor holidays', () => {
    // Week containing Memorial Day 2026-05-25 (Mon): Mon..Fri = 5 weekdays,
    // minus the major Monday = 4.
    const majors = new Set(['2026-05-25']);
    expect(workingDaysInRange(range('2026-05-25', '2026-05-29'), majors)).toBe(4);
  });
  it('a major holiday on a weekend does not reduce the count', () => {
    // Fictional major on a Saturday: weekend already excluded, no double effect.
    const majors = new Set(['2026-01-10']); // Sat
    expect(workingDaysInRange(range('2026-01-05', '2026-01-11'), majors)).toBe(5);
  });
});

describe('requiredWorkDays — round(FTE × WD) − PTO weekdays, floored at 0', () => {
  it("Gabriel's 200-day → 175 with 5 weeks PTO", () => {
    // full-year proxy: WD=200, FTE 1.0, 25 PTO weekdays → 175.
    expect(requiredWorkDays(1.0, 200, 25)).toBe(175);
  });
  it('rounds FTE × WD half-up before subtracting PTO', () => {
    // 0.5 × 21 = 10.5 → 11; minus 2 PTO → 9.
    expect(requiredWorkDays(0.5, 21, 2)).toBe(9);
  });
  it('PTO excuses regardless of FTE (1:1)', () => {
    // 0.5 × 20 = 10; minus 4 PTO → 6.
    expect(requiredWorkDays(0.5, 20, 4)).toBe(6);
  });
  it('never goes below zero', () => {
    expect(requiredWorkDays(0.5, 20, 99)).toBe(0);
  });
});

describe('entitledOffDays — WD − round(FTE × WD) (independent of PTO)', () => {
  it('a 0.5 FTE over 20 WD is entitled to 10 off', () => {
    expect(entitledOffDays(0.5, 20)).toBe(10);
  });
  it('a 1.0 FTE is entitled to 0 off', () => {
    expect(entitledOffDays(1.0, 20)).toBe(0);
  });
  it('uses the same half-up rounding as required (0.5 × 21 = 10.5 → 11 → off 10)', () => {
    expect(entitledOffDays(0.5, 21)).toBe(10);
  });
});

describe('ptoWeekdaysCovered — netting set only, working days only, deduped', () => {
  const wd = new Set(range('2026-01-05', '2026-01-16').filter(d => isWorkingDay(d, new Set())));
  it('counts pto/fmla/parental/military working days covered', () => {
    const entries = [
      { availability_type: 'pto', start_date: '2026-01-06', end_date: '2026-01-08', approval_status: 'approved' },
    ];
    // Tue..Thu = 3 working days.
    expect(ptoWeekdaysCovered(entries, wd).size).toBe(3);
  });
  it('pending PTO counts (blocking semantics); denied/canceled do not', () => {
    expect(ptoWeekdaysCovered(
      [{ availability_type: 'pto', start_date: '2026-01-06', end_date: '2026-01-06', approval_status: 'pending' }], wd,
    ).size).toBe(1);
    expect(ptoWeekdaysCovered(
      [{ availability_type: 'pto', start_date: '2026-01-06', end_date: '2026-01-06', approval_status: 'denied' }], wd,
    ).size).toBe(0);
  });
  it('sick / jury_duty / unavailable / blocked do NOT net (judgment call)', () => {
    for (const t of ['sick', 'jury_duty', 'unavailable', 'blocked']) {
      expect(ptoWeekdaysCovered(
        [{ availability_type: t, start_date: '2026-01-06', end_date: '2026-01-08', approval_status: 'approved' }], wd,
      ).size).toBe(0);
    }
  });
  it('excludes weekend coverage and dedupes overlapping rows', () => {
    const entries = [
      { availability_type: 'pto', start_date: '2026-01-09', end_date: '2026-01-12', approval_status: 'approved' }, // Fri..Mon
      { availability_type: 'fmla', start_date: '2026-01-12', end_date: '2026-01-12', approval_status: 'approved' }, // Mon dup
    ];
    // Fri (09), Mon (12) = 2 working days; Sat/Sun excluded; Mon not double.
    expect(ptoWeekdaysCovered(entries, wd).size).toBe(2);
  });
  it('PTO_NETTING_TYPES is exactly the four planned-leave types', () => {
    expect([...PTO_NETTING_TYPES].sort()).toEqual(
      ['fmla', 'military_leave', 'parental_leave', 'pto'],
    );
  });
});

describe('creditsAsWorkedAvailability — ICU rows credit as worked', () => {
  it('blocked/icu_week and blocked/icu_post_call credit', () => {
    expect(creditsAsWorkedAvailability(
      { availability_type: 'blocked', reason_code: 'icu_week', approval_status: 'approved' },
    )).toBe(true);
    expect(creditsAsWorkedAvailability(
      { availability_type: 'blocked', reason_code: 'icu_post_call', approval_status: 'approved' },
    )).toBe(true);
  });
  it('plain blocked / unavailable / pto do NOT credit', () => {
    expect(creditsAsWorkedAvailability(
      { availability_type: 'blocked', reason_code: null, approval_status: 'approved' },
    )).toBe(false);
    expect(creditsAsWorkedAvailability(
      { availability_type: 'unavailable', reason_code: null, approval_status: 'approved' },
    )).toBe(false);
    expect(creditsAsWorkedAvailability(
      { availability_type: 'pto', reason_code: null, approval_status: 'approved' },
    )).toBe(false);
  });
  it('a denied/canceled ICU row does not credit', () => {
    expect(creditsAsWorkedAvailability(
      { availability_type: 'blocked', reason_code: 'icu_week', approval_status: 'canceled' },
    )).toBe(false);
  });
});

describe('exceedsWorkDayCap — the cap predicate', () => {
  const wd = new Set(['2026-01-06', '2026-01-07', '2026-01-08']);
  it('non-working days are exempt (never capped)', () => {
    // Saturday not in wd set.
    expect(exceedsWorkDayCap('2026-01-10', wd, new Set(['2026-01-06', '2026-01-07']), 2)).toBe(false);
  });
  it('caps when credited count has reached required', () => {
    expect(exceedsWorkDayCap('2026-01-08', wd, new Set(['2026-01-06', '2026-01-07']), 2)).toBe(true);
  });
  it('does not cap below required', () => {
    expect(exceedsWorkDayCap('2026-01-08', wd, new Set(['2026-01-06']), 2)).toBe(false);
  });
  it('a day already credited is not a NEW credit (not capped)', () => {
    // credited already includes the target date → placing there consumes no new
    // credit, so it is never blocked even at/over the cap.
    expect(exceedsWorkDayCap('2026-01-06', wd, new Set(['2026-01-06', '2026-01-07']), 2)).toBe(false);
  });
  it('handles an empty credited set', () => {
    expect(exceedsWorkDayCap('2026-01-06', wd, undefined, 0)).toBe(true);
    expect(exceedsWorkDayCap('2026-01-06', wd, undefined, 1)).toBe(false);
  });
});
