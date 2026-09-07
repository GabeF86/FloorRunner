'use client';

// The dashboard's window onto the annual tally. /dashboard is org-wide and has
// no site picker of its own, so this thin client wrapper carries one and hands
// the choice to the shared AnnualTallyCard. The card itself is identical to the
// one on /block-prep — same component, same route, same numbers.
//
// Self-fetch mode: `data` and `refreshKey` are both omitted, so AnnualTallyCard
// issues its own /block-prep request for whichever site is picked here. There
// is no roster or write flow on this page for the card's own refetch to race
// with, so there is nothing here to bump a refreshKey for.

import { useEffect, useState } from 'react';
import AnnualTallyCard from '@/components/AnnualTallyCard';

interface Site { id: string; name: string; short_name: string | null }

export default function DashboardTallyCard() {
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState('');
  const year = new Date().getFullYear();

  useEffect(() => {
    (async () => {
      const orgRes = await fetch('/api/scheduling/organizations');
      const orgs = await orgRes.json();
      if (!Array.isArray(orgs) || orgs.length === 0) return;
      const res = await fetch(`/api/scheduling/sites?org_id=${orgs[0].id}`);
      const list = await res.json();
      if (Array.isArray(list)) {
        setSites(list);
        if (list.length > 0) setSiteId(list[0].id);
      }
    })();
  }, []);

  const site = sites.find(s => s.id === siteId);

  return (
    <div>
      {sites.length > 1 && (
        <div style={{ marginBottom: 'var(--space-2)' }}>
          <select
            value={siteId}
            onChange={e => setSiteId(e.target.value)}
            style={{
              padding: '6px 10px', borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)', background: 'var(--bg-deep)',
              color: 'var(--text)', fontSize: 'var(--fs-sm)', cursor: 'pointer',
            }}
          >
            {sites.map(s => <option key={s.id} value={s.id}>{s.short_name || s.name}</option>)}
          </select>
        </div>
      )}
      <AnnualTallyCard
        siteId={siteId || null}
        year={year}
        siteName={site?.short_name || site?.name}
      />
    </div>
  );
}
