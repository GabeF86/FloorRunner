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
 * decision (sorting, blank-vs-zero text, parsing) both cards render through.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import BlockPrepPage from './page';

describe('BlockPrepPage — first paint, before any site has loaded', () => {
  const html = renderToStaticMarkup(<BlockPrepPage />);

  it('renders the page header', () => {
    expect(html).toContain('Block Prep');
    expect(html).toContain('Set the roster up, then build the block.');
  });

  it('disables Create Schedule until a site is chosen', () => {
    expect(html).toContain('Create Schedule');
    expect(html).toContain('disabled');
  });

  it('shows "pick a site" in the roster card, not an empty-roster or error state', () => {
    expect(html).toContain('Call takers are tracked per site');
    expect(html).not.toContain('No call takers at this site');
  });

  it('shows "pick a site" in the tally card too, not its own empty or loading state', () => {
    expect(html).toContain("running totals");
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
});
