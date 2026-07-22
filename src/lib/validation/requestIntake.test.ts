import { describe, it, expect } from 'vitest';
import {
  RequestWindowCreateSchema, IntakeSubmissionSchema,
  windowNotesTag, callRequestsEnabled, countWindowRequestRows,
  weekendGroupKey, weekendGroupDates, noCallUnitKey,
  countNoCallRequestUnits, windowRequestDates,
} from './requestIntake';

// Pure request-window helpers + zod surfaces for the call-request category
// (2026-07-22). The schemas gate bodies before Supabase; the two helpers are
// the single home for "is the call category on?" and the used-count both the
// admin forms and the profile Availability tab render.

describe('RequestWindowCreateSchema — max_call_requests', () => {
  const base = { site_id: 's1', block_start: '2026-09-07', block_end: '2026-11-22' };

  it('accepts an integer cap ≥ 1', () => {
    const r = RequestWindowCreateSchema.safeParse({ ...base, max_call_requests: 1 });
    expect(r.success).toBe(true);
  });
  it('accepts null / omitted (category off)', () => {
    expect(RequestWindowCreateSchema.safeParse({ ...base, max_call_requests: null }).success).toBe(true);
    expect(RequestWindowCreateSchema.safeParse(base).success).toBe(true);
  });
  it('rejects 0 and non-integers', () => {
    expect(RequestWindowCreateSchema.safeParse({ ...base, max_call_requests: 0 }).success).toBe(false);
    expect(RequestWindowCreateSchema.safeParse({ ...base, max_call_requests: 1.5 }).success).toBe(false);
  });
});

describe('IntakeSubmissionSchema — call_dates', () => {
  it('defaults call_dates to [] and validates date shape', () => {
    const r = IntakeSubmissionSchema.parse({ provider_id: 'p1' });
    expect(r.call_dates).toEqual([]);
    expect(IntakeSubmissionSchema.safeParse({ provider_id: 'p1', call_dates: ['nope'] }).success).toBe(false);
    expect(IntakeSubmissionSchema.safeParse({ provider_id: 'p1', call_dates: ['2026-09-10'] }).success).toBe(true);
  });
});

describe('callRequestsEnabled', () => {
  it('true only for an integer cap ≥ 1', () => {
    expect(callRequestsEnabled(1)).toBe(true);
    expect(callRequestsEnabled(6)).toBe(true);
    expect(callRequestsEnabled(0)).toBe(false);
    expect(callRequestsEnabled(null)).toBe(false);
    expect(callRequestsEnabled(undefined)).toBe(false);
  });
});

describe('countWindowRequestRows', () => {
  const rows = [
    { availability_type: 'call_request', notes: windowNotesTag('w1') },
    { availability_type: 'call_request', notes: windowNotesTag('w1') },
    { availability_type: 'call_request', notes: windowNotesTag('w2') }, // other window
    { availability_type: 'call_request', notes: null },                 // untagged
    { availability_type: 'no_call_request', notes: windowNotesTag('w1') },
  ];
  it('counts only rows of the given type tagged to the given window', () => {
    expect(countWindowRequestRows(rows, 'w1', 'call_request')).toBe(2);
    expect(countWindowRequestRows(rows, 'w1', 'no_call_request')).toBe(1);
    expect(countWindowRequestRows(rows, 'w2', 'call_request')).toBe(1);
    expect(countWindowRequestRows(rows, 'w3', 'call_request')).toBe(0);
  });
});

// ── Weekend no-call unit counting (Gabriel 2026-07-22) ──────────────────────
// "A no weekend call (no Friday, no Saturday and no Sunday call) is considered
// one request not three." NO-CALL dates count against max_no_call_requests in
// UNITS: weekday = 1 each; Fri/Sat/Sun of the SAME weekend share 1. The
// weekend key is that weekend's Saturday (Fri → +1, Sat → itself, Sun → −1).
// CALL requests are NOT unit-counted — they stay one request per date.
// 2026 anchors used below: 9/10 Thu · 9/11 Fri · 9/12 Sat · 9/13 Sun ·
// 9/18–20 = the NEXT weekend · 10/30 Fri · 10/31 Sat · 11/1 Sun.

describe('weekendGroupKey', () => {
  it('maps Fri/Sat/Sun to that weekend\'s Saturday', () => {
    expect(weekendGroupKey('2026-09-11')).toBe('2026-09-12'); // Fri → +1
    expect(weekendGroupKey('2026-09-12')).toBe('2026-09-12'); // Sat → itself
    expect(weekendGroupKey('2026-09-13')).toBe('2026-09-12'); // Sun → −1
  });
  it('returns null for Mon–Thu', () => {
    expect(weekendGroupKey('2026-09-07')).toBeNull(); // Mon
    expect(weekendGroupKey('2026-09-10')).toBeNull(); // Thu
  });
  it('crosses month boundaries with pure date math', () => {
    expect(weekendGroupKey('2026-10-30')).toBe('2026-10-31'); // Fri → Sat next day
    expect(weekendGroupKey('2026-11-01')).toBe('2026-10-31'); // Sun → Sat prev month
  });
  it('crosses year boundaries with pure date math', () => {
    expect(weekendGroupKey('2027-12-31')).toBe('2028-01-01'); // Fri → Sat next year
    expect(weekendGroupKey('2028-01-02')).toBe('2028-01-01'); // Sun → Sat prev day
  });
});

describe('weekendGroupDates', () => {
  it('returns the Fri/Sat/Sun of the date\'s weekend', () => {
    for (const d of ['2026-09-11', '2026-09-12', '2026-09-13']) {
      expect(weekendGroupDates(d)).toEqual(['2026-09-11', '2026-09-12', '2026-09-13']);
    }
  });
  it('returns [] for weekdays', () => {
    expect(weekendGroupDates('2026-09-10')).toEqual([]);
  });
  it('spans a month boundary correctly', () => {
    expect(weekendGroupDates('2026-11-01')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
  });
});

describe('noCallUnitKey', () => {
  it('weekday → the date itself; Fri/Sat/Sun → the Saturday key', () => {
    expect(noCallUnitKey('2026-09-10')).toBe('2026-09-10');
    expect(noCallUnitKey('2026-09-11')).toBe('2026-09-12');
    expect(noCallUnitKey('2026-09-13')).toBe('2026-09-12');
  });
});

describe('countNoCallRequestUnits', () => {
  it('a weekday date counts as one unit each', () => {
    expect(countNoCallRequestUnits(['2026-09-10'])).toBe(1);
    expect(countNoCallRequestUnits(['2026-09-10', '2026-10-01'])).toBe(2);
  });
  it('a lone Saturday is one unit', () => {
    expect(countNoCallRequestUnits(['2026-09-12'])).toBe(1);
  });
  it('a full Fri+Sat+Sun weekend is ONE unit, not three', () => {
    expect(countNoCallRequestUnits(['2026-09-11', '2026-09-12', '2026-09-13'])).toBe(1);
  });
  it('Fri+Sat of one weekend + Sun of ANOTHER weekend = 2 units', () => {
    expect(countNoCallRequestUnits(['2026-09-11', '2026-09-12', '2026-09-20'])).toBe(2);
  });
  it('a month-boundary weekend (Oct 30 – Nov 1) is one unit', () => {
    expect(countNoCallRequestUnits(['2026-10-30', '2026-10-31', '2026-11-01'])).toBe(1);
  });
  it('a year-boundary weekend (Dec 31 – Jan 2) is one unit', () => {
    expect(countNoCallRequestUnits(['2027-12-31', '2028-01-01', '2028-01-02'])).toBe(1);
  });
  it('duplicate dates collapse; empty input is 0', () => {
    expect(countNoCallRequestUnits(['2026-09-10', '2026-09-10'])).toBe(1);
    expect(countNoCallRequestUnits([])).toBe(0);
  });
  it('mixed weekday + weekend: units add independently', () => {
    // Thu + full weekend + Thu = 3 units.
    expect(countNoCallRequestUnits([
      '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-10-01',
    ])).toBe(3);
  });
});

describe('windowRequestDates', () => {
  const rows = [
    { availability_type: 'no_call_request', notes: windowNotesTag('w1'), start_date: '2026-09-11' },
    { availability_type: 'no_call_request', notes: windowNotesTag('w1'), start_date: '2026-09-12' },
    { availability_type: 'no_call_request', notes: windowNotesTag('w2'), start_date: '2026-09-19' }, // other window
    { availability_type: 'no_call_request', notes: null, start_date: '2026-09-20' },                 // untagged
    { availability_type: 'call_request', notes: windowNotesTag('w1'), start_date: '2026-10-01' },
  ];
  it('returns the dates of rows of the given type tagged to the given window', () => {
    expect(windowRequestDates(rows, 'w1', 'no_call_request')).toEqual(['2026-09-11', '2026-09-12']);
    expect(windowRequestDates(rows, 'w1', 'call_request')).toEqual(['2026-10-01']);
    expect(windowRequestDates(rows, 'w3', 'no_call_request')).toEqual([]);
  });
  it('unit-counts compose: a window\'s no-call rows collapse by weekend', () => {
    expect(countNoCallRequestUnits(windowRequestDates(rows, 'w1', 'no_call_request'))).toBe(1);
  });
});
