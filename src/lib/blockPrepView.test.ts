import { describe, it, expect } from 'vitest';
import {
  sortRosterRows, allotmentText, remainingText, offDaysText,
  coveredSpanLabel, unrosteredFootnote, parseFteInput, parseAllotmentInput,
  ADDABLE_AVAILABILITY_TYPES, isPairedIcuRow, availabilityTypeTone,
  availabilityStatusBadge,
  type RosterRow,
} from './blockPrepView';
// CoveredSpanInfo is annualTally's exported span shape — used below by
// coveredSpanLabel's tests. Missing from the plan's listing; added here
// per the Task 5 gap note (it comes from annualTally, not blockPrepView).
import type { CoveredSpanInfo } from './annualTally';

const row = (over: Partial<RosterRow> = {}): RosterRow => ({
  provider_id: 'p1',
  display_name: 'A.Jones',
  last_name: 'Jones',
  fte_value: 1,
  work_days_fte: null,
  pto_weeks: 4,
  call_taker: true,
  partial_call_taker: false,
  pto: { usedWeekdays: 0, soldWeekdays: 0, allotmentDays: 20, remainingDays: 20 },
  offDayBudget: { kind: 'none' },
  offDaysUsed: null,
  callCounts: [],
  callTotal: 0,
  ...over,
});

describe('sortRosterRows', () => {
  it('orders by FTE descending, then last name', () => {
    const rows = [
      row({ provider_id: 'a', last_name: 'Zeta', fte_value: 0.5 }),
      row({ provider_id: 'b', last_name: 'Beta', fte_value: 1 }),
      row({ provider_id: 'c', last_name: 'Alpha', fte_value: 1 }),
    ];
    expect(sortRosterRows(rows).map(r => r.provider_id)).toEqual(['c', 'b', 'a']);
  });

  it('puts a null FTE last rather than first', () => {
    const rows = [
      row({ provider_id: 'a', last_name: 'Alpha', fte_value: null }),
      row({ provider_id: 'b', last_name: 'Beta', fte_value: 0.5 }),
    ];
    expect(sortRosterRows(rows).map(r => r.provider_id)).toEqual(['b', 'a']);
  });

  // --- Beyond the plan: mutation and edge-size checks a reviewer will look for.

  it('does not mutate its input array', () => {
    const rows = [
      row({ provider_id: 'a', last_name: 'Zeta', fte_value: 0.5 }),
      row({ provider_id: 'b', last_name: 'Beta', fte_value: 1 }),
    ];
    const originalOrder = rows.map(r => r.provider_id);
    const result = sortRosterRows(rows);
    expect(rows.map(r => r.provider_id)).toEqual(originalOrder); // input untouched
    expect(result).not.toBe(rows); // a genuinely new array, not the same reference
  });

  it('returns an empty array for an empty input', () => {
    expect(sortRosterRows([])).toEqual([]);
  });

  it('returns a single row unchanged', () => {
    const only = row({ provider_id: 'solo' });
    const input = [only];
    const result = sortRosterRows(input);
    expect(result).toEqual([only]);
    expect(result).not.toBe(input); // still a new array wrapper, not the same reference
  });

  // --- Fix C: blank-vs-zero is this module's entire thesis, so the one sort
  // case that actually distinguishes a stated 0 from an unstated FTE is worth
  // pinning directly, not just inferred from the null-vs-0.5 case above.
  it('sorts a null (unstated) FTE after a stated zero — blank is not the same as zero', () => {
    const rows = [
      row({ provider_id: 'a', last_name: 'Alpha', fte_value: null }),
      row({ provider_id: 'b', last_name: 'Beta', fte_value: 0 }),
    ];
    expect(sortRosterRows(rows).map(r => r.provider_id)).toEqual(['b', 'a']);
  });
});

describe('allotmentText', () => {
  it('renders an em-dash when the allotment is unstated', () => {
    expect(allotmentText(null)).toBe('—');
  });
  it('renders a stated zero as 0, never as unstated', () => {
    expect(allotmentText(0)).toBe('0');
  });
  it('renders weeks as typed', () => {
    expect(allotmentText(7)).toBe('7');
  });
});

describe('remainingText', () => {
  it('says "not stated" rather than showing a number', () => {
    expect(remainingText({ usedWeekdays: 5, soldWeekdays: 0, allotmentDays: null, remainingDays: null }))
      .toBe('5 used · allotment not stated');
  });
  it('shows used and remaining when stated', () => {
    expect(remainingText({ usedWeekdays: 5, soldWeekdays: 0, allotmentDays: 20, remainingDays: 15 }))
      .toBe('5 of 20 used · 15 left');
  });
  it('notes sold-back days inline', () => {
    expect(remainingText({ usedWeekdays: 5, soldWeekdays: 2, allotmentDays: 20, remainingDays: 15 }))
      .toBe('5 of 20 used (incl. 2 sold back) · 15 left');
  });
  it('does not hide an overdrawn balance', () => {
    expect(remainingText({ usedWeekdays: 25, soldWeekdays: 0, allotmentDays: 20, remainingDays: -5 }))
      .toBe('25 of 20 used · 5 over');
  });

  // --- Beyond the plan: the real per-diem case — allotment stated as a real
  // zero (not unstated) and nothing used against it. Must not read as the
  // "not stated" branch (which only fires when allotmentDays/remainingDays
  // are null) and must not print anything nonsensical like "0 of 0 left".
  it('reads sensibly for a per-diem with a stated zero allotment and nothing used', () => {
    expect(remainingText({ usedWeekdays: 0, soldWeekdays: 0, allotmentDays: 0, remainingDays: 0 }))
      .toBe('0 of 0 used · 0 left');
  });
});

describe('offDaysText', () => {
  it('shows the budget alone when nothing is built', () => {
    expect(offDaysText({ kind: 'days', days: 62 }, null)).toBe('62 budgeted');
  });
  it('shows used against budget when blocks exist', () => {
    expect(offDaysText({ kind: 'days', days: 62 }, 20)).toBe('20 of 62 used');
  });
  it('shows a full-timer as having none — they owe every working day', () => {
    expect(offDaysText({ kind: 'none' }, null)).toBe('none');
  });
  it('shows a per diem as n/a — NOT the same as a full-timer having none', () => {
    expect(offDaysText({ kind: 'not-applicable' }, null)).toBe('n/a');
    // The two must never collapse into one string: they are opposite facts.
    expect(offDaysText({ kind: 'not-applicable' }, null))
      .not.toBe(offDaysText({ kind: 'none' }, null));
  });
  it('says the FTE is not stated rather than inventing a budget', () => {
    expect(offDaysText({ kind: 'unknown' }, null)).toBe('FTE not stated');
  });

  // --- Beyond the plan: `used === 0` is a real, counted zero here (a provider
  // who took none of their budgeted off days across a real published span),
  // NOT the "nothing was counted" case — annualTally.ts now returns
  // `offDaysUsed: null` (not 0) precisely when nothing was counted, so a
  // literal 0 reaching this function is trustworthy. "0 of 62 used" is
  // therefore the correct, honest rendering — pinned here on purpose.
  it('renders a genuine zero used as "0 of N used", distinct from nothing counted', () => {
    expect(offDaysText({ kind: 'days', days: 62 }, 0)).toBe('0 of 62 used');
    expect(offDaysText({ kind: 'days', days: 62 }, 0))
      .not.toBe(offDaysText({ kind: 'days', days: 62 }, null));
  });
});

describe('coveredSpanLabel', () => {
  const span = (over: Partial<CoveredSpanInfo> = {}): CoveredSpanInfo => ({
    start: '2026-08-10', end: '2026-10-25', workingDays: 55,
    segments: [{ start: '2026-08-10', end: '2026-10-25' }],
    ...over,
  });

  it('names the span the off-day figure was counted over', () => {
    expect(coveredSpanLabel(span()))
      .toBe('Off days counted across published blocks only: Aug 10 – Oct 25, 2026 (55 working days).');
  });
  it('says plainly that nothing is published', () => {
    expect(coveredSpanLabel(null))
      .toBe('No published blocks this year — off days show the budget only, with nothing counted against it.');
  });
  it('does not present a GAPPED range as continuous coverage', () => {
    // Two blocks at either end of the year with a five-month hole between
    // them. The bare range reads as near-total coverage; the label must not.
    // Pinned with toBe (not just toContain) — the trailing "(N working days
    // counted)" wording is the one place this branch differs from the
    // single-segment branch's "(N working days)", and a toContain pair could
    // let that difference get edited away silently.
    const label = coveredSpanLabel(span({
      start: '2026-01-05', end: '2026-12-20', workingDays: 130,
      segments: [
        { start: '2026-01-05', end: '2026-03-22' },
        { start: '2026-09-07', end: '2026-12-20' },
      ],
    }));
    expect(label).toBe(
      'Off days counted across 2 published blocks only, with gaps between them: '
      + 'Jan 5 – Dec 20, 2026 (130 working days counted).');
  });
  it('distinguishes a block with no working days from nothing published', () => {
    const label = coveredSpanLabel(span({
      start: '2026-01-01', end: '2026-01-01', workingDays: 0,
      segments: [{ start: '2026-01-01', end: '2026-01-01' }],
    }));
    expect(label).toContain('no working days');
    expect(label).not.toBe(coveredSpanLabel(null));
  });
});

describe('unrosteredFootnote', () => {
  // Fix 3 (AnnualTallyCard review, 2026-09-06): this sentence used to be
  // assembled inline in JSX with three pluralization branches — moved here so
  // it is testable and so the card only ever renders a string, never builds one.

  it('renders nothing when the roster read failed (null)', () => {
    expect(unrosteredFootnote(null)).toBeNull();
  });

  it('renders nothing when nobody was excluded ([])', () => {
    expect(unrosteredFootnote([])).toBeNull();
  });

  it('singularizes for exactly one provider', () => {
    expect(unrosteredFootnote(['p1'])).toBe(
      '1 provider holds published call at this site but is not on the roster above — '
      + 'inactive, based at another site, or not marked a call taker. Those calls are not shown in '
      + 'any row.');
  });

  it('pluralizes for two or more providers', () => {
    expect(unrosteredFootnote(['p1', 'p2'])).toBe(
      '2 providers hold published call at this site but are not on the roster above — '
      + 'inactive, based at another site, or not marked a call taker. Those calls are not shown in '
      + 'any row.');
  });
});

describe('parseFteInput', () => {
  // Fix A: bounds and blank policy are now selected by a `kind` tag
  // ('call' | 'workDays') rather than a hand-passed { allowBlank, max } bag,
  // so a caller cannot pair the wrong bound with the wrong blank policy. The
  // numbers themselves come from validation/providers.ts's FTE_MIN/FTE_MAX
  // and WORK_DAYS_FTE_MIN/WORK_DAYS_FTE_MAX (0..2 and 0..1 respectively,
  // matching the DB CHECK, the API validator and the profile editor).
  it('accepts a blank working-days FTE as "same as call FTE"', () => {
    expect(parseFteInput('', 'workDays')).toEqual({ ok: true, value: null });
  });
  it('rejects a blank call FTE', () => {
    expect(parseFteInput('', 'call').ok).toBe(false);
  });
  it('rejects a working-days FTE above 1', () => {
    expect(parseFteInput('1.5', 'workDays').ok).toBe(false);
  });
  it('accepts a call FTE up to 2', () => {
    expect(parseFteInput('1.5', 'call')).toEqual({ ok: true, value: 1.5 });
  });
  it('rejects a negative value and non-numbers', () => {
    expect(parseFteInput('-1', 'call').ok).toBe(false);
    expect(parseFteInput('abc', 'call').ok).toBe(false);
  });

  // --- Beyond the plan: a stated zero call FTE is legal (per diems have one)
  // and must be accepted, not rejected as if it were blank/invalid.
  it('accepts a stated zero call FTE — per diems have one', () => {
    expect(parseFteInput('0', 'call')).toEqual({ ok: true, value: 0 });
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseFteInput('  0.75  ', 'call')).toEqual({ ok: true, value: 0.75 });
  });
});

describe('parseAllotmentInput', () => {
  it('maps blank to null — not stated', () => {
    expect(parseAllotmentInput('')).toEqual({ ok: true, value: null });
  });
  it('keeps a typed zero as a real zero', () => {
    expect(parseAllotmentInput('0')).toEqual({ ok: true, value: 0 });
  });
  it('rejects fractions and negatives', () => {
    expect(parseAllotmentInput('2.5').ok).toBe(false);
    expect(parseAllotmentInput('-1').ok).toBe(false);
  });

  // --- Beyond the plan: whitespace handling and a non-numeric rejection.
  it('trims surrounding whitespace before parsing', () => {
    expect(parseAllotmentInput('  3  ')).toEqual({ ok: true, value: 3 });
  });
  it('rejects a non-numeric string', () => {
    expect(parseAllotmentInput('abc').ok).toBe(false);
  });
});

describe('ADDABLE_AVAILABILITY_TYPES', () => {
  it('offers exactly the four planning-relevant types', () => {
    expect([...ADDABLE_AVAILABILITY_TYPES].sort()).toEqual(
      ['no_call_request', 'pto', 'pto_sellback', 'unavailable'].sort());
  });

  it('excludes paired ICU rows, HR-sensitive/as-they-occur types, and gated request types', () => {
    const addable = ADDABLE_AVAILABILITY_TYPES as readonly string[];
    for (const excluded of [
      'blocked', 'fmla', 'military_leave', 'sick', 'jury_duty',
      'conference', 'admin', 'cme', 'call_request', 'available',
    ]) {
      expect(addable).not.toContain(excluded);
    }
  });
});

describe('isPairedIcuRow', () => {
  it('flags both halves of an ICU pair', () => {
    expect(isPairedIcuRow('icu_week')).toBe(true);
    expect(isPairedIcuRow('icu_post_call')).toBe(true);
  });

  it('does not flag a plain reason code, null, or undefined', () => {
    expect(isPairedIcuRow('something_else')).toBe(false);
    expect(isPairedIcuRow(null)).toBe(false);
    expect(isPairedIcuRow(undefined)).toBe(false);
  });
});

describe('availabilityTypeTone', () => {
  it('renders sell-back in danger red — it is a working day, not leave', () => {
    expect(availabilityTypeTone('pto_sellback')).toBe('danger');
    // The whole point: it must never collapse onto PTO's tone, or a
    // sold-back date reads as the provider being off when they're working.
    expect(availabilityTypeTone('pto_sellback')).not.toBe(availabilityTypeTone('pto'));
  });

  it('renders PTO as ok and a no-call request as warn', () => {
    expect(availabilityTypeTone('pto')).toBe('ok');
    expect(availabilityTypeTone('no_call_request')).toBe('warn');
  });

  it('falls back to neutral for anything else, including unavailable', () => {
    expect(availabilityTypeTone('unavailable')).toBe('neutral');
    expect(availabilityTypeTone('some_future_type')).toBe('neutral');
  });
});

describe('availabilityStatusBadge', () => {
  it('shows no badge for approved — the unremarkable default', () => {
    expect(availabilityStatusBadge('approved')).toBeNull();
  });

  it('marks pending as LIVE with a warn badge, never as inert', () => {
    // Clinical invariant 2: pending blocks scheduling exactly like approved.
    expect(availabilityStatusBadge('pending')).toEqual({ tone: 'warn', label: 'Pending' });
  });

  it('marks denied and canceled neutral — the only statuses the engine ignores', () => {
    expect(availabilityStatusBadge('denied')).toEqual({ tone: 'neutral', label: 'Denied' });
    expect(availabilityStatusBadge('canceled')).toEqual({ tone: 'neutral', label: 'Canceled' });
  });

  it('never gives denied/canceled the same tone as pending', () => {
    expect(availabilityStatusBadge('denied')!.tone).not.toBe(availabilityStatusBadge('pending')!.tone);
    expect(availabilityStatusBadge('canceled')!.tone).not.toBe(availabilityStatusBadge('pending')!.tone);
  });

  it('falls back to a neutral badge with the raw string for an unknown status', () => {
    expect(availabilityStatusBadge('weird')).toEqual({ tone: 'neutral', label: 'weird' });
  });
});
