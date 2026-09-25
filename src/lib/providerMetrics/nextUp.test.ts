// Next Up — the next 30 days for one physician.
//
// `today` is always an argument here, never a clock read, so these tests pin
// exact dates and cannot rot into failure overnight. Thu 2026-09-24 is the
// default "today"; a 30-day horizon therefore runs to Fri 2026-10-23.
import { describe, it, expect } from 'vitest';
import { computeNextUp, DEFAULT_HORIZON_DAYS, type NextUpInput } from './nextUp';
import type { MetricAssignment, MetricAvailability, MetricHoliday } from './types';

const TODAY = '2026-09-24';                                  // Thursday
const PUBLISHED = { start: '2026-09-01', end: '2026-12-31' };

const call = (
  date: string, code = 'C1', over: Partial<MetricAssignment> = {},
): MetricAssignment => ({ date, code, category: 'call', ...over });
const day = (date: string, code = '7-3'): MetricAssignment =>
  ({ date, code, category: 'day' });

const pto = (
  start: string, end: string, approval_status = 'approved',
): MetricAvailability => ({
  availability_type: 'pto', approval_status, start_date: start, end_date: end,
});

const THANKSGIVING: MetricHoliday = { holiday_date: '2026-11-26', name: 'Thanksgiving Day' };
const CHRISTMAS: MetricHoliday = { holiday_date: '2026-12-25', name: 'Christmas Day' };
const NEW_YEAR: MetricHoliday = { holiday_date: '2027-01-01', name: "New Year's Day" };

const next = (over: Partial<NextUpInput> = {}) => computeNextUp({
  today: TODAY,
  assignments: [],
  availability: [],
  holidays: [],
  published: PUBLISHED,
  ...over,
});

describe('the window', () => {
  it('spans exactly `horizonDays` calendar days, INCLUDING today', () => {
    const r = next();
    expect(r.horizonDays).toBe(DEFAULT_HORIZON_DAYS);
    expect(r.window).toEqual({ start: '2026-09-24', end: '2026-10-23' });
  });

  it('honours a caller-supplied horizon', () => {
    expect(next({ horizonDays: 7 }).window).toEqual({ start: TODAY, end: '2026-09-30' });
    expect(next({ horizonDays: 1 }).window).toEqual({ start: TODAY, end: TODAY });
  });

  it('crosses the year boundary', () => {
    const r = next({ today: '2026-12-24', assignments: [call('2027-01-05')] });
    expect(r.window).toEqual({ start: '2026-12-24', end: '2027-01-22' });
    expect(r.nextCall?.date).toBe('2027-01-05');
    expect(r.nextCall?.daysAway).toBe(12);
  });

  it('is deterministic — no clock, no randomness', () => {
    const input = { assignments: [call('2026-09-28')], availability: [pto('2026-10-05', '2026-10-09')] };
    expect(next(input)).toEqual(next(input));
  });
});

describe('next call', () => {
  it('is the earliest call in the window, with its code', () => {
    const r = next({ assignments: [call('2026-10-02', 'C2'), call('2026-09-28', 'C1')] });
    expect(r.nextCall).toMatchObject({ date: '2026-09-28', code: 'C1', daysAway: 4 });
    expect(r.status.call).toBe('found');
  });

  it('counts TODAY — a tile that hides tonight\'s call is wrong', () => {
    const r = next({ assignments: [call(TODAY, 'C1')] });
    expect(r.nextCall?.date).toBe(TODAY);
    expect(r.nextCall?.daysAway).toBe(0);
  });

  it('ignores day shifts and anything before today', () => {
    const r = next({ assignments: [day('2026-09-25'), call('2026-09-20')] });
    expect(r.nextCall).toBeNull();
    expect(r.status.call).toBe('none_in_window');
  });

  it('includes the last day of the window and excludes the day after', () => {
    expect(next({ assignments: [call('2026-10-23')] }).nextCall?.date).toBe('2026-10-23');
    expect(next({ assignments: [call('2026-10-24')] }).nextCall).toBeNull();
  });

  it('reports the parent code and the post-call day the call earns', () => {
    const r = next({
      assignments: [call('2026-09-28', 'C1D12', { parentCode: 'C1', requiresPostCall: true })],
    });
    expect(r.nextCall).toMatchObject({
      code: 'C1D12', parentCode: 'C1', requiresPostCall: true, postCallDate: '2026-09-29',
    });
  });

  it('leaves postCallDate null for a code that confers no rest', () => {
    expect(next({ assignments: [call('2026-09-28', 'CB')] }).nextCall?.postCallDate).toBeNull();
  });
});

describe('next post-call day', () => {
  it('can be earned by a call BEFORE the window — yesterday\'s call is today\'s day off', () => {
    const r = next({ assignments: [call('2026-09-23', 'C1', { requiresPostCall: true })] });
    expect(r.nextPostCall).toEqual({
      date: TODAY, sourceDate: '2026-09-23', sourceCode: 'C1', daysAway: 0,
    });
    expect(r.status.postCall).toBe('found');
  });

  it('is the earliest rest day in the window', () => {
    const r = next({
      assignments: [
        call('2026-10-01', 'C1', { requiresPostCall: true }),
        call('2026-09-28', 'C2', { requiresPostCall: true }),
      ],
    });
    expect(r.nextPostCall?.date).toBe('2026-09-29');
    expect(r.nextPostCall?.sourceCode).toBe('C2');
  });

  it('is null when no call in range confers rest', () => {
    const r = next({ assignments: [call('2026-09-28', 'CB')] });
    expect(r.nextPostCall).toBeNull();
    expect(r.status.postCall).toBe('none_in_window');
  });
});

describe('next weekend on', () => {
  it('is the weekend an assignment lands in, named by its Saturday', () => {
    const r = next({ assignments: [call('2026-09-26', 'C1')] });
    expect(r.nextWeekendOn).toMatchObject({
      saturday: '2026-09-26',
      dates: ['2026-09-25', '2026-09-26', '2026-09-27'],
      daysAway: 2,
    });
    expect(r.nextWeekendOn?.reasons.map(x => x.kind)).toEqual(['assignment']);
  });

  it('counts a post-call day landing in a weekend — same rule as the free-weekend count', () => {
    // Thu 2026-10-01 C1 → post-call Fri 2026-10-02 → the 10-03 weekend is gone.
    const r = next({ assignments: [call('2026-10-01', 'C1', { requiresPostCall: true })] });
    expect(r.nextWeekendOn?.saturday).toBe('2026-10-03');
    expect(r.nextWeekendOn?.reasons).toEqual([{
      date: '2026-10-02', kind: 'post_call', code: 'C1', sourceDate: '2026-10-01',
    }]);
  });

  it('picks the EARLIEST occupied weekend, not the first one listed', () => {
    const r = next({ assignments: [call('2026-10-10'), call('2026-09-27')] });
    expect(r.nextWeekendOn?.saturday).toBe('2026-09-26');
  });

  it('does not resurrect a weekend whose only work is already past', () => {
    // Today is the Saturday; the Friday call has been and gone.
    const r = next({ today: '2026-09-26', assignments: [call('2026-09-25')] });
    expect(r.nextWeekendOn).toBeNull();
    expect(r.status.weekend).toBe('none_in_window');
  });

  it('ignores Mon–Thu work', () => {
    const r = next({ assignments: [call('2026-09-28'), call('2026-09-29')] });
    expect(r.nextWeekendOn).toBeNull();
  });
});

describe('next PTO block', () => {
  it('is the earliest live block touching the window', () => {
    const r = next({ availability: [pto('2026-10-19', '2026-10-23'), pto('2026-10-05', '2026-10-09')] });
    expect(r.nextPto).toEqual({
      start: '2026-10-05', end: '2026-10-09', approvalStatus: 'approved',
      daysAway: 11, inProgress: false,
    });
    expect(r.status.pto).toBe('found');
  });

  it('shows a PENDING block AS pending — it blocks scheduling but was not granted', () => {
    const r = next({ availability: [pto('2026-10-05', '2026-10-09', 'pending')] });
    expect(r.nextPto?.approvalStatus).toBe('pending');
  });

  it('ignores denied and canceled rows', () => {
    const r = next({
      availability: [pto('2026-10-05', '2026-10-09', 'denied'), pto('2026-10-12', '2026-10-16', 'canceled')],
    });
    expect(r.nextPto).toBeNull();
    expect(r.status.pto).toBe('none_in_window');
  });

  it('reports a block already running, with a negative daysAway', () => {
    const r = next({ availability: [pto('2026-09-20', '2026-09-28')] });
    expect(r.nextPto).toMatchObject({ inProgress: true, daysAway: -4 });
  });

  it('ignores a block entirely past or entirely beyond the horizon', () => {
    const r = next({ availability: [pto('2026-09-01', '2026-09-05'), pto('2026-12-01', '2026-12-10')] });
    expect(r.nextPto).toBeNull();
    expect(r.status.pto).toBe('none_in_window');
  });

  it('ignores other leave types — sick leave is not "your next PTO"', () => {
    const r = next({
      availability: [{
        availability_type: 'sick', approval_status: 'approved',
        start_date: '2026-10-05', end_date: '2026-10-06',
      }],
    });
    expect(r.nextPto).toBeNull();
  });

  it('will NOT call an empty availability read "no PTO"', () => {
    // An empty array is ambiguous — nothing on file, or the read failed.
    expect(next({ availability: [] }).status.pto).toBe('not_covered');
    // … unless the caller asserts the read succeeded.
    expect(next({ availability: [], availabilityLoaded: true }).status.pto).toBe('none_in_window');
  });
});

describe('next holiday obligation', () => {
  const NOV = { today: '2026-11-20', published: { start: '2026-09-01', end: '2027-01-31' } };
  const DEC = { today: '2026-12-01', published: { start: '2026-09-01', end: '2027-01-31' } };

  it('names the holiday a working date belongs to', () => {
    const r = next({ ...NOV, holidays: [THANKSGIVING], assignments: [call('2026-11-26', 'C1')] });
    expect(r.nextHolidayObligation).toEqual({
      date: '2026-11-26', holiday: 'Thanksgiving Day', code: 'C1',
      source: 'assignment', daysAway: 6,
    });
    expect(r.status.holiday).toBe('found');
  });

  it('covers the whole holiday BLOCK, not just the holiday date', () => {
    // Thanksgiving takes the Wednesday eve and the Friday after (holidayCall).
    const r = next({ ...NOV, holidays: [THANKSGIVING], assignments: [call('2026-11-27', 'C1')] });
    expect(r.nextHolidayObligation).toMatchObject({
      date: '2026-11-27', holiday: 'Thanksgiving Day',
    });
    const eve = next({ ...NOV, holidays: [THANKSGIVING], assignments: [call('2026-11-25', 'C1')] });
    expect(eve.nextHolidayObligation?.holiday).toBe('Thanksgiving Day');
  });

  it('covers the weekend Christmas pulls in behind it', () => {
    const r = next({
      today: '2026-12-20', published: { start: '2026-09-01', end: '2027-01-31' },
      holidays: [CHRISTMAS], assignments: [call('2026-12-27', 'C1')],
    });
    expect(r.nextHolidayObligation?.holiday).toBe('Christmas Day');
  });

  it("attributes New Year's Eve to New Year's Day, across the year boundary", () => {
    const r = next({
      today: '2026-12-29', published: { start: '2026-09-01', end: '2027-01-31' },
      holidays: [NEW_YEAR], assignments: [call('2026-12-31', 'C1')],
    });
    expect(r.nextHolidayObligation).toMatchObject({
      date: '2026-12-31', holiday: "New Year's Day", daysAway: 2,
    });
  });

  it('reads the chief\'s plan of record before any schedule covers the date', () => {
    const r = next({
      ...DEC, holidays: [CHRISTMAS],
      availability: [{
        availability_type: 'holiday_call', approval_status: 'approved',
        start_date: '2026-12-25', end_date: '2026-12-25', reason_code: 'C2',
      }],
    });
    expect(r.nextHolidayObligation).toEqual({
      date: '2026-12-25', holiday: 'Christmas Day', code: 'C2',
      source: 'recorded', daysAway: 24,
    });
  });

  it('prefers the real assignment over the recorded intention on the same day', () => {
    const r = next({
      ...NOV, holidays: [THANKSGIVING],
      assignments: [call('2026-11-26', 'C1')],
      availability: [{
        availability_type: 'holiday_call', approval_status: 'approved',
        start_date: '2026-11-26', end_date: '2026-11-26', reason_code: 'C2',
      }],
    });
    expect(r.nextHolidayObligation?.source).toBe('assignment');
    expect(r.nextHolidayObligation?.code).toBe('C1');
  });

  it('ignores a dismissed holiday-call row', () => {
    const r = next({
      ...DEC, holidays: [CHRISTMAS],
      availability: [{
        availability_type: 'holiday_call', approval_status: 'canceled',
        start_date: '2026-12-25', end_date: '2026-12-25', reason_code: 'C2',
      }],
    });
    expect(r.nextHolidayObligation).toBeNull();
  });

  it('ignores work on an ordinary day', () => {
    const r = next({ ...NOV, holidays: [THANKSGIVING], assignments: [call('2026-11-23', 'C1')] });
    expect(r.nextHolidayObligation).toBeNull();
    expect(r.status.holiday).toBe('none_in_window');
  });

  it('will NOT call an empty holiday calendar "no holiday obligation"', () => {
    const r = next({ ...NOV, holidays: [], assignments: [call('2026-11-26', 'C1')] });
    expect(r.nextHolidayObligation).toBeNull();
    expect(r.status.holiday).toBe('not_covered');
  });
});

describe('coverage — never a confident zero', () => {
  it('reports NOT COVERED for every schedule-backed tile when nothing is published', () => {
    const r = next({ published: null, availabilityLoaded: true, holidayCalendarLoaded: true });
    expect(r.coverage.kind).toBe('none');
    expect(r.status.call).toBe('not_covered');
    expect(r.status.postCall).toBe('not_covered');
    expect(r.status.weekend).toBe('not_covered');
    expect(r.status.holiday).toBe('not_covered');
    // PTO does not need a published schedule to exist.
    expect(r.status.pto).toBe('none_in_window');
  });

  it('reports PARTIALLY COVERED when the schedule runs out mid-window', () => {
    const r = next({ published: { start: '2026-09-01', end: '2026-10-04' } });
    expect(r.coverage.kind).toBe('partial');
    expect(r.coverage.coveredThrough).toBe('2026-10-04');
    expect(r.coverage.uncoveredDays).toBe(19);
    expect(r.status.call).toBe('partially_covered');
  });

  it('still says FOUND when something turned up inside a partial window', () => {
    const r = next({
      published: { start: '2026-09-01', end: '2026-10-04' },
      assignments: [call('2026-09-28')],
    });
    expect(r.status.call).toBe('found');
    expect(r.coverage.kind).toBe('partial');   // the caller still gets the caveat
  });

  it('gives a trustworthy all-clear only when the whole window is published', () => {
    const r = next({
      published: { start: '2026-09-01', end: '2026-12-31' },
      availabilityLoaded: true, holidayCalendarLoaded: true,
    });
    expect(r.coverage.kind).toBe('full');
    expect(r.status).toEqual({
      call: 'none_in_window', postCall: 'none_in_window', weekend: 'none_in_window',
      pto: 'none_in_window', holiday: 'none_in_window',
    });
  });
});
