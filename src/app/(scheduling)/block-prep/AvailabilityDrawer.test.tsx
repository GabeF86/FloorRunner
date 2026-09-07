/**
 * Availability drawer — render smoke tests (Task 9, 2026-09-06; revised
 * 2026-09-07 after review — see the Critical/Important fixes below).
 *
 * Same strategy as components/ui/Modal.test.tsx and schedules/[id]/
 * BlockTargetsTab.test.tsx: react-dom/server renderToStaticMarkup in the node
 * environment (vitest.config.ts: environment: 'node', no jsdom, automatic JSX
 * runtime) — zero extra dependencies. Interaction (typing, clicking Add,
 * confirm()) is NOT tested here; every decision the drawer makes that could be
 * wrong (which types are addable, badge tones, ICU pairing, sell-back
 * standalone detection, date-range validation, the confirm/query-url text)
 * lives in blockPrepView.ts and is tested there — this file only pins that
 * the component actually WIRES those decisions into the markup.
 *
 * IMPORTANT — why this imports `AvailabilityDrawerBody`, not the default
 * export: the default-exported `AvailabilityDrawer` wraps everything in
 * <Modal>, and Modal (components/ui/Modal.tsx) portals to `document.body` —
 * it renders `null` outright whenever `document` is undefined, which is
 * exactly the case in this node test environment (Modal.test.tsx pins this:
 * "renders nothing (and does not crash) without a document, since it portals
 * to document.body", even with `open`). Rendering the default export here
 * would make every assertion below pass or fail against an empty string
 * regardless of the drawer's actual state — the split into a hook-free,
 * Modal-free `AvailabilityDrawerBody` is what makes these paths testable at
 * all (review confirmed this: every `not.toContain` below would have passed
 * vacuously without the split).
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AvailabilityDrawerBody, type AvailabilityDrawerRow } from './AvailabilityDrawer';
import type { AddableAvailabilityType } from '@/lib/blockPrepView';

function row(over: Partial<AvailabilityDrawerRow> = {}): AvailabilityDrawerRow {
  return {
    id: 'a1',
    availability_type: 'pto',
    start_date: '2026-08-10',
    end_date: '2026-08-14',
    approval_status: 'approved',
    reason_code: null,
    ...over,
  };
}

interface BodyProps {
  rows: AvailabilityDrawerRow[] | null;
  loadError: string | null;
  addError: string | null;
  deleteError: string | null;
  year: number;
  type: AddableAvailabilityType;
  start: string;
  end: string;
  saving: boolean;
  onTypeChange: (t: AddableAvailabilityType) => void;
  onStartChange: (v: string) => void;
  onEndChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (row: AvailabilityDrawerRow) => void;
}

function render(over: Partial<BodyProps> = {}): string {
  const props: BodyProps = {
    rows: null,
    loadError: null,
    addError: null,
    deleteError: null,
    year: 2026,
    type: 'pto',
    start: '',
    end: '',
    saving: false,
    onTypeChange: () => {},
    onStartChange: () => {},
    onEndChange: () => {},
    onAdd: () => {},
    onRemove: () => {},
    ...over,
  };
  return renderToStaticMarkup(<AvailabilityDrawerBody {...props} />);
}

describe('AvailabilityDrawerBody — loading / empty / populated', () => {
  it('shows a loading state while rows have not arrived yet (null)', () => {
    const html = render({ rows: null });
    expect(html).toContain('Loading…');
  });

  it('shows an empty state naming the year once loaded with zero rows', () => {
    const html = render({ rows: [] });
    expect(html).toContain('No dates in 2026');
    expect(html).not.toContain('Loading…');
  });

  it('names a DIFFERENT year in the empty state when the board year differs', () => {
    const html = render({ rows: [], year: 2027 });
    expect(html).toContain('No dates in 2027');
    expect(html).not.toContain('No dates in 2026');
  });

  it('lists a populated row with its type label and date range', () => {
    const html = render({
      rows: [row({ id: 'p1', availability_type: 'pto', start_date: '2026-08-10', end_date: '2026-08-14' })],
    });
    expect(html).not.toContain('No dates in');
    expect(html).not.toContain('Loading…');
    expect(html).toContain('PTO');
    expect(html).toContain('2026-08-10');
    expect(html).toContain('2026-08-14');
  });

  it('lists every row when several are present', () => {
    const html = render({
      rows: [
        row({ id: 'r1', start_date: '2026-01-05', end_date: '2026-01-09' }),
        row({ id: 'r2', availability_type: 'unavailable', start_date: '2026-03-02', end_date: '2026-03-02' }),
      ],
    });
    expect(html).toContain('2026-01-05');
    expect(html).toContain('2026-03-02');
    expect(html).toContain('Unavailable');
  });

  it('names only what this drawer can actually ADD in the empty-state hint (Fix 3)', () => {
    // An earlier edit swapped an accurate clause ("no-call requests", addable
    // at the time) for an inaccurate one ("ICU rotation dates") — ICU rows
    // specifically cannot be added from here. The hint must never claim that.
    const html = render({ rows: [] });
    expect(html).toContain('PTO, sell-back and days off');
    expect(html).not.toContain('ICU rotation dates');
  });
});

describe('AvailabilityDrawerBody — errors are shown in the RIGHT banner (Fix I3)', () => {
  it('surfaces a load error in the top banner', () => {
    const html = render({ loadError: 'Could not load dates (500)' });
    expect(html).toContain('Could not load dates (500)');
  });

  it('surfaces an add error independently of a load error', () => {
    const html = render({
      rows: [],
      loadError: null,
      addError: 'end_date must be on or after start_date',
    });
    expect(html).toContain('end_date must be on or after start_date');
  });

  it('surfaces a delete error in its OWN banner, not the load-error banner', () => {
    // Fix I3 (review 2026-09-07): a failed DELETE used to write into
    // `loadError` — the same banner explicitly documented as reserved for "the
    // list failed to load" — so a delete failure read as a load failure while
    // the list underneath rendered fine. `deleteError` is now a distinct prop
    // with its own banner.
    const html = render({
      rows: [row()],
      loadError: null,
      deleteError: 'availability entry not found',
    });
    expect(html).toContain('availability entry not found');
    // The list must still be showing — this is an action failure, not a load
    // failure, and must not be conflated with one.
    expect(html).not.toContain('No dates in');
  });

  it('can show all three error banners at once, each distinctly', () => {
    const html = render({
      rows: null,
      loadError: 'Could not load dates (500)',
      addError: 'availability_type must be one of: available, unavailable, ...',
      deleteError: 'Could not delete (500)',
    });
    expect(html).toContain('Could not load dates (500)');
    expect(html).toContain('availability_type must be one of');
    expect(html).toContain('Could not delete (500)');
  });
});

describe('AvailabilityDrawerBody — sell-back reads as a working day, not leave (Fix I4)', () => {
  it('renders a sell-back row with the danger (red) tone, never the ok tone PTO gets', () => {
    const html = render({
      rows: [row({ id: 's1', availability_type: 'pto_sellback', start_date: '2026-05-01', end_date: '2026-05-01' })],
    });
    expect(html).toContain('PTO Sell-Back');
    expect(html).toContain('var(--danger-bg)');
    expect(html).toContain('var(--danger)');
    // The ok (green) tone must NOT appear — a sell-back row must never carry
    // the same visual treatment as an actual day off.
    expect(html).not.toContain('var(--ok-bg)');
  });

  it('renders a plain PTO row with the ok (green) tone, not danger', () => {
    const html = render({ rows: [row({ id: 'pto1', availability_type: 'pto' })] });
    expect(html).toContain('var(--ok-bg)');
    expect(html).not.toContain('var(--danger-bg)');
  });

  it('carries the "IS WORKING" explanation as a title on the sell-back row, not just a colour', () => {
    const html = render({ rows: [row({ id: 's1', availability_type: 'pto_sellback' })] });
    expect(html).toContain('IS WORKING');
  });

  it('does not attach the sell-back explanation to an ordinary PTO row', () => {
    const html = render({ rows: [row({ id: 'pto1', availability_type: 'pto' })] });
    expect(html).not.toContain('IS WORKING');
  });

  it('shows the sell-back hint under the add form only when sell-back is the selected type', () => {
    expect(render({ type: 'pto_sellback' })).toContain('IS WORKING');
    expect(render({ type: 'pto' })).not.toContain('IS WORKING');
  });

  it('flags a standalone sell-back (nothing it overlaps) so a chief can see it changes nothing yet', () => {
    const sb = row({ id: 's1', availability_type: 'pto_sellback', start_date: '2026-07-04', end_date: '2026-07-04' });
    const html = render({ rows: [sb] });
    expect(html).toContain('Standalone');
  });

  it('does not flag a sell-back that overlaps a live PTO row in the same list', () => {
    const pto = row({ id: 'p1', availability_type: 'pto', start_date: '2026-07-01', end_date: '2026-07-10' });
    const sb = row({ id: 's1', availability_type: 'pto_sellback', start_date: '2026-07-04', end_date: '2026-07-04' });
    const html = render({ rows: [pto, sb] });
    expect(html).not.toContain('Standalone');
  });
});

describe('AvailabilityDrawerBody — pending is visibly live, approved is not', () => {
  it('marks a pending row with a Pending badge', () => {
    const html = render({ rows: [row({ id: 'pend1', approval_status: 'pending' })] });
    expect(html).toContain('Pending');
  });

  it('shows no status badge at all for an approved row', () => {
    const html = render({ rows: [row({ id: 'appr1', approval_status: 'approved' })] });
    expect(html).not.toContain('Pending');
    expect(html).not.toContain('Denied');
    expect(html).not.toContain('Canceled');
    expect(html).not.toContain('Waitlisted');
  });

  it('renders a pending row at full opacity but a denied row dimmed — pending is LIVE, denied is inert', () => {
    // Matched against the ROW WRAPPER's own style string specifically (not
    // just "opacity:0.55" anywhere in the markup) — the Add button also picks
    // up that same opacity value whenever it's disabled, which would give a
    // false pass/fail unrelated to the row itself.
    const rowOpacity = (html: string) => {
      const m = html.match(/border-radius:var\(--radius-sm\);opacity:([0-9.]+)"/);
      if (!m) throw new Error('row wrapper style not found in: ' + html);
      return m[1];
    };
    const pendingHtml = render({ rows: [row({ id: 'pend1', approval_status: 'pending' })] });
    const deniedHtml = render({ rows: [row({ id: 'den1', approval_status: 'denied' })] });
    expect(rowOpacity(pendingHtml)).toBe('1');
    expect(rowOpacity(deniedHtml)).toBe('0.55');
    expect(deniedHtml).toContain('Denied');
  });

  it('renders a canceled row dimmed and labeled, same as denied', () => {
    const html = render({ rows: [row({ id: 'can1', approval_status: 'canceled' })] });
    expect(html).toMatch(/border-radius:var\(--radius-sm\);opacity:0\.55"/);
    expect(html).toContain('Canceled');
  });
});

describe('AvailabilityDrawerBody — ICU pairing (Fix I5 + M10: correct lock, correct wording, correct label)', () => {
  it('offers Remove for an ordinary non-ICU row', () => {
    const html = render({ rows: [row({ id: 'ord1', reason_code: null })] });
    expect(html).toContain('Remove');
    expect(html).not.toContain('ICU-paired');
  });

  it('locks BOTH halves of a genuinely intact pair, with DIFFERENT wording per half', () => {
    // 2026-06-08..12 is Mon-Fri; icuMondayAfter lands on 2026-06-15.
    const week = row({
      id: 'week1', availability_type: 'blocked', reason_code: 'icu_week',
      start_date: '2026-06-08', end_date: '2026-06-12',
    });
    const monday = row({
      id: 'mon1', availability_type: 'blocked', reason_code: 'icu_post_call',
      start_date: '2026-06-15', end_date: '2026-06-15',
    });
    const html = render({ rows: [week, monday] });
    // Both halves locked: no Remove offered for either.
    expect(html).not.toContain('>Remove<');
    const icuPairedCount = (html.match(/ICU-paired/g) ?? []).length;
    expect(icuPairedCount).toBe(2);
    // The bug this fixes: ONE fixed string used to say "paired with a
    // post-call Monday" on BOTH rows — backwards on the Monday row itself.
    expect(html).toContain('Paired with the post-call Monday after it');
    expect(html).toContain('post-call rest day after an ICU week');
  });

  it('does NOT lock a week row whose Monday was never created — nothing to orphan', () => {
    // No matching Monday anywhere in `rows` (e.g. an existing blocked row
    // already covered that date, so icuRotation.ts never created one).
    const week = row({
      id: 'week1', availability_type: 'blocked', reason_code: 'icu_week',
      start_date: '2026-06-08', end_date: '2026-06-12',
    });
    const html = render({ rows: [week] });
    expect(html).toContain('>Remove<');
    expect(html).not.toContain('ICU-paired');
  });

  it('does NOT lock an orphaned post-call Monday whose week no longer exists — matches the profile\'s own orphan handling', () => {
    const orphanMonday = row({
      id: 'mon1', availability_type: 'blocked', reason_code: 'icu_post_call',
      start_date: '2026-06-15', end_date: '2026-06-15',
    });
    const html = render({ rows: [orphanMonday] });
    expect(html).toContain('>Remove<');
    expect(html).not.toContain('ICU-paired');
  });

  it('labels ICU rows by their reason code, not the generic "Blocked" type (Fix M10)', () => {
    const week = row({
      id: 'week1', availability_type: 'blocked', reason_code: 'icu_week',
      start_date: '2026-06-08', end_date: '2026-06-12',
    });
    const monday = row({
      id: 'mon1', availability_type: 'blocked', reason_code: 'icu_post_call',
      start_date: '2026-06-15', end_date: '2026-06-15',
    });
    const html = render({ rows: [week, monday] });
    expect(html).toContain('ICU Week');
    expect(html).toContain('ICU Post-Call');
  });

  it('does not attach an ICU reason-code badge to a row with no reason code', () => {
    const html = render({ rows: [row({ id: 'ord1', reason_code: null })] });
    expect(html).not.toContain('ICU Week');
    expect(html).not.toContain('ICU Post-Call');
  });

  // ── Fix 1 (CRITICAL, review 2026-09-07) ───────────────────────────────────
  // The first version of the year-scoped fix trusted "partner absent from
  // THIS render's `rows`" as "partner does not exist" — wrong, because `rows`
  // is a year-scoped fetch. These exercise the fix end-to-end through the
  // component (not just the lib function) at the exact boundary named in
  // review: a week starting 2026-12-22 whose post-call Monday lands in
  // January.
  it('keeps a December week LOCKED on the 2026 board even though its Monday is not in this year\'s rows', () => {
    const decWeek = row({
      id: 'week-dec', availability_type: 'blocked', reason_code: 'icu_week',
      start_date: '2026-12-22', end_date: '2026-12-28',
    });
    // Only the week is present — exactly what the 2026-scoped GET returns;
    // the January Monday is out of window, not fetched.
    const html = render({ year: 2026, rows: [decWeek] });
    expect(html).toContain('ICU-paired');
    expect(html).not.toContain('>Remove<');
  });

  it('keeps a January Monday LOCKED on the 2027 board even though its week is not in this year\'s rows', () => {
    const janMonday = row({
      id: 'mon-jan', availability_type: 'blocked', reason_code: 'icu_post_call',
      start_date: '2027-01-04', end_date: '2027-01-04',
    });
    // Only the Monday is present — exactly what the 2027-scoped GET returns;
    // its December week is out of window, not fetched.
    const html = render({ year: 2027, rows: [janMonday] });
    expect(html).toContain('ICU-paired');
    expect(html).not.toContain('>Remove<');
  });

  it('still unlocks a genuinely orphaned row far from any year boundary', () => {
    // Sanity check that the boundary fix didn't overcorrect into "always
    // locked" — this is the same mid-year case as the earlier orphan test,
    // re-asserted after the hoisted icuPairsFor/liveBlockingRows wiring.
    const midYearWeek = row({
      id: 'week-mid', availability_type: 'blocked', reason_code: 'icu_week',
      start_date: '2026-06-08', end_date: '2026-06-12',
    });
    const html = render({ year: 2026, rows: [midYearWeek] });
    expect(html).toContain('>Remove<');
    expect(html).not.toContain('ICU-paired');
  });
});

describe('AvailabilityDrawerBody — add-form validation and addable types', () => {
  it('offers exactly the three types this surface can create correctly', () => {
    const html = render();
    expect(html).toContain('PTO Sell-Back');
    expect(html).toContain('Unavailable');
    // Fix C1 (Critical, review 2026-09-07): no_call_request used to be
    // offered here. The profile creates it through a DIFFERENT route
    // (/api/requests/submit/{token}) that tags rows for the per-window cap
    // accounting; a row added through this generic form would be a fully
    // live no-call lever that counts as ZERO against that cap. Must never
    // appear as an option again.
    expect(html).not.toContain('No-Call Request');
    expect(html).not.toContain('>Call Request<');
    // Also excluded, unrelated to the Critical fix: HR-sensitive / ICU-paired
    // types must never appear as options a chief could pick from here.
    expect(html).not.toContain('FMLA');
    expect(html).not.toContain('Military Leave');
    expect(html).not.toContain('>Blocked<');
  });

  it('flags an end date before the start date and disables Add, without waiting for the server', () => {
    const html = render({ start: '2026-08-14', end: '2026-08-10' });
    expect(html).toContain('End date must be on or after the start date.');
    expect(html).toContain('disabled');
  });

  it('does not show the range warning when the range is valid or incomplete', () => {
    expect(render({ start: '2026-08-10', end: '2026-08-14' }))
      .not.toContain('End date must be on or after the start date.');
    expect(render({ start: '2026-08-10', end: '' }))
      .not.toContain('End date must be on or after the start date.');
  });

  it('disables Add and reads "Adding…" while a save is in flight', () => {
    const html = render({ start: '2026-08-10', end: '2026-08-14', saving: true });
    expect(html).toContain('Adding…');
    expect(html).toContain('disabled');
  });

  it('carries the board\'s year bounds on the inputs that still need one (Fix I2)', () => {
    // Which input carries which bound is pinned precisely by the
    // "drops min on start / max on end" test below; this just confirms both
    // surviving bounds are present somewhere.
    const html = render({ year: 2026 });
    expect(html).toContain('min="2026-01-01"');
    expect(html).toContain('max="2026-12-31"');
  });

  it('carries a DIFFERENT year\'s bounds when the board year differs', () => {
    const html = render({ year: 2027 });
    expect(html).toContain('min="2027-01-01"');
    expect(html).toContain('max="2027-12-31"');
    expect(html).not.toContain('2026-01-01');
  });

  // ── Fix 2 (Important, review 2026-09-07) ──────────────────────────────────
  // min/max alone do not clamp a date input's value and this form has no
  // <form> for native constraint validation to run against, so a range with
  // NO overlap with the board year at all must be caught by the SAME
  // rangeError path that already disables Add for a backwards range — not
  // just decorated with an attribute a typed/pasted date can ignore.
  //
  // OVERLAP, NOT CONTAINMENT (second-pass fix): a range spanning INTO the
  // neighboring year (the single most common PTO shape in a hospital
  // calendar — a holiday block crossing New Year) must be ACCEPTED, not
  // rejected — the fetch would show it fine on this board.
  it('accepts a range spanning into the NEXT year — the fetch would show it fine on this board', () => {
    const html = render({ start: '2026-12-28', end: '2027-01-05' });
    expect(html).not.toContain('Dates must overlap');
    expect(html).not.toContain('disabled');
  });

  it('accepts a range spanning in from the PREVIOUS year — the fetch would show it fine on this board', () => {
    const html = render({ start: '2025-12-29', end: '2026-01-02' });
    expect(html).not.toContain('Dates must overlap');
    expect(html).not.toContain('disabled');
  });

  it('rejects a range with no overlap with the board year at all, and disables Add', () => {
    const html = render({ start: '2027-06-01', end: '2027-06-05' });
    expect(html).toContain('Dates must overlap 2026 to appear on this board.');
    expect(html).toContain('disabled');
  });

  it('does not flag a range that is valid and fully inside the board year', () => {
    const html = render({ start: '2026-01-01', end: '2026-12-31' });
    expect(html).not.toContain('Dates must overlap');
    expect(html).not.toContain('disabled');
  });

  it('drops min on the start input and max on the end input, so the spanning case above is even enterable', () => {
    // Fix 2 (second pass): the picker's native min/max must not contradict
    // what dateRangeError now accepts. Start keeps a `max` (a start after the
    // year ends can never overlap it); end keeps a `min` (an end before the
    // year begins can never overlap it) — but start has no `min` and end has
    // no `max`.
    const html = render();
    expect(html).toContain('aria-label="Start date" type="date" max="2026-12-31"');
    expect(html).toContain('aria-label="End date" type="date" min="2026-01-01"');
  });
});

describe('AvailabilityDrawerBody — accessibility (Fix M8)', () => {
  it('labels the type select and both date inputs so they read as distinct fields', () => {
    const html = render();
    expect(html).toContain('aria-label="Availability type"');
    expect(html).toContain('aria-label="Start date"');
    expect(html).toContain('aria-label="End date"');
  });
});
