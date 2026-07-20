// Physician Planner view helpers — pure logic only (formatting, ranges,
// picker filtering, what-if parsing, bucket display order). The numeric
// assembly these feed is pinned in lib/plannerMath.test.ts.
import { describe, it, expect } from 'vitest';
import { addDays } from '@/lib/rulesEngine/shared';
import { MAX_PLANNER_RANGE_DAYS, type PlannerRosterEntry } from '@/lib/plannerMath';
import {
  EMPTY_WHAT_IF_INPUTS,
  bucketLabel,
  buildWhatIf,
  deltaTone,
  filterRoster,
  fmt1,
  fmtFte,
  monthRangeAfter,
  monthRangeContaining,
  numberDelta,
  parseCountInput,
  parseFteInput,
  parsePositiveInput,
  providerLabel,
  signed,
  signedFmt,
  sortBucketRows,
  validPlannerRange,
  yearRangeOf,
} from './plannerView';

const entry = (over: Partial<PlannerRosterEntry>): PlannerRosterEntry => ({
  provider_id: 'p1',
  first_name: null,
  last_name: null,
  short_display_name: null,
  initials: null,
  provider_type: 'physician',
  fte_value: 1,
  home_site_id: 'site-1',
  call_taker: true,
  partial_call_taker: false,
  is_day_doc: false,
  is_icu_doc: false,
  ...over,
});

describe('month/year range defaults', () => {
  it('monthRangeContaining spans the full calendar month, leap-aware', () => {
    expect(monthRangeContaining('2026-07-20')).toEqual({ date_start: '2026-07-01', date_end: '2026-07-31' });
    expect(monthRangeContaining('2026-02-10')).toEqual({ date_start: '2026-02-01', date_end: '2026-02-28' });
    expect(monthRangeContaining('2028-02-05')).toEqual({ date_start: '2028-02-01', date_end: '2028-02-29' });
    expect(monthRangeContaining('2026-12-31')).toEqual({ date_start: '2026-12-01', date_end: '2026-12-31' });
  });

  it('monthRangeAfter rolls into the next month, across year boundaries', () => {
    expect(monthRangeAfter('2026-07-20')).toEqual({ date_start: '2026-08-01', date_end: '2026-08-31' });
    expect(monthRangeAfter('2026-12-15')).toEqual({ date_start: '2027-01-01', date_end: '2027-01-31' });
    expect(monthRangeAfter('2026-01-31')).toEqual({ date_start: '2026-02-01', date_end: '2026-02-28' });
  });

  it('yearRangeOf yields the calendar-year fetch window', () => {
    expect(yearRangeOf('2026-07-20')).toEqual({ year: 2026, from: '2026-01-01', to: '2026-12-31' });
  });
});

describe('validPlannerRange', () => {
  it('requires two valid ordered ISO dates', () => {
    expect(validPlannerRange({ date_start: '2026-07-01', date_end: '2026-07-31' })).toBe(true);
    expect(validPlannerRange({ date_start: '2026-07-01', date_end: '2026-07-01' })).toBe(true);
    expect(validPlannerRange({ date_start: '2026-07-31', date_end: '2026-07-01' })).toBe(false);
    expect(validPlannerRange({ date_start: '2026-07', date_end: '2026-07-31' })).toBe(false);
    expect(validPlannerRange({ date_start: '', date_end: '2026-07-31' })).toBe(false);
  });

  it(`enforces the API's ${MAX_PLANNER_RANGE_DAYS}-day cap client-side`, () => {
    const start = '2026-01-01';
    expect(validPlannerRange({ date_start: start, date_end: addDays(start, MAX_PLANNER_RANGE_DAYS - 1) })).toBe(true);
    expect(validPlannerRange({ date_start: start, date_end: addDays(start, MAX_PLANNER_RANGE_DAYS) })).toBe(false);
  });
});

describe('formatting', () => {
  it('fmt1 / fmtFte fix decimals', () => {
    expect(fmt1(10.875)).toBe('10.9');
    expect(fmt1(3)).toBe('3.0');
    expect(fmtFte(0.6)).toBe('0.60');
    expect(fmtFte(1)).toBe('1.00');
  });

  it('signed / signedFmt use a typographic minus and an explicit plus', () => {
    expect(signed(2)).toBe('+2');
    expect(signed(-3)).toBe('−3');
    expect(signed(0)).toBe('0');
    expect(signedFmt(0.15, 2)).toBe('+0.15');
    expect(signedFmt(-0.05, 2)).toBe('−0.05');
    expect(signedFmt(0, 1)).toBe('0.0');
  });

  it('deltaTone: over warns, under alarms, on-target is ok', () => {
    expect(deltaTone(2)).toBe('warn');
    expect(deltaTone(-1)).toBe('danger');
    expect(deltaTone(0)).toBe('ok');
  });

  it('numberDelta is hypothetical − current', () => {
    expect(numberDelta(3, 5)).toBe(2);
    expect(numberDelta(5, 3)).toBe(-2);
  });
});

describe('roster picker', () => {
  const roster = [
    entry({ provider_id: 'p1', last_name: 'Smith', first_name: 'Ann' }),
    entry({ provider_id: 'p2', last_name: 'Torres', first_name: 'Ben', initials: 'BT' }),
    entry({ provider_id: 'p3', short_display_name: 'Dr. Q' }),
    entry({ provider_id: 'p4' }),
  ];

  it('providerLabel prefers "Last, First" then the display fallbacks', () => {
    expect(providerLabel(roster[0])).toBe('Smith, Ann');
    expect(providerLabel(roster[2])).toBe('Dr. Q');
    expect(providerLabel(roster[3])).toBe('p4'); // nothing else to show
  });

  it('filterRoster: case-insensitive over every name field, order preserved, empty query = all', () => {
    expect(filterRoster(roster, '').map(r => r.provider_id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(filterRoster(roster, 'smi').map(r => r.provider_id)).toEqual(['p1']);
    expect(filterRoster(roster, 'bt').map(r => r.provider_id)).toEqual(['p2']);
    expect(filterRoster(roster, 'dr. q').map(r => r.provider_id)).toEqual(['p3']);
    expect(filterRoster(roster, 'zzz')).toEqual([]);
  });
});

describe('bucket display order', () => {
  it('sorts weekday → friday → saturday → sunday → holiday, unknowns after', () => {
    const rows = ['holiday', 'sunday', 'zebra', 'weekday', 'saturday', 'friday'].map(bucket => ({ bucket }));
    expect(sortBucketRows(rows).map(r => r.bucket)).toEqual([
      'weekday', 'friday', 'saturday', 'sunday', 'holiday', 'zebra',
    ]);
  });

  it('bucketLabel capitalizes', () => {
    expect(bucketLabel('weekday')).toBe('Weekday');
    expect(bucketLabel('holiday')).toBe('Holiday');
  });
});

describe('what-if input parsing', () => {
  it('parseFteInput clamps to [0.1, 1]; blank/garbage contribute nothing', () => {
    expect(parseFteInput('0.75')).toBe(0.75);
    expect(parseFteInput('0.05')).toBe(0.1);
    expect(parseFteInput('1.5')).toBe(1);
    expect(parseFteInput('')).toBeUndefined();
    expect(parseFteInput('abc')).toBeUndefined();
  });

  it('parseCountInput: non-negative integer (rounds, floors at 0)', () => {
    expect(parseCountInput('2.6')).toBe(3);
    expect(parseCountInput('-1')).toBe(0);
    expect(parseCountInput('')).toBeUndefined();
  });

  it('parsePositiveInput: strictly positive numbers only', () => {
    expect(parsePositiveInput('8.5')).toBe(8.5);
    expect(parsePositiveInput('0')).toBeUndefined();
    expect(parsePositiveInput('-3')).toBeUndefined();
  });

  it('buildWhatIf: empty form → null (no hypothetical), populated fields map to overrides', () => {
    expect(buildWhatIf(EMPTY_WHAT_IF_INPUTS)).toBeNull();
    // Zero extra PTO / sell-back is "no change", not an override.
    expect(buildWhatIf({ ...EMPTY_WHAT_IF_INPUTS, extraPto: '0', sellback: '0' })).toBeNull();
    expect(buildWhatIf({ fte: '0.8', extraPto: '2', sellback: '1', par: '10', pool: '8.8' })).toEqual({
      fte: 0.8, extraPtoWeekdays: 2, sellbackWeekdays: 1, parLevel: 10, poolFte: 8.8,
    });
    // Garbage fields drop out; valid ones survive.
    expect(buildWhatIf({ ...EMPTY_WHAT_IF_INPUTS, fte: 'x', par: '9' })).toEqual({ parLevel: 9 });
  });
});
