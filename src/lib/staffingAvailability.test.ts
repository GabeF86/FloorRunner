/**
 * Counting the bodies the schedule puts at a site on a day.
 *
 * The two things that would do real damage: counting the overnight call team
 * among the daytime floor (a grid built around people who are at home asleep),
 * and counting one person twice because they hold two slots.
 */
import { describe, it, expect } from 'vitest';
import {
  scheduledAvailability, availableStaff, availablePeople, bucketFor,
  type AvailabilitySlot,
} from './staffingAvailability';
import type { OpsProviderRow } from './operationsBoard';

const DATE = '2026-09-18';
const SITE = 'site-1';

const md = (id: string, last: string): OpsProviderRow =>
  ({ id, last_name: last, provider_type: 'physician' });
const crna = (id: string, last: string): OpsProviderRow =>
  ({ id, last_name: last, provider_type: 'crna' });

const slot = (
  code: string,
  start: string | null,
  providerIds: string[],
  category = 'call',
  over: Partial<AvailabilitySlot> = {},
): AvailabilitySlot => ({
  site_id: SITE, slot_date: DATE,
  shift: { code, start_time: start, category },
  providerIds, ...over,
});

const run = (slots: AvailabilitySlot[], providers: OpsProviderRow[]) =>
  scheduledAvailability({ siteId: SITE, date: DATE, slots, providers });

describe('the overnight call team is not on the daytime floor', () => {
  it("splits Paoli's C1 (15:00 → 07:00) out of the day count", () => {
    // The live shape. Counting C1 among Friday's available staff overstates
    // the floor by one and hides a real gap.
    const a = run([
      slot('7-3', '07:00:00', ['m1'], 'day'),
      slot('C1', '15:00:00', ['m2']),
    ], [md('m1', 'Ross'), md('m2', 'Ng')]);
    expect(a.day).toEqual({ mds: 1, crnas: 0 });
    expect(a.overnightCall).toEqual({ mds: 1, crnas: 0 });
    expect(a.overnightCodes).toEqual(['C1']);
  });

  it("splits Lankenau's C1 AND C2 out — both run 15:00 → 07:00", () => {
    const a = run([
      slot('C3', '07:00:00', ['m1']),
      slot('C1', '15:00:00', ['m2']),
      slot('C2', '15:00:00', ['m3']),
    ], [md('m1', 'Ross'), md('m2', 'Ng'), md('m3', 'Adler')]);
    expect(a.day.mds).toBe(1);
    expect(a.overnightCall.mds).toBe(2);
    expect(a.overnightCodes).toEqual(['C1', 'C2']);
  });

  it('keeps the daytime call doctor ON the floor', () => {
    // Lankenau C3 is 07:00–19:00 and Paoli C2 is 07:00–19:00: on call and at
    // work. A rule that excluded call by CATEGORY would lose them both.
    const a = run([slot('C3', '07:00:00', ['m1'])], [md('m1', 'Ross')]);
    expect(a.day.mds).toBe(1);
    expect(a.overnightCall.mds).toBe(0);
  });

  it('catches the split segments a code test would miss', () => {
    // C1E8 starts 15:00 and C1N12 starts 19:00. Neither is called "C1", so a
    // `code === 'C1'` exclusion would count both as daytime staff.
    const a = run([
      slot('C1E8', '15:00:00', ['m1']),
      slot('C1N12', '19:00:00', ['m2']),
    ], [md('m1', 'Ross'), md('m2', 'Ng')]);
    expect(a.day.mds).toBe(0);
    expect(a.overnightCall.mds).toBe(2);
  });

  it('counts a shift with NO start time as daytime', () => {
    // Several imported types state none; dropping them would silently
    // under-report a whole site.
    const a = run([slot('DAY', null, ['m1'], 'day')], [md('m1', 'Ross')]);
    expect(a.day.mds).toBe(1);
  });
});

describe('late but not call is its own bucket', () => {
  it('is counted in neither total', () => {
    // A 15:00 non-call shift is not on the daytime floor AND not part of the
    // team the checkbox adds. Folding it into either would be a lie.
    const a = run([slot('3-11', '15:00:00', ['c1'], 'day')], [crna('c1', 'Ng')]);
    expect(a.day).toEqual({ mds: 0, crnas: 0 });
    expect(a.overnightCall).toEqual({ mds: 0, crnas: 0 });
    expect(a.lateOther).toEqual({ mds: 0, crnas: 1 });
    expect(a.lateOtherCodes).toEqual(['3-11']);
  });

  it('is not added by the include-overnight toggle', () => {
    const a = run([slot('3-11', '15:00:00', ['c1'], 'day')], [crna('c1', 'Ng')]);
    expect(availableStaff(a, true)).toEqual({ mds: 0, crnas: 0 });
    expect(availablePeople(a, true)).toEqual([]);
  });
});

describe('bodies, not assignments', () => {
  it('counts somebody holding two slots ONCE', () => {
    // Live: D1+D5, C2+DAY, 07-19+C2. Counting assignments would build a grid
    // around staff who do not exist.
    const a = run([
      slot('D1', '07:00:00', ['m1'], 'day'),
      slot('D5', '07:00:00', ['m1'], 'day'),
    ], [md('m1', 'Ross')]);
    expect(a.day.mds).toBe(1);
    expect(a.people).toHaveLength(1);
    expect(a.people[0].shiftCodes).toEqual(['D1', 'D5']);
  });

  it('puts somebody on BOTH call and a day shift on the floor, not in the night bucket', () => {
    // Live: C1+D1. They are at work during the day; filing them as overnight
    // would remove a real body from the grid.
    const a = run([
      slot('C1', '15:00:00', ['m1']),
      slot('D1', '07:00:00', ['m1'], 'day'),
    ], [md('m1', 'Ross')]);
    expect(a.day.mds).toBe(1);
    expect(a.overnightCall.mds).toBe(0);
    expect(a.people).toHaveLength(1);
  });

  it('ignores an UNFILLED position — a vacancy is not a body', () => {
    const a = run([slot('D1', '07:00:00', [], 'day')], []);
    expect(a.day).toEqual({ mds: 0, crnas: 0 });
    expect(a.scheduled).toBe(true);
  });
});

describe('group comes from the person, not the shift type', () => {
  it('counts a CRNA on an either-group shift as a CRNA', () => {
    const a = run([slot('DAY', '07:00:00', ['c1', 'm1'], 'day')],
      [crna('c1', 'Ng'), md('m1', 'Ross')]);
    expect(a.day).toEqual({ mds: 1, crnas: 1 });
  });

  it('treats an unknown provider as a physician rather than dropping them', () => {
    const a = run([slot('DAY', '07:00:00', ['ghost'], 'day')], []);
    expect(a.day).toEqual({ mds: 1, crnas: 0 });
    expect(a.people[0].name).toBe('—');
  });
});

describe('no schedule is not an empty day', () => {
  it('reports scheduled=false when the site has no slot at all', () => {
    // Zero available because nothing is published, and zero available because
    // nobody is working, are different facts. Only one is a staffing problem.
    const a = run([], []);
    expect(a.scheduled).toBe(false);
    expect(a.day).toEqual({ mds: 0, crnas: 0 });
  });

  it('reports scheduled=true for a published day with nobody assigned', () => {
    const a = run([slot('D1', '07:00:00', [], 'day')], []);
    expect(a.scheduled).toBe(true);
  });

  it('ignores slots for another site or another date', () => {
    const a = run([
      { ...slot('D1', '07:00:00', ['m1'], 'day'), site_id: 'other' },
      { ...slot('D2', '07:00:00', ['m2'], 'day'), slot_date: '2026-09-19' },
    ], [md('m1', 'Ross'), md('m2', 'Ng')]);
    expect(a.scheduled).toBe(false);
    expect(a.day.mds).toBe(0);
  });
});

describe('what the steppers read', () => {
  const a = () => run([
    slot('7-3', '07:00:00', ['m1'], 'day'),
    slot('7-3', '07:00:00', ['c1'], 'day'),
    slot('C1', '15:00:00', ['m2']),
  ], [md('m1', 'Ross'), crna('c1', 'Ng'), md('m2', 'Adler')]);

  it('excludes the overnight team by default', () => {
    expect(availableStaff(a(), false)).toEqual({ mds: 1, crnas: 1 });
  });

  it('adds them when the box is checked', () => {
    expect(availableStaff(a(), true)).toEqual({ mds: 2, crnas: 1 });
  });

  it('offers a name for assignment only when it is being counted', () => {
    // A person absent from the totals must not be placeable in a room —
    // the diagram would then hold more staff than the panel says exist.
    expect(availablePeople(a(), false).map(p => p.name)).toEqual(['Ross', 'Ng']);
    expect(availablePeople(a(), true).map(p => p.name)).toEqual(['Ross', 'Ng', 'Adler']);
  });

  it('lists MDs before CRNAs, alphabetically inside each', () => {
    const b = run([slot('7-3', '07:00:00', ['c2', 'm2', 'c1', 'm1'], 'day')],
      [crna('c1', 'Zhang'), crna('c2', 'Ng'), md('m1', 'Ross'), md('m2', 'Adler')]);
    expect(b.people.map(p => p.name)).toEqual(['Adler', 'Ross', 'Ng', 'Zhang']);
  });
});

describe('bucketFor', () => {
  it('sorts by start hour, then by whether it is call', () => {
    expect(bucketFor({ start_time: '07:00:00', category: 'call' })).toBe('day');
    expect(bucketFor({ start_time: '14:59:00', category: 'day' })).toBe('day');
    expect(bucketFor({ start_time: '15:00:00', category: 'call' })).toBe('overnight_call');
    expect(bucketFor({ start_time: '15:00:00', category: 'day' })).toBe('late_other');
    expect(bucketFor(null)).toBe('day');
  });
});
