/**
 * The master schedule.
 *
 * What matters here: the window arithmetic (a month-step that silently skips
 * a month is a whole block of schedule missing), who counts as which
 * discipline, and that absences land at the bottom once rather than inside
 * every site.
 */
import { describe, it, expect } from 'vitest';
import {
  buildMasterSchedule, masterWindow, monthsOf, datesInMonth, awayInMonth,
  AWAY_TYPES,
  type MasterSlotRow, type MasterAwayRow,
} from './masterSchedule';
import type { OpsProviderRow } from './operationsBoard';

const PAOLI = { id: 's1', name: 'Paoli Hospital', short_name: 'PH' };
const LMC = { id: 's2', name: 'Lankenau Hospital', short_name: 'LMC' };

const md = (id: string, last: string): OpsProviderRow =>
  ({ id, first_name: 'A', last_name: last, provider_type: 'physician' });
const crna = (id: string, last: string): OpsProviderRow =>
  ({ id, first_name: 'B', last_name: last, provider_type: 'crna' });

const slot = (
  site: string, date: string, code: string,
  providerIds: string[],
  over: { order?: number; category?: string } = {},
): MasterSlotRow => ({
  site_id: site, slot_date: date,
  shift: { code, display_order: over.order ?? 0, category: over.category ?? 'regular' },
  providerIds,
});

const build = (o: Partial<Parameters<typeof buildMasterSchedule>[0]> = {}) =>
  buildMasterSchedule({
    group: 'physician',
    from: '2026-09-01', to: '2026-09-30',
    sites: [PAOLI, LMC],
    slots: [], away: [], providers: [],
    ...o,
  });

describe('the twelve-month window', () => {
  it('is six months back and six forward', () => {
    expect(masterWindow('2026-09-22')).toEqual({ from: '2026-03-22', to: '2027-03-22' });
  });

  it('crosses a year boundary in both directions', () => {
    expect(masterWindow('2026-01-15')).toEqual({ from: '2025-07-15', to: '2026-07-15' });
  });

  it('CLAMPS rather than rolling over a short month', () => {
    // 31 August minus six months is not 3 March. A roll-over would shift the
    // whole window and silently drop a day of schedule at each end.
    expect(masterWindow('2026-08-31').from).toBe('2026-02-28');
    expect(masterWindow('2024-08-31').from).toBe('2024-02-29');   // leap year
  });

  it('spans thirteen month-columns, because both ends are included', () => {
    const { from, to } = masterWindow('2026-09-22');
    const months = monthsOf(from, to);
    expect(months).toHaveLength(13);
    expect(months[0]).toBe('2026-03');
    expect(months[12]).toBe('2027-03');
  });

  it('steps months without skipping December', () => {
    expect(monthsOf('2026-11-01', '2027-02-01'))
      .toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });

  it('counts the days in a month, leap years included', () => {
    expect(datesInMonth('2026-09')).toHaveLength(30);
    expect(datesInMonth('2026-02')).toHaveLength(28);
    expect(datesInMonth('2024-02')).toHaveLength(29);
    expect(datesInMonth('2026-09')[0]).toBe('2026-09-01');
  });
});

describe('discipline comes from the PROVIDER, not the shift type', () => {
  it('puts a CRNA on an either-group room in the CRNA sheet', () => {
    const slots = [slot('s1', '2026-09-02', 'DAY', ['c1', 'm1'])];
    const providers = [crna('c1', 'Ng'), md('m1', 'Ross')];

    const mds = build({ slots, providers, group: 'physician' });
    const crnas = build({ slots, providers, group: 'crna' });

    expect(mds.blocks[0].rows[0].byDate.get('2026-09-02')!.map(c => c.name)).toEqual(['A. Ross']);
    expect(crnas.blocks[0].rows[0].byDate.get('2026-09-02')!.map(c => c.name)).toEqual(['B. Ng']);
  });

  it('treats an unknown provider_type as a physician, matching the bench', () => {
    const m = build({
      slots: [slot('s1', '2026-09-02', 'DAY', ['x'])],
      providers: [{ id: 'x', last_name: 'Ghost' }],
      group: 'physician',
    });
    expect(m.blocks[0].rows[0].byDate.get('2026-09-02')).toHaveLength(1);
  });

  it('reports EMPTY when the discipline has nothing — not an error', () => {
    // The live shape today: no CRNA schedule has been built, so that sheet is
    // legitimately blank. It must not be confusable with a failed read.
    const m = build({
      slots: [slot('s1', '2026-09-02', 'DAY', ['m1'])],
      providers: [md('m1', 'Ross')],
      group: 'crna',
    });
    expect(m.empty).toBe(true);
    expect(m.blocks).toEqual([]);
  });
});

describe('sites stack, in order, and empty ones are left out', () => {
  it('keeps the configured site order', () => {
    const m = build({
      slots: [
        slot('s2', '2026-09-02', 'DAY', ['m2']),
        slot('s1', '2026-09-02', 'DAY', ['m1']),
      ],
      providers: [md('m1', 'Ross'), md('m2', 'Ng')],
    });
    expect(m.blocks.map(b => b.shortName)).toEqual(['PH', 'LMC']);
  });

  it('omits a site with nothing in the window', () => {
    // Eight empty bands would bury the two carrying the work.
    const m = build({
      slots: [slot('s1', '2026-09-02', 'DAY', ['m1'])],
      providers: [md('m1', 'Ross')],
    });
    expect(m.blocks.map(b => b.shortName)).toEqual(['PH']);
  });

  it('puts CALL rows above day rows within a site', () => {
    const m = build({
      slots: [
        slot('s1', '2026-09-02', 'DAY', ['m1'], { order: 20 }),
        slot('s1', '2026-09-02', 'C1', ['m2'], { order: 0, category: 'call' }),
      ],
      providers: [md('m1', 'Ross'), md('m2', 'Ng')],
    });
    expect(m.blocks[0].rows.map(r => r.code)).toEqual(['C1', 'DAY']);
  });

  it('counts each person once per site however many shifts they hold', () => {
    const m = build({
      slots: [
        slot('s1', '2026-09-02', 'C1', ['m1'], { category: 'call' }),
        slot('s1', '2026-09-03', 'DAY', ['m1']),
      ],
      providers: [md('m1', 'Ross')],
    });
    expect(m.blocks[0].people).toBe(1);
  });

  it('ignores slots outside the window', () => {
    const m = build({
      from: '2026-09-01', to: '2026-09-30',
      slots: [
        slot('s1', '2026-08-31', 'DAY', ['m1']),
        slot('s1', '2026-10-01', 'DAY', ['m1']),
      ],
      providers: [md('m1', 'Ross')],
    });
    expect(m.empty).toBe(true);
  });
});

describe('away sits at the bottom of the whole sheet', () => {
  const providers = [md('m1', 'Ross'), crna('c1', 'Ng')];
  const away: MasterAwayRow[] = [
    { provider_id: 'm1', availability_type: 'pto', approval_status: 'approved',
      start_date: '2026-09-10', end_date: '2026-09-14' },
  ];

  it('is returned once, not repeated inside each site block', () => {
    // Leave is a fact about a PERSON. Filing it under a site would either
    // duplicate it or force a choice of which hospital owns the holiday.
    const m = build({
      away, providers,
      slots: [
        slot('s1', '2026-09-02', 'DAY', ['m1']),
        slot('s2', '2026-09-03', 'DAY', ['m1']),
      ],
    });
    expect(m.away).toHaveLength(1);
    expect(m.away[0]).toMatchObject({ name: 'A. Ross', label: 'PTO' });
  });

  it('CLIPS a spell that starts before the window', () => {
    const m = build({
      from: '2026-09-01', to: '2026-09-30', providers,
      away: [{ provider_id: 'm1', availability_type: 'pto',
               start_date: '2026-08-20', end_date: '2026-09-05' }],
    });
    expect(m.away[0]).toMatchObject({ start: '2026-09-01', end: '2026-09-05' });
  });

  it('drops a spell entirely outside the window', () => {
    const m = build({
      from: '2026-09-01', to: '2026-09-30', providers,
      away: [{ provider_id: 'm1', availability_type: 'pto',
               start_date: '2026-07-01', end_date: '2026-07-10' }],
    });
    expect(m.away).toEqual([]);
  });

  it('marks a WAITLISTED request as pending rather than showing it as leave', () => {
    // A waitlisted request is not time off. Rendering it identically would
    // have somebody believing they hold leave they were never granted.
    const m = build({
      providers,
      away: [{ provider_id: 'm1', availability_type: 'pto',
               approval_status: 'waitlisted',
               start_date: '2026-09-10', end_date: '2026-09-12' }],
    });
    expect(m.away[0].pending).toBe(true);
  });

  it('separates away by discipline too', () => {
    const m = build({
      providers, group: 'crna',
      away: [{ provider_id: 'm1', availability_type: 'pto',
               start_date: '2026-09-10', end_date: '2026-09-12' }],
    });
    expect(m.away).toEqual([]);
  });

  it('excludes preferences and duties that are NOT time off', () => {
    // no_call_request / call_request are scheduling preferences; holiday_call
    // and admin still put the person at work. Reporting either as leave would
    // be wrong in opposite directions.
    for (const t of ['no_call_request', 'call_request', 'holiday_call', 'admin']) {
      expect(AWAY_TYPES.has(t), t).toBe(false);
      const m = build({
        providers,
        away: [{ provider_id: 'm1', availability_type: t,
                 start_date: '2026-09-10', end_date: '2026-09-12' }],
      });
      expect(m.away, t).toEqual([]);
    }
  });

  it('includes the real leave types', () => {
    for (const t of ['pto', 'unavailable', 'sick', 'jury_duty']) {
      expect(AWAY_TYPES.has(t), t).toBe(true);
    }
  });

  it('filters to the month on show, keeping spells that merely overlap it', () => {
    const m = build({
      from: '2026-08-01', to: '2026-10-31', providers,
      away: [
        { provider_id: 'm1', availability_type: 'pto',
          start_date: '2026-08-28', end_date: '2026-09-03' },
        { provider_id: 'm1', availability_type: 'pto',
          start_date: '2026-10-05', end_date: '2026-10-09' },
      ],
    });
    expect(awayInMonth(m.away, '2026-09')).toHaveLength(1);
    expect(awayInMonth(m.away, '2026-10')).toHaveLength(1);
    expect(awayInMonth(m.away, '2026-08')).toHaveLength(1);
  });
});
