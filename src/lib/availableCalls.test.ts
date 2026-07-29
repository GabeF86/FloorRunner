import { describe, it, expect } from 'vitest';
import {
  buildAvailableCallList, bucketSummaryText, dateLabelOf, formatAvailableCallText,
  isUnfilledCallSlot, shortDate, slotIsUnfilled,
  type AvailableCallAssignment, type AvailableCallSlot,
} from './availableCalls';

/* ── Fixtures ──────────────────────────────────────────────────────────────
 * Shaped like the grid payload's slot rows (schedule_slots + shift_types +
 * assignments), which is what the page hands in. */

let seq = 0;
function slot(
  over: Partial<AvailableCallSlot> & { slot_date: string; code?: string },
): AvailableCallSlot {
  const { code = 'C1', ...rest } = over;
  return {
    id: `slot-${++seq}`,
    derived_day_type: 'weekday',
    slot_index: 0,
    locked: false,
    shift_types: { code, name: `${code} Call`, category: 'call', display_order: 1 },
    assignments: [],
    ...rest,
  };
}

/** A real, filled assignment. */
const filled = (provider_id = 'p1'): AvailableCallAssignment =>
  ({ provider_id, assignment_status: 'assigned' });

/** THE trap row: clearing a cell deletes the assignment and re-inserts one
 *  with a null provider and status 'open'. A row exists; the slot is empty. */
const openPlaceholder = (over: Partial<AvailableCallAssignment> = {}): AvailableCallAssignment =>
  ({ provider_id: null, assignment_status: 'open', ...over });

describe('slotIsUnfilled / isUnfilledCallSlot', () => {
  it('an OPEN PLACEHOLDER row (provider null, status "open") is unfilled', () => {
    expect(slotIsUnfilled({ assignments: [openPlaceholder()] })).toBe(true);
  });

  it('a slot with no assignment rows at all is unfilled', () => {
    expect(slotIsUnfilled({ assignments: [] })).toBe(true);
    expect(slotIsUnfilled({ assignments: null })).toBe(true);
    expect(slotIsUnfilled({})).toBe(true);
  });

  it('a real assignment fills the slot', () => {
    expect(slotIsUnfilled({ assignments: [filled()] })).toBe(false);
  });

  // The grid reads assignments[0]; this module scans every row, so a slot
  // carrying both a stale placeholder and a real assignment reads as FILLED
  // whichever order they arrive in.
  it('one filled row among placeholders fills the slot, in either order', () => {
    expect(slotIsUnfilled({ assignments: [openPlaceholder(), filled()] })).toBe(false);
    expect(slotIsUnfilled({ assignments: [filled(), openPlaceholder()] })).toBe(false);
  });

  // assignmentFills (plannerMath) is the single home, and it excludes these
  // two statuses as well as null providers.
  it('canceled and declined rows leave the slot unfilled', () => {
    expect(slotIsUnfilled({ assignments: [{ provider_id: 'p1', assignment_status: 'canceled' }] })).toBe(true);
    expect(slotIsUnfilled({ assignments: [{ provider_id: 'p1', assignment_status: 'declined' }] })).toBe(true);
  });

  it('scopes on the shift type CATEGORY, not on a code list', () => {
    const st = (category: string) => ({ code: 'X', category, display_order: 1 });
    expect(isUnfilledCallSlot({ shift_types: st('call'), assignments: [openPlaceholder()] })).toBe(true);
    expect(isUnfilledCallSlot({ shift_types: st('regular'), assignments: [openPlaceholder()] })).toBe(false);
    expect(isUnfilledCallSlot({ shift_types: st('admin'), assignments: [] })).toBe(false);
    expect(isUnfilledCallSlot({ shift_types: null, assignments: [] })).toBe(false);
  });
});

describe('buildAvailableCallList: membership', () => {
  it('lists an open-placeholder call slot and omits a filled one', () => {
    const list = buildAvailableCallList([
      slot({ slot_date: '2026-10-13', code: 'C1', assignments: [filled()] }),
      slot({ slot_date: '2026-10-13', code: 'C2', assignments: [openPlaceholder()] }),
    ]);
    expect(list.total).toBe(1);
    expect(list.rows.map(r => r.code)).toEqual(['C2']);
  });

  // MUTATION PROOF for the placeholder case. If the predicate is weakened to
  // "has no assignment row" (`(slot.assignments ?? []).length === 0`), this
  // block reports 0 open calls instead of 3 and every assertion below fails.
  it('a block whose cells were CLEARED (all placeholders) reports every call open', () => {
    const list = buildAvailableCallList([
      slot({ slot_date: '2026-10-16', code: 'C1', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-16', code: 'C2', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-17', code: 'C1', assignments: [openPlaceholder()] }),
    ]);
    expect(list.total).toBe(3);
    expect(list.rows.every(r => r.code.startsWith('C'))).toBe(true);
    expect(list.clusters).toHaveLength(1);
  });

  it('excludes day-shift slots even when they are wide open', () => {
    const list = buildAvailableCallList([
      slot({
        slot_date: '2026-10-13', code: '7-3',
        shift_types: { code: '7-3', name: 'Day', category: 'regular', display_order: 9 },
        assignments: [openPlaceholder()],
      }),
      slot({ slot_date: '2026-10-13', code: 'C1', assignments: [openPlaceholder()] }),
    ]);
    expect(list.rows.map(r => r.code)).toEqual(['C1']);
  });

  it('includes split SEGMENT slots under their own code', () => {
    const list = buildAvailableCallList([
      slot({
        slot_date: '2026-10-17', code: 'C1D12',
        shift_types: { code: 'C1D12', name: 'First Call Day 12h', category: 'call', display_order: 2 },
        assignments: [openPlaceholder()],
      }),
      slot({
        slot_date: '2026-10-17', code: 'C1N12',
        shift_types: { code: 'C1N12', name: 'First Call Night 12h', category: 'call', display_order: 3 },
        assignments: [filled()],
      }),
    ]);
    expect(list.rows.map(r => r.code)).toEqual(['C1D12']);
  });

  it('flags rows already listed up for grabs', () => {
    const list = buildAvailableCallList([
      slot({ slot_date: '2026-10-13', code: 'C1', assignments: [openPlaceholder({ is_open_call: true })] }),
      slot({ slot_date: '2026-10-13', code: 'C2', assignments: [openPlaceholder()] }),
    ]);
    expect(list.postedCount).toBe(1);
    expect(list.rows.find(r => r.code === 'C1')!.posted).toBe(true);
    expect(list.rows.find(r => r.code === 'C2')!.posted).toBe(false);
  });
});

describe('buildAvailableCallList: ordering', () => {
  it('is chronological, then display_order, then code numerically (C2 before C10)', () => {
    const list = buildAvailableCallList([
      slot({ slot_date: '2026-10-17', code: 'C1', assignments: [openPlaceholder()] }),
      slot({
        slot_date: '2026-10-13', code: 'C10',
        shift_types: { code: 'C10', name: 'Tenth', category: 'call', display_order: 5 },
        assignments: [openPlaceholder()],
      }),
      slot({
        slot_date: '2026-10-13', code: 'C2',
        shift_types: { code: 'C2', name: 'Second', category: 'call', display_order: 5 },
        assignments: [openPlaceholder()],
      }),
      slot({ slot_date: '2026-10-13', code: 'C1', assignments: [openPlaceholder()] }),
    ]);
    expect(list.rows.map(r => `${r.date}|${r.code}`)).toEqual([
      '2026-10-13|C1', '2026-10-13|C2', '2026-10-13|C10', '2026-10-17|C1',
    ]);
  });

  it('is stable regardless of input order', () => {
    const rows = [
      slot({ slot_date: '2026-10-18', code: 'C1', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-16', code: 'C1', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-17', code: 'C1', assignments: [openPlaceholder()] }),
    ];
    const a = buildAvailableCallList(rows).rows.map(r => r.date);
    const b = buildAvailableCallList([...rows].reverse()).rows.map(r => r.date);
    expect(a).toEqual(b);
    expect(a).toEqual(['2026-10-16', '2026-10-17', '2026-10-18']);
  });
});

describe('buildAvailableCallList: day-type buckets', () => {
  it('buckets by day of week and counts per bucket', () => {
    const list = buildAvailableCallList([
      slot({ slot_date: '2026-10-13', derived_day_type: 'weekday', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-16', derived_day_type: 'friday', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-17', derived_day_type: 'saturday', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-18', derived_day_type: 'sunday', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-18', code: 'C2', derived_day_type: 'sunday', assignments: [openPlaceholder()] }),
    ]);
    expect(list.byBucket).toEqual([
      { bucket: 'weekday', label: 'M–Th', count: 1 },
      { bucket: 'friday', label: 'Fri', count: 1 },
      { bucket: 'saturday', label: 'Sat', count: 1 },
      { bucket: 'sunday', label: 'Sun', count: 2 },
    ]);
    expect(bucketSummaryText(list)).toBe('M–Th 1 · Fri 1 · Sat 1 · Sun 2');
  });

  // dayTypeBucketOn: there is no holiday bucket — a holiday-dated call belongs
  // to the bucket for the day of the week it lands on. Labor Day is a Monday.
  it('a holiday call folds onto its day of the week, keeping the holiday NAME as a note', () => {
    const list = buildAvailableCallList(
      [slot({ slot_date: '2026-09-07', derived_day_type: 'federal_holiday', assignments: [openPlaceholder()] })],
      [{ holiday_date: '2026-09-07', holiday_name: 'Labor Day' }],
    );
    expect(list.rows[0].bucket).toBe('weekday');
    expect(list.rows[0].bucketLabel).toBe('M–Th');
    expect(list.rows[0].holidayName).toBe('Labor Day');
  });

  it('counts per call code, most open first', () => {
    const list = buildAvailableCallList([
      slot({ slot_date: '2026-10-16', code: 'C1', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-17', code: 'C1', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-17', code: 'C2', assignments: [openPlaceholder()] }),
    ]);
    expect(list.byCode).toEqual([{ code: 'C1', count: 2 }, { code: 'C2', count: 1 }]);
  });

  it('empty buckets are dropped from the summary line', () => {
    const list = buildAvailableCallList(
      [slot({ slot_date: '2026-10-17', derived_day_type: 'saturday', assignments: [openPlaceholder()] })]);
    expect(bucketSummaryText(list)).toBe('Sat 1');
  });
});

describe('buildAvailableCallList: clustering', () => {
  it('groups Fri/Sat/Sun into ONE weekend cluster and leaves weekdays alone', () => {
    const list = buildAvailableCallList([
      slot({ slot_date: '2026-10-16', derived_day_type: 'friday', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-17', derived_day_type: 'saturday', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-18', derived_day_type: 'sunday', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-20', assignments: [openPlaceholder()] }),
    ]);
    expect(list.clusters).toHaveLength(2);
    expect(list.clusters[0].kind).toBe('weekend');
    expect(list.clusters[0].key).toBe('2026-10-17'); // the weekend's Saturday
    expect(list.clusters[0].dates).toEqual(['2026-10-16', '2026-10-17', '2026-10-18']);
    expect(list.clusters[0].label).toBe('Fri 10/16 – Sun 10/18');
    expect(list.clusters[0].rows).toHaveLength(3);
    expect(list.clusters[1].kind).toBe('day');
    expect(list.clusters[1].dates).toEqual(['2026-10-20']);
    expect(list.clusters[1].label).toBe('Tue 10/20');
  });

  // The reason this is grouped by WEEKEND rather than by runs of consecutive
  // dates. A brand-new draft has every call slot open, so consecutive-date
  // runs collapse the whole block into one cluster — useless exactly when the
  // list matters most. Thu/Fri/Sat/Sun adjacent must still be 2 clusters: the
  // Thursday is a weekday call, sold on its own.
  it('does NOT swallow an adjacent Thursday into the weekend', () => {
    const list = buildAvailableCallList([
      slot({ slot_date: '2026-10-15', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-16', derived_day_type: 'friday', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-17', derived_day_type: 'saturday', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-18', derived_day_type: 'sunday', assignments: [openPlaceholder()] }),
    ]);
    expect(list.clusters.map(c => c.label)).toEqual(['Thu 10/15', 'Fri 10/16 – Sun 10/18']);
    expect(list.clusters.map(c => c.kind)).toEqual(['day', 'weekend']);
  });

  it('stays readable when EVERY date in a stretch is open', () => {
    const dates = [
      '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15',
      '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19',
    ];
    const dt = (d: string) =>
      d === '2026-10-16' ? 'friday' : d === '2026-10-17' ? 'saturday' : d === '2026-10-18' ? 'sunday' : 'weekday';
    const list = buildAvailableCallList(
      dates.map(d => slot({ slot_date: d, derived_day_type: dt(d), assignments: [openPlaceholder()] })));
    // 5 weekdays (Mon–Thu + the following Mon) + 1 weekend, never one blob.
    expect(list.clusters).toHaveLength(6);
    expect(list.clusters.map(c => c.label)).toEqual([
      'Mon 10/12', 'Tue 10/13', 'Wed 10/14', 'Thu 10/15',
      'Fri 10/16 – Sun 10/18', 'Mon 10/19',
    ]);
  });

  it('several open calls on ONE date stay one cluster of that date', () => {
    const list = buildAvailableCallList([
      slot({ slot_date: '2026-10-13', code: 'C1', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-13', code: 'C2', assignments: [openPlaceholder()] }),
    ]);
    expect(list.clusters).toHaveLength(1);
    expect(list.clusters[0].dates).toEqual(['2026-10-13']);
    expect(list.clusters[0].rows).toHaveLength(2);
  });

  it('separate weekends stay separate clusters', () => {
    const list = buildAvailableCallList([
      slot({ slot_date: '2026-10-17', derived_day_type: 'saturday', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-24', derived_day_type: 'saturday', assignments: [openPlaceholder()] }),
    ]);
    expect(list.clusters).toHaveLength(2);
    expect(list.clusters.map(c => c.key)).toEqual(['2026-10-17', '2026-10-24']);
  });

  it('flags a weekend whose Fri, Sat AND Sun are all open', () => {
    const list = buildAvailableCallList([
      slot({ slot_date: '2026-10-16', derived_day_type: 'friday', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-17', derived_day_type: 'saturday', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-18', derived_day_type: 'sunday', assignments: [openPlaceholder()] }),
    ]);
    expect(list.clusters[0].wholeWeekend).toBe(true);
  });

  it('does NOT flag a partial weekend (Sat+Sun without the Friday)', () => {
    const list = buildAvailableCallList([
      slot({ slot_date: '2026-10-17', derived_day_type: 'saturday', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-18', derived_day_type: 'sunday', assignments: [openPlaceholder()] }),
    ]);
    expect(list.clusters[0].kind).toBe('weekend');
    expect(list.clusters[0].wholeWeekend).toBe(false);
    expect(list.clusters[0].label).toBe('Sat 10/17 – Sun 10/18');
  });

  it('never flags a weekday cluster', () => {
    const list = buildAvailableCallList([
      slot({ slot_date: '2026-10-12', assignments: [openPlaceholder()] }),
      slot({ slot_date: '2026-10-13', assignments: [openPlaceholder()] }),
    ]);
    expect(list.clusters.every(c => c.wholeWeekend === false)).toBe(true);
    expect(list.clusters.every(c => c.kind === 'day')).toBe(true);
  });
});

describe('an empty / fully covered block', () => {
  it('returns an empty list, not a broken one', () => {
    const list = buildAvailableCallList([
      slot({ slot_date: '2026-10-13', assignments: [filled()] }),
    ]);
    expect(list.total).toBe(0);
    expect(list.rows).toEqual([]);
    expect(list.clusters).toEqual([]);
    expect(list.postedCount).toBe(0);
    expect(list.byCode).toEqual([]);
    expect(bucketSummaryText(list)).toBe('');
  });

  it('says so in the copied text', () => {
    const list = buildAvailableCallList([]);
    expect(formatAvailableCallText(list, 'Nov Block')).toBe(
      'Available Call — Nov Block\nNo unfilled call slots — every call in this block is covered.');
  });
});

describe('date labels', () => {
  it('formats straight off the ISO string (no timezone can shift the day)', () => {
    expect(shortDate('2026-10-17')).toBe('10/17');
    expect(shortDate('2026-01-05')).toBe('1/05');
    expect(dateLabelOf('2026-10-17')).toBe('Sat 10/17');
    expect(dateLabelOf('2026-09-07')).toBe('Mon 9/07');
  });
});

describe('formatAvailableCallText', () => {
  it('reproduces the rendered grouping as pasteable plain text', () => {
    const list = buildAvailableCallList(
      [
        slot({
          slot_date: '2026-10-16', code: 'C2', derived_day_type: 'friday',
          shift_types: { code: 'C2', name: 'Second Call', category: 'call', display_order: 2 },
          assignments: [openPlaceholder()],
        }),
        slot({
          slot_date: '2026-10-17', code: 'C1', derived_day_type: 'saturday',
          shift_types: { code: 'C1', name: 'First Call', category: 'call', display_order: 1 },
          assignments: [openPlaceholder({ is_open_call: true })],
        }),
        slot({
          slot_date: '2026-10-18', code: 'C1', derived_day_type: 'sunday',
          shift_types: { code: 'C1', name: 'First Call', category: 'call', display_order: 1 },
          assignments: [openPlaceholder()],
        }),
        slot({
          slot_date: '2026-11-26', code: 'C1', derived_day_type: 'federal_holiday',
          shift_types: { code: 'C1', name: 'First Call', category: 'call', display_order: 1 },
          assignments: [openPlaceholder()],
        }),
      ],
      [{ holiday_date: '2026-11-26', holiday_name: 'Thanksgiving' }],
    );
    expect(formatAvailableCallText(list, 'Paoli Nov Block')).toBe([
      'Available Call — Paoli Nov Block',
      '4 open call slots (1 already posted)',
      'M–Th 1 · Fri 1 · Sat 1 · Sun 1',
      '',
      'Fri 10/16 – Sun 10/18 — 3 open — WHOLE WEEKEND',
      '  Fri 10/16  C2  Second Call',
      '  Sat 10/17  C1  First Call  [posted]',
      '  Sun 10/18  C1  First Call',
      '',
      'Thu 11/26 — 1 open',
      '  Thu 11/26  C1  First Call  (Thanksgiving)',
    ].join('\n'));
  });

  it('singularizes a lone open call and omits the posted count when none are', () => {
    const list = buildAvailableCallList(
      [slot({ slot_date: '2026-10-20', assignments: [openPlaceholder()] })]);
    expect(formatAvailableCallText(list, 'B')).toContain('1 open call slot\n');
    expect(formatAvailableCallText(list, 'B')).not.toContain('already posted');
  });
});
