import { describe, it, expect } from 'vitest';
import {
  addDays,
  dayOfWeekUTC,
  mondayOfWeek,
  thursdayBeforeWeekOf,
  datesOverlap,
  daysBetween,
  effectivePtoRange,
  normalizeWeekdays,
  dayTypeBucket,
  dayTypeBucketOn,
  isBlockingAvailability,
  isActiveNoCallRequest,
  isActiveCallRequest,
  isActiveSellback,
  isSellbackOverridden,
  isDateBlocked,
  isMissingColumnError,
  isMissingFunctionError,
} from './shared';

// Characterization tests pinning the hard-won date / PTO / bucket logic.
// 2026-01-01 is a Thursday; the week Mon..Sun containing it starts 2025-12-29.

describe('addDays (UTC)', () => {
  it('adds and subtracts days', () => {
    expect(addDays('2026-01-01', 1)).toBe('2026-01-02');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('dayOfWeekUTC', () => {
  it('returns 0=Sun..6=Sat', () => {
    expect(dayOfWeekUTC('2026-01-01')).toBe(4); // Thursday
    expect(dayOfWeekUTC('2026-01-03')).toBe(6); // Saturday
    expect(dayOfWeekUTC('2026-01-04')).toBe(0); // Sunday
    expect(dayOfWeekUTC('2026-01-05')).toBe(1); // Monday
  });
});

describe('mondayOfWeek', () => {
  it('returns the Monday of the Mon-Sun week', () => {
    expect(mondayOfWeek('2026-01-01')).toBe('2025-12-29'); // Thu -> prior Mon
    expect(mondayOfWeek('2026-01-05')).toBe('2026-01-05'); // Mon -> itself
  });
  it('treats Sunday as the end of the week (Monday 6 days prior)', () => {
    expect(mondayOfWeek('2026-01-04')).toBe('2025-12-29');
  });
});

describe('thursdayBeforeWeekOf', () => {
  it('returns the Thursday of the prior week (pre-PTO placement)', () => {
    // Week of Jan 8 (Thu) -> Monday Jan 5 -> minus 4 -> Thu Jan 1
    expect(thursdayBeforeWeekOf('2026-01-08')).toBe('2026-01-01');
  });
});

describe('datesOverlap', () => {
  it('is inclusive of both range ends', () => {
    expect(datesOverlap('2026-01-05', '2026-01-09', '2026-01-05')).toBe(true);
    expect(datesOverlap('2026-01-05', '2026-01-09', '2026-01-09')).toBe(true);
    expect(datesOverlap('2026-01-05', '2026-01-09', '2026-01-10')).toBe(false);
    expect(datesOverlap('2026-01-05', '2026-01-09', '2026-01-04')).toBe(false);
  });
});

describe('effectivePtoRange (weekend bookend)', () => {
  it('extends back 2 days when PTO starts Monday (captures the Saturday before)', () => {
    const r = effectivePtoRange({ start_date: '2026-01-05', end_date: '2026-01-09', availability_type: 'pto' });
    expect(r).toEqual({ start: '2026-01-03', end: '2026-01-11' }); // Sat before, Sun after
  });
  it('leaves single-day / non-bookend types alone', () => {
    const r = effectivePtoRange({ start_date: '2026-01-05', end_date: '2026-01-05', availability_type: 'sick' });
    expect(r).toEqual({ start: '2026-01-05', end: '2026-01-05' });
  });
  it('does not extend when PTO starts/ends mid-week', () => {
    const r = effectivePtoRange({ start_date: '2026-01-07', end_date: '2026-01-08', availability_type: 'pto' });
    expect(r).toEqual({ start: '2026-01-07', end: '2026-01-08' });
  });
});

describe('dayTypeBucket', () => {
  it('collapses day types into quota buckets', () => {
    expect(dayTypeBucket('weekday')).toBe('weekday');
    expect(dayTypeBucket('friday')).toBe('friday');
    expect(dayTypeBucket('federal_holiday')).toBe('holiday');
    expect(dayTypeBucket('major_holiday')).toBe('holiday');
  });

  it('gives Saturday and Sunday SEPARATE buckets (the split — no longer merged into weekend)', () => {
    // Both directions pinned: saturday is its own bucket, sunday is its own
    // bucket, and neither is 'weekend'. This is what lets a provider's Saturday
    // call load stop offsetting their Sunday deficit (and vice versa).
    expect(dayTypeBucket('saturday')).toBe('saturday');
    expect(dayTypeBucket('sunday')).toBe('sunday');
    expect(dayTypeBucket('saturday')).not.toBe(dayTypeBucket('sunday'));
    expect(dayTypeBucket('saturday')).not.toBe('weekend');
    expect(dayTypeBucket('sunday')).not.toBe('weekend');
  });

  it('is FROZEN at the day-type-only mapping solveLegacy was written against', () => {
    // solveLegacy.ts (never edited — the golden-parity net) calls this with one
    // string argument. If the live rule ever needs to move, it moves in
    // dayTypeBucketOn, not here.
    expect(dayTypeBucket.length).toBe(1);
    expect(dayTypeBucket('federal_holiday')).toBe('holiday');
  });
});

// Gabriel 2026-07-27, verbatim: "Holidays that fall out on a weekend Friday
// saturday or sunday, get included in the obligatory weekend count, and those
// that fall out on weekdays do the same." A holiday-dated call is charged to
// the bucket of the DAY OF THE WEEK it lands on — there is no holiday bucket.
describe('dayTypeBucketOn (the LIVE fairness bucket — holidays count as their weekday)', () => {
  // 2026-09-07 Labor Day = MONDAY; 2026-10-12 Columbus Day = MONDAY;
  // 2026-07-03 (observed Independence Day) = FRIDAY; 2026-07-04 = SATURDAY;
  // 2026-11-01 = SUNDAY.
  it('puts a MONDAY holiday in the weekday bucket (the live Paoli case)', () => {
    expect(dayTypeBucketOn('major_holiday', '2026-09-07')).toBe('weekday');
    expect(dayTypeBucketOn('federal_holiday', '2026-10-12')).toBe('weekday');
    // ...and the old rule did NOT — this is the behavior change.
    expect(dayTypeBucket('major_holiday')).toBe('holiday');
  });

  it('puts a SATURDAY holiday in the saturday bucket, a SUNDAY one in sunday, a FRIDAY one in friday', () => {
    expect(dayTypeBucketOn('major_holiday', '2026-07-04')).toBe('saturday');
    expect(dayTypeBucketOn('federal_holiday', '2026-11-01')).toBe('sunday');
    expect(dayTypeBucketOn('major_holiday', '2026-07-03')).toBe('friday');
  });

  it('never emits a holiday bucket — every DOW lands on that DOW\'s ordinary bucket', () => {
    // 2026-09-06 is a Sunday, so i = 0..6 walks Sun..Sat.
    const expected = ['sunday', 'weekday', 'weekday', 'weekday', 'weekday', 'friday', 'saturday'];
    for (let i = 0; i < 7; i++) {
      const d = addDays('2026-09-06', i);
      for (const dt of ['federal_holiday', 'major_holiday']) {
        expect(dayTypeBucketOn(dt, d)).toBe(expected[i]);
        expect(dayTypeBucketOn(dt, d)).not.toBe('holiday');
      }
    }
  });

  it('the DAY TYPE still wins whenever it names a real day — non-holiday keys are byte-identical', () => {
    // Every non-holiday day type maps exactly as dayTypeBucket does, whatever
    // the date says. That equality is what keeps golden parity intact: only
    // holiday-typed slots move.
    for (const dt of ['weekday', 'friday', 'saturday', 'sunday']) {
      for (let i = 0; i < 7; i++) {
        const d = addDays('2026-09-06', i);
        expect(dayTypeBucketOn(dt, d)).toBe(dayTypeBucket(dt));
      }
    }
  });

  it('passes unknown day types through unchanged (no silent re-derivation)', () => {
    expect(dayTypeBucketOn('zebra', '2026-09-07')).toBe('zebra');
  });
});

describe('normalizeWeekdays', () => {
  it('defaults null/malformed to all-true', () => {
    expect(normalizeWeekdays(null)).toEqual([true, true, true, true, true, true, true]);
    expect(normalizeWeekdays('nope')).toEqual([true, true, true, true, true, true, true]);
  });
  it('preserves a valid 7-element boolean array', () => {
    const v = [false, true, true, true, true, true, false];
    expect(normalizeWeekdays(v)).toEqual(v);
  });
});

describe('isBlockingAvailability (canonical predicate — spec §6.7)', () => {
  it('pending blocks — only denied/canceled are ignored', () => {
    expect(isBlockingAvailability({ availability_type: 'pto', approval_status: 'pending' })).toBe(true);
    expect(isBlockingAvailability({ availability_type: 'pto', approval_status: 'approved' })).toBe(true);
    expect(isBlockingAvailability({ availability_type: 'pto', approval_status: 'denied' })).toBe(false);
    expect(isBlockingAvailability({ availability_type: 'pto', approval_status: 'canceled' })).toBe(false);
  });
  it('non-blocking availability types never block', () => {
    expect(isBlockingAvailability({ availability_type: 'preference', approval_status: 'approved' })).toBe(false);
  });
});

// ── pto_sellback date-level override (2026-07-20) ───────────────────────────
// A live pto_sellback row means the provider IS WORKING those dates: any
// blocking coverage (pending PTO included) is overridden on exactly the
// covered dates. Dates: 2026-01-05 Mon .. 2026-01-09 Fri; 01-03 Sat.

const ptoWeek = {
  availability_type: 'pto', start_date: '2026-01-05', end_date: '2026-01-09',
  approval_status: 'approved',
};
const sellTue = {
  availability_type: 'pto_sellback', start_date: '2026-01-06', end_date: '2026-01-06',
  approval_status: 'approved',
};

describe('isActiveSellback (live sell-back rows only)', () => {
  it('approved and pending sell-back rows are live', () => {
    expect(isActiveSellback(sellTue)).toBe(true);
    expect(isActiveSellback({ ...sellTue, approval_status: 'pending' })).toBe(true);
  });
  it('denied/canceled sell-back rows are dismissed', () => {
    expect(isActiveSellback({ ...sellTue, approval_status: 'denied' })).toBe(false);
    expect(isActiveSellback({ ...sellTue, approval_status: 'canceled' })).toBe(false);
  });
  it('other availability types are never sell-back', () => {
    expect(isActiveSellback(ptoWeek)).toBe(false);
  });
  it('pto_sellback is NOT a blocking type (row-level classification unchanged)', () => {
    expect(isBlockingAvailability(sellTue)).toBe(false);
  });
});

describe('isDateBlocked (single-homed per-date decision)', () => {
  it('blocks a plain PTO week (zero-sellback ≡ isBlockingAvailability coverage)', () => {
    expect(isDateBlocked([ptoWeek], '2026-01-06')).toBe(true);
    expect(isDateBlocked([ptoWeek], '2026-01-12')).toBe(false);
  });
  it('sell-back Tuesday unblocks exactly Tuesday — Mon/Wed-Fri stay blocked', () => {
    const rows = [ptoWeek, sellTue];
    expect(isDateBlocked(rows, '2026-01-05')).toBe(true);
    expect(isDateBlocked(rows, '2026-01-06')).toBe(false);
    expect(isDateBlocked(rows, '2026-01-07')).toBe(true);
    expect(isDateBlocked(rows, '2026-01-08')).toBe(true);
    expect(isDateBlocked(rows, '2026-01-09')).toBe(true);
  });
  it('overrides PENDING PTO too — that is the feature meaning (invariant-2 nuance)', () => {
    const rows = [{ ...ptoWeek, approval_status: 'pending' }, sellTue];
    expect(isDateBlocked(rows, '2026-01-05')).toBe(true); // pending still blocks
    expect(isDateBlocked(rows, '2026-01-06')).toBe(false); // sell-back wins
  });
  it('a dismissed sell-back row does not override', () => {
    expect(isDateBlocked([ptoWeek, { ...sellTue, approval_status: 'canceled' }], '2026-01-06')).toBe(true);
    expect(isDateBlocked([ptoWeek, { ...sellTue, approval_status: 'denied' }], '2026-01-06')).toBe(true);
  });
  it('row order does not matter (sell-back wins even when listed first)', () => {
    expect(isDateBlocked([sellTue, ptoWeek], '2026-01-06')).toBe(false);
  });
  it('bookend option extends blocking rows; a sell-back on the extended date overrides it', () => {
    // Mon-start PTO bookends back over Sat 01-03 (effectivePtoRange).
    expect(isDateBlocked([ptoWeek], '2026-01-03', { bookend: true })).toBe(true);
    expect(isDateBlocked([ptoWeek], '2026-01-03')).toBe(false); // raw dates: not covered
    const sellSat = { ...sellTue, start_date: '2026-01-03', end_date: '2026-01-03' };
    expect(isDateBlocked([ptoWeek, sellSat], '2026-01-03', { bookend: true })).toBe(false);
  });
  it('a standalone sell-back row (no blocking overlap) changes nothing', () => {
    expect(isDateBlocked([sellTue], '2026-01-06')).toBe(false);
    expect(isDateBlocked([], '2026-01-06')).toBe(false);
  });
});

describe('isSellbackOverridden (the override coverage decision)', () => {
  it('true exactly on live sell-back-covered dates', () => {
    expect(isSellbackOverridden([sellTue], '2026-01-06')).toBe(true);
    expect(isSellbackOverridden([sellTue], '2026-01-07')).toBe(false);
    expect(isSellbackOverridden([{ ...sellTue, approval_status: 'denied' }], '2026-01-06')).toBe(false);
    expect(isSellbackOverridden([ptoWeek], '2026-01-06')).toBe(false);
  });
});

// ── request predicates (no-call 2026-07-17 / call 2026-07-22) ───────────────
// isActiveCallRequest is the MIRROR IMAGE of isActiveNoCallRequest: same
// status semantics (pending counts; denied/canceled don't), different
// availability_type, opposite engine meaning (prefer vs avoid). Pinned in
// parity so the two single-home predicates can never drift.

describe('isActiveNoCallRequest / isActiveCallRequest (single-home parity)', () => {
  const cases: Array<[string, boolean]> = [
    ['approved', true], ['pending', true], ['waitlisted', true],
    ['denied', false], ['canceled', false],
  ];
  it('identical status semantics for both predicates', () => {
    for (const [status, live] of cases) {
      expect(isActiveNoCallRequest({ availability_type: 'no_call_request', approval_status: status }),
        `no_call/${status}`).toBe(live);
      expect(isActiveCallRequest({ availability_type: 'call_request', approval_status: status }),
        `call/${status}`).toBe(live);
    }
  });
  it('each predicate matches ONLY its own availability_type', () => {
    expect(isActiveNoCallRequest({ availability_type: 'call_request', approval_status: 'approved' })).toBe(false);
    expect(isActiveCallRequest({ availability_type: 'no_call_request', approval_status: 'approved' })).toBe(false);
    expect(isActiveCallRequest({ availability_type: 'pto', approval_status: 'approved' })).toBe(false);
  });
  it('neither request type is blocking (soft levers only)', () => {
    expect(isBlockingAvailability({ availability_type: 'no_call_request', approval_status: 'approved' })).toBe(false);
    expect(isBlockingAvailability({ availability_type: 'call_request', approval_status: 'approved' })).toBe(false);
  });
});

describe('daysBetween (UTC whole days)', () => {
  it('counts forward and backward', () => {
    expect(daysBetween('2026-01-01', '2026-01-08')).toBe(7);
    expect(daysBetween('2026-01-08', '2026-01-01')).toBe(-7);
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
  });
  it('crosses month/year boundaries', () => {
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
  });
});

// The degraded-mode error classifiers. A MISSING FUNCTION is the case the
// schedules list depends on (patch39's RPC): it must not read as a missing
// column, or a DB that predates the patch gets logged as a genuine failure.
describe('isMissingFunctionError vs isMissingColumnError', () => {
  const PGRST202 = {
    code: 'PGRST202',
    message: 'Could not find the function scheduling.schedule_last_activity(p_schedule_ids) in the schema cache',
  };
  const UNDEFINED_FN = {
    code: '42883',
    message: 'function scheduling.schedule_last_activity(uuid[]) does not exist',
  };

  it('catches PostgREST schema-cache misses and raw 42883', () => {
    expect(isMissingFunctionError(PGRST202)).toBe(true);
    expect(isMissingFunctionError(UNDEFINED_FN)).toBe(true);
    expect(isMissingFunctionError({ message: 'Could not find the function foo' })).toBe(true);
  });

  it('is NOT covered by isMissingColumnError — the whole reason it exists', () => {
    expect(isMissingColumnError(PGRST202)).toBe(false);
    expect(isMissingColumnError(UNDEFINED_FN)).toBe(false);
  });

  it('leaves a genuine read failure alone', () => {
    expect(isMissingFunctionError({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe(false);
    expect(isMissingFunctionError({ code: '42703', message: 'column x does not exist' })).toBe(false);
    expect(isMissingFunctionError(null)).toBe(false);
    expect(isMissingFunctionError(undefined)).toBe(false);
  });
});
