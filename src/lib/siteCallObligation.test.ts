import { describe, it, expect } from 'vitest';
import {
  computeSiteCallObligation,
  bucketFor,
  datesInYear,
  perFteShare,
  formatShare,
  OBLIGATION_BUCKETS,
  type ObligationTemplate,
} from './siteCallObligation';

const NO_HOLIDAYS = new Map<string, { is_major_holiday: boolean; holiday_type: string }>();

function tmpl(over: Partial<ObligationTemplate> = {}): ObligationTemplate {
  return {
    code: 'C1',
    day_type: 'weekday',
    shift_type_id: 'st-c1',
    required_count: 1,
    ...over,
  } as ObligationTemplate;
}

/** Paoli's real call slate, as stored (note: NO active friday row). */
const PAOLI: ObligationTemplate[] = [
  tmpl({ code: 'C1', day_type: 'weekday', shift_type_id: 'c1' }),
  tmpl({ code: 'C2', day_type: 'weekday', shift_type_id: 'c2' }),
  tmpl({ code: 'C1', day_type: 'saturday', shift_type_id: 'c1' }),
  tmpl({ code: 'C2', day_type: 'saturday', shift_type_id: 'c2' }),
  tmpl({ code: 'C3', day_type: 'saturday', shift_type_id: 'c3' }),
  tmpl({ code: 'C1', day_type: 'sunday', shift_type_id: 'c1' }),
  tmpl({ code: 'C2', day_type: 'sunday', shift_type_id: 'c2' }),
  tmpl({ code: 'C3', day_type: 'sunday', shift_type_id: 'c3' }),
];

describe('datesInYear', () => {
  it('covers a common year', () => {
    expect(datesInYear(2026)).toHaveLength(365);
  });
  it('covers a leap year', () => {
    expect(datesInYear(2028)).toHaveLength(366);
  });
  it('starts on Jan 1 and ends on Dec 31', () => {
    const d = datesInYear(2026);
    expect(d[0]).toBe('2026-01-01');
    expect(d[d.length - 1]).toBe('2026-12-31');
  });
});

describe('bucketFor', () => {
  it('keeps Saturday and Sunday as separate rows', () => {
    expect(bucketFor('weekday', '2026-09-15')).toBe('weekday');   // Tue
    expect(bucketFor('friday', '2026-09-18')).toBe('friday');
    expect(bucketFor('saturday', '2026-09-19')).toBe('saturday');
    expect(bucketFor('sunday', '2026-09-20')).toBe('sunday');
  });

  it('charges a holiday to the weekday it actually falls on', () => {
    // Christmas 2026 is a Friday — it belongs in Friday's row, not a weekend one.
    expect(bucketFor('major_holiday', '2026-12-25')).toBe('friday');
    expect(bucketFor('federal_holiday', '2026-12-29')).toBe('weekday'); // a Tuesday
    expect(bucketFor('major_holiday', '2026-12-27')).toBe('sunday');
  });
});

/** Helper: the per-FTE figure for one code on one kind of day. */
function cell(r: ReturnType<typeof computeSiteCallObligation>, bucket: string, code: string) {
  return r.groups.find(g => g.bucket === bucket)?.rows.find(x => x.code === code);
}

describe('computeSiteCallObligation — the Friday contract', () => {
  it('materializes weekday call onto Fridays even with no friday template', () => {
    // THE bug this module exists to avoid. Paoli stores no active friday call
    // row, yet its live schedule holds Friday C1 and C2 — slateForDayType
    // fills Fridays from the weekday slate. A naive template read reports 0.
    const r = computeSiteCallObligation({
      year: 2026, parLevel: 11, templates: PAOLI, holidays: NO_HOLIDAYS,
    });
    expect(cell(r, 'friday', 'C1')!.slots).toBe(52); // 2026 has 52 Fridays
  });

  it('lets a friday-specific row override that shift type only', () => {
    const withFri: ObligationTemplate[] = [
      ...PAOLI,
      tmpl({ code: 'C1', day_type: 'friday', shift_type_id: 'c1', required_count: 2 }),
    ];
    const r = computeSiteCallObligation({
      year: 2026, parLevel: 11, templates: withFri, holidays: NO_HOLIDAYS,
    });
    expect(cell(r, 'friday', 'C1')!.slots).toBe(104); // 52 × 2
    // C2 has no friday row, so it still fills from weekday.
    expect(cell(r, 'friday', 'C2')!.slots).toBe(52);
  });

  it('lets a count-0 friday row suppress that shift type on Fridays', () => {
    const suppressed: ObligationTemplate[] = [
      ...PAOLI,
      tmpl({ code: 'C1', day_type: 'friday', shift_type_id: 'c1', required_count: 0 }),
    ];
    const r = computeSiteCallObligation({
      year: 2026, parLevel: 11, templates: suppressed, holidays: NO_HOLIDAYS,
    });
    expect(cell(r, 'friday', 'C1')).toBeUndefined(); // suppressed entirely
    expect(cell(r, 'weekday', 'C1')!.slots).toBeGreaterThan(0);
  });
});

describe('computeSiteCallObligation — counts', () => {
  const r = computeSiteCallObligation({
    year: 2026, parLevel: 11, templates: PAOLI, holidays: NO_HOLIDAYS,
  });

  it('counts M–Th as four weekdays a week', () => {
    // 2026: 365 days, 52 Fridays, 52 Saturdays, 52 Sundays → 209 M–Th.
    expect(cell(r, 'weekday', 'C1')!.slots).toBe(209);
  });

  it('lists Saturday and Sunday separately', () => {
    expect(cell(r, 'saturday', 'C1')!.slots).toBe(52);
    expect(cell(r, 'sunday', 'C1')!.slots).toBe(52);
  });

  it('describes the Paoli slate Gabriel named', () => {
    // "M-Th C1, C2; Friday C1, C2; Saturday C1, C2, C3; same with Sunday."
    expect(r.groups.map(g => g.bucket)).toEqual(['weekday', 'friday', 'saturday', 'sunday']);
    expect(r.groups.find(g => g.bucket === 'weekday')!.rows.map(x => x.code)).toEqual(['C1', 'C2']);
    expect(r.groups.find(g => g.bucket === 'friday')!.rows.map(x => x.code)).toEqual(['C1', 'C2']);
    expect(r.groups.find(g => g.bucket === 'saturday')!.rows.map(x => x.code)).toEqual(['C1', 'C2', 'C3']);
    expect(r.groups.find(g => g.bucket === 'sunday')!.rows.map(x => x.code)).toEqual(['C1', 'C2', 'C3']);
  });

  it('gives a 1.0 FTE the par-divided share of each call type', () => {
    // Par 11. M–Th C1 = 209 slots → 19 each. Saturday C3 = 52 → 4.7.
    expect(cell(r, 'weekday', 'C1')!.perFte).toBeCloseTo(19, 6);
    expect(cell(r, 'saturday', 'C3')!.perFte).toBeCloseTo(52 / 11, 6);
  });

  it('agrees with the stated 16-calls-per-block obligation', () => {
    // 834 call slots a year ÷ par 11 = 75.8 for a 1.0 FTE; over an 11-week
    // block that is 16.0 — exactly the top obligation band (patch46).
    expect(r.totalSlots).toBe(834);
    expect(r.totalPerFte * (11 / 52)).toBeCloseTo(16, 1);
  });

  it('adds up: group totals and the grand total are the sums of their rows', () => {
    for (const g of r.groups) {
      expect(g.slots, g.bucket).toBe(g.rows.reduce((a, x) => a + x.slots, 0));
    }
    expect(r.totalSlots).toBe(r.groups.reduce((a, g) => a + g.slots, 0));
  });

  it('orders codes by name, not by frequency', () => {
    // Stable across sites; a table that reorders itself is harder to read.
    for (const g of r.groups) {
      const codes = g.rows.map(x => x.code);
      expect([...codes].sort()).toEqual(codes);
    }
  });

  it('omits a day type that carries no call at all', () => {
    const weekendOnly = computeSiteCallObligation({
      year: 2026, parLevel: 11, holidays: NO_HOLIDAYS,
      templates: [tmpl({ code: 'C3', day_type: 'saturday', shift_type_id: 'c3' })],
    });
    expect(weekendOnly.groups.map(g => g.bucket)).toEqual(['saturday']);
  });
});

describe('computeSiteCallObligation — holidays', () => {
  it('does not double-count a holiday, it re-buckets it', () => {
    const holidays = new Map([
      // Christmas 2026 falls on a Friday.
      ['2026-12-25', { is_major_holiday: true, holiday_type: 'federal' }],
    ]);
    const withHol: ObligationTemplate[] = [
      ...PAOLI,
      tmpl({ code: 'C1', day_type: 'major_holiday', shift_type_id: 'c1' }),
    ];
    const plain = computeSiteCallObligation({
      year: 2026, parLevel: 11, templates: withHol, holidays: NO_HOLIDAYS,
    });
    const holiday = computeSiteCallObligation({
      year: 2026, parLevel: 11, templates: withHol, holidays,
    });
    // That Friday now materializes the major_holiday slate instead of the
    // weekday-filled one — the day is counted once either way.
    const totalC1 = (x: typeof plain) =>
      x.groups.reduce((a, g) => a + (g.rows.find(r2 => r2.code === 'C1')?.slots ?? 0), 0);
    expect(totalC1(holiday)).toBe(totalC1(plain));
  });
});

describe('computeSiteCallObligation — a site with no slate', () => {
  it('reports noSlate rather than a table of zeros', () => {
    // Six of eight sites are in exactly this state. "0 calls a year" would be
    // a claim; "not configured" is the truth.
    const r = computeSiteCallObligation({
      year: 2026, parLevel: 12, templates: [], holidays: NO_HOLIDAYS,
    });
    expect(r.noSlate).toBe(true);
    expect(r.groups).toEqual([]);
    expect(r.totalSlots).toBe(0);
    expect(r.totalPerFte).toBe(0);
  });
});

describe('split segments fold into their parent code', () => {
  it('charges C2N12 to C2', () => {
    const split: ObligationTemplate[] = [
      tmpl({ code: 'C2', day_type: 'weekday', shift_type_id: 'c2' }),
      tmpl({ code: 'C2N12', day_type: 'saturday', shift_type_id: 'c2n12', parent_call_code: 'C2' }),
    ];
    const r = computeSiteCallObligation({
      year: 2026, parLevel: 11, templates: split, holidays: NO_HOLIDAYS,
    });
    expect(cell(r, 'saturday', 'C2')!.slots).toBe(52);
    expect(cell(r, 'saturday', 'C2N12')).toBeUndefined();
  });
});

describe('perFteShare — par is the denominator', () => {
  it('divides the site total by par', () => {
    expect(perFteShare(209, 11)).toBeCloseTo(19, 6);
  });

  it('returns 0 for a nonsensical par rather than Infinity', () => {
    expect(perFteShare(100, 0)).toBe(0);
    expect(perFteShare(100, -3)).toBe(0);
    expect(perFteShare(100, NaN)).toBe(0);
  });

  it('stays fractional — rounding belongs at the whole-provider level', () => {
    // fteTarget.roundedObligation rounds the SUM across buckets; rounding each
    // bucket here and summing would disagree with it.
    expect(perFteShare(10, 3)).toBeCloseTo(3.3333, 3);
  });
});

describe('formatShare', () => {
  it('drops a trailing .0', () => {
    expect(formatShare(19)).toBe('19');
    expect(formatShare(19.04)).toBe('19');
  });
  it('keeps one decimal otherwise', () => {
    expect(formatShare(19.36)).toBe('19.4');
  });
  it('renders a non-number as a dash', () => {
    expect(formatShare(NaN)).toBe('—');
  });
});
