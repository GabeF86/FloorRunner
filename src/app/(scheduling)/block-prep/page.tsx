'use client';

// Block Prep — the site-scoped board you sit at before building a block
// (Gabriel 2026-09-06). Roster with inline FTE / PTO-allotment editing, a dates
// drawer per provider, the annual tally, and Create Schedule with the site
// already chosen.
//
// Fetch, state and markup only: the math is lib/annualTally.ts behind the
// block-prep route, and the view decisions are lib/blockPrepView.ts.

import { useCallback, useEffect, useState } from 'react';
import { Button, PageHeader } from '@/components/ui';
import AnnualTallyCard from '@/components/AnnualTallyCard';
import type { BlockPrepData } from '@/app/api/scheduling/block-prep/route.helpers';
import type { RosterRow } from '@/lib/blockPrepView';
import RosterCard from './RosterCard';
import AvailabilityDrawer from './AvailabilityDrawer';

interface Site { id: string; name: string; short_name: string | null }

const CONTROL: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 'var(--fs-sm)', cursor: 'pointer',
};

/**
 * How a failed `/block-prep` request is represented for the two cards that
 * read it. NOT a rendered string, no wording decision of its own — it just
 * reshapes a fetch failure into the exact `BlockPrepData` panel shape both
 * `RosterCard` and `AnnualTallyCard` already know how to show as an error,
 * mirroring the route's own `fail()` in route.helpers.ts (same reasoning:
 * "a failed blocks read must fail the roster too"). Giving `roster` and
 * `blocks` the IDENTICAL message is deliberate: `AnnualTallyCard`'s Fix 1
 * already suppresses a blocks banner that byte-matches the roster's, so a
 * route-level failure here renders as ONE banner in the tally card, not two,
 * for the same reason a `route.helpers.ts` blocks failure does.
 *
 * `site_id`/`year` are stamped so `AnnualTallyCard` never treats this as a
 * stale payload for a different (site, year) and swallows it into a skeleton.
 */
function loadFailure(siteId: string, year: number, message: string): BlockPrepData {
  return {
    site_id: siteId,
    year,
    roster: { data: null, error: message },
    blocks: { data: null, error: message },
    coveredSpan: null,
    unrosteredProviderIds: null,
  };
}

export default function BlockPrepPage() {
  const [orgId, setOrgId] = useState('');
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState('');
  const [year, setYear] = useState(new Date().getFullYear());
  // null = nothing loaded yet for the current (siteId, year) — drives the
  // skeleton in both RosterCard and AnnualTallyCard (rows undefined until
  // roster.data is present). A route-level failure is NOT represented by a
  // separate top-of-page banner: it becomes a BlockPrepData whose roster/
  // blocks panels carry the error, so it shows up exactly where a fail-soft
  // panel error from the route itself would — one error path, not two.
  const [data, setData] = useState<BlockPrepData | null>(null);
  const [loading, setLoading] = useState(false);
  const [drawerRow, setDrawerRow] = useState<RosterRow | null>(null);
  // Bumped after any write so the tally card refetches alongside the roster.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    (async () => {
      const res = await fetch('/api/scheduling/organizations');
      const orgs = await res.json();
      if (Array.isArray(orgs) && orgs.length > 0) setOrgId(orgs[0].id);
    })();
  }, []);

  useEffect(() => {
    if (!orgId) return;
    (async () => {
      const res = await fetch(`/api/scheduling/sites?org_id=${orgId}`);
      const list = await res.json();
      if (Array.isArray(list)) {
        setSites(list);
        if (list.length > 0) setSiteId(prev => prev || list[0].id);
      }
    })();
  }, [orgId]);

  const load = useCallback(async () => {
    if (!siteId) { setData(null); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/scheduling/block-prep?site_id=${siteId}&year=${year}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setData(loadFailure(siteId, year, body.error || `Request failed (${res.status})`));
        return;
      }
      setData(await res.json());
    } catch (e) {
      setData(loadFailure(siteId, year, e instanceof Error ? e.message : 'Network error'));
    } finally {
      setLoading(false);
    }
  }, [siteId, year]);

  useEffect(() => { load(); }, [load]);

  // Apply an inline edit to the local copy. The board does NOT refetch on every
  // keystroke-commit: the roster figures that depend on FTE (off-day budget,
  // PTO remaining) are recomputed server-side, so a refresh is triggered
  // instead, debounced by the fact that commits happen on blur.
  //
  // The PREVIOUS `data` stays on screen while that refresh is in flight —
  // deliberately NOT nulled out here. AnnualTallyCard keys its skeleton off
  // `data` being absent for the current (siteId, year); clearing it on every
  // edit would drop the tally into a full-card skeleton on every keystroke
  // commit, mid-interaction, for numbers that are still perfectly readable
  // until the refresh actually lands.
  const onPatched = (providerId: string, field: 'fte_value' | 'work_days_fte' | 'pto_weeks', value: number | null) => {
    setData(prev => {
      if (!prev?.roster.data) return prev;
      return {
        ...prev,
        roster: {
          ...prev.roster,
          data: prev.roster.data.map(r =>
            r.provider_id === providerId ? { ...r, [field]: value } : r),
        },
      };
    });
    setRefreshKey(k => k + 1);
  };

  useEffect(() => {
    if (refreshKey > 0) load();
    // `load` is stable per (siteId, year); refreshKey is the explicit trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const site = sites.find(s => s.id === siteId);
  const siteName = site?.short_name || site?.name;
  const thisYear = new Date().getFullYear();
  const years = [thisYear - 1, thisYear, thisYear + 1];

  return (
    <div>
      <PageHeader
        title="Block Prep"
        subtitle="Set the roster up, then build the block."
        actions={
          <Button
            onClick={() => { window.location.href = `/schedules?create=1&site_id=${siteId}`; }}
            disabled={!siteId}
            title={siteId ? 'Create a schedule for this site' : 'Pick a site first'}
          >
            Create Schedule
          </Button>
        }
      />

      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-5)', flexWrap: 'wrap' }}>
        <select value={siteId} onChange={e => setSiteId(e.target.value)} disabled={loading} style={CONTROL}>
          {sites.length === 0 && <option value="">No sites</option>}
          {sites.map(s => <option key={s.id} value={s.id}>{s.short_name || s.name}</option>)}
        </select>
        <select value={year} onChange={e => setYear(Number(e.target.value))} disabled={loading} style={CONTROL}>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <RosterCard
          siteId={siteId || null}
          rows={data?.roster.data ?? null}
          error={data?.roster.error ?? null}
          onPatched={onPatched}
          onOpenDrawer={setDrawerRow}
        />
        {/* Data is passed in: the page already loaded /block-prep for its
            roster, and the card must not fire a second identical year-wide
            query. On /dashboard the same component self-fetches instead. */}
        <AnnualTallyCard
          siteId={siteId || null}
          year={year}
          siteName={siteName}
          data={data}
        />
      </div>

      {drawerRow && (
        <AvailabilityDrawer
          key={drawerRow.provider_id}
          providerId={drawerRow.provider_id}
          providerName={drawerRow.display_name}
          year={year}
          onClose={() => setDrawerRow(null)}
          onChanged={() => setRefreshKey(k => k + 1)}
        />
      )}
    </div>
  );
}
