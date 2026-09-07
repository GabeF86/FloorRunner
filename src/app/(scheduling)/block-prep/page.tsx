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
import type { BlockPrepData } from '@/app/api/scheduling/block-prep/route.helpers';
import {
  blockPrepYearOptions, CREATE_SCHEDULE_TOOLTIP, CREATE_SCHEDULE_NO_SITE_TOOLTIP,
  type RosterRow,
} from '@/lib/blockPrepView';
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

/**
 * C2 fix (CRITICAL, round 5 review): `data` alone is not enough to render —
 * it may still be the PREVIOUS site/year's payload while a fresh fetch for
 * the current one is in flight (deliberately kept on screen; see the
 * onCommitted/onPatched split below for why). `AnnualTallyCard` already
 * guards its OWN rendering against exactly this with an identical check; this
 * gives `RosterCard` the same guard on the same payload, so the two cards can
 * never disagree about which site is on screen — either both show fresh data
 * for `(siteId, year)`, or both fall back to their loading/pick-a-site state.
 * Uses the stamps the route puts on every shape it returns, INCLUDING every
 * failure panel (`loadFailure` above stamps them too), so a route-level
 * failure for the CURRENT site/year still passes this check and renders its
 * error, while a stale payload for a DIFFERENT site/year does not.
 */
export function freshFor(data: BlockPrepData | null, siteId: string, year: number): BlockPrepData | null {
  return data && data.site_id === siteId && data.year === year ? data : null;
}

/**
 * The exact prop object handed to `AnnualTallyCard` on this page — pulled out
 * so a test can pin that `data` is ALWAYS included (I6, round 5 review):
 * omitting `data` flips `AnnualTallyCard` into its self-fetch branch,
 * reintroducing the duplicate year-wide query this task exists to prevent,
 * and that mutation previously typechecked clean and left every test green.
 * Spread at the JSX call site below (`{...tallyCardProps(...)}`) rather than
 * writing the props out by hand there, so there is one call whose return
 * value a test can inspect directly — same pattern as RosterCard's
 * `buildRosterTableRows` / `resolveDisplayRows`.
 */
export function tallyCardProps(
  fresh: BlockPrepData | null, siteId: string, year: number, siteName: string | undefined,
): { siteId: string | null; year: number; siteName: string | undefined; data: BlockPrepData | null } {
  return { siteId: siteId || null, year, siteName, data: fresh };
}

export default function BlockPrepPage() {
  const router = useRouter();
  const [orgId, setOrgId] = useState('');
  const [sites, setSites] = useState<Site[]>([]);
  // Set when the bootstrap org/site fetch itself fails — kept separate from
  // `sites` being genuinely empty (I2, round 5 review): a failed fetch must
  // never render "No sites" as though it successfully looked and found none.
  const [bootError, setBootError] = useState<string | null>(null);
  // True only once the sites fetch has genuinely completed (successfully).
  // Distinguishes "hasn't looked yet" from "looked and found zero" in the
  // site select's placeholder — both start from the same empty `sites`
  // array, and collapsing them would let a still-loading page claim a
  // confirmed "No sites" before it had looked (I2, round 5 review).
  const [sitesLoaded, setSitesLoaded] = useState(false);
  // True once the org fetch succeeds but returns zero organizations (round 6
  // nit 1): without this, the sites effect below never runs (it's gated on
  // `orgId`), so `sitesLoaded` would stay false forever and the site select
  // would read "Loading sites…" permanently instead of naming the real,
  // if unlikely, degenerate config.
  const [noOrg, setNoOrg] = useState(false);
  const [siteId, setSiteId] = useState('');
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

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/scheduling/organizations');
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setBootError(body.error || `Could not load organizations (${res.status})`);
          return;
        }
        const orgs = await res.json();
        // Round 6 nit 2: a malformed (non-array) 200 must not silently fall
        // through as though it were a confirmed empty list — that reads
        // identically to "no organizations exist" downstream.
        if (!Array.isArray(orgs)) {
          setBootError('Organizations response was malformed.');
          return;
        }
        if (orgs.length > 0) setOrgId(orgs[0].id);
        else setNoOrg(true); // round 6 nit 1: name the degenerate case, don't leave the site select loading forever
      } catch (e) {
        setBootError(e instanceof Error ? e.message : 'Network error loading organizations');
      }
    })();
  }, []);

  useEffect(() => {
    if (!orgId) return;
    (async () => {
      try {
        const res = await fetch(`/api/scheduling/sites?org_id=${orgId}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setBootError(body.error || `Could not load sites (${res.status})`);
          return;
        }
        const list = await res.json();
        // Round 6 nit 2: same malformed-response guard as the org fetch —
        // `sitesLoaded` must only ever mean "genuinely looked and this is
        // what came back", never "got something, didn't check its shape".
        if (!Array.isArray(list)) {
          setBootError('Sites response was malformed.');
          return;
        }
        setSites(list);
        if (list.length > 0) setSiteId(prev => prev || list[0].id);
        setSitesLoaded(true);
      } catch (e) {
        setBootError(e instanceof Error ? e.message : 'Network error loading sites');
      }
    })();
  }, [orgId]);

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
          {/* I2 (+ round 6 nits 1/2): four distinguishable facts, never
              collapsed into one guess — a fetch failure, no organization
              configured at all, "hasn't looked yet", and a genuinely
              confirmed zero sites must not read as each other. */}
          {sites.length === 0 && (
            <option value="">
              {bootError ? 'Could not load sites'
                : noOrg ? 'No organization configured'
                  : sitesLoaded ? 'No sites' : 'Loading sites…'}
            </option>
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
