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
// REAL ERROR HANDLING (I2, round 5 review, Important): the bootstrap org/site
// fetch used to have no try/catch and no error state, so a failed request
// silently rendered as "no sites" (with `sites.length > 1` false, that also
// hid the site picker entirely) — an empty state instructing the chief to use
// a control that wasn't on screen, with an unhandled promise rejection to
// boot. A failure now renders a distinguishable error Banner instead.

import { useEffect, useState } from 'react';
import { Banner, Button, Card } from '@/components/ui';
import AnnualTallyCard from '@/components/AnnualTallyCard';

interface Site { id: string; name: string; short_name: string | null }

const SELECT: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 'var(--fs-sm)', cursor: 'pointer',
};

export default function DashboardTallyCard() {
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const year = new Date().getFullYear();

  useEffect(() => {
    (async () => {
      try {
        const orgRes = await fetch('/api/scheduling/organizations');
        if (!orgRes.ok) {
          const body = await orgRes.json().catch(() => ({}));
          setError(body.error || `Could not load organizations (${orgRes.status})`);
          return;
        }
        const orgs = await orgRes.json();
        if (!Array.isArray(orgs)) { setError('Organizations response was malformed.'); return; }
        if (orgs.length === 0) return;
        const res = await fetch(`/api/scheduling/sites?org_id=${orgs[0].id}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error || `Could not load sites (${res.status})`);
          return;
        }
        const list = await res.json();
        if (!Array.isArray(list)) { setError('Sites response was malformed.'); return; }
        setSites(list);
        if (list.length > 0) setSiteId(list[0].id);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error loading sites');
      }
    })();
  }, []);

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
              : 'Loading sites…'}
          </div>
        </Card>
      )}
    </div>
  );
}
