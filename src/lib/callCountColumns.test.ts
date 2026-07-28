// Call Counts modal column shape (2026-07-28). Two rules under test:
//   1. a (bucket, code) column exists iff the BLOCK has a slot for that pair —
//      so Paoli's retired Friday C3 (patch38) disappears from new blocks while
//      the drafts that already materialized those slots keep showing them;
//   2. an EXTRA call is attributed to the day type it was worked, because the
//      pickup rate depends on it.
// Both route the bucket through the engine's dayTypeBucketOn, so a holiday
// folds onto its day of the week here exactly as it does in the engine.
import { describe, it, expect } from 'vitest';
import { dayTypeBucketOn } from './rulesEngine/shared';
import {
  BUCKET_LABELS,
  CALL_COUNT_CODES,
  computeCallCountColumns,
  extraCallsByBucketCode,
  extraKey,
  type CallCountSlotRow,
  type ExtraCallRecord,
} from './callCountColumns';

// 2026-03-02 Mon … 2026-03-08 Sun — the holiday-free week callCountDays.test
// uses. Holiday dates: 2026-05-25 Memorial Day = MONDAY, 2026-06-19 Juneteenth
// = FRIDAY, 2026-07-04 Independence Day = SATURDAY, 2026-11-01 = SUNDAY.
const MON = '2026-03-02', THU = '2026-03-05', FRI = '2026-03-06';
const SAT = '2026-03-07', SUN = '2026-03-08';

type Sh = NonNullable<CallCountSlotRow['shift_types']>;

const slot = (
  slot_date: string,
  derived_day_type: string,
  code: string,
  pids: string[] = [],
  shiftExtras: Partial<Sh> = {},
  ids?: string[],
): CallCountSlotRow => ({
  slot_date,
  derived_day_type,
  shift_types: { code, ...shiftExtras },
  assignments: pids.map((provider_id, i) => ({
    id: ids ? ids[i] : `a-${slot_date}-${code}-${provider_id}`,
    provider_id,
  })),
});

// Paoli after patch38: weekday C1/C2 (Fridays get C1/C2 from the SAME weekday
// templates through slateForDayType's union), Sat/Sun C1/C2/C3. No weekday C3
// template has ever existed; the friday/C3 row was deactivated 2026-07-27.
const paoliBlock = (): CallCountSlotRow[] => [
  slot(MON, 'weekday', 'C1', ['p1']),
  slot(MON, 'weekday', 'C2', ['p2']),
  slot(THU, 'weekday', 'C1', ['p2']),
  slot(THU, 'weekday', 'C2', ['p1']),
  slot(FRI, 'friday', 'C1', ['p1']),
  slot(FRI, 'friday', 'C2', ['p3']),
  slot(SAT, 'saturday', 'C1', ['p1']),
  slot(SAT, 'saturday', 'C2', ['p3']),
  slot(SAT, 'saturday', 'C3', ['p4']),
  slot(SUN, 'sunday', 'C1', ['p1']),
  slot(SUN, 'sunday', 'C2', ['p3']),
  slot(SUN, 'sunday', 'C3', ['p4']),
];

const keysOf = (slots: CallCountSlotRow[]) =>
  computeCallCountColumns(slots).columns.map(c => c.key);

/* ── Column derivation ───────────────────────────────────────────────────── */

describe('computeCallCountColumns — a column exists iff the block has that slot', () => {
  it('Paoli shape: no weekday C3 and no friday C3, but saturday and sunday C3 render', () => {
    const keys = keysOf(paoliBlock());
    // The two columns Gabriel asked to remove (2026-07-28) — permanently empty
    // on new blocks since patch38 deactivated the friday/C3 template.
    expect(keys).not.toContain('weekday|C3');
    expect(keys).not.toContain('friday|C3');
    // The neuro weekend still stands both days, so those columns stay.
    expect(keys).toContain('saturday|C3');
    expect(keys).toContain('sunday|C3');
    expect(keys).toEqual([
      'weekday|C1', 'weekday|C2',
      'friday|C1', 'friday|C2',
      'saturday|C1', 'saturday|C2', 'saturday|C3',
      'sunday|C1', 'sunday|C2', 'sunday|C3',
    ]);
  });

  it('a LEGACY draft that still holds Friday C3 slots keeps that column', () => {
    // patch38: "Friday C3 slots ALREADY materialized in EXISTING draft
    // schedules are left untouched." Deriving is what keeps a real assigned
    // call visible on those drafts; hardcoding the removal would hide it.
    const legacy = [...paoliBlock(), slot(FRI, 'friday', 'C3', ['p4'])];
    const { columns, counts } = computeCallCountColumns(legacy);
    expect(columns.map(c => c.key)).toContain('friday|C3');
    expect(counts['p4']['friday|C3']).toBe(1);
  });

  it('a single-tier site (C1 only) renders only C1 columns', () => {
    const keys = keysOf([
      slot(MON, 'weekday', 'C1', ['p1']),
      slot(FRI, 'friday', 'C1', ['p1']),
      slot(SAT, 'saturday', 'C1', ['p2']),
      slot(SUN, 'sunday', 'C1', ['p2']),
    ]);
    expect(keys).toEqual(['weekday|C1', 'friday|C1', 'saturday|C1', 'sunday|C1']);
  });

  it('a pair with slots but NOBODY assigned still renders — an empty column is information', () => {
    const { columns, blockTotals, counts } = computeCallCountColumns([
      slot(MON, 'weekday', 'C1', ['p1']),
      slot(SAT, 'saturday', 'C3', []),   // stood, unfilled
    ]);
    expect(columns.map(c => c.key)).toEqual(['weekday|C1', 'saturday|C3']);
    expect(blockTotals['saturday|C3']).toBe(1);
    expect(counts['p1']['saturday|C3']).toBeUndefined();
  });

  it('a code outside C1–C3 gets no column (display grouping unchanged)', () => {
    expect(keysOf([
      slot(MON, 'weekday', 'C1', ['p1']),
      slot(MON, 'weekday', 'CB', ['p2']),   // beeper — counts in the census, no column
    ])).toEqual(['weekday|C1']);
  });

  it('no call slots at all → no columns and no groups', () => {
    expect(computeCallCountColumns([])).toEqual({
      columns: [], groups: [], blockTotals: {}, counts: {},
    });
  });

  it('groups match the columns exactly — the header colSpans and the body cannot drift', () => {
    const { columns, groups } = computeCallCountColumns(paoliBlock());
    expect(groups.map(g => g.bucket)).toEqual(['weekday', 'friday', 'saturday', 'sunday']);
    expect(groups.map(g => g.codes.length)).toEqual([2, 2, 3, 3]);
    expect(groups.reduce((n, g) => n + g.codes.length, 0)).toBe(columns.length);
    expect(groups.flatMap(g => g.codes.map(c => `${g.bucket}|${c}`)))
      .toEqual(columns.map(c => c.key));
    expect(groups.map(g => g.label)).toEqual(['M–Th', 'Fri', 'Sat', 'Sun']);
    expect(columns.find(c => c.key === 'saturday|C1')!.label).toBe('Sat C1');
  });

  it('a bucket with no slots at all is dropped whole (a block with no Sunday call)', () => {
    const { groups } = computeCallCountColumns([
      slot(MON, 'weekday', 'C1', ['p1']),
      slot(SAT, 'saturday', 'C1', ['p2']),
    ]);
    expect(groups.map(g => g.bucket)).toEqual(['weekday', 'saturday']);
  });
});

describe('computeCallCountColumns — totals and counts', () => {
  it('weighted per-provider counts and block totals', () => {
    const { counts, blockTotals } = computeCallCountColumns(paoliBlock());
    expect(counts['p1']).toEqual({
      'weekday|C1': 1, 'weekday|C2': 1, 'friday|C1': 1, 'saturday|C1': 1, 'sunday|C1': 1,
    });
    expect(blockTotals['weekday|C1']).toBe(2);   // Mon + Thu
    expect(blockTotals['saturday|C3']).toBe(1);
  });

  it('split segments aggregate under their PARENT code by weight (patch35)', () => {
    const { columns, counts, blockTotals } = computeCallCountColumns([
      slot(SAT, 'saturday', 'C1D12', ['p1'], { parent_call_code: 'C1', call_burden_weight: 0.5 }),
      slot(SAT, 'saturday', 'C1N12', ['p2'], { parent_call_code: 'C1', call_burden_weight: 0.5 }),
    ]);
    // The SEGMENT code never becomes a column — the parent does.
    expect(columns.map(c => c.key)).toEqual(['saturday|C1']);
    expect(counts['p1']['saturday|C1']).toBe(0.5);
    expect(counts['p2']['saturday|C1']).toBe(0.5);
    expect(blockTotals['saturday|C1']).toBe(1);
  });

  it('unassigned rows and rows with a null provider are skipped, the slot still counts', () => {
    const { blockTotals, counts } = computeCallCountColumns([
      { slot_date: SAT, derived_day_type: 'saturday', shift_types: { code: 'C1' },
        assignments: [{ id: 'x', provider_id: null }] },
    ]);
    expect(blockTotals['saturday|C1']).toBe(1);
    expect(counts).toEqual({});
  });
});

describe('computeCallCountColumns — holiday folding comes from the engine', () => {
  it('a MONDAY holiday call is an M–Th call, not a column of its own', () => {
    // Labor Day 2026-09-07 is a Monday. dayTypeBucketOn (2026-07-27) folds it
    // onto its day of the week — there is no holiday bucket.
    const { columns, blockTotals } = computeCallCountColumns([
      slot('2026-09-07', 'major_holiday', 'C1', ['p1']),
    ]);
    expect(columns.map(c => c.key)).toEqual(['weekday|C1']);
    expect(blockTotals['weekday|C1']).toBe(1);
  });

  it('holidays on a Friday / Saturday / Sunday fold onto those buckets', () => {
    expect(keysOf([
      slot('2026-06-19', 'federal_holiday', 'C1', ['p1']),   // Juneteenth, Friday
      slot('2026-07-04', 'major_holiday', 'C2', ['p2']),     // July 4, Saturday
      slot('2026-11-01', 'federal_holiday', 'C3', ['p3']),   // Sunday
    ])).toEqual(['friday|C1', 'saturday|C2', 'sunday|C3']);
  });

  it('a holiday-only block creates the day-of-week column it folds into', () => {
    // The folding is what makes these calls visible at all: before 2026-07-27
    // a holiday-dated call landed in no column and vanished from the modal.
    const { columns } = computeCallCountColumns([
      slot('2026-09-07', 'major_holiday', 'C2', ['p1']),
    ]);
    expect(columns).toHaveLength(1);
    expect(columns[0].bucket).toBe('weekday');
  });

  it('agrees with dayTypeBucketOn on every day type the enum allows', () => {
    // scheduling.day_type = weekday|friday|saturday|sunday|federal_holiday|
    // major_holiday. Pin the column bucket to the engine's own answer rather
    // than to a literal, so a change to the engine rule can never leave this
    // module behind.
    const cases: Array<[string, string]> = [
      [MON, 'weekday'], [FRI, 'friday'], [SAT, 'saturday'], [SUN, 'sunday'],
      ['2026-09-07', 'major_holiday'], ['2026-06-19', 'federal_holiday'],
      ['2026-07-04', 'major_holiday'], ['2026-11-01', 'federal_holiday'],
    ];
    for (const [date, dt] of cases) {
      const { columns } = computeCallCountColumns([slot(date, dt, 'C1', ['p1'])]);
      expect(columns[0].bucket).toBe(dayTypeBucketOn(dt, date));
    }
  });
});

/* ── Extra calls by day type ─────────────────────────────────────────────── */

const rec = (
  id: string, provider_id: string, slot_date: string, shift_type_code: string,
  extra: Partial<ExtraCallRecord> = {},
): ExtraCallRecord => ({ id, provider_id, slot_date, shift_type_code, ...extra });

describe('extraCallsByBucketCode', () => {
  it('an extra C1 is attributed to the day type it was worked — each has a different price', () => {
    const slots = [
      slot(MON, 'weekday', 'C1', ['p1'], {}, ['a1']),
      slot(SAT, 'saturday', 'C1', ['p1'], {}, ['a2']),
      slot(SUN, 'sunday', 'C1', ['p1'], {}, ['a3']),
    ];
    const records = [
      rec('a1', 'p1', MON, 'C1'), rec('a2', 'p1', SAT, 'C1'), rec('a3', 'p1', SUN, 'C1'),
    ];
    // Only the weekend two are past the obligation.
    const tally = extraCallsByBucketCode(slots, records, new Set(['a2', 'a3']));
    expect(tally).toEqual({
      [extraKey('p1', 'saturday', 'C1')]: 1,
      [extraKey('p1', 'sunday', 'C1')]: 1,
    });
    // The one inside the obligation is NOT extra — the over set is the shared
    // census's, never recomputed here.
    expect(tally[extraKey('p1', 'weekday', 'C1')]).toBeUndefined();
  });

  it('a HOLIDAY-dated extra lands in its day-of-week bucket, never a holiday bucket', () => {
    const slots = [slot('2026-09-07', 'major_holiday', 'C1', ['p1'], {}, ['h1'])];
    const tally = extraCallsByBucketCode(slots, [rec('h1', 'p1', '2026-09-07', 'C1')], new Set(['h1']));
    expect(tally).toEqual({ [extraKey('p1', 'weekday', 'C1')]: 1 });
    expect(Object.keys(tally).some(k => k.includes('holiday'))).toBe(false);
  });

  it('a Saturday holiday extra bills as a Saturday', () => {
    const slots = [slot('2026-07-04', 'major_holiday', 'C1', ['p1'], {}, ['h2'])];
    expect(extraCallsByBucketCode(slots, [rec('h2', 'p1', '2026-07-04', 'C1')], new Set(['h2'])))
      .toEqual({ [extraKey('p1', 'saturday', 'C1')]: 1 });
  });

  it('splits group under the parent code at weight', () => {
    const slots = [
      slot(SAT, 'saturday', 'C1N12', ['p1'], { parent_call_code: 'C1', call_burden_weight: 0.5 }, ['s1']),
    ];
    const records = [rec('s1', 'p1', SAT, 'C1N12', { parent_code: 'C1', weight: 0.5 })];
    expect(extraCallsByBucketCode(slots, records, new Set(['s1'])))
      .toEqual({ [extraKey('p1', 'saturday', 'C1')]: 0.5 });
  });

  it('same provider, same code, different days stay in different columns', () => {
    const slots = [
      slot(SAT, 'saturday', 'C2', ['p1'], {}, ['x1']),
      slot(SUN, 'sunday', 'C2', ['p1'], {}, ['x2']),
      slot(FRI, 'friday', 'C2', ['p1'], {}, ['x3']),
    ];
    const records = [
      rec('x1', 'p1', SAT, 'C2'), rec('x2', 'p1', SUN, 'C2'), rec('x3', 'p1', FRI, 'C2'),
    ];
    expect(extraCallsByBucketCode(slots, records, new Set(['x1', 'x2', 'x3']))).toEqual({
      [extraKey('p1', 'friday', 'C2')]: 1,
      [extraKey('p1', 'saturday', 'C2')]: 1,
      [extraKey('p1', 'sunday', 'C2')]: 1,
    });
  });

  it('multiple extras in the SAME column add up', () => {
    const slots = [
      slot(SAT, 'saturday', 'C1', ['p1'], {}, ['y1']),
      slot('2026-07-04', 'major_holiday', 'C1', ['p1'], {}, ['y2']),  // also a Saturday
    ];
    const records = [rec('y1', 'p1', SAT, 'C1'), rec('y2', 'p1', '2026-07-04', 'C1')];
    expect(extraCallsByBucketCode(slots, records, new Set(['y1', 'y2'])))
      .toEqual({ [extraKey('p1', 'saturday', 'C1')]: 2 });
  });

  it('providers are kept apart', () => {
    const slots = [
      slot(SAT, 'saturday', 'C1', ['p1', 'p2'], {}, ['z1', 'z2']),
    ];
    const records = [rec('z1', 'p1', SAT, 'C1'), rec('z2', 'p2', SAT, 'C1')];
    expect(extraCallsByBucketCode(slots, records, new Set(['z1', 'z2']))).toEqual({
      [extraKey('p1', 'saturday', 'C1')]: 1,
      [extraKey('p2', 'saturday', 'C1')]: 1,
    });
  });

  it('falls back to the date when the payload carries no assignment ids', () => {
    // Belt-and-braces: records and slots come from the same grid array in
    // production, so the id join always hits. The fallback exists so a billable
    // pickup can never silently vanish from the table.
    const slots = [{ slot_date: SAT, derived_day_type: 'saturday', shift_types: { code: 'C1' },
                     assignments: [{ provider_id: 'p1' }] }];
    expect(extraCallsByBucketCode(slots, [rec('unknown-id', 'p1', SAT, 'C1')], new Set(['unknown-id'])))
      .toEqual({ [extraKey('p1', 'saturday', 'C1')]: 1 });
  });

  it('an extra outside C1–C3 is tallied but has no column — the pre-existing gap, unchanged', () => {
    const slots = [slot(MON, 'weekday', 'CB', ['p1'], {}, ['b1'])];
    const tally = extraCallsByBucketCode(slots, [rec('b1', 'p1', MON, 'CB')], new Set(['b1']));
    expect(tally).toEqual({ [extraKey('p1', 'weekday', 'CB')]: 1 });
    // …and the column set never offers a home for it.
    expect(keysOf(slots)).toEqual([]);
  });

  it('no over-par ids → an empty tally', () => {
    const slots = paoliBlock();
    expect(extraCallsByBucketCode(slots, [rec('a1', 'p1', MON, 'C1')], new Set())).toEqual({});
  });

  it('EVERY extra in the C1–C3 universe has a column to land in', () => {
    // The property that makes the derivation safe for billing: an assignment
    // implies its slot, and a slot implies its column, so pruning empty columns
    // can never hide an extra.
    const slots = [...paoliBlock(), slot(FRI, 'friday', 'C3', ['p4'], {}, ['legacy'])];
    const records: ExtraCallRecord[] = slots.flatMap(s =>
      (s.assignments || []).map(a => rec(
        a.id as string, a.provider_id as string, s.slot_date, s.shift_types!.code)));
    const tally = extraCallsByBucketCode(slots, records, new Set(records.map(r => r.id)));
    const columnKeys = new Set(computeCallCountColumns(slots).columns.map(c => c.key));
    for (const key of Object.keys(tally)) {
      const [, bucket, code] = key.split('|');
      if (!(CALL_COUNT_CODES as readonly string[]).includes(code)) continue;
      expect(columnKeys.has(`${bucket}|${code}`)).toBe(true);
    }
    expect(Object.keys(tally).length).toBeGreaterThan(0);
  });
});

describe('BUCKET_LABELS', () => {
  it('covers every bucket the columns can produce', () => {
    expect(BUCKET_LABELS).toEqual({
      weekday: 'M–Th', friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
    });
  });
});
