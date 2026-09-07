'use client';

// Block Prep — the site-scoped board you sit at before building a block
// (Gabriel 2026-09-06). Roster with inline FTE / PTO-allotment editing, a dates
// drawer per provider, the annual tally, and Create Schedule with the site
// already chosen.
//
// Fetch, state and markup only: the math is lib/annualTally.ts behind the
// block-prep route, and the view decisions (which years to offer, button
// copy) are lib/blockPrepView.ts.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button, PageHeader } from '@/components/ui';
import AnnualTallyCard from '@/components/AnnualTallyCard';
import { useOrgAndSites } from '@/components/useOrgAndSites';
import type { BlockPrepData } from '@/app/api/scheduling/block-prep/route.helpers';
import { freshFor, tallyCardProps } from './pageData';
import {
  blockPrepYearOptions, siteBootstrapText,
  CREATE_SCHEDULE_TOOLTIP, CREATE_SCHEDULE_NO_SITE_TOOLTIP,
  type RosterRow,
} from '@/lib/blockPrepView';
import RosterCard from './RosterCard';
import AvailabilityDrawer from './AvailabilityDrawer';

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
  const router = useRouter();
  // Org→sites bootstrap (round 7 review, Fix 2): was a hand-duplicated pair
  // of effects here and in DashboardTallyCard, and a fix (the `noOrg` guard)
  // landed in only this copy — see useOrgAndSites's own header. Renamed to
  // `bootError` at destructure time to keep it visually distinct from
  // `loadFailure` below, which builds an unrelated per-request failure (the
  // `/block-prep` GET, not the org/sites bootstrap) into a BlockPrepData.
  const { sites, siteId, setSiteId, error: bootError, noOrg, sitesLoaded } = useOrgAndSites();
  const [year, setYear] = useState(new Date().getFullYear());
  // null = nothing loaded yet for the current (siteId, year) — drives the
  // skeleton in both RosterCard and AnnualTallyCard (rows undefined until
  // roster.data is present). A route-level failure is NOT represented by a
  // separate top-of-page banner: it becomes a BlockPrepData whose roster/
  // blocks panels carry the error, so it shows up exactly where a fail-soft
  // panel error from the route itself would — one error path, not two.
  const [data, setData] = useState<BlockPrepData | null>(null);
  const [drawerRow, setDrawerRow] = useState<RosterRow | null>(null);
  // Bumped after a PATCH has actually SETTLED (see onCommitted below) so the
  // roster and tally card refetch together.
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    if (!siteId) { setData(null); return; }
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
    }
  }, [siteId, year]);

  useEffect(() => { load(); }, [load]);

  // Optimistic local update ONLY — applies an edit to the local copy so the
  // cell (and the roster row beside it) feels instant. Does NOT trigger a
  // refetch: see `onCommitted` below for why that has to be a separate hook
  // (C1, CRITICAL, round 5 review).
  //
  // The PREVIOUS `data` stays on screen while a refresh is in flight —
  // deliberately NOT nulled out here. `AnnualTallyCard` and `RosterCard` both
  // key their skeletons off `data`/`fresh` being absent for the current
  // (siteId, year); clearing it on every edit would drop both into a
  // full-card skeleton on every keystroke commit, mid-interaction, for
  // numbers that are still perfectly readable until the refresh lands.
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
  };

  // The REFETCH trigger (C1, CRITICAL, round 5 review). RosterCard calls this
  // from a cell's `finally` block, strictly AFTER its PATCH has settled
  // (success or failure) — never from the optimistic `onSaved`/`onPatched`
  // path, which fires before the PATCH is even sent and would otherwise let
  // this page's GET race the PATCH it was meant to follow (the GET could
  // reach the DB first and silently overwrite the field back to its pre-edit
  // value, with no further refetch ever scheduled to correct it).
  const onCommitted = useCallback(() => { setRefreshKey(k => k + 1); }, []);

  useEffect(() => {
    if (refreshKey > 0) load();
    // `load` is stable per (siteId, year); refreshKey is the explicit trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const site = sites.find(s => s.id === siteId);
  const siteName = site?.short_name || site?.name;
  const years = blockPrepYearOptions(new Date().getFullYear());
  // C2 (CRITICAL, round 5 review): never render a payload stamped for a
  // DIFFERENT (siteId, year) than what this render is asking for — see
  // freshFor's own doc for why. Both cards below read `fresh`, never `data`
  // directly.
  const fresh = freshFor(data, siteId, year);

  return (
    <div>
      <PageHeader
        title="Block Prep"
        subtitle="Set the roster up, then build the block."
        actions={
          <Button
            onClick={() => {
              // next/navigation's router avoids a full app-shell reload —
              // window.location.href would tear down and remount AppShell
              // (theme/sidebar state) just to reach a page inside the same
              // shell.
              router.push(`/schedules?create=1&site_id=${siteId}`);
            }}
            disabled={!siteId}
            title={siteId ? CREATE_SCHEDULE_TOOLTIP : CREATE_SCHEDULE_NO_SITE_TOOLTIP}
          >
            Create Schedule
          </Button>
        }
      />

      {bootError && (
        <div style={{ marginBottom: 'var(--space-4)' }}><Banner tone="error">{bootError}</Banner></div>
      )}

      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-5)', flexWrap: 'wrap' }}>
        <select aria-label="Site" value={siteId} onChange={e => setSiteId(e.target.value)} style={CONTROL}>
          {/* I2 (+ round 6 nits 1/2, round 7 Fix 2): four distinguishable
              facts, never collapsed into one guess — a fetch failure, no
              organization configured at all, "hasn't looked yet", and a
              genuinely confirmed zero sites must not read as each other. */}
          {sites.length === 0 && (
            <option value="">{siteBootstrapText({ error: bootError, noOrg, sitesLoaded })}</option>
          )}
          {sites.map(s => <option key={s.id} value={s.id}>{s.short_name || s.name}</option>)}
        </select>
        <select aria-label="Year" value={year} onChange={e => setYear(Number(e.target.value))} style={CONTROL}>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <RosterCard
          siteId={siteId || null}
          rows={fresh?.roster.data ?? null}
          error={fresh?.roster.error ?? null}
          coveredSpan={fresh?.coveredSpan ?? null}
          onPatched={onPatched}
          onCommitted={onCommitted}
          onOpenDrawer={setDrawerRow}
        />
        {/* Data is passed in: the page already loaded /block-prep for its
            roster, and the card must not fire a second identical year-wide
            query. On /dashboard the same component self-fetches instead. */}
        <AnnualTallyCard {...tallyCardProps(fresh, siteId, year, siteName)} />
      </div>

      {drawerRow && (
        <AvailabilityDrawer
          key={drawerRow.provider_id}
          providerId={drawerRow.provider_id}
          providerName={drawerRow.display_name}
          year={year}
          onClose={() => setDrawerRow(null)}
          onChanged={onCommitted}
        />
      )}
    </div>
  );
}
