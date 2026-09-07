/**
 * DashboardTallyCard render-path test (node environment, zero new deps).
 *
 * Same renderToStaticMarkup-at-first-paint strategy as page.test.tsx: the
 * bootstrap org/site fetch never resolves under SSR, so this pins the
 * COLLAPSED first-paint state (I3, round 5 review) — the one state reachable
 * without an effect ever firing, which is exactly the state that matters:
 * AnnualTallyCard (and its self-fetch of the app's slowest query) must NOT be
 * mounted until the chief opts in.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import DashboardTallyCard from './DashboardTallyCard';

describe('DashboardTallyCard — first paint, before the bootstrap fetch resolves', () => {
  const html = renderToStaticMarkup(<DashboardTallyCard />);

  it('renders collapsed, with an Expand action, not the tally table', () => {
    expect(html).toContain('Annual tally');
    expect(html).toContain('Expand');
    // AnnualTallyCard's table markup (and therefore its self-fetch) must not
    // be mounted while collapsed.
    expect(html).not.toContain('running tally');
    expect(html.match(/fr-skeleton/g) ?? []).toHaveLength(0);
  });

  it('has not loaded a site yet, so it says so rather than fabricating a site name', () => {
    expect(html).toContain('Loading sites…');
  });

  it('never shows a route-level error before the bootstrap fetch has even run', () => {
    expect(html).not.toContain('Could not load');
    expect(html).not.toContain('Network error');
  });
});
