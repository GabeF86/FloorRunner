/**
 * Availability drawer — render smoke tests (Task 9, 2026-09-06).
 *
 * Same strategy as components/ui/Modal.test.tsx and schedules/[id]/
 * BlockTargetsTab.test.tsx: react-dom/server renderToStaticMarkup in the node
 * environment (vitest.config.ts: environment: 'node', no jsdom, automatic JSX
 * runtime) — zero extra dependencies. Interaction (typing, clicking Add,
 * confirm()) is NOT tested here; every decision the drawer makes that could be
 * wrong (which types are addable, the type/status badge tones) lives in
 * blockPrepView.ts and is tested there.
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
 * all.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AvailabilityDrawerBody, type AvailabilityDrawerRow } from './AvailabilityDrawer';
import type { AvailabilityType } from '@/lib/validation/providers';

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
  year: number;
  type: AvailabilityType;
  start: string;
  end: string;
  saving: boolean;
  onTypeChange: (t: AvailabilityType) => void;
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
});

describe('AvailabilityDrawerBody — errors', () => {
  it('surfaces a load error in a banner', () => {
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

  it('can show both a load error and an add error at once, distinctly', () => {
    const html = render({
      rows: null,
      loadError: 'Could not load dates (500)',
      addError: 'availability_type must be one of: available, unavailable, ...',
    });
    expect(html).toContain('Could not load dates (500)');
    expect(html).toContain('availability_type must be one of');
  });
});

describe('AvailabilityDrawerBody — sell-back reads as a working day, not leave', () => {
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

describe('AvailabilityDrawerBody — ICU-paired rows cannot be deleted from here', () => {
  it('offers Remove for an ordinary row', () => {
    const html = render({ rows: [row({ id: 'ord1', reason_code: null })] });
    expect(html).toContain('Remove');
    expect(html).not.toContain('ICU-paired');
  });

  it('replaces Remove with an ICU-paired note for an icu_week row', () => {
    const html = render({
      rows: [row({ id: 'icu1', availability_type: 'blocked', reason_code: 'icu_week' })],
    });
    expect(html).toContain('ICU-paired');
    expect(html).not.toContain('>Remove<');
  });

  it('replaces Remove with an ICU-paired note for the post-call Monday half too', () => {
    const html = render({
      rows: [row({ id: 'icu2', availability_type: 'blocked', reason_code: 'icu_post_call' })],
    });
    expect(html).toContain('ICU-paired');
    expect(html).not.toContain('>Remove<');
  });
});

describe('AvailabilityDrawerBody — add-form validation and addable types', () => {
  it('offers only the four planning-relevant types in the type picker', () => {
    const html = render();
    expect(html).toContain('PTO Sell-Back');
    expect(html).toContain('Unavailable');
    expect(html).toContain('No-Call Request');
    // Excluded: HR-sensitive / gated / ICU-paired types must never appear as
    // options a chief could pick from this drawer.
    expect(html).not.toContain('FMLA');
    expect(html).not.toContain('Military Leave');
    expect(html).not.toContain('Blocked');
    // Checked as ">Call Request<" (an option whose label is exactly "Call
    // Request") rather than the bare substring "Call Request" — the offered
    // "No-Call Request" option legitimately CONTAINS that substring, so a
    // naive `not.toContain('Call Request')` would false-fail on the very
    // option this drawer is supposed to offer.
    expect(html).not.toContain('>Call Request<');
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
});
