/**
 * The operations board.
 *
 * What is worth pinning here is not the arithmetic — it is the refusals. A
 * staffing page that guesses is worse than no page, so most of these tests say
 * "given a hole in the data, show a hole".
 */
import { describe, it, expect } from 'vitest';
import {
  siteOpenDays, coverageWeek, perDiemBench, siteDayBoard, rosterSummary,
  shiftHours, weekDates, providerName, transferPicture, monthsWorkedThisYear,
  type OpsSlotRow, type OpsSiteRow, type OpsProviderRow, type OpsCredentialRow,
  type OpsProfileRow,
} from './operationsBoard';

const MON = '2026-09-14';
const TUE = '2026-09-15';
const SAT = '2026-09-19';
const SUN = '2026-09-20';

const site = (id: string, name: string, days?: unknown): OpsSiteRow =>
  ({ id, name, short_name: name.slice(0, 3).toUpperCase(), operational_days: days });

const md: OpsProviderRow = {
  id: 'p1', provider_type: 'physician', short_display_name: 'FARG', last_name: 'Farkas',
};
const md2: OpsProviderRow = {
  id: 'p2', provider_type: 'physician', short_display_name: 'AMUA', last_name: 'Amusa',
};
const crna: OpsProviderRow = {
  id: 'c1', provider_type: 'crna', short_display_name: 'ORMO', last_name: 'Ormond',
};

const slot = (
  siteId: string, date: string, code: string,
  opts: Partial<OpsSlotRow> & {
    group?: string; category?: string; rank?: number | null;
    held?: string[]; postCall?: boolean; start?: string; end?: string;
  } = {},
): OpsSlotRow => ({
  site_id: siteId,
  slot_date: date,
  required_count: opts.required_count ?? 1,
  shift_types: {
    code,
    category: opts.category ?? 'regular',
    provider_group: opts.group ?? 'physician',
    call_rank: opts.rank ?? null,
    start_time: opts.start ?? null,
    end_time: opts.end ?? null,
    requires_post_call_rule: opts.postCall ?? false,
  },
  assignments: (opts.held ?? []).map(id => ({ provider_id: id })),
});

describe('siteOpenDays — two shapes are live in this column', () => {
  it('reads the ARRAY form the six non-Paoli sites actually store', () => {
    // ["Mon".."Fri"] — the shape sites/[id] never handled, which is why those
    // sites have been rendering as closed every day there.
    const open = siteOpenDays(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    expect(open[1]).toBe(true);   // Monday
    expect(open[5]).toBe(true);   // Friday
    expect(open[6]).toBe(false);  // Saturday
    expect(open[0]).toBe(false);  // Sunday
  });

  it('reads the OBJECT form, ignoring the numeric junk keys beside it', () => {
    // Live Paoli/Lankenau: named booleans PLUS {"0":"Mon","1":"Tue",…}. Reading
    // "0" as a flag would mark Sunday open everywhere it appears.
    const open = siteOpenDays({
      0: 'Mon', 1: 'Tue', 2: 'Wed', 3: 'Thu', 4: 'Fri',
      monday: true, tuesday: true, wednesday: true, thursday: true,
      friday: true, saturday: true, sunday: true,
    });
    expect(open).toEqual([true, true, true, true, true, true, true]);
  });

  it('honours a named false', () => {
    expect(siteOpenDays({ sunday: false, saturday: false })[0]).toBe(false);
  });

  it('treats NOT CONFIGURED as open all week, never as closed', () => {
    // "No value" is not "shut". Printing CLOSED over a real Sunday would hide
    // a genuine gap; an open day with no slots reads "no schedule" instead,
    // which is true either way.
    for (const junk of [null, undefined, {}, [], 42, 'Mon']) {
      expect(siteOpenDays(junk)).toEqual([true, true, true, true, true, true, true]);
    }
  });

  it('falls back to open when the object has only numeric keys', () => {
    expect(siteOpenDays({ 0: 'Mon', 1: 'Tue' })).toEqual([true, true, true, true, true, true, true]);
  });
});

describe('coverageWeek — supply measured against DEMAND', () => {
  const sites = [site('s1', 'Paoli')];
  const need = (md: number | null, crna: number | null, src: 'manual' | 'calculated' = 'manual') =>
    new Map([[`s1|${MON}`, { md, crna, source: src, notes: null }]]);

  const week = (opts: {
    slots?: OpsSlotRow[]; demand?: Map<string, any>; dates?: string[];
    sites?: OpsSiteRow[]; providers?: OpsProviderRow[];
  } = {}) => coverageWeek({
    sites: opts.sites ?? sites,
    providers: opts.providers ?? [md, md2, crna],
    slots: opts.slots ?? [],
    dates: opts.dates ?? [MON],
    demand: opts.demand ?? new Map(),
  });

  it('counts AVAILABLE as people on the schedule, by their own provider type', () => {
    // Not by what the shift type permits: a both-groups room filled by a CRNA
    // is a CRNA on the floor.
    const rows = week({
      demand: need(2, 1),
      slots: [
        slot('s1', MON, 'C1', { held: ['p1'] }),
        slot('s1', MON, '7-3', { group: 'both', held: ['c1'] }),
      ],
    });
    expect(rows[0].cells[0].groups).toEqual([
      { group: 'physician', available: 1, needed: 2 },
      { group: 'crna', available: 1, needed: 1 },
    ]);
    expect(rows[0].cells[0]).toMatchObject({ status: 'short', shortBy: 1 });
  });

  it('does NOT count an empty room as availability', () => {
    // The old "needed" was the slot census, so an unfilled room counted on
    // both sides and cancelled itself. Availability is bodies.
    const rows = week({ demand: need(1, null), slots: [slot('s1', MON, 'C1')] });
    expect(rows[0].cells[0].groups[0]).toMatchObject({ available: 0, needed: 1 });
    expect(rows[0].cells[0].status).toBe('short');
  });

  it('grades one short as SHORT and two as a GAP', () => {
    const one = week({ demand: need(2, null), slots: [slot('s1', MON, 'C1', { held: ['p1'] })] });
    expect(one[0].cells[0]).toMatchObject({ status: 'short', shortBy: 1 });
    const two = week({ demand: need(3, null), slots: [slot('s1', MON, 'C1', { held: ['p1'] })] });
    expect(two[0].cells[0]).toMatchObject({ status: 'gap', shortBy: 2 });
  });

  it('is COVERED when supply meets demand exactly', () => {
    const rows = week({
      demand: need(1, null),
      slots: [slot('s1', MON, 'C1', { held: ['p1'] })],
    });
    expect(rows[0].cells[0]).toMatchObject({ status: 'covered', shortBy: 0, surplusBy: 0 });
  });

  it('is SURPLUS when supply exceeds it — the pool a transfer draws from', () => {
    const rows = week({
      demand: need(1, null),
      slots: [slot('s1', MON, 'C1', { held: ['p1'] }), slot('s1', MON, 'D4', { held: ['p2'] })],
    });
    expect(rows[0].cells[0]).toMatchObject({ status: 'surplus', shortBy: 0, surplusBy: 1 });
  });

  it('reads N/A — never 0 — when nobody has counted the day', () => {
    // The whole point of the demand table. A zero here would paint an
    // uncounted day green and report an unstaffed hospital as covered.
    const rows = week({ slots: [slot('s1', MON, 'C1', { held: ['p1'] })] });
    expect(rows[0].cells[0]).toMatchObject({ status: 'unstated', shortBy: 0, demandSource: null });
    // The people on it are still reported — the tooltip wants them.
    expect(rows[0].cells[0].groups.find(g => g.group === 'physician')).toMatchObject({
      available: 1, needed: null,
    });
  });

  it('treats a row stating NEITHER count as no count at all', () => {
    const rows = week({ demand: need(null, null) });
    expect(rows[0].cells[0].status).toBe('unstated');
  });

  it('grades only the half that was stated', () => {
    // MD counted, CRNA not. The MD side is judged; the CRNA side is not, and
    // must not drag the cell to green or to red.
    const rows = week({
      demand: need(2, null),
      slots: [slot('s1', MON, 'C1', { held: ['p1'] }), slot('s1', MON, '7-3', { group: 'both', held: ['c1'] })],
    });
    const cell = rows[0].cells[0];
    expect(cell.groups).toEqual([
      { group: 'physician', available: 1, needed: 2 },
      { group: 'crna', available: 1, needed: null },
    ]);
    expect(cell).toMatchObject({ status: 'short', shortBy: 1 });
  });

  it('reports which source the count came from', () => {
    expect(week({ demand: need(1, 1) })[0].cells[0].demandSource).toBe('manual');
    expect(week({ demand: need(1, 1, 'calculated') })[0].cells[0].demandSource).toBe('calculated');
  });

  it('CLOSED beats everything, including a count somebody entered', () => {
    const rows = coverageWeek({
      sites: [site('s1', 'Rothman', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])],
      providers: [], slots: [], dates: [SAT, SUN],
      demand: new Map([[`s1|${SAT}`, { md: 2, crna: 2, source: 'manual' as const, notes: null }]]),
    });
    expect(rows[0].cells.map(c => c.status)).toEqual(['closed', 'closed']);
    expect(rows[0].shortBy).toBe(0);
  });

  it('sums the week into the row total', () => {
    const rows = coverageWeek({
      sites, providers: [md], slots: [], dates: [MON, TUE],
      demand: new Map([
        [`s1|${MON}`, { md: 2, crna: null, source: 'manual' as const, notes: null }],
        [`s1|${TUE}`, { md: 3, crna: null, source: 'manual' as const, notes: null }],
      ]),
    });
    expect(rows[0].shortBy).toBe(5);
  });
});

describe('perDiemBench — the engine\'s four checks, in its order', () => {
  const sites = [site('s1', 'Paoli'), site('s2', 'Riddle')];
  const base = {
    date: TUE,
    providers: [md, md2],
    profiles: [
      { provider_id: 'p1', employment_status: 'per_diem' },
      { provider_id: 'p2', employment_status: 'per_diem' },
    ],
    credentials: [
      { provider_id: 'p1', site_id: 's1' },
      { provider_id: 'p2', site_id: 's1' },
    ],
    availability: [],
    slots: [] as OpsSlotRow[],
    sites,
  };

  it('reports someone credentialed, free and unbooked as AVAILABLE', () => {
    const b = perDiemBench(base);
    expect(b.rows.every(r => r.status === 'available')).toBe(true);
    expect(b.freeToday).toBe(2);
    expect(b.sitesCovered).toBe(1);
  });

  it('PENDING time off still blocks — invariant 2, via the shared predicate', () => {
    const b = perDiemBench({
      ...base,
      availability: [{
        provider_id: 'p1', availability_type: 'pto',
        approval_status: 'pending', start_date: TUE, end_date: TUE,
      }],
    });
    expect(b.rows.find(r => r.providerId === 'p1')).toMatchObject({ status: 'off' });
    expect(b.freeToday).toBe(1);
  });

  it('names the site someone is already booked at', () => {
    const b = perDiemBench({
      ...base,
      slots: [slot('s2', TUE, '7-3', { held: ['p1'] })],
    });
    expect(b.rows.find(r => r.providerId === 'p1')).toMatchObject({
      status: 'booked', detail: 'booked at RID', name: 'Farkas', code: 'FARG',
    });
  });

  it('counts a POST-CALL rest as booked, though the day looks empty', () => {
    // Invariant 1. Their calendar is clear and they are still not callable.
    const b = perDiemBench({
      ...base,
      slots: [slot('s1', MON, 'C1', { category: 'call', rank: 0, postCall: true, held: ['p1'] })],
    });
    const row = b.rows.find(r => r.providerId === 'p1');
    expect(row?.status).toBe('booked');
    expect(row?.detail).toContain('post-call');
  });

  it('a day shift yesterday does NOT make someone post-call', () => {
    const b = perDiemBench({
      ...base,
      slots: [slot('s1', MON, '7-3', { held: ['p1'] })],
    });
    expect(b.rows.find(r => r.providerId === 'p1')?.status).toBe('available');
  });

  it('COUNTS an uncredentialed per diem instead of listing them', () => {
    // Live roster: 135 per diems, 119 of them credentialed nowhere. Listing
    // those by name buries the handful who can actually be phoned.
    const b = perDiemBench({ ...base, credentials: [{ provider_id: 'p1', site_id: 's1' }] });
    expect(b.rows.map(r => r.providerId)).toEqual(['p1']);
    expect(b).toMatchObject({ onRoster: 2, uncredentialed: 1, freeToday: 1 });
  });

  it('respects a credential that has lapsed by this date', () => {
    const b = perDiemBench({
      ...base,
      credentials: [
        { provider_id: 'p1', site_id: 's1', effective_end_date: '2026-01-01' },
        { provider_id: 'p2', site_id: 's1' },
      ],
    });
    expect(b.rows.map(r => r.providerId)).toEqual(['p2']);
    expect(b.uncredentialed).toBe(1);
  });

  it('puts the callable names at the top', () => {
    const b = perDiemBench({
      ...base,
      availability: [{
        provider_id: 'p2', availability_type: 'pto',
        approval_status: 'approved', start_date: TUE, end_date: TUE,
      }],
    });
    expect(b.rows.map(r => r.status)).toEqual(['available', 'off']);
  });

  it('leaves out anyone who is not on the bench', () => {
    const b = perDiemBench({
      ...base,
      profiles: [{ provider_id: 'p1', employment_status: 'full_time' },
                 { provider_id: 'p2', employment_status: 'per_diem' }],
    });
    expect(b.rows.map(r => r.providerId)).toEqual(['p2']);
  });
});

describe('siteDayBoard', () => {
  const sites = [site('s1', 'Paoli')];

  it('puts first call at the top, then second, then the rooms', () => {
    const board = siteDayBoard({
      date: TUE, sites, providers: [md, md2, crna],
      slots: [
        slot('s1', TUE, '7-3', { group: 'both', held: ['c1'] }),
        slot('s1', TUE, 'C2', { category: 'call', rank: 1, held: ['p2'] }),
        slot('s1', TUE, 'C1', { category: 'call', rank: 0, held: ['p1'], start: '15:00', end: '07:00' }),
        slot('s1', TUE, '7-5', { group: 'both', held: ['p2'] }),
      ],
    });
    expect(board[0].onCall.map(p => p.code)).toEqual(['C1', 'C2']);
    expect(board[0].onCall[0]).toMatchObject({ name: 'Farkas', hours: '16 h' });
    // Physicians before CRNAs in the rooms.
    expect(board[0].inRooms.map(p => p.providerType)).toEqual(['physician', 'crna']);
    expect(board[0]).toMatchObject({ mdCount: 3, crnaCount: 1 });
  });

  it('counts an open position without inventing a person for it', () => {
    const board = siteDayBoard({
      date: TUE, sites, providers: [md],
      slots: [slot('s1', TUE, '7-3', { required_count: 3, held: ['p1'] })],
    });
    expect(board[0].inRooms).toHaveLength(1);
    expect(board[0].openPositions).toBe(2);
  });

  it('distinguishes closed from unscheduled', () => {
    const closed = siteDayBoard({
      date: SUN, sites: [site('s1', 'Rothman', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])],
      providers: [], slots: [],
    });
    expect(closed[0]).toMatchObject({ closed: true, unscheduled: false });

    const unscheduled = siteDayBoard({ date: TUE, sites, providers: [], slots: [] });
    expect(unscheduled[0]).toMatchObject({ closed: false, unscheduled: true });
  });
});

describe('shiftHours', () => {
  it('measures a plain day shift', () => {
    expect(shiftHours('07:00', '15:00')).toBe('8 h');
  });

  it('wraps past midnight', () => {
    expect(shiftHours('15:00', '07:00')).toBe('16 h');
  });

  it('reads equal times as a FULL 24 h, not zero', () => {
    // Paoli's C3 is stored 07:00 → 07:00. A zero-length neuro weekend would be
    // the crosses_midnight bug all over again.
    expect(shiftHours('07:00', '07:00')).toBe('24 h');
  });

  it('says nothing rather than guessing when a time is missing', () => {
    expect(shiftHours(null, '15:00')).toBe('');
    expect(shiftHours('07:00', undefined)).toBe('');
    expect(shiftHours('nonsense', '15:00')).toBe('');
  });
});

describe('rosterSummary', () => {
  it('counts the roster, the mix, who is off, and who is back tomorrow', () => {
    const s = rosterSummary({
      date: TUE,
      providers: [md, md2, crna],
      profiles: [
        { provider_id: 'p1', employment_status: 'full_time' },
        { provider_id: 'p2', employment_status: 'part_time' },
        { provider_id: 'c1', employment_status: 'per_diem' },
      ],
      availability: [
        // Off today, back tomorrow.
        { provider_id: 'p2', availability_type: 'pto', approval_status: 'approved',
          start_date: TUE, end_date: TUE },
        // Off today and still off tomorrow.
        { provider_id: 'c1', availability_type: 'pto', approval_status: 'approved',
          start_date: TUE, end_date: '2026-09-30' },
      ],
      slots: [slot('s1', TUE, '7-3', { required_count: 2, held: ['p1'] })],
      freeToday: 4,
    });
    expect(s).toMatchObject({
      physicians: 2, crnas: 1,
      fullTime: 1, partTime: 1, perDiem: 1,
      offMd: 1, offCrna: 1, returning: 1,
      scheduledToday: 1, openToday: 1, freeToday: 4,
    });
  });
});

describe('weekDates', () => {
  it('starts the week on Monday', () => {
    expect(weekDates(TUE)[0]).toBe(MON);
    expect(weekDates(TUE)).toHaveLength(7);
  });

  it('puts a Sunday at the END of its week, not the start', () => {
    // Sunday is the week's last night of call, not its first day.
    expect(weekDates(SUN)[0]).toBe(MON);
    expect(weekDates(SUN)[6]).toBe(SUN);
  });

  it('is stable for every day of one week', () => {
    const w = weekDates(MON);
    for (const d of w) expect(weekDates(d)).toEqual(w);
  });
});

describe('providerName — the roster carries two naming schemes', () => {
  it('prefers a real name', () => {
    expect(providerName({ id: 'x', first_name: 'Dina', last_name: 'Gorelick' }))
      .toBe('D. Gorelick');
  });

  it('uses the surname alone when there is no first name', () => {
    expect(providerName({ id: 'x', last_name: 'Gorelick' })).toBe('Gorelick');
  });

  it('falls back to the SCHEDULE CODE only when there is no name at all', () => {
    // CHOD / GONJ / SIRA are grid shorthand. Fine in a cell, unreadable in a
    // list back office is scanning for somebody to call.
    expect(providerName({ id: 'x', short_display_name: 'CHOD' })).toBe('CHOD');
  });

  it('never renders an empty label', () => {
    expect(providerName({ id: 'x' })).toBe('—');
  });
});

describe('the schedule code beside the name', () => {
  it('is dropped when it is only the name with the spacing squeezed out', () => {
    // Live: short_display_name "D.Gorelick" beside a name of "D. Gorelick".
    // Printing both reads as two different people.
    const b = perDiemBench({
      date: '2026-09-15',
      providers: [{ id: 'g', first_name: 'Dina', last_name: 'Gorelick',
                    short_display_name: 'D.Gorelick', provider_type: 'physician' }],
      profiles: [{ provider_id: 'g', employment_status: 'per_diem' }],
      credentials: [{ provider_id: 'g', site_id: 's1' }],
      availability: [], slots: [], sites: [{ id: 's1', name: 'Paoli', short_name: 'PH' }],
    });
    expect(b.rows[0]).toMatchObject({ name: 'D. Gorelick', code: '' });
  });

  it('is kept when it is genuinely grid shorthand', () => {
    const b = perDiemBench({
      date: '2026-09-15',
      providers: [{ id: 'c', first_name: 'Dev', last_name: 'Choudhry',
                    short_display_name: 'CHOD', provider_type: 'physician' }],
      profiles: [{ provider_id: 'c', employment_status: 'per_diem' }],
      credentials: [{ provider_id: 'c', site_id: 's1' }],
      availability: [], slots: [], sites: [{ id: 's1', name: 'Paoli', short_name: 'PH' }],
    });
    expect(b.rows[0]).toMatchObject({ name: 'D. Choudhry', code: 'CHOD' });
  });
});

describe('bench rows carry site IDS, not just names', () => {
  it('lists the ids the board filters on', () => {
    // The board filters by credential so a scheduler can answer "site X is
    // short, who can I call FOR IT". Filtering on the short NAME would break
    // the day two sites shared one.
    const sites = [
      { id: 's1', name: 'Paoli', short_name: 'PH' },
      { id: 's2', name: 'Riddle', short_name: 'RH' },
      { id: 's3', name: 'Lankenau', short_name: 'LMC' },
    ];
    const b = perDiemBench({
      date: '2026-09-15',
      providers: [{ id: 'p1', last_name: 'Martinez', provider_type: 'physician' }],
      profiles: [{ provider_id: 'p1', employment_status: 'per_diem' }],
      credentials: [{ provider_id: 'p1', site_id: 's3' }, { provider_id: 'p1', site_id: 's1' }],
      availability: [], slots: [], sites,
    });
    // Site order, not credential-row order — the chips read the same way down
    // every row.
    expect(b.rows[0].siteIds).toEqual(['s1', 's3']);
    expect(b.rows[0].sites).toEqual(['PH', 'LMC']);
  });

  it('gives an uncredentialed per diem no ids to match — they filter out of every site', () => {
    const b = perDiemBench({
      date: '2026-09-15',
      providers: [{ id: 'p1', last_name: 'Martinez', provider_type: 'physician' }],
      profiles: [{ provider_id: 'p1', employment_status: 'per_diem' }],
      credentials: [], availability: [], slots: [],
      sites: [{ id: 's1', name: 'Paoli', short_name: 'PH' }],
    });
    expect(b.rows).toEqual([]);
    expect(b.uncredentialed).toBe(1);
  });
});

describe('discipline on the bench', () => {
  const sites = [{ id: 's1', name: 'Paoli', short_name: 'PH' }];
  const build = (providers: OpsProviderRow[], credentials = providers.map(
    p => ({ provider_id: p.id, site_id: 's1' }))) => perDiemBench({
    date: '2026-09-15',
    providers,
    profiles: providers.map(p => ({ provider_id: p.id, employment_status: 'per_diem' })),
    credentials, availability: [], slots: [], sites,
  });

  it('splits CRNA from physician the same way the coverage matrix does', () => {
    const b = build([
      { id: 'a', last_name: 'Ng', provider_type: 'crna' },
      { id: 'b', last_name: 'Ross', provider_type: 'physician' },
    ]);
    expect(b.rows.map(r => [r.name, r.group])).toEqual([['Ng', 'crna'], ['Ross', 'physician']]);
  });

  it('counts an unstated provider_type as a physician, never as a third group', () => {
    // The coverage matrix already collapses everything non-CRNA into
    // physician. A bench that invented a third bucket would show a discipline
    // total that disagrees with the matrix directly above it.
    const b = build([{ id: 'a', last_name: 'Ng' }]);
    expect(b.rows[0].group).toBe('physician');
  });

  it('counts the roster by discipline INCLUDING the uncredentialed', () => {
    // The live shape, and the whole reason byGroup exists: 104 per diem CRNAs
    // are on the roster and none holds a credential, so the bench lists zero.
    // "0 CRNAs free" and "0 CRNAs credentialed, ever" need different actions.
    const b = build(
      [{ id: 'a', last_name: 'Ng', provider_type: 'crna' },
       { id: 'b', last_name: 'Ross', provider_type: 'physician' }],
      [{ provider_id: 'b', site_id: 's1' }],   // only the physician is credentialed
    );
    expect(b.rows).toHaveLength(1);
    expect(b.byGroup.crna).toEqual({ onRoster: 1, uncredentialed: 1, free: 0 });
    expect(b.byGroup.physician).toEqual({ onRoster: 1, uncredentialed: 0, free: 1 });
  });
});

describe('who can take call — the two-table conjunction', () => {
  const sites = [
    { id: 's1', name: 'Paoli', short_name: 'PH' },
    { id: 's2', name: 'Lankenau', short_name: 'LMC' },
  ];
  const build = (
    profile: Partial<OpsProfileRow>,
    credentials: Array<{ site_id: string; can_take_call?: boolean | null }>,
  ) => perDiemBench({
    date: '2026-09-15',
    providers: [{ id: 'p1', last_name: 'Ross', provider_type: 'physician' }],
    profiles: [{ provider_id: 'p1', employment_status: 'per_diem', ...profile }],
    credentials: credentials.map(c => ({ provider_id: 'p1', ...c })),
    availability: [], slots: [], sites,
  });

  it('needs BOTH the role and the site clearance', () => {
    expect(build({ call_taker: true }, [{ site_id: 's1', can_take_call: true }])
      .rows[0].canTakeCall).toBe(true);
  });

  it('refuses somebody cleared at the site who does not take call as a role', () => {
    // can_take_call defaults TRUE in the database, so reading it alone would
    // mark almost the entire roster call-capable. It is a veto, not an
    // invitation — genContext.ts is explicit that it does not pull anyone into
    // the pool.
    expect(build({ call_taker: false }, [{ site_id: 's1', can_take_call: true }])
      .rows[0].canTakeCall).toBe(false);
  });

  it('refuses a call-taker whose credential at that site vetoes call', () => {
    expect(build({ call_taker: true }, [{ site_id: 's1', can_take_call: false }])
      .rows[0].canTakeCall).toBe(false);
  });

  it('accepts a PARTIAL call taker — they still take call', () => {
    expect(build({ partial_call_taker: true }, [{ site_id: 's1', can_take_call: true }])
      .rows[0].canTakeCall).toBe(true);
  });

  it('reports call clearance PER SITE, so the site filter can compose with it', () => {
    // Cleared at Paoli, vetoed at Lankenau. A Lankenau call vacancy must not
    // be offered this person even though they "can take call".
    const b = build({ call_taker: true }, [
      { site_id: 's1', can_take_call: true },
      { site_id: 's2', can_take_call: false },
    ]);
    expect(b.rows[0].siteIds).toEqual(['s1', 's2']);
    expect(b.rows[0].callSiteIds).toEqual(['s1']);
    expect(b.rows[0].canTakeCall).toBe(true);
  });

  it('treats an ABSENT can_take_call as cleared, matching the column default', () => {
    // The column is NOT NULL DEFAULT true. A row that predates the field, or a
    // select that omitted it, must not read as a veto — that would silently
    // empty the filter.
    expect(build({ call_taker: true }, [{ site_id: 's1' }]).rows[0].canTakeCall).toBe(true);
  });

  it('counts the call-capable across the listed bench', () => {
    const b = perDiemBench({
      date: '2026-09-15',
      providers: [
        { id: 'p1', last_name: 'Ross', provider_type: 'physician' },
        { id: 'p2', last_name: 'Ng', provider_type: 'physician' },
      ],
      profiles: [
        { provider_id: 'p1', employment_status: 'per_diem', call_taker: true },
        { provider_id: 'p2', employment_status: 'per_diem', call_taker: false },
      ],
      credentials: [
        { provider_id: 'p1', site_id: 's1', can_take_call: true },
        { provider_id: 'p2', site_id: 's1', can_take_call: true },
      ],
      availability: [], slots: [], sites,
    });
    expect(b.callCapable).toBe(1);
  });
});

describe('CLOSED must never hide people who are actually there', () => {
  // operational_days is config, and config goes stale. Riddle was stored
  // Mon–Fri while taking call every weekend of the imported block; an
  // unconditional close hid nine real staffed days behind the word CLOSED.
  const monFri = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

  it('closes a genuinely empty weekend at a Mon–Fri site', () => {
    const rows = coverageWeek({
      sites: [site('s1', 'Orthopedic', monFri)],
      providers: [], slots: [], dates: [SAT], demand: new Map(),
    });
    expect(rows[0].cells[0].status).toBe('closed');
  });

  it('does NOT close a day somebody is scheduled on', () => {
    const rows = coverageWeek({
      sites: [site('s1', 'Riddle', monFri)],
      providers: [md],
      slots: [slot('s1', SAT, 'C1', { category: 'call', rank: 0, held: ['p1'] })],
      dates: [SAT],
      demand: new Map(),
    });
    expect(rows[0].cells[0].status).toBe('unstated');
    expect(rows[0].cells[0].groups.find(g => g.group === 'physician')?.available).toBe(1);
  });

  it('grades a staffed "closed" day against its demand like any other', () => {
    const rows = coverageWeek({
      sites: [site('s1', 'Riddle', monFri)],
      providers: [md],
      slots: [slot('s1', SAT, 'C1', { category: 'call', rank: 0, held: ['p1'] })],
      dates: [SAT],
      demand: new Map([[`s1|${SAT}`, { md: 2, crna: null, source: 'manual' as const, notes: null }]]),
    });
    expect(rows[0].cells[0]).toMatchObject({ status: 'short', shortBy: 1 });
  });

  it('still refuses a weekend DEFAULT to a closed, empty site', () => {
    // A Mon–Fri surgery centre must not acquire a weekend requirement from a
    // standing complement it should never have been given.
    const rows = coverageWeek({
      sites: [site('s1', 'Orthopedic', monFri)],
      providers: [], slots: [], dates: [SAT], demand: new Map(),
      weekendCall: new Map([['s1', { md: 3, crna: 2 }]]),
    });
    expect(rows[0].cells[0].status).toBe('closed');
    expect(rows[0].shortBy).toBe(0);
  });
});

describe('transfers — who can move from a spare site to a short one', () => {
  const sites = [site('s1', 'Lankenau'), site('s2', 'Riddle')];
  const dem = (over: [number, number], under: [number, number]) => new Map([
    [`s1|${MON}`, { md: over[0], crna: over[1], source: 'manual' as const, notes: null }],
    [`s2|${MON}`, { md: under[0], crna: under[1], source: 'manual' as const, notes: null }],
  ]);

  const picture = (opts: {
    slots: OpsSlotRow[]; demand: Map<string, any>;
    credentials?: OpsCredentialRow[]; providers?: OpsProviderRow[];
  }) => {
    const providers = opts.providers ?? [md, md2, crna];
    const coverage = coverageWeek({
      sites, providers, slots: opts.slots, dates: [MON], demand: opts.demand,
    });
    return transferPicture({
      date: MON, coverage, slots: opts.slots, providers,
      credentials: opts.credentials ?? [
        { provider_id: 'p1', site_id: 's1' }, { provider_id: 'p1', site_id: 's2' },
      ],
    });
  };

  it('offers a spare physician who is credentialed at the short site', () => {
    const p = picture({
      demand: dem([1, 0], [1, 0]),
      slots: [
        slot('s1', MON, '7-3', { held: ['p1'] }),
        slot('s1', MON, '7-5', { held: ['p2'] }),   // s1 has 2 against 1 needed
      ],
    });
    expect(p.surplus.map(s => [s.shortName, s.by])).toEqual([['LAN', 1]]);
    expect(p.short.map(s => [s.shortName, s.by])).toEqual([['RID', 1]]);
    expect(p.candidates).toEqual([expect.objectContaining({
      providerId: 'p1', fromSite: 'LAN', toSite: 'RID', group: 'physician',
    })]);
  });

  it('REFUSES somebody not credentialed at the destination', () => {
    // The engine will not place them there, so offering the move wastes the
    // minute this panel exists to save.
    const p = picture({
      demand: dem([1, 0], [1, 0]),
      slots: [slot('s1', MON, '7-3', { held: ['p1'] }), slot('s1', MON, '7-5', { held: ['p2'] })],
      credentials: [{ provider_id: 'p1', site_id: 's1' }],
    });
    expect(p.candidates).toEqual([]);
    expect(p.unmatched).toEqual([
      { siteId: 's2', shortName: 'RID', reason: 'nobody spare today is credentialed there' },
    ]);
  });

  it('REFUSES to move somebody off CALL', () => {
    // Moving first call is a different and much larger decision than covering
    // a room.
    const p = picture({
      demand: dem([1, 0], [1, 0]),
      slots: [
        slot('s1', MON, 'C1', { category: 'call', rank: 0, held: ['p1'] }),
        slot('s1', MON, 'C2', { category: 'call', rank: 1, held: ['p2'] }),
      ],
    });
    expect(p.candidates).toEqual([]);
  });

  it('never offers a CRNA against a physician gap', () => {
    const p = picture({
      demand: dem([0, 1], [1, 0]),
      slots: [
        slot('s1', MON, '7-3', { group: 'both', held: ['c1'] }),
        slot('s1', MON, '7-5', { group: 'both', held: ['c1'] }),
      ],
      providers: [md, md2, crna],
      credentials: [{ provider_id: 'c1', site_id: 's1' }, { provider_id: 'c1', site_id: 's2' }],
    });
    expect(p.candidates).toEqual([]);
  });

  it('matches a CRNA to a CRNA gap', () => {
    const p = picture({
      demand: dem([0, 1], [0, 1]),
      slots: [
        slot('s1', MON, '7-3', { group: 'both', held: ['c1'] }),
        slot('s1', MON, '7-5', { group: 'both', held: ['p1'] }),
      ],
      credentials: [{ provider_id: 'c1', site_id: 's1' }, { provider_id: 'c1', site_id: 's2' }],
    });
    expect(p.candidates.map(c => c.providerId)).toEqual(['c1']);
  });

  it('says nothing at all when nowhere is short', () => {
    const p = picture({
      demand: dem([1, 0], [0, 0]),
      slots: [slot('s1', MON, '7-3', { held: ['p1'] }), slot('s1', MON, '7-5', { held: ['p2'] })],
    });
    expect(p.candidates).toEqual([]);
    expect(p.short).toEqual([]);
  });

  it('reports a short site with no surplus anywhere as unmatched', () => {
    const p = picture({ demand: dem([0, 0], [2, 0]), slots: [] });
    expect(p.surplus).toEqual([]);
    expect(p.candidates).toEqual([]);
  });

  it('does not offer to move somebody to the site they are already at', () => {
    const both = new Map([
      [`s1|${MON}`, { md: 1, crna: null, source: 'manual' as const, notes: null }],
    ]);
    const coverage = coverageWeek({
      sites: [site('s1', 'Lankenau')], providers: [md, md2],
      slots: [slot('s1', MON, '7-3', { held: ['p1'] })], dates: [MON], demand: both,
    });
    const p = transferPicture({
      date: MON, coverage, providers: [md, md2],
      slots: [slot('s1', MON, '7-3', { held: ['p1'] })],
      credentials: [{ provider_id: 'p1', site_id: 's1' }],
    });
    expect(p.candidates).toEqual([]);
  });
});

describe('surplus is its own state', () => {
  it('reads as SURPLUS, not plain covered, when supply exceeds demand', () => {
    // A site with 10 against 7 needed is the pool a transfer draws from.
    // Painting it the same green as an exact match hides that.
    const rows = coverageWeek({
      sites: [site('s1', 'Paoli')], providers: [md, md2],
      slots: [slot('s1', MON, '7-3', { held: ['p1'] }), slot('s1', MON, '7-5', { held: ['p2'] })],
      dates: [MON],
      demand: new Map([[`s1|${MON}`, { md: 1, crna: null, source: 'manual' as const, notes: null }]]),
    });
    expect(rows[0].cells[0]).toMatchObject({ status: 'surplus', surplusBy: 1, shortBy: 0 });
  });

  it('SHORT outranks surplus in the same cell', () => {
    // Two MDs down and a CRNA spare is a problem, not an opportunity.
    const rows = coverageWeek({
      sites: [site('s1', 'Paoli')], providers: [md, crna],
      slots: [slot('s1', MON, '7-3', { group: 'both', held: ['c1'] })],
      dates: [MON],
      demand: new Map([[`s1|${MON}`, { md: 2, crna: 0, source: 'manual' as const, notes: null }]]),
    });
    expect(rows[0].cells[0]).toMatchObject({ status: 'gap', shortBy: 2, surplusBy: 1 });
  });
});

describe('why nobody can be moved — the reason has to be specific', () => {
  // "Nobody is credentialed there", "the spare staff are the wrong group" and
  // "the only spare staff are already here" lead somewhere completely
  // different. A vague reason sends somebody hunting a person who does not
  // exist.
  const sites = [site('s1', 'Lankenau'), site('s2', 'Riddle')];
  const build = (opts: {
    slots: OpsSlotRow[]; demand: Map<string, any>;
    credentials?: OpsCredentialRow[]; providers?: OpsProviderRow[];
  }) => {
    const providers = opts.providers ?? [md, md2, crna];
    const coverage = coverageWeek({
      sites, providers, slots: opts.slots, dates: [MON], demand: opts.demand,
    });
    return transferPicture({
      date: MON, coverage, slots: opts.slots, providers,
      credentials: opts.credentials ?? [],
    });
  };

  it('says so when nobody is spare anywhere', () => {
    const p = build({
      slots: [],
      demand: new Map([[`s2|${MON}`, { md: 2, crna: null, source: 'manual' as const, notes: null }]]),
    });
    expect(p.unmatched[0].reason).toBe('nobody is spare anywhere today');
  });

  it('says so when the only spare staff are already at the short site', () => {
    // A site short of CRNAs and spare on MDs is BOTH, and you cannot move
    // somebody to where they already are.
    const p = build({
      providers: [md, md2, crna],
      slots: [
        slot('s1', MON, '7-3', { held: ['p1'] }),
        slot('s1', MON, '7-5', { held: ['p2'] }),
      ],
      demand: new Map([[`s1|${MON}`, { md: 1, crna: 3, source: 'manual' as const, notes: null }]]),
    });
    expect(p.unmatched[0].reason).toBe('the only spare staff today are already at LAN');
  });

  it('says so when the spare staff are the wrong GROUP', () => {
    const p = build({
      providers: [md, crna],
      slots: [
        slot('s1', MON, '7-3', { group: 'both', held: ['c1'] }),
        slot('s1', MON, '7-5', { group: 'both', held: ['c1'] }),
      ],
      credentials: [{ provider_id: 'c1', site_id: 's1' }, { provider_id: 'c1', site_id: 's2' }],
      demand: new Map([
        [`s1|${MON}`, { md: null, crna: 1, source: 'manual' as const, notes: null }],
        [`s2|${MON}`, { md: 2, crna: null, source: 'manual' as const, notes: null }],
      ]),
    });
    expect(p.unmatched[0].reason).toContain('CRNA');
    expect(p.unmatched[0].reason).toContain('short of MD');
  });

  it('falls back to the credential reason when group and location both fit', () => {
    const p = build({
      slots: [
        slot('s1', MON, '7-3', { held: ['p1'] }),
        slot('s1', MON, '7-5', { held: ['p2'] }),
      ],
      credentials: [{ provider_id: 'p1', site_id: 's1' }],   // not at s2
      demand: new Map([
        [`s1|${MON}`, { md: 1, crna: null, source: 'manual' as const, notes: null }],
        [`s2|${MON}`, { md: 2, crna: null, source: 'manual' as const, notes: null }],
      ]),
    });
    expect(p.unmatched[0].reason).toBe('nobody spare today is credentialed there');
  });
});

describe('the overnight call doctor is not daytime floor coverage', () => {
  // Paoli's Friday read MD 9 when 8 people were actually in rooms: the C1
  // doctor starts at 15:00. The schedule grid has excluded weekday first call
  // from its headline count since it was built; the board was not.
  const sites = [site('s1', 'Paoli')];
  const FRI = '2026-09-18';
  const SATURDAY = '2026-09-19';

  const cover = (slots: OpsSlotRow[], dates: string[]) => coverageWeek({
    sites, providers: [md, md2], slots, dates, demand: new Map(),
  });

  it('excludes a 15:00 call start on a WEEKDAY', () => {
    const rows = cover([
      slot('s1', FRI, 'C1', { category: 'call', rank: 0, held: ['p1'], start: '15:00', end: '07:00' }),
      slot('s1', FRI, '7-5', { held: ['p2'], start: '07:00', end: '17:00' }),
    ], [FRI]);
    expect(rows[0].cells[0].groups.find(g => g.group === 'physician')?.available).toBe(1);
  });

  it('INCLUDES it at the weekend, where the call team IS the coverage', () => {
    // Paoli's stated weekend requirement is 3 — C1, C2 and C3. Excluding C1
    // there would report every weekend a body short.
    const rows = cover([
      slot('s1', SATURDAY, 'C1', { category: 'call', rank: 0, held: ['p1'], start: '15:00', end: '07:00' }),
      slot('s1', SATURDAY, 'C2', { category: 'call', rank: 1, held: ['p2'], start: '07:00', end: '19:00' }),
    ], [SATURDAY]);
    expect(rows[0].cells[0].groups.find(g => g.group === 'physician')?.available).toBe(2);
  });

  it('counts a 07:00 call start — second call IS on the floor', () => {
    const rows = cover([
      slot('s1', FRI, 'C2', { category: 'call', rank: 1, held: ['p1'], start: '07:00', end: '19:00' }),
    ], [FRI]);
    expect(rows[0].cells[0].groups.find(g => g.group === 'physician')?.available).toBe(1);
  });

  it('excludes the evening and night SPLIT segments too', () => {
    // The code test the grid uses (`code === 'C1'`) misses C1E8 and C1N12
    // entirely. A time test catches them.
    const rows = cover([
      slot('s1', FRI, 'C1E8', { category: 'call', held: ['p1'], start: '15:00', end: '23:00' }),
      slot('s1', FRI, 'C1N12', { category: 'call', held: ['p2'], start: '19:00', end: '07:00' }),
    ], [FRI]);
    expect(rows[0].cells[0].groups.every(g => g.available === 0)).toBe(true);
  });

  it('counts a shift that states NO times rather than dropping it', () => {
    // Several imported types state none. Dropping them would silently
    // under-report a whole site.
    const rows = cover([
      slot('s1', FRI, 'DAY', { held: ['p1'], start: undefined, end: undefined }),
    ], [FRI]);
    expect(rows[0].cells[0].groups.find(g => g.group === 'physician')?.available).toBe(1);
  });

  it('counts a late-morning start', () => {
    const rows = cover([
      slot('s1', FRI, '11-19', { held: ['p1'], start: '11:00', end: '19:00' }),
    ], [FRI]);
    expect(rows[0].cells[0].groups.find(g => g.group === 'physician')?.available).toBe(1);
  });
});

describe('per-diem shift minimums', () => {
  const sites = [site('s1', 'Paoli')];
  const base = (opts: {
    min?: number | null; shifts?: number; startDate?: string | null;
  }) => perDiemBench({
    date: '2026-09-18',            // ~8.6 months into the year
    providers: [{
      id: 'p1', last_name: 'Martinez', provider_type: 'physician',
      start_date: opts.startDate ?? null,
    }],
    profiles: [{
      provider_id: 'p1', employment_status: 'per_diem',
      min_monthly_shifts: opts.min === undefined ? null : opts.min,
    }],
    credentials: [{ provider_id: 'p1', site_id: 's1' }],
    availability: [], slots: [], sites,
    shiftsYtd: new Map([['p1', opts.shifts ?? 0]]),
  }).rows[0];

  it('reports shifts worked and the monthly average', () => {
    const r = base({ shifts: 26 });
    expect(r.shiftsYtd).toBe(26);
    expect(r.avgShiftsPerMonth).toBeCloseTo(3, 0);
  });

  it('FLAGS somebody under their stated minimum', () => {
    const r = base({ min: 4, shifts: 17 });      // ~2/month against 4
    expect(r.belowMinimum).toBe(true);
    expect(r.minMonthlyShifts).toBe(4);
  });

  it('does not flag somebody meeting it', () => {
    expect(base({ min: 2, shifts: 26 }).belowMinimum).toBe(false);
  });

  it('never flags somebody with NO minimum stated', () => {
    // Most of the roster has no such obligation. A null is not a zero, and
    // flagging everyone without one would make the flag meaningless.
    expect(base({ min: null, shifts: 0 }).belowMinimum).toBe(false);
    expect(base({ min: null, shifts: 0 }).minMonthlyShifts).toBeNull();
  });

  it('honours an explicit ZERO minimum, which is a real statement', () => {
    const r = base({ min: 0, shifts: 0 });
    expect(r.minMonthlyShifts).toBe(0);
    expect(r.belowMinimum).toBe(false);
  });

  it('judges a MID-YEAR starter only on the months they have been here', () => {
    // Started 1 September, worked 5 shifts in ~18 days against a minimum of 4.
    // Dividing by the whole year would read as 0.6/month and flag them for an
    // obligation they did not have in March.
    const r = base({ min: 4, shifts: 5, startDate: '2026-09-01' });
    expect(r.avgShiftsPerMonth).toBeGreaterThan(4);
    expect(r.belowMinimum).toBe(false);
  });

  it('does not flag anybody in their FIRST month', () => {
    // One slow fortnight is not a pattern, and a flag that fires on everybody
    // new teaches people to ignore it.
    const r = base({ min: 8, shifts: 0, startDate: '2026-09-10' });
    expect(r.belowMinimum).toBe(false);
  });

  it('counts a provider with no YTD entry as zero rather than throwing', () => {
    const r = perDiemBench({
      date: '2026-09-18',
      providers: [{ id: 'p1', last_name: 'Martinez', provider_type: 'physician' }],
      profiles: [{ provider_id: 'p1', employment_status: 'per_diem', min_monthly_shifts: 2 }],
      credentials: [{ provider_id: 'p1', site_id: 's1' }],
      availability: [], slots: [], sites,
    }).rows[0];
    expect(r.shiftsYtd).toBe(0);
    expect(r.belowMinimum).toBe(true);
  });

  it('reads a minimum that arrives as a string', () => {
    expect(base({ min: '3' as never, shifts: 0 }).minMonthlyShifts).toBe(3);
  });

  it('counts how many on the bench are running short', () => {
    const summary = perDiemBench({
      date: '2026-09-18',
      providers: [
        { id: 'p1', last_name: 'A', provider_type: 'physician' },
        { id: 'p2', last_name: 'B', provider_type: 'physician' },
      ],
      profiles: [
        { provider_id: 'p1', employment_status: 'per_diem', min_monthly_shifts: 4 },
        { provider_id: 'p2', employment_status: 'per_diem', min_monthly_shifts: 1 },
      ],
      credentials: [
        { provider_id: 'p1', site_id: 's1' }, { provider_id: 'p2', site_id: 's1' },
      ],
      availability: [], slots: [], sites,
      shiftsYtd: new Map([['p1', 0], ['p2', 40]]),
    });
    expect(summary.belowMinimum).toBe(1);
  });
});

describe('monthsWorkedThisYear', () => {
  it('measures from 1 January when there is no start date', () => {
    expect(monthsWorkedThisYear('2026-09-18')).toBeCloseTo(261 / 30.44, 1);
  });

  it('measures from the start date when it is later', () => {
    expect(monthsWorkedThisYear('2026-09-18', '2026-09-01')).toBeCloseTo(18 / 30.44, 2);
  });

  it('ignores a start date from a previous year', () => {
    expect(monthsWorkedThisYear('2026-09-18', '2019-04-02'))
      .toBeCloseTo(monthsWorkedThisYear('2026-09-18'), 3);
  });

  it('never returns zero, so nothing divides by it', () => {
    expect(monthsWorkedThisYear('2026-09-18', '2026-09-18')).toBeGreaterThan(0);
  });

  it('returns zero for a start date in the future', () => {
    expect(monthsWorkedThisYear('2026-09-18', '2026-12-01')).toBe(0);
  });
});

describe('the average covers the schedule we HOLD, not the calendar year', () => {
  // The bug this prevents, found on live data: FloorRunner holds September
  // onwards. Everyone worked through the spring, but those months are not in
  // the database. Dividing by the whole year put the entire bench at 0.2 a
  // month — measuring the data gap and calling it their performance.
  it('measures from the first published slot, not from 1 January', () => {
    const full = monthsWorkedThisYear('2026-09-18');
    const windowed = monthsWorkedThisYear('2026-09-18', null, '2026-09-01');
    expect(full).toBeCloseTo(8.6, 1);
    expect(windowed).toBeCloseTo(0.6, 1);
  });

  it('takes the LATEST of year start, hire date and data start', () => {
    // A June hire, with data from September: September wins.
    expect(monthsWorkedThisYear('2026-09-18', '2026-06-01', '2026-09-01'))
      .toBeCloseTo(monthsWorkedThisYear('2026-09-18', null, '2026-09-01'), 3);
    // A September hire, with data from January: the hire date wins.
    expect(monthsWorkedThisYear('2026-09-18', '2026-09-10', '2026-01-01'))
      .toBeCloseTo(9 / 30.44, 2);
  });

  it('does not flag a bench that looks idle only because of the data gap', () => {
    // 9 shifts since 1 September is ~15 a month, not 1 a month. Against a
    // minimum of 4 that is comfortably met; against the year it would flag.
    const row = perDiemBench({
      date: '2026-09-18',
      providers: [{ id: 'p1', last_name: 'Lincoln', provider_type: 'physician' }],
      profiles: [{ provider_id: 'p1', employment_status: 'per_diem', min_monthly_shifts: 4 }],
      credentials: [{ provider_id: 'p1', site_id: 's1' }],
      availability: [], slots: [],
      sites: [site('s1', 'Paoli')],
      shiftsYtd: new Map([['p1', 9]]),
      scheduleDataFrom: '2026-09-01',
    }).rows[0];
    expect(row.avgShiftsPerMonth).toBeGreaterThan(4);
    expect(row.belowMinimum).toBe(false);
  });

  it('reports the window so the panel need not imply a full year', () => {
    const b = perDiemBench({
      date: '2026-09-18',
      providers: [], profiles: [], credentials: [], availability: [], slots: [],
      sites: [], scheduleDataFrom: '2026-09-01',
    });
    expect(b.averageFrom).toBe('2026-09-01');
    expect(b.averageMonths).toBeCloseTo(0.6, 1);
  });

  it('falls back to the year when no schedule window is known', () => {
    const b = perDiemBench({
      date: '2026-09-18',
      providers: [], profiles: [], credentials: [], availability: [], slots: [], sites: [],
    });
    expect(b.averageFrom).toBe('2026-01-01');
  });
});
