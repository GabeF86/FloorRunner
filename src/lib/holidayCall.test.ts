import { describe, it, expect } from 'vitest';
import {
  holidayBlockDates,
  planHolidayCallSeeds,
  isHolidayCallCode,
  holidayCallCodeLabel,
  HOLIDAY_CALL_CODES,
  type HolidayCallSlot,
} from './holidayCall';

describe('holidayBlockDates', () => {
  // Dates below are the real patch23-seeded federal holidays.
  it('takes the Friday after Thanksgiving and the weekend behind it', () => {
    expect(holidayBlockDates('2026-11-26', 'Thanksgiving'))
      .toEqual(['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']);
  });

  it('pulls the trailing weekend in for a Friday holiday', () => {
    expect(holidayBlockDates('2026-12-25', 'Christmas Day'))
      .toEqual(['2026-12-25', '2026-12-26', '2026-12-27']);
    expect(holidayBlockDates('2027-01-01', "New Year's Day"))
      .toEqual(['2027-01-01', '2027-01-02', '2027-01-03']);
  });

  it('pulls the leading weekend in for a Monday holiday', () => {
    expect(holidayBlockDates('2026-05-25', 'Memorial Day'))
      .toEqual(['2026-05-23', '2026-05-24', '2026-05-25']);
    expect(holidayBlockDates('2026-09-07', 'Labor Day'))
      .toEqual(['2026-09-05', '2026-09-06', '2026-09-07']);
  });

  it('leaves a midweek holiday as a single day', () => {
    // Tue/Wed/Thu holidays touch no weekend: Veterans Day 2026 is a
    // Wednesday, New Year's Day 2026 a Thursday.
    expect(holidayBlockDates('2026-11-11', 'Veterans Day')).toEqual(['2026-11-11']);
    expect(holidayBlockDates('2026-01-01', "New Year's Day")).toEqual(['2026-01-01']);
  });

  it('extends a Saturday holiday forward only — Friday is a working day', () => {
    // Independence Day 2026 falls on a Saturday.
    expect(holidayBlockDates('2026-07-04', 'Independence Day'))
      .toEqual(['2026-07-04', '2026-07-05']);
  });

  it('extends a Sunday holiday backward onto its Saturday', () => {
    // Independence Day 2027 falls on a Sunday.
    expect(holidayBlockDates('2027-07-04', 'Independence Day'))
      .toEqual(['2027-07-03', '2027-07-04']);
    // Christmas 2027 is a Saturday — forward onto the Sunday only.
    expect(holidayBlockDates('2027-12-25', 'Christmas Day'))
      .toEqual(['2027-12-25', '2027-12-26']);
  });

  it('does not treat a non-Thanksgiving holiday name as Thanksgiving', () => {
    // Same Thursday date, different holiday: no Friday pickup.
    expect(holidayBlockDates('2026-11-26', 'Some Other Day')).toEqual(['2026-11-26']);
    expect(holidayBlockDates('2026-11-26', null)).toEqual(['2026-11-26']);
  });

  it('is timezone-stable — dates never shift a day', () => {
    // A UTC-midnight bug shows up first on a year boundary, where a day shift
    // in a negative-offset zone also rolls the year. Juneteenth 2026 is a
    // Friday, so its trailing weekend must come back intact.
    expect(holidayBlockDates('2026-06-19', 'Juneteenth'))
      .toEqual(['2026-06-19', '2026-06-20', '2026-06-21']);
    expect(holidayBlockDates('2027-01-01', "New Year's Day"))
      .toEqual(['2027-01-01', '2027-01-02', '2027-01-03']);
  });
});

describe('holiday call codes', () => {
  it('exposes exactly C1/C2/C3/PC', () => {
    expect(HOLIDAY_CALL_CODES.map(c => c.code)).toEqual(['C1', 'C2', 'C3', 'PC']);
  });

  it('recognizes only those codes', () => {
    expect(isHolidayCallCode('C1')).toBe(true);
    expect(isHolidayCallCode('PC')).toBe(true);
    expect(isHolidayCallCode('D1')).toBe(false);
    expect(isHolidayCallCode('')).toBe(false);
    expect(isHolidayCallCode(null)).toBe(false);
  });

  it('falls back to the raw code for an unknown label', () => {
    expect(holidayCallCodeLabel('C1')).toMatch(/^C1/);
    expect(holidayCallCodeLabel('D9')).toBe('D9');
  });
});

describe('planHolidayCallSeeds', () => {
  const slot = (
    id: string, date: string, code: string, slot_index = 0,
  ): HolidayCallSlot => ({
    slot_id: `slot-${id}`, assignment_id: `asg-${id}`, slot_date: date, code, slot_index,
  });

  it('fills the matching slot for each recorded decision', () => {
    const plan = planHolidayCallSeeds(
      [
        { provider_id: 'p1', date: '2026-12-25', code: 'C1' },
        { provider_id: 'p2', date: '2026-12-25', code: 'C2' },
      ],
      [slot('a', '2026-12-25', 'C1'), slot('b', '2026-12-25', 'C2')],
    );
    expect(plan.skipped).toEqual([]);
    expect(plan.fills).toEqual([
      { slot_id: 'slot-a', assignment_id: 'asg-a', provider_id: 'p1', slot_date: '2026-12-25', code: 'C1' },
      { slot_id: 'slot-b', assignment_id: 'asg-b', provider_id: 'p2', slot_date: '2026-12-25', code: 'C2' },
    ]);
  });

  it('records a skip rather than dropping a decision with no slot', () => {
    const plan = planHolidayCallSeeds(
      [{ provider_id: 'p1', date: '2026-12-25', code: 'PC' }],
      [slot('a', '2026-12-25', 'C1')],
    );
    expect(plan.fills).toEqual([]);
    expect(plan.skipped).toEqual([
      { provider_id: 'p1', date: '2026-12-25', code: 'PC', reason: 'no PC slot on this date in the new schedule' },
    ]);
  });

  it('uses sibling slots when the slate has them, and skips the overflow', () => {
    const plan = planHolidayCallSeeds(
      [
        { provider_id: 'p1', date: '2026-12-25', code: 'C1' },
        { provider_id: 'p2', date: '2026-12-25', code: 'C1' },
        { provider_id: 'p3', date: '2026-12-25', code: 'C1' },
      ],
      [slot('a', '2026-12-25', 'C1', 0), slot('b', '2026-12-25', 'C1', 1)],
    );
    expect(plan.fills.map(f => f.provider_id)).toEqual(['p1', 'p2']);
    expect(plan.fills.map(f => f.slot_id)).toEqual(['slot-a', 'slot-b']);
    expect(plan.skipped).toEqual([
      { provider_id: 'p3', date: '2026-12-25', code: 'C1', reason: 'every C1 slot on this date is already taken' },
    ]);
  });

  it('takes the lowest slot_index first regardless of input order', () => {
    const plan = planHolidayCallSeeds(
      [{ provider_id: 'p1', date: '2026-12-25', code: 'C1' }],
      [slot('b', '2026-12-25', 'C1', 1), slot('a', '2026-12-25', 'C1', 0)],
    );
    expect(plan.fills[0].slot_id).toBe('slot-a');
  });

  it('never double-books one provider on a single date', () => {
    const plan = planHolidayCallSeeds(
      [
        { provider_id: 'p1', date: '2026-12-25', code: 'C1' },
        { provider_id: 'p1', date: '2026-12-25', code: 'C2' },
      ],
      [slot('a', '2026-12-25', 'C1'), slot('b', '2026-12-25', 'C2')],
    );
    expect(plan.fills).toHaveLength(1);
    expect(plan.fills[0].code).toBe('C1');
    expect(plan.skipped).toEqual([
      { provider_id: 'p1', date: '2026-12-25', code: 'C2', reason: 'provider already placed on this date' },
    ]);
  });

  it('is deterministic — input order does not change the outcome', () => {
    const slots = [
      slot('a', '2026-12-25', 'C1'), slot('b', '2026-12-25', 'C2'),
      slot('c', '2026-12-26', 'C1'),
    ];
    const entries = [
      { provider_id: 'p2', date: '2026-12-26', code: 'C1' },
      { provider_id: 'p1', date: '2026-12-25', code: 'C2' },
      { provider_id: 'p3', date: '2026-12-25', code: 'C1' },
    ];
    const forward = planHolidayCallSeeds(entries, slots);
    const reversed = planHolidayCallSeeds([...entries].reverse(), slots);
    expect(forward).toEqual(reversed);
    expect(forward.fills.map(f => `${f.slot_date}|${f.code}`))
      .toEqual(['2026-12-25|C1', '2026-12-25|C2', '2026-12-26|C1']);
  });

  it('does not mutate its inputs', () => {
    const entries = [{ provider_id: 'p1', date: '2026-12-25', code: 'C1' }];
    const slots = [slot('a', '2026-12-25', 'C1')];
    planHolidayCallSeeds(entries, slots);
    expect(entries).toHaveLength(1);
    expect(slots).toHaveLength(1);
  });

  it('returns an empty plan for no decisions', () => {
    expect(planHolidayCallSeeds([], [slot('a', '2026-12-25', 'C1')]))
      .toEqual({ fills: [], skipped: [] });
  });
});
