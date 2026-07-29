import { describe, it, expect } from 'vitest';
import {
  isWorkingDay,
  workingDaysInRange,
  requiredWorkDays,
  entitledOffDays,
  effectiveWorkDaysFte,
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

// ── The two-FTE split (2026-07-29, patch43) ─────────────────────────────────
// The working-days contract multiplies by the WORKING-DAYS FTE, which is the
// CALL FTE (fte_value) unless the provider states a separate work_days_fte.
// The whole feature has to be a no-op when nothing is stated, and Hussain's
// case has to come out at "every working day he isn't on call, PTO, or off".
describe('effectiveWorkDaysFte — the single home for "null means use fte_value"', () => {
  it('null / undefined fall back to the call FTE', () => {
    expect(effectiveWorkDaysFte(0.66, null)).toBe(0.66);
    expect(effectiveWorkDaysFte(0.66, undefined)).toBe(0.66);
    expect(effectiveWorkDaysFte(1)).toBe(1);
  });
  it('a stated value wins, in both directions', () => {
    expect(effectiveWorkDaysFte(0.66, 1)).toBe(1);    // Hussain
    expect(effectiveWorkDaysFte(1, 0.75)).toBe(0.75); // the general case
    expect(effectiveWorkDaysFte(0.5, 0.75)).toBe(0.75);
  });
  it('a stated ZERO is honored — it is a real contract, not a blank', () => {
    // "Owes call, owes no working days." Blank is null, never 0; conflating
    // them would silently zero somebody's obligation.
    expect(effectiveWorkDaysFte(0.5, 0)).toBe(0);
  });
  it('garbage falls back to the call FTE rather than zeroing the obligation', () => {
    expect(effectiveWorkDaysFte(0.8, Number.NaN)).toBe(0.8);
    expect(effectiveWorkDaysFte(0.8, Number.POSITIVE_INFINITY)).toBe(0.8);
    expect(effectiveWorkDaysFte(0.8, -1)).toBe(0.8);
  });
  it('accepts a numeric string (Postgres numeric arrives as one over PostgREST)', () => {
    expect(effectiveWorkDaysFte(0.66, '1' as unknown as number)).toBe(1);
  });
});

describe('requiredWorkDays / entitledOffDays with a stated work-days FTE', () => {
  // The no-op proof: for a spread of FTEs and PTO counts, passing null (or
  // nothing) must reproduce the pre-patch43 number EXACTLY.
  it('a null work-days FTE reproduces the FTE-only formula for every FTE', () => {
    const wd = 54;
    for (const fte of [0.2, 0.33, 0.5, 0.66, 0.7, 0.75, 0.8, 0.9, 1.0]) {
      for (const pto of [0, 1, 5, 12, 60]) {
        const legacy = Math.max(0, Math.round(fte * wd) - pto);
        expect(requiredWorkDays(fte, wd, pto)).toBe(legacy);
        expect(requiredWorkDays(fte, wd, pto, null)).toBe(legacy);
        expect(requiredWorkDays(fte, wd, pto, undefined)).toBe(legacy);
      }
      expect(entitledOffDays(fte, wd)).toBe(Math.max(0, wd - Math.round(fte * wd)));
      expect(entitledOffDays(fte, wd, null)).toBe(entitledOffDays(fte, wd));
    }
  });

  // HUSSAIN (Gabriel 2026-07-29): 0.66 FTE for CALL, full-time for WORKING
  // DAYS. "if hes not on call, PTO, or 'off', he should be placed in a D slot
  // to work." Not pinned to a specific block length — the working-day count is
  // a parameter here precisely because deleting a holiday moves it.
  it.each([53, 54, 55])(
    'Hussain (call 0.66, work-days 1.0) is required for every non-PTO working day of a %i-day block',
    (wd) => {
      const pto = 7;
      expect(requiredWorkDays(0.66, wd, pto, 1)).toBe(wd - pto);
      // ...and he is entitled to ZERO off days, unlike a real 0.66.
      expect(entitledOffDays(0.66, wd, 1)).toBe(0);
      // Before: a third of the block off.
      expect(requiredWorkDays(0.66, wd, pto)).toBe(Math.round(0.66 * wd) - pto);
      expect(entitledOffDays(0.66, wd)).toBe(wd - Math.round(0.66 * wd));
    },
  );

  it('the general case works too — 0.5 call, 0.75 working days (not a boolean flag)', () => {
    // The reason this is a number and not a "full time for work days" flag.
    expect(requiredWorkDays(0.5, 40, 0, 0.75)).toBe(30);
    expect(entitledOffDays(0.5, 40, 0.75)).toBe(10);
  });

  it('PTO still nets 1:1 against the raised requirement, and the floor still holds', () => {
    expect(requiredWorkDays(0.66, 54, 54, 1)).toBe(0);
    expect(requiredWorkDays(0.66, 54, 99, 1)).toBe(0);
  });

  it('the entitledOff identity survives: WD − pto − required = entitledOff', () => {
    // The identity workDays.ts documents, now on the WORK-DAYS FTE.
    for (const [fte, workFte] of [[0.66, 1], [1, 0.5], [0.5, 0.75]] as const) {
      const wd = 54, pto = 4;
      expect(wd - pto - requiredWorkDays(fte, wd, pto, workFte))
        .toBe(entitledOffDays(fte, wd, workFte));
    }
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

  // pto_sellback (2026-07-20): a sold-back weekday is OWED AGAIN — it must not
  // net the working-days obligation. The day credits as worked only when an
  // assignment actually lands on it (normal placement credit path).
  it('sell-back-covered weekdays are excluded from netting (owed again)', () => {
    const entries = [
      { availability_type: 'pto', start_date: '2026-01-05', end_date: '2026-01-09', approval_status: 'approved' }, // Mon..Fri
      { availability_type: 'pto_sellback', start_date: '2026-01-06', end_date: '2026-01-06', approval_status: 'approved' }, // Tue
    ];
    const covered = ptoWeekdaysCovered(entries, wd);
    expect(covered.size).toBe(4); // Mon, Wed, Thu, Fri
    expect(covered.has('2026-01-06')).toBe(false);
    // requiredWorkDays consumes the netted count: 1.0 FTE × 10 WD − 4 = 6.
    expect(requiredWorkDays(1, wd.size, covered.size)).toBe(6);
  });
  it('a dismissed sell-back row nets nothing back', () => {
    const entries = [
      { availability_type: 'pto', start_date: '2026-01-05', end_date: '2026-01-09', approval_status: 'approved' },
      { availability_type: 'pto_sellback', start_date: '2026-01-06', end_date: '2026-01-06', approval_status: 'canceled' },
    ];
    expect(ptoWeekdaysCovered(entries, wd).size).toBe(5);
  });
  it('a standalone sell-back row (no PTO overlap) nets nothing', () => {
    expect(ptoWeekdaysCovered(
      [{ availability_type: 'pto_sellback', start_date: '2026-01-06', end_date: '2026-01-06', approval_status: 'approved' }], wd,
    ).size).toBe(0);
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
