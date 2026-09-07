/**
 * BlockPrepPage render-path test (node environment, zero new deps).
 *
 * Same strategy as RosterCard.test.tsx / AnnualTallyCard.test.tsx /
 * Modal.test.tsx: react-dom/server's renderToStaticMarkup freezes the page at
 * its FIRST PAINT — none of its useEffects (org load, site load, the
 * /block-prep fetch) ever run under SSR. That first paint is therefore the
 * ONLY page-level state reachable from a render-only test: before any effect
 * fires, `siteId` is still '' (no site chosen yet), so this pins the
 * no-site-selected state across the whole page — the Create Schedule button,
 * the roster card, and the tally card all keyed off the same `siteId`.
 *
 * Everything reachable only via useEffect (a loaded roster, a failed fetch,
 * an inline edit, the availability drawer) is exercised where the actual
 * decisions live: RosterCard.test.tsx, AnnualTallyCard.test.tsx and
 * AvailabilityDrawer.test.tsx already cover those states for the shared
 * components this page is markup over. blockPrepView.test.ts covers every
 * decision (sorting, blank-vs-zero text, parsing, the year options) both
 * cards render through.
 *
 * `next/navigation`'s useRouter throws ("invariant expected app router to be
 * mounted") outside an actual Next router context, which renderToStaticMarkup
 * never provides — mocked here so the page can render at all under vitest.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import BlockPrepPage, { freshFor, tallyCardProps } from './page';
import type { BlockPrepData } from '@/app/api/scheduling/block-prep/route.helpers';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

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

describe('BlockPrepPage — first paint, before any site has loaded', () => {
  const html = renderToStaticMarkup(<BlockPrepPage />);

  it('renders the page header', () => {
    expect(html).toContain('Block Prep');
    expect(html).toContain('Set the roster up, then build the block.');
  });

  it('disables Create Schedule specifically, not just some element on the page', () => {
    // A bare `toContain('disabled')` would pass for a disabled element
    // anywhere on the page (I6, round 5 review) — this pins it to the
    // Create Schedule button's own opening tag.
    const match = html.match(/<button([^>]*)>Create Schedule/);
    expect(match).not.toBeNull();
    expect(match![1]).toContain('disabled');
  });

  it('labels the site and year pickers for assistive tech (I4, round 5 review)', () => {
    expect(html).toContain('aria-label="Site"');
    expect(html).toContain('aria-label="Year"');
  });

  it('shows "pick a site" in the roster card, not an empty-roster or error state', () => {
    expect(html).toContain('Call takers are tracked per site');
    expect(html).not.toContain('No call takers at this site');
  });

  it('shows "pick a site" in the tally card too, not its own empty or loading state', () => {
    expect(html).toContain('running totals');
    // The tally card's loading skeleton uses this class; nothing has a siteId
    // yet, so neither card should be mid-fetch.
    expect(html.match(/fr-skeleton/g) ?? []).toHaveLength(0);
  });

  it('never shows a route-level error banner before any request has been made', () => {
    // loadFailure()'s message only ever reaches the DOM via RosterCard's or
    // AnnualTallyCard's own error Banner, and neither should be showing yet.
    expect(html).not.toContain('Request failed');
    expect(html).not.toContain('Network error');
  });

  it('never claims "No sites" before the bootstrap fetch has even run (I2 regression)', () => {
    // Nothing has loaded yet (sites is still [], sitesLoaded is still false)
    // — an unqualified "No sites" option would read as a confirmed empty
    // roster of sites rather than "hasn't looked yet".
    expect(html).not.toContain('>No sites<');
    expect(html).toContain('Loading sites…');
  });
});

describe('freshFor (C2 regression, CRITICAL) — a stale (site, year) payload must never render', () => {
  it('passes through a payload stamped for the CURRENT site and year', () => {
    const data = blockPrepData({ site_id: 'site-1', year: 2026 });
    expect(freshFor(data, 'site-1', 2026)).toBe(data);
  });

  it('discards a payload stamped for a DIFFERENT site — the exact bug the reviewer proved against RosterCard', () => {
    const data = blockPrepData({ site_id: 'SITE-A', year: 2026 });
    expect(freshFor(data, 'SITE-B', 2026)).toBeNull();
  });

  it('discards a payload stamped for a DIFFERENT year', () => {
    const data = blockPrepData({ site_id: 'site-1', year: 2025 });
    expect(freshFor(data, 'site-1', 2026)).toBeNull();
  });

  it('passes null through as null', () => {
    expect(freshFor(null, 'site-1', 2026)).toBeNull();
  });
});

describe('tallyCardProps (I6 regression, CRITICAL) — pins that `data` is always sent to AnnualTallyCard', () => {
  it('includes `data` as an own key even when the payload is null — omitting it silently flips AnnualTallyCard into self-fetch mode', () => {
    const props = tallyCardProps(null, 'site-1', 2026, undefined);
    expect(Object.prototype.hasOwnProperty.call(props, 'data')).toBe(true);
    expect(props.data).toBeNull();
  });

  it('passes the fresh payload straight through, and normalizes an empty siteId to null', () => {
    const data = blockPrepData();
    const props = tallyCardProps(data, '', 2026, 'Paoli');
    expect(props.data).toBe(data);
    expect(props.siteId).toBeNull();
    expect(props.year).toBe(2026);
    expect(props.siteName).toBe('Paoli');
  });
});
