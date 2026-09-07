/**
 * AnnualTallyCard render-path tests (node environment, zero new deps).
 *
 * Strategy per Modal.test.tsx (ui-v1 plan, "components ARE render-testable" —
 * corrected premise, 2026-09-06): interaction can't be tested without jsdom,
 * but render OUTPUT can, via react-dom/server's renderToStaticMarkup.
 * useEffect never fires under SSR, which is exactly what makes this useful
 * here: it freezes the card at its FIRST paint, before any fetch resolves —
 * so both the self-fetch path (no `data` prop; the effect that would call
 * `load()` never runs) and the pre-fetched path (`data` passed straight in)
 * render their real, static output with no async plumbing to fake.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AnnualTallyCard from './AnnualTallyCard';
import type { RosterRow } from '@/lib/blockPrepView';
import type { BlockPrepData, PublishedBlock } from '@/app/api/scheduling/block-prep/route.helpers';

// Provider column + 4 fairness-bucket columns (always all four, never
// filtered — see the component's Fix 2 note) + Calls + PTO + Off days.
const HEADER_COUNT = 8;

function rosterRow(over: Partial<RosterRow> = {}): RosterRow {
  return {
    provider_id: 'p1',
    display_name: 'A. Jones',
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
  };
}

function block(over: Partial<PublishedBlock> = {}): PublishedBlock {
  return {
    schedule_id: 'b1',
    schedule_name: 'Block A',
    date_start: '2026-08-10',
    date_end: '2026-10-25',
    ...over,
  };
}

// Matches the (site, year) every test renders the card for, unless a test
// deliberately mismatches it (the Fix 5 staleness test).
function blockPrepData(over: Partial<BlockPrepData> = {}): BlockPrepData {
  return {
    site_id: 'site-1',
    year: 2026,
    roster: { data: [], error: null },
    blocks: { data: [], error: null },
    coveredSpan: null,
    unrosteredProviderIds: [],
    ...over,
  };
}

describe('AnnualTallyCard — loading (Fix 2 regression: both mount modes)', () => {
  it('self-fetch mode (no `data` prop) renders a skeleton before the effect ever runs, never the empty state', () => {
    // No `data` prop => self-fetch. useEffect (which would call load() and
    // eventually setFetched) never fires under renderToStaticMarkup, so this
    // is exactly the pre-effect first paint that used to flash "No call
    // takers at this site" under the plan's `loading && !rows` gate.
    const html = renderToStaticMarkup(<AnnualTallyCard siteId="site-1" year={2026} />);
    const skeletons = html.match(/fr-skeleton/g) ?? [];
    expect(skeletons.length).toBe(3 * HEADER_COUNT);
    expect(html).not.toContain('No call takers at this site');
  });

  it('pre-fetched mode with data={null} (host still loading) renders a skeleton, never the empty state', () => {
    const html = renderToStaticMarkup(<AnnualTallyCard siteId="site-1" year={2026} data={null} />);
    const skeletons = html.match(/fr-skeleton/g) ?? [];
    expect(skeletons.length).toBe(3 * HEADER_COUNT);
    expect(html).not.toContain('No call takers at this site');
  });
});

describe('AnnualTallyCard — empty roster', () => {
  it('renders the empty state once loaded with zero call takers', () => {
    const html = renderToStaticMarkup(
      <AnnualTallyCard siteId="site-1" year={2026} data={blockPrepData()} />,
    );
    expect(html).toContain('No call takers at this site');
    // Not a loading skeleton — the roster genuinely loaded empty.
    expect(html.match(/fr-skeleton/g) ?? []).toHaveLength(0);
  });
});

describe('AnnualTallyCard — roster.error and blocks.error are separate panels', () => {
  it('a roster error still renders a healthy, independent blocks list', () => {
    const html = renderToStaticMarkup(
      <AnnualTallyCard
        siteId="site-1"
        year={2026}
        data={blockPrepData({
          roster: { data: null, error: 'Roster boom' },
          blocks: { data: [block({ schedule_name: 'Block A' })], error: null },
        })}
      />,
    );
    expect(html).toContain('Roster boom');
    expect(html).toContain('Block A');
  });

  it('Fix 1 regression: a blocks failure that cascaded from the roster read renders exactly ONE banner', () => {
    // route.helpers.ts's fail(blocks.error, blocks) stamps roster.error with
    // the IDENTICAL string as blocks.error when a failed blocks read is what
    // took the roster down with it. Decoupling the two panels naively (Fix 3
    // of the original implementation) rendered this message twice, stacked.
    const html = renderToStaticMarkup(
      <AnnualTallyCard
        siteId="site-1"
        year={2026}
        data={blockPrepData({
          roster: { data: null, error: 'Published blocks could not be loaded: timeout' },
          blocks: { data: null, error: 'Published blocks could not be loaded: timeout' },
        })}
      />,
    );
    const occurrences = html.match(/Published blocks could not be loaded: timeout/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('an independent blocks failure (different message) still gets its own banner', () => {
    const html = renderToStaticMarkup(
      <AnnualTallyCard
        siteId="site-1"
        year={2026}
        data={blockPrepData({
          roster: { data: [], error: null },
          blocks: { data: null, error: 'Published blocks could not be loaded: separate failure' },
        })}
      />,
    );
    expect(html).toContain('Published blocks could not be loaded: separate failure');
  });
});

describe('AnnualTallyCard — the unrostered footnote', () => {
  it('renders no footnote when unrosteredProviderIds is null', () => {
    const html = renderToStaticMarkup(
      <AnnualTallyCard
        siteId="site-1"
        year={2026}
        data={blockPrepData({ roster: { data: [], error: null }, unrosteredProviderIds: null })}
      />,
    );
    expect(html).not.toContain('role="note"');
    expect(html).not.toContain('not on the roster above');
  });

  it('renders no footnote when unrosteredProviderIds is [] (nobody excluded)', () => {
    const html = renderToStaticMarkup(
      <AnnualTallyCard
        siteId="site-1"
        year={2026}
        data={blockPrepData({ roster: { data: [], error: null }, unrosteredProviderIds: [] })}
      />,
    );
    expect(html).not.toContain('role="note"');
    expect(html).not.toContain('not on the roster above');
  });

  it('renders the footnote when unrosteredProviderIds is non-empty', () => {
    const html = renderToStaticMarkup(
      <AnnualTallyCard
        siteId="site-1"
        year={2026}
        data={blockPrepData({ roster: { data: [], error: null }, unrosteredProviderIds: ['orji-id'] })}
      />,
    );
    expect(html).toContain('role="note"');
    expect(html).toContain('1 provider holds published call at this site');
  });
});

describe('AnnualTallyCard — weighted call counts', () => {
  it('renders a raw-float bucket total of 0.9999 as "1", never as "0.9999"', () => {
    const html = renderToStaticMarkup(
      <AnnualTallyCard
        siteId="site-1"
        year={2026}
        data={blockPrepData({
          roster: {
            data: [rosterRow({
              callCounts: [{ bucket: 'weekday', code: 'C1', count: 0.9999 }],
              callTotal: 0.9999,
            })],
            error: null,
          },
        })}
      />,
    );
    expect(html).not.toContain('0.9999');
    expect(html).toMatch(/>1<\/span>/);
  });
});

describe('AnnualTallyCard — Fix 5: stale (site, year) payload', () => {
  it('discards a payload stamped for a different site than requested, showing a skeleton instead', () => {
    const html = renderToStaticMarkup(
      <AnnualTallyCard
        siteId="site-2"
        year={2026}
        data={blockPrepData({
          site_id: 'site-1', // mismatched — the previous site's response
          roster: { data: [rosterRow({ display_name: 'STALE PROVIDER' })], error: null },
        })}
      />,
    );
    expect(html).not.toContain('STALE PROVIDER');
    expect(html.match(/fr-skeleton/g) ?? []).toHaveLength(3 * HEADER_COUNT);
  });

  it('discards a payload stamped for a different year than requested, showing a skeleton instead', () => {
    const html = renderToStaticMarkup(
      <AnnualTallyCard
        siteId="site-1"
        year={2027}
        data={blockPrepData({
          year: 2026, // mismatched — the previous year's response
          roster: { data: [rosterRow({ display_name: 'STALE PROVIDER' })], error: null },
        })}
      />,
    );
    expect(html).not.toContain('STALE PROVIDER');
    expect(html.match(/fr-skeleton/g) ?? []).toHaveLength(3 * HEADER_COUNT);
  });

  it('renders normally when (site, year) match', () => {
    const html = renderToStaticMarkup(
      <AnnualTallyCard
        siteId="site-1"
        year={2026}
        data={blockPrepData({
          site_id: 'site-1', year: 2026,
          roster: { data: [rosterRow({ display_name: 'FRESH PROVIDER' })], error: null },
        })}
      />,
    );
    expect(html).toContain('FRESH PROVIDER');
  });
});

describe('AnnualTallyCard — Fix 6: `data` and `refreshKey` are mutually exclusive props', () => {
  it('type-rejects passing refreshKey alongside a pre-fetched data prop', () => {
    // @ts-expect-error refreshKey has no effect once `data` is supplied (the
    // host owns reloading in that mode) — the discriminated union now makes
    // this uncompilable instead of a silent no-op.
    const el = <AnnualTallyCard siteId="site-1" year={2026} data={null} refreshKey={1} />;
    expect(el).toBeTruthy();
  });
});
