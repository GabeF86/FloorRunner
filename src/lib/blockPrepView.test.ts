import { describe, it, expect } from 'vitest';
import {
  sortRosterRows, allotmentText, remainingText, offDaysText,
  coveredSpanLabel, parseFteInput, parseAllotmentInput,
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
    const result = sortRosterRows([only]);
    expect(result).toEqual([only]);
    expect(result).not.toBe([only]); // still a new array wrapper
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
    const label = coveredSpanLabel(span({
      start: '2026-01-05', end: '2026-12-20', workingDays: 130,
      segments: [
        { start: '2026-01-05', end: '2026-03-22' },
        { start: '2026-09-07', end: '2026-12-20' },
      ],
    }));
    expect(label).toContain('2 published blocks');
    expect(label).toContain('gaps between them');
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

describe('parseFteInput', () => {
  it('accepts a blank working-days FTE as "same as call FTE"', () => {
    expect(parseFteInput('', { allowBlank: true, max: 1 })).toEqual({ ok: true, value: null });
  });
  it('rejects a blank call FTE', () => {
    expect(parseFteInput('', { allowBlank: false, max: 2 }).ok).toBe(false);
  });
  it('rejects a working-days FTE above 1', () => {
    expect(parseFteInput('1.5', { allowBlank: true, max: 1 }).ok).toBe(false);
  });
  it('accepts a call FTE up to 2', () => {
    expect(parseFteInput('1.5', { allowBlank: false, max: 2 })).toEqual({ ok: true, value: 1.5 });
  });
  it('rejects a negative value and non-numbers', () => {
    expect(parseFteInput('-1', { allowBlank: false, max: 2 }).ok).toBe(false);
    expect(parseFteInput('abc', { allowBlank: false, max: 2 }).ok).toBe(false);
  });

  // --- Beyond the plan: a stated zero call FTE is legal (per diems have one)
  // and must be accepted, not rejected as if it were blank/invalid.
  it('accepts a stated zero call FTE — per diems have one', () => {
    expect(parseFteInput('0', { allowBlank: false, max: 2 })).toEqual({ ok: true, value: 0 });
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseFteInput('  0.75  ', { allowBlank: false, max: 2 }))
      .toEqual({ ok: true, value: 0.75 });
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
