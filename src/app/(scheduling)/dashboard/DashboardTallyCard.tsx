'use client';

// The dashboard's window onto the annual tally. /dashboard is org-wide and has
// no site picker of its own, so this thin client wrapper carries one and hands
// the choice to the shared AnnualTallyCard. The card itself is identical to the
// one on /block-prep — same component, same route, same numbers.
//
// COLLAPSED BY DEFAULT (I3, round 5 review, Important): AnnualTallyCard
// self-fetches /block-prep, which route.helpers.ts's own header describes as
// the slowest query in the app — year-wide, three embeds, paged past the
// 1000-row cap. /dashboard is `force-dynamic` and is the landing page, so
// mounting AnnualTallyCard unconditionally would pay that cost on every
// dashboard load whether or not anyone looks at it. AnnualTallyCard is not
// mounted at all until the chief expands the card — same "collapsed by
// default" posture PhysicianPlannerCard already uses directly below it,
// adapted for the fact that this card has no cheaper partial query to show
// while collapsed (the route computes roster and tally together): the
// collapsed state is a plain static summary line, not a chip row.
//
// THE CONTROL ROW NEVER MOVES (round 6 nit 4): collapsed used to put Expand
// inside a Card header while expanded floated the site picker + Collapse in
// a bare div above a DIFFERENT Card (AnnualTallyCard's own) — the toggle
// jumped position across the one interaction this component has. The title
// + site picker + toggle now live in ONE row that renders identically either
// way; only what's BELOW that row changes (a static hint Card, or the real
// AnnualTallyCard).
//
// ORG/SITES BOOTSTRAP (round 7 review, Fix 2): this used to carry its OWN
// copy of the org→sites fetch sequence — the exact same one page.tsx has —
// and round 6's `noOrg` fix landed in page.tsx alone. This component still
// read "Loading sites…" forever whenever the organizations list came back
// empty, with its site picker gated behind `expanded && sites.length > 1`
// and therefore not even on screen to explain why. `useOrgAndSites` is now
// the ONE place either host reads from, and `siteBootstrapText` the one
// place that turns its three booleans into words, so a future fix can't
// land in only one copy again.

import { useState } from 'react';
import { useOrgAndSites } from '@/components/useOrgAndSites';
import { Banner, Button, Card } from '@/components/ui';
import AnnualTallyCard from '@/components/AnnualTallyCard';
import { siteBootstrapText } from '@/lib/blockPrepView';

const SELECT: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 'var(--fs-sm)', cursor: 'pointer',
};

export default function DashboardTallyCard() {
  const { sites, siteId, setSiteId, error, noOrg, sitesLoaded } = useOrgAndSites();
  const [expanded, setExpanded] = useState(false);
  const year = new Date().getFullYear();

  const site = sites.find(s => s.id === siteId);
  const siteName = site?.short_name || site?.name;

  if (error) {
    return <Card title="Annual tally"><Banner tone="error">{error}</Banner></Card>;
  }

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 'var(--space-2)', marginBottom: 'var(--space-2)',
      }}>
        <div style={{ fontSize: 'var(--fs-md)', fontWeight: 700, color: 'var(--text-strong)' }}>
          Annual tally
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          {expanded && sites.length > 1 && (
            <select aria-label="Site" value={siteId} onChange={e => setSiteId(e.target.value)} style={SELECT}>
              {sites.map(s => <option key={s.id} value={s.id}>{s.short_name || s.name}</option>)}
            </select>
          )}
          <Button variant="secondary" size="sm" onClick={() => setExpanded(v => !v)}>
            {expanded ? 'Collapse' : 'Expand'}
          </Button>
        </div>
      </div>

      {expanded ? (
        <AnnualTallyCard siteId={siteId || null} year={year} siteName={siteName} />
      ) : (
        <Card>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
            {siteName
              ? `${siteName}'s ${year} call, PTO and off-day running totals — expand to view.`
              // `error` is handled by the early return above, so it's
              // deliberately not passed here — this call only ever needs to
              // distinguish "no organization" / "hasn't looked yet" /
              // "genuinely zero sites" for its own fallback text.
              : siteBootstrapText({ error: null, noOrg, sitesLoaded })}
          </div>
        </Card>
      )}
    </div>
  );
}
