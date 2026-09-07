import { describe, it, expect } from 'vitest';
import {
  sortRosterRows, allotmentText, remainingText, offDaysText,
  coveredSpanLabel, unrosteredFootnote, parseFteInput, parseAllotmentInput,
  ADDABLE_AVAILABILITY_TYPES, icuPairsFor, icuRowLockInfo, availabilityTypeTone,
  availabilityStatusBadge, rosterFooterNote, WORK_DAYS_FTE_PLACEHOLDER,
  liveBlockingRows, sellbackStandaloneNote, availabilityTypeHint, dateRangeError,
  yearBounds, availabilityQueryUrl, removalConfirmMessage, blockPrepYearOptions,
  siteBootstrapText,
  type RosterRow, type AvailabilityLikeRow, type AddableAvailabilityType,
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

  // Fix 4 (round 7 review, minor): the module's own header rule — "AN
  // OVERDRAWN BALANCE IS SHOWN, NOT CLAMPED... reads '5 over'" — used to be
  // implemented in remainingText (PTO) alone. An off-days overdraw silently
  // read as a bare "14 of 12 used" with nothing flagging it, while the
  // adjacent PTO column for the same overdraw read "25 of 20 used · 5 over".
  it('shows an overdrawn off-day balance the same way the PTO column shows one — "· N over", not clamped', () => {
    expect(offDaysText({ kind: 'days', days: 12 }, 14)).toBe('14 of 12 used · 2 over');
  });
  it('does not add an "over" tail when used is exactly at budget', () => {
    expect(offDaysText({ kind: 'days', days: 12 }, 12)).toBe('12 of 12 used');
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
      .toBe('The off-day budget is for the full year; days used are counted only across the published block: '
        + 'Aug 10 – Oct 25, 2026 (55 working days).');
  });
  it('says plainly that nothing is published', () => {
    expect(coveredSpanLabel(null))
      .toBe('The off-day budget is for the full year — no published block exists yet, so nothing has been '
        + 'examined and no days are counted as used.');
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
      'The off-day budget is for the full year; days used are counted only across 2 published blocks, '
      + 'with gaps between them: Jan 5 – Dec 20, 2026 (130 working days counted).');
  });
  it('distinguishes a block with no working days from nothing published', () => {
    const label = coveredSpanLabel(span({
      start: '2026-01-01', end: '2026-01-01', workingDays: 0,
      segments: [{ start: '2026-01-01', end: '2026-01-01' }],
    }));
    expect(label).toContain('no working days');
    expect(label).not.toBe(coveredSpanLabel(null));
  });

  // Fix 1 (round 7 review, IMPORTANT): every branch must say BOTH that the
  // budget is annual AND that the used figure is span-scoped — naming just
  // the span (the pre-fix wording) is the root confusion this caveat exists
  // to close. At Paoli today (one published 2026 block, ~54 of ~255 working
  // days) a 0.7 FTE's "10 of 76 used" reads as "66 off days left this year"
  // without this sentence saying the 76 and the 10 are measured over
  // different periods.
  it('states the annual/span time-scale mismatch in every branch, not just the span', () => {
    expect(coveredSpanLabel(span())).toContain('full year');
    expect(coveredSpanLabel(null)).toContain('full year');
    expect(coveredSpanLabel(span({ workingDays: 0, segments: [{ start: '2026-01-01', end: '2026-01-01' }] })))
      .toContain('full year');
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

describe('rosterFooterNote (Fix M1 regression: what the tally actually says)', () => {
  it('does not claim the tally prints an em dash — nothing in AnnualTallyCard calls allotmentText', () => {
    const note = rosterFooterNote();
    expect(note).not.toContain('shows — in the tally');
  });

  it('names the tally\'s actual wording, "allotment not stated" — the same phrase remainingText prints', () => {
    // Pinned against the LIVE output of remainingText for an unstated
    // allotment, not a second copy of the phrase, so the two can't drift
    // apart the way the original footer text did.
    const tallyWording = remainingText({ usedWeekdays: 2, soldWeekdays: 0, allotmentDays: null, remainingDays: null });
    expect(tallyWording).toContain('allotment not stated');
    expect(rosterFooterNote()).toContain('allotment not stated');
  });

  it('names the roster\'s own blank placeholder via allotmentText(null), not a hardcoded em dash', () => {
    expect(rosterFooterNote()).toContain(allotmentText(null));
  });

  it('still states the two blank-vs-zero conventions the columns rely on', () => {
    const note = rosterFooterNote();
    expect(note).toContain('same as call FTE');
    expect(note).toContain('genuinely none');
  });
});

describe('WORK_DAYS_FTE_PLACEHOLDER', () => {
  it('is the literal string a blank working-days FTE cell shows', () => {
    expect(WORK_DAYS_FTE_PLACEHOLDER).toBe('same');
  });
});

describe('ADDABLE_AVAILABILITY_TYPES', () => {
  it('offers exactly the three types this surface can create correctly', () => {
    expect([...ADDABLE_AVAILABILITY_TYPES].sort()).toEqual(
      ['pto', 'pto_sellback', 'unavailable'].sort());
  });

  // Fix C1 (Critical, review 2026-09-07): no_call_request used to be offered
  // here. The profile never creates it through THIS API — it POSTs to
  // /api/requests/submit/{token}, tags the row with windowNotesTag(id), and
  // that tag is what countWindowRequestRows/windowRequestDates count against
  // max_no_call_requests. A range row added here would carry no tag, so it
  // counts as ZERO against the cap while still being a fully live no-call
  // lever to solve.ts/slotCandidates.ts — pinned here so it can never
  // silently come back.
  it('excludes paired ICU rows, HR-sensitive/as-they-occur types, and both gated request types', () => {
    const addable = ADDABLE_AVAILABILITY_TYPES as readonly string[];
    for (const excluded of [
      'blocked', 'fmla', 'military_leave', 'sick', 'jury_duty',
      'conference', 'admin', 'cme', 'call_request', 'no_call_request', 'available',
    ]) {
      expect(addable).not.toContain(excluded);
    }
  });
});

describe('AddableAvailabilityType', () => {
  // Fix 5 (Minor, review 2026-09-07): mostly a compile-time guarantee — a
  // select whose value matches no rendered ADDABLE_AVAILABILITY_TYPES option
  // is now unrepresentable. The runtime check below is a weak echo of that
  // (every member must be assignable to the narrowed type); the real
  // enforcement is `npx tsc --noEmit` rejecting a stray fourth type.
  it('every ADDABLE_AVAILABILITY_TYPES member is assignable to the narrowed type', () => {
    const sample: AddableAvailabilityType[] = [...ADDABLE_AVAILABILITY_TYPES];
    expect(sample).toEqual(['pto', 'pto_sellback', 'unavailable']);
  });
});

function availRow(over: Partial<AvailabilityLikeRow> = {}): AvailabilityLikeRow {
  return {
    id: 'r1',
    availability_type: 'blocked',
    approval_status: 'approved',
    reason_code: null,
    start_date: '2026-06-08',
    end_date: '2026-06-12',
    ...over,
  };
}

/** icuRowLockInfo is called on the HOISTED pairing result, matching how the
 *  component actually calls it (icuPairsFor once per render, then per row) —
 *  never on the raw row list directly. */
function lockInfoFor(allRows: AvailabilityLikeRow[], row: AvailabilityLikeRow, year: number) {
  return icuRowLockInfo(icuPairsFor(allRows), row, year);
}

describe('icuRowLockInfo', () => {
  it('locks an ICU week row whose post-call Monday exists in the same row set', () => {
    const week = availRow({ id: 'week1', reason_code: 'icu_week', start_date: '2026-06-08', end_date: '2026-06-12' });
    const monday = availRow({ id: 'mon1', reason_code: 'icu_post_call', start_date: '2026-06-15', end_date: '2026-06-15' });
    const info = lockInfoFor([week, monday], week, 2026);
    expect(info.locked).toBe(true);
    expect(info.note).toContain('post-call Monday');
  });

  it('locks the post-call Monday itself, with wording that does not call IT the thing paired with a Monday', () => {
    const week = availRow({ id: 'week1', reason_code: 'icu_week', start_date: '2026-06-08', end_date: '2026-06-12' });
    const monday = availRow({ id: 'mon1', reason_code: 'icu_post_call', start_date: '2026-06-15', end_date: '2026-06-15' });
    const info = lockInfoFor([week, monday], monday, 2026);
    expect(info.locked).toBe(true);
    // The bug this fixes: the OLD single fixed string said "paired with a
    // post-call Monday" on BOTH rows — backwards on the Monday row itself,
    // since IT is the post-call day, not something paired with one.
    expect(info.note).not.toContain('post-call Monday after it');
    expect(info.note).toContain('post-call rest day');
  });

  it('does not lock a week row whose Monday was never created, WITHIN the fetch window (nothing to orphan)', () => {
    // Week 2026-06-08..12 (Mon-Fri) -> expected Monday 2026-06-15, well
    // inside the 2026 window, so its absence from the fetch is provable.
    const week = availRow({ id: 'week1', reason_code: 'icu_week', start_date: '2026-06-08', end_date: '2026-06-12' });
    expect(lockInfoFor([week], week, 2026)).toEqual({ locked: false, note: null });
  });

  it('does not lock an orphaned post-call Monday whose week no longer exists, WITHIN the fetch window', () => {
    // Every candidate week-end date (the 7 days before 2026-06-15) is well
    // inside the 2026 window, so genuine absence is provable.
    const orphan = availRow({ id: 'orphan1', reason_code: 'icu_post_call', start_date: '2026-06-15', end_date: '2026-06-15' });
    expect(lockInfoFor([orphan], orphan, 2026)).toEqual({ locked: false, note: null });
  });

  it('never locks a non-ICU row, even one that happens to be type blocked', () => {
    const plain = availRow({ id: 'b1', reason_code: null });
    expect(lockInfoFor([plain], plain, 2026)).toEqual({ locked: false, note: null });
  });

  it('never locks an ordinary PTO/sell-back/unavailable row', () => {
    for (const type of ['pto', 'pto_sellback', 'unavailable']) {
      const r = availRow({ id: 'x', availability_type: type, reason_code: null });
      expect(lockInfoFor([r], r, 2026).locked).toBe(false);
    }
  });

  it('does not promise the profile section is visible — it names how to make it visible', () => {
    const week = availRow({ id: 'week1', reason_code: 'icu_week', start_date: '2026-06-08', end_date: '2026-06-12' });
    const monday = availRow({ id: 'mon1', reason_code: 'icu_post_call', start_date: '2026-06-15', end_date: '2026-06-15' });
    const info = lockInfoFor([week, monday], week, 2026);
    expect(info.note).toContain('ICU-doc flag');
  });

  // ── Year-boundary regression (CRITICAL, review 2026-09-07) ────────────────
  // A prior version of this fix trusted "partner absent from the fetch" as
  // "partner does not exist" — wrong under year-scoping. These pin the
  // boundary-safe behaviour on BOTH sides so the regression can't silently
  // come back.
  describe('year boundary — a pair split across Dec 31 / Jan 1 stays locked on both sides', () => {
    // Dates verified against the real icuMondayAfter arithmetic (dow(2026-12-28)
    // = Monday, delta=7 for "strictly after" -> 2027-01-04). This is the exact
    // review example: a week starting 2026-12-22 whose post-call Monday lands
    // in January.
    const week = availRow({
      id: 'week-dec', reason_code: 'icu_week', start_date: '2026-12-22', end_date: '2026-12-28',
    });
    const monday = availRow({
      id: 'mon-jan', reason_code: 'icu_post_call', start_date: '2027-01-04', end_date: '2027-01-04',
    });

    it('keeps the December week LOCKED when viewed from the 2026 board — the Monday is out of window, not absent', () => {
      // Only the week is in the 2026-scoped fetch; the Monday (Jan 2027) is
      // NOT — exactly what the real GET would return.
      const info = lockInfoFor([week], week, 2026);
      expect(info.locked).toBe(true);
      expect(info.note).toContain('post-call Monday');
    });

    it('keeps the January Monday LOCKED when viewed from the 2027 board — its week is out of window, not absent', () => {
      // Only the Monday is in the 2027-scoped fetch; the week (Dec 2026) is
      // NOT — exactly what the real GET would return.
      const info = lockInfoFor([monday], monday, 2027);
      expect(info.locked).toBe(true);
      expect(info.note).toContain('post-call rest day');
    });

    it('sanity check: the SAME pair unlocks correctly when both halves ARE in one fetch', () => {
      // Guards against the boundary fix overcorrecting into "always locked".
      const infoWeek = lockInfoFor([week, monday], week, 2026);
      expect(infoWeek.locked).toBe(true); // genuinely paired, correctly locked
      const soloWeek = availRow({ id: 'w2', reason_code: 'icu_week', start_date: '2026-06-08', end_date: '2026-06-12' });
      expect(lockInfoFor([soloWeek], soloWeek, 2026).locked).toBe(false); // genuinely alone, correctly unlocked
    });
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

/** sellbackStandaloneNote is called on the HOISTED live-blocking list, matching
 *  how the component actually calls it (liveBlockingRows once per render,
 *  then per row) — never on the raw row list directly. */
function standaloneNoteFor(allRows: AvailabilityLikeRow[], row: AvailabilityLikeRow) {
  return sellbackStandaloneNote(liveBlockingRows(allRows), row);
}

describe('liveBlockingRows', () => {
  it('keeps only live (non-dismissed) BLOCKING_AVAIL rows', () => {
    const pto = availRow({ id: 'p1', availability_type: 'pto' });
    const deniedPto = availRow({ id: 'p2', availability_type: 'pto', approval_status: 'denied' });
    const sellback = availRow({ id: 's1', availability_type: 'pto_sellback' }); // not in BLOCKING_AVAIL
    expect(liveBlockingRows([pto, deniedPto, sellback]).map(r => r.id)).toEqual(['p1']);
  });
});

describe('sellbackStandaloneNote', () => {
  it('returns null for anything that is not a sell-back row', () => {
    const pto = availRow({ id: 'p1', availability_type: 'pto' });
    expect(standaloneNoteFor([pto], pto)).toBeNull();
  });

  it('flags a sell-back row that overlaps nothing as standalone/inert', () => {
    const sb = availRow({
      id: 's1', availability_type: 'pto_sellback', start_date: '2026-07-04', end_date: '2026-07-04',
    });
    expect(standaloneNoteFor([sb], sb)).toContain('Standalone');
  });

  it('does not flag a sell-back row that overlaps a live PTO row', () => {
    const pto = availRow({
      id: 'p1', availability_type: 'pto', start_date: '2026-07-01', end_date: '2026-07-10',
    });
    const sb = availRow({
      id: 's1', availability_type: 'pto_sellback', start_date: '2026-07-04', end_date: '2026-07-04',
    });
    expect(standaloneNoteFor([pto, sb], sb)).toBeNull();
  });

  it('ignores a DENIED PTO row when deciding overlap — a dismissed row blocks nothing', () => {
    const deniedPto = availRow({
      id: 'p1', availability_type: 'pto', approval_status: 'denied',
      start_date: '2026-07-01', end_date: '2026-07-10',
    });
    const sb = availRow({
      id: 's1', availability_type: 'pto_sellback', start_date: '2026-07-04', end_date: '2026-07-04',
    });
    expect(standaloneNoteFor([deniedPto, sb], sb)).toContain('Standalone');
  });

  it('honors the bookend-extended blocking range — a sell-back on the bookend Saturday is not standalone', () => {
    // A Monday-start PTO run bookends over the PRECEDING Saturday/Sunday
    // (effectivePtoRange, rulesEngine/shared.ts) — pinned in shared.test.ts.
    // Monday 2026-07-06 start; the extended range reaches back to Saturday
    // 2026-07-04.
    const pto = availRow({
      id: 'p1', availability_type: 'pto', start_date: '2026-07-06', end_date: '2026-07-10',
    });
    const sb = availRow({
      id: 's1', availability_type: 'pto_sellback', start_date: '2026-07-04', end_date: '2026-07-04',
    });
    expect(standaloneNoteFor([pto, sb], sb)).toBeNull();
  });
});

describe('availabilityTypeHint', () => {
  it('explains that a sell-back date is a working day, not leave', () => {
    expect(availabilityTypeHint('pto_sellback')).toContain('IS WORKING');
  });

  it('returns null for every other type — no elaboration needed', () => {
    expect(availabilityTypeHint('pto')).toBeNull();
    expect(availabilityTypeHint('unavailable')).toBeNull();
  });
});

describe('dateRangeError', () => {
  it('is null while the range is incomplete', () => {
    expect(dateRangeError('', '', 2026)).toBeNull();
    expect(dateRangeError('2026-08-10', '', 2026)).toBeNull();
    expect(dateRangeError('', '2026-08-10', 2026)).toBeNull();
  });

  it('flags an end date before the start date', () => {
    expect(dateRangeError('2026-08-14', '2026-08-10', 2026)).toBe('End date must be on or after the start date.');
  });

  it('is null for a valid range, including a single-day range', () => {
    expect(dateRangeError('2026-08-10', '2026-08-14', 2026)).toBeNull();
    expect(dateRangeError('2026-08-10', '2026-08-10', 2026)).toBeNull();
  });

  // ── Fix 2 (Important, review 2026-09-07) ──────────────────────────────────
  // min/max on a date input do NOT clamp the value (they only set
  // rangeUnderflow/rangeOverflow), and this form has no <form> for native
  // constraint validation to run against — so the year bound has to be a
  // real, enforced check here, not just an input attribute.
  //
  // OVERLAP, NOT CONTAINMENT (second-pass fix, review 2026-09-07): the first
  // version of this check required BOTH endpoints inside the year — strictly
  // narrower than the OVERLAP fetch that actually decides visibility
  // (end_date >= from AND start_date <= to). That rejected a Dec 28 – Jan 5
  // holiday PTO block from BOTH the 2026 AND the 2027 board — the single
  // most common PTO shape in a hospital calendar, with no board left that
  // could enter it. These three cases are the exact ones review named.
  it('accepts a range that starts in-year and ends in the NEXT year — the fetch shows it fine on this board', () => {
    // 2026-12-28 -> 2027-01-05: visible on the 2026 board (end_date 2027-01-05
    // >= from 2026-01-01; start_date 2026-12-28 <= to 2026-12-31).
    expect(dateRangeError('2026-12-28', '2027-01-05', 2026)).toBeNull();
  });

  it('accepts a range that starts in the PREVIOUS year and ends in-year — the fetch shows it fine on this board', () => {
    // 2025-12-29 -> 2026-01-02: visible on the 2026 board (end_date
    // 2026-01-02 >= from 2026-01-01; start_date 2025-12-29 <= to 2026-12-31).
    expect(dateRangeError('2025-12-29', '2026-01-02', 2026)).toBeNull();
  });

  it('rejects a range that does not overlap the board year AT ALL', () => {
    // 2027-06-01 -> 2027-06-05 viewed from the 2026 board: genuinely
    // invisible on this board — start_date 2027-06-01 > to 2026-12-31, so
    // the range starts after the year has already ended.
    expect(dateRangeError('2027-06-01', '2027-06-05', 2026))
      .toBe('Dates must overlap 2026 to appear on this board.');
  });

  it('rejects a range entirely BEFORE the board year too', () => {
    expect(dateRangeError('2025-01-01', '2025-06-01', 2026))
      .toBe('Dates must overlap 2026 to appear on this board.');
  });

  it('is null for a range flush against both year edges', () => {
    expect(dateRangeError('2026-01-01', '2026-12-31', 2026)).toBeNull();
  });

  it('is null for the same valid range under its own year, not a neighboring one', () => {
    expect(dateRangeError('2027-06-01', '2027-06-05', 2027)).toBeNull();
  });

  it('is null for a range spanning the ENTIRE board year and beyond on both sides', () => {
    expect(dateRangeError('2025-06-01', '2027-06-01', 2026)).toBeNull();
  });
});

describe('yearBounds / availabilityQueryUrl', () => {
  it('spans Jan 1 to Dec 31 of the given year', () => {
    expect(yearBounds(2026)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });

  it('builds the GET url with provider_id and the year bounds as from/to', () => {
    expect(availabilityQueryUrl('prov-1', 2026)).toBe(
      '/api/scheduling/availability?provider_id=prov-1&from=2026-01-01&to=2026-12-31');
  });

  it('encodes a provider id that needs escaping', () => {
    expect(availabilityQueryUrl('a b', 2026)).toContain('provider_id=a%20b');
  });
});

describe('removalConfirmMessage', () => {
  it('names the provider, the type, and the range', () => {
    const msg = removalConfirmMessage({
      providerName: 'A.Jones', typeLabel: 'PTO', startDate: '2026-08-10', endDate: '2026-08-14',
    });
    expect(msg).toContain('A.Jones');
    expect(msg).toContain('PTO');
    expect(msg).toContain('2026-08-10 → 2026-08-14');
    expect(msg).toContain('cannot be undone');
  });

  it('collapses a single-day range to one date rather than "X → X"', () => {
    const msg = removalConfirmMessage({
      providerName: 'A.Jones', typeLabel: 'PTO Sell-Back', startDate: '2026-08-10', endDate: '2026-08-10',
    });
    expect(msg).toContain('2026-08-10');
    expect(msg).not.toContain('→');
  });
});

describe('blockPrepYearOptions', () => {
  it('offers last year, this year, and next year, in that order', () => {
    expect(blockPrepYearOptions(2026)).toEqual([2025, 2026, 2027]);
  });
});

describe('siteBootstrapText (Fix 2, round 7 review)', () => {
  // Four distinguishable facts — a real ordering test matters here as much
  // as the individual strings: `error` must win over everything else (a
  // failed fetch is never a confirmed anything), and `noOrg` must win over
  // `sitesLoaded` (an empty org list means the sites fetch never even ran).
  it('an error wins over every other state', () => {
    expect(siteBootstrapText({ error: 'boom', noOrg: true, sitesLoaded: true })).toBe('Could not load sites');
  });
  it('no organization at all is named, not conflated with "hasn\'t looked yet"', () => {
    expect(siteBootstrapText({ error: null, noOrg: true, sitesLoaded: false })).toBe('No organization configured');
  });
  it('a genuinely confirmed empty list reads "No sites"', () => {
    expect(siteBootstrapText({ error: null, noOrg: false, sitesLoaded: true })).toBe('No sites');
  });
  it('the default, pre-fetch state reads "Loading sites…", never a confirmed empty state', () => {
    expect(siteBootstrapText({ error: null, noOrg: false, sitesLoaded: false })).toBe('Loading sites…');
  });
});
