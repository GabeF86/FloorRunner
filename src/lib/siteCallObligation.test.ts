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
  it('maps the three display buckets', () => {
    expect(bucketFor('weekday', '2026-09-15')).toBe('weekday');   // Tue
    expect(bucketFor('friday', '2026-09-18')).toBe('friday');
    expect(bucketFor('saturday', '2026-09-19')).toBe('weekend');
    expect(bucketFor('sunday', '2026-09-20')).toBe('weekend');
  });

  it('charges a holiday to the weekday it actually falls on', () => {
    // Christmas 2026 is a Friday — it belongs in the Fri column, not weekend.
    expect(bucketFor('major_holiday', '2026-12-25')).toBe('friday');
    // A Tuesday federal holiday is M–Th.
    expect(bucketFor('federal_holiday', '2026-12-29')).toBe('weekday');
    // A holiday on a Sunday stays weekend.
    expect(bucketFor('major_holiday', '2026-12-27')).toBe('weekend');
  });
});

describe('computeSiteCallObligation — the Friday contract', () => {
  it('materializes weekday call onto Fridays even with no friday template', () => {
    // THE bug this module exists to avoid. Paoli stores no active friday call
    // row, yet its live schedule holds Friday C1 and C2 — slateForDayType
    // fills Fridays from the weekday slate. A naive template read reports 0.
    const r = computeSiteCallObligation({
      year: 2026, parLevel: 11, templates: PAOLI, holidays: NO_HOLIDAYS,
    });
    const c1 = r.codes.find(c => c.code === 'C1')!;
    expect(c1.byBucket.friday).toBeGreaterThan(0);
    expect(c1.byBucket.friday).toBe(52); // 2026 has 52 Fridays
  });

  it('lets a friday-specific row override that shift type only', () => {
    const withFri: ObligationTemplate[] = [
      ...PAOLI,
      tmpl({ code: 'C1', day_type: 'friday', shift_type_id: 'c1', required_count: 2 }),
    ];
    const r = computeSiteCallObligation({
      year: 2026, parLevel: 11, templates: withFri, holidays: NO_HOLIDAYS,
    });
    expect(r.codes.find(c => c.code === 'C1')!.byBucket.friday).toBe(104); // 52 × 2
    // C2 has no friday row, so it still fills from weekday.
    expect(r.codes.find(c => c.code === 'C2')!.byBucket.friday).toBe(52);
  });

  it('lets a count-0 friday row suppress that shift type on Fridays', () => {
    const suppressed: ObligationTemplate[] = [
      ...PAOLI,
      tmpl({ code: 'C1', day_type: 'friday', shift_type_id: 'c1', required_count: 0 }),
    ];
    const r = computeSiteCallObligation({
      year: 2026, parLevel: 11, templates: suppressed, holidays: NO_HOLIDAYS,
    });
    expect(r.codes.find(c => c.code === 'C1')!.byBucket.friday).toBe(0);
    expect(r.codes.find(c => c.code === 'C1')!.byBucket.weekday).toBeGreaterThan(0);
  });
});

describe('computeSiteCallObligation — counts', () => {
  const r = computeSiteCallObligation({
    year: 2026, parLevel: 11, templates: PAOLI, holidays: NO_HOLIDAYS,
  });

  it('counts M–Th as four weekdays a week', () => {
    // 2026: 365 days, 52 Fridays, 52 Saturdays, 52 Sundays → 209 M–Th.
    expect(r.codes.find(c => c.code === 'C1')!.byBucket.weekday).toBe(209);
  });

  it('counts Sat and Sun together in the weekend column', () => {
    expect(r.codes.find(c => c.code === 'C1')!.byBucket.weekend).toBe(104);
  });

  it('gives C3 weekend-only coverage, since it has no weekday template', () => {
    const c3 = r.codes.find(c => c.code === 'C3')!;
    expect(c3.byBucket.weekday).toBe(0);
    expect(c3.byBucket.friday).toBe(0);
    expect(c3.byBucket.weekend).toBe(104);
  });

  it('adds up: bucket totals equal the sum of the code rows', () => {
    for (const b of OBLIGATION_BUCKETS) {
      const summed = r.codes.reduce((acc, c) => acc + c.byBucket[b], 0);
      expect(r.bucketTotals[b], b).toBe(summed);
    }
    expect(r.grandTotal).toBe(r.codes.reduce((a, c) => a + c.total, 0));
  });

  it('orders codes commonest first', () => {
    const totals = r.codes.map(c => c.total);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
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
    expect(holiday.codes.find(c => c.code === 'C1')!.total)
      .toBe(plain.codes.find(c => c.code === 'C1')!.total);
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
    expect(r.codes).toEqual([]);
    expect(r.grandTotal).toBe(0);
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
    expect(r.codes.map(c => c.code)).toEqual(['C2']);
    expect(r.codes[0].byBucket.weekend).toBe(52);
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
