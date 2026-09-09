import { describe, it, expect } from 'vitest';
import {
  BURDEN_BUCKETS,
  tallyBurden,
  formatBreakdown,
  type TallyInput,
} from './callCodeBreakdown';

function row(over: Partial<TallyInput> = {}): TallyInput {
  return {
    shift_code: 'C1',
    shift_category: 'call',
    day_type: 'weekday',
    counts_toward_call_burden: true,
    ...over,
  };
}

describe('tallyBurden — bucketing', () => {
  it('counts a weekday call in total_assignments, total_call and weekday_call', () => {
    const { burden } = tallyBurden([row()]);
    expect(burden.total_assignments).toBe(1);
    expect(burden.total_call).toBe(1);
    expect(burden.weekday_call).toBe(1);
    expect(burden.friday_call).toBe(0);
    expect(burden.weekend_call).toBe(0);
    expect(burden.holiday_call).toBe(0);
  });

  it('routes every day type to its bucket', () => {
    const { burden } = tallyBurden([
      row({ day_type: 'weekday' }),
      row({ day_type: 'friday' }),
      row({ day_type: 'saturday' }),
      row({ day_type: 'sunday' }),
      row({ day_type: 'federal_holiday' }),
      row({ day_type: 'major_holiday' }),
    ]);
    expect(burden.weekday_call).toBe(1);
    expect(burden.friday_call).toBe(1);
    expect(burden.weekend_call).toBe(2); // saturday + sunday
    expect(burden.holiday_call).toBe(2); // federal + major
    expect(burden.total_call).toBe(6);
  });

  it('counts as call when the flag is true even if the category is not call', () => {
    const { burden } = tallyBurden([
      row({ shift_category: 'regular', counts_toward_call_burden: true }),
    ]);
    expect(burden.total_call).toBe(1);
  });

  it('counts as call when the category is call even if the flag is false', () => {
    const { burden } = tallyBurden([
      row({ shift_category: 'call', counts_toward_call_burden: false }),
    ]);
    expect(burden.total_call).toBe(1);
  });

  it('a non-call assignment reaches total_assignments and nothing else', () => {
    const { burden, breakdown } = tallyBurden([
      row({ shift_code: '7-3', shift_category: 'regular', counts_toward_call_burden: false }),
    ]);
    expect(burden.total_assignments).toBe(1);
    expect(burden.total_call).toBe(0);
    expect(burden.weekday_call).toBe(0);
    expect(breakdown.total_assignments).toEqual([{ code: '7-3', count: 1 }]);
    expect(breakdown.total_call).toEqual([]);
  });

  it('a call assignment with an unrecognised day type still counts as call', () => {
    // total_call must not silently lose rows the four day-type buckets miss.
    const { burden } = tallyBurden([row({ day_type: null })]);
    expect(burden.total_call).toBe(1);
    expect(burden.weekday_call).toBe(0);
    expect(burden.friday_call).toBe(0);
    expect(burden.weekend_call).toBe(0);
    expect(burden.holiday_call).toBe(0);
  });

  it('returns all six buckets at zero for an empty history', () => {
    const { burden, breakdown } = tallyBurden([]);
    for (const b of BURDEN_BUCKETS) {
      expect(burden[b]).toBe(0);
      expect(breakdown[b]).toEqual([]);
    }
  });
});

describe('tallyBurden — breakdown', () => {
  const mixed: TallyInput[] = [
    ...Array.from({ length: 3 }, () => row({ shift_code: 'C1' })),
    ...Array.from({ length: 7 }, () => row({ shift_code: 'C2' })),
    row({ shift_code: 'C2', day_type: 'saturday' }),
    row({ shift_code: 'C3', day_type: 'sunday' }),
    row({ shift_code: '7-3', shift_category: 'regular', counts_toward_call_burden: false }),
  ];

  it("breaks a bucket down by code, Gabriel's 3 C1 / 7 C2 case", () => {
    const { breakdown } = tallyBurden(mixed);
    expect(breakdown.weekday_call).toEqual([
      { code: 'C2', count: 7 },
      { code: 'C1', count: 3 },
    ]);
  });

  it('every bucket breakdown sums EXACTLY to its total', () => {
    const { burden, breakdown } = tallyBurden(mixed);
    for (const b of BURDEN_BUCKETS) {
      const sum = breakdown[b].reduce((acc, r) => acc + r.count, 0);
      expect(sum, `bucket ${b}`).toBe(burden[b]);
    }
  });

  it('does not fold split segments into their parent code', () => {
    // C2N12 stays C2N12. Folding would mix whole and split shifts under one
    // label while the raw total above stayed a plain assignment count.
    const { breakdown } = tallyBurden([
      row({ shift_code: 'C2' }),
      row({ shift_code: 'C2N12' }),
    ]);
    expect(breakdown.weekday_call).toEqual([
      { code: 'C2', count: 1 },
      { code: 'C2N12', count: 1 },
    ]);
  });

  it('orders by count descending, then code ascending', () => {
    const { breakdown } = tallyBurden([
      row({ shift_code: 'C3' }),
      row({ shift_code: 'C1' }),
      row({ shift_code: 'C2' }),
      row({ shift_code: 'C2' }),
    ]);
    expect(breakdown.weekday_call).toEqual([
      { code: 'C2', count: 2 },
      { code: 'C1', count: 1 },
      { code: 'C3', count: 1 },
    ]);
  });

  it('total_assignments breaks down over call and non-call codes alike', () => {
    const { breakdown } = tallyBurden(mixed);
    const codes = breakdown.total_assignments.map(r => r.code).sort();
    expect(codes).toEqual(['7-3', 'C1', 'C2', 'C3']);
  });
});

describe('formatBreakdown', () => {
  it('renders an empty bucket as an empty string', () => {
    expect(formatBreakdown([])).toBe('');
  });

  it('renders a single code', () => {
    expect(formatBreakdown([{ code: 'C1', count: 3 }])).toBe('3 C1');
  });

  it('joins multiple codes with a middot', () => {
    expect(formatBreakdown([
      { code: 'C2', count: 7 },
      { code: 'C1', count: 3 },
    ])).toBe('7 C2 · 3 C1');
  });
});

describe('parity with the pre-change route arithmetic', () => {
  // The route used to increment inline:
  //   burden.total_assignments++ for every row with a slot and a shift type;
  //   then, if (counts_toward_call_burden || category === 'call'):
  //     total_call++, and one of weekday/friday/weekend/holiday by day type.
  // This fixture exercises every branch of that; tallyBurden must reproduce it.
  const fixture: TallyInput[] = [
    { shift_code: 'C1', shift_category: 'call', day_type: 'weekday', counts_toward_call_burden: true },
    { shift_code: 'C1', shift_category: 'call', day_type: 'weekday', counts_toward_call_burden: true },
    { shift_code: 'C2', shift_category: 'call', day_type: 'friday', counts_toward_call_burden: true },
    { shift_code: 'C2', shift_category: 'call', day_type: 'saturday', counts_toward_call_burden: true },
    { shift_code: 'C1', shift_category: 'call', day_type: 'sunday', counts_toward_call_burden: true },
    { shift_code: 'C3', shift_category: 'call', day_type: 'major_holiday', counts_toward_call_burden: true },
    { shift_code: 'D1', shift_category: 'regular', day_type: 'weekday', counts_toward_call_burden: false },
    { shift_code: '7-3', shift_category: 'regular', day_type: 'weekday', counts_toward_call_burden: false },
  ];

  it('reproduces the hand-computed totals exactly', () => {
    const { burden } = tallyBurden(fixture);
    expect(burden).toEqual({
      total_assignments: 8,
      total_call: 6,
      weekday_call: 2,
      friday_call: 1,
      weekend_call: 2,
      holiday_call: 1,
    });
  });
});
