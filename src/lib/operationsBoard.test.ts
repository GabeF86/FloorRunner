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
  shiftHours, weekDates, providerName,
  type OpsSlotRow, type OpsSiteRow, type OpsProviderRow,
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

describe('coverageWeek', () => {
  const sites = [site('s1', 'Paoli')];

  it('counts filled against required and grades the shortfall', () => {
    const rows = coverageWeek({
      sites, providers: [md, md2], dates: [MON],
      slots: [
        slot('s1', MON, '7-3', { held: ['p1'] }),
        slot('s1', MON, '7-5', { held: ['p2'] }),
        slot('s1', MON, 'D4', {}),               // open
      ],
    });
    expect(rows[0].cells[0]).toMatchObject({ status: 'short', shortBy: 1 });
    expect(rows[0].cells[0].groups).toEqual([{ group: 'physician', filled: 2, required: 3 }]);
    expect(rows[0].shortBy).toBe(1);
  });

  it('calls two or more short a GAP, not a shortage', () => {
    const rows = coverageWeek({
      sites, providers: [md], dates: [MON],
      slots: [slot('s1', MON, 'D4', { required_count: 3, held: ['p1'] })],
    });
    expect(rows[0].cells[0]).toMatchObject({ status: 'gap', shortBy: 2 });
  });

  it('reads CLOSED off the site, not off the empty schedule', () => {
    const rows = coverageWeek({
      sites: [site('s1', 'Rothman', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])],
      providers: [], slots: [], dates: [SAT, SUN],
    });
    expect(rows[0].cells.map(c => c.status)).toEqual(['closed', 'closed']);
  });

  it('says UNSCHEDULED — not 0/0 — for an open day nobody has built', () => {
    // Six of the seven sites have no schedule at all. A zero here would read
    // as "fully staffed, nobody needed"; the whole point is that it is blank.
    const rows = coverageWeek({ sites, providers: [], slots: [], dates: [MON] });
    expect(rows[0].cells[0]).toMatchObject({ status: 'unscheduled', shortBy: 0 });
    expect(rows[0].cells[0].groups).toEqual([]);
  });

  it('attributes a BOTH-groups slot to whoever is actually standing it', () => {
    const rows = coverageWeek({
      sites, providers: [md, crna], dates: [MON],
      slots: [
        slot('s1', MON, '7-3', { group: 'both', held: ['p1'] }),
        slot('s1', MON, '7-5', { group: 'both', held: ['c1'] }),
      ],
    });
    expect(rows[0].cells[0].groups).toEqual([
      { group: 'physician', filled: 1, required: 1 },
      { group: 'crna', filled: 1, required: 1 },
    ]);
  });

  it('parks an UNFILLED both-groups slot in neither column', () => {
    // Folding an open either-group room into MD would invent a physician
    // shortage that nobody has established.
    const rows = coverageWeek({
      sites, providers: [md], dates: [MON],
      slots: [slot('s1', MON, '7-3', { group: 'both' })],
    });
    expect(rows[0].cells[0].groups).toEqual([{ group: 'either', filled: 0, required: 1 }]);
    expect(rows[0].cells[0].shortBy).toBe(1);
  });

  it('never emits a 0/0 filler row for a group the site does not schedule', () => {
    const rows = coverageWeek({
      sites, providers: [md], dates: [MON],
      slots: [slot('s1', MON, 'C1', { category: 'call', rank: 0, held: ['p1'] })],
    });
    expect(rows[0].cells[0].groups.map(g => g.group)).toEqual(['physician']);
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
