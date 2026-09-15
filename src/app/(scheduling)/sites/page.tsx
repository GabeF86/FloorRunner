// The site list.
//
// This page used to be the client component that now lives in SitesClient.tsx.
// The HTML arrived empty, the browser hydrated, fetched the organization list,
// and only THEN — gated behind that id — fetched the sites, and only after
// those had landed did it fetch the shift types that decorate them. Three
// serial round trips before a single hospital appeared.
//
// Now the reads happen here, in the same request that renders the shell, using
// the service client directly: no HTTP hop, no second pass through the
// middleware, and the first response already contains the rows. The client
// component keeps every interactive path it had (adding a site, reloading
// afterwards) — it simply starts with data instead of with an empty array.
//
// Query logic is shared with /api/scheduling/sites and
// /api/scheduling/shift-types via lib/queries, so the list rendered here and
// the list fetched after an edit cannot disagree.

import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { firstOrg, listSites } from '@/lib/queries/roster';
import { listShiftTypes } from '@/lib/queries/config';
import SitesClient, { type SitesClientProps } from './SitesClient';

// Never prerender — this reads per-request, per-user data.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function SitesPage() {
  const sb = sbSchedulingServer();

  let orgId = '';
  let sites: SitesClientProps['initialSites'] = [];
  let shiftTypesLoadError: string | null = null;
  let loadError: string | null = null;

  try {
    // firstOrg rather than firstOrgId: a failed organizations read must not
    // collapse into "this group has no sites", because that view invites the
    // user to add hospitals that already exist.
    const org = await firstOrg(sb);
    if (!org.ok) loadError = org.error;
    else orgId = org.rows[0]?.id ?? '';

    if (orgId) {
      // Independent reads, so they overlap rather than queue. Shift types are
      // fetched unscoped — the same read the client made — and bucketed by
      // site below.
      const [s, st] = await Promise.all([listSites(sb, orgId), listShiftTypes(sb)]);

      if (!s.ok) {
        loadError = s.error;
      } else {
        // A failed SHIFT-TYPE read only costs a count, so it must not blank the
        // site list. "0 shift types" would be a lie, so the count is left
        // undefined (rendered "unknown") and the failure is said out loud.
        shiftTypesLoadError = st.ok ? null : st.error;
        const shiftTypes = st.ok ? (st.rows as unknown as Array<{ site_id: string }>) : null;
        sites = (s.rows as unknown as SitesClientProps['initialSites']).map(site => ({
          ...site,
          shift_types: shiftTypes ? shiftTypes.filter(t => t.site_id === site.id) : undefined,
        }));
      }
    }
  } catch (e) {
    loadError = e instanceof Error ? e.message : 'Sites could not be loaded.';
  }

  return (
    <SitesClient
      initialSites={sites}
      orgId={orgId}
      loadError={loadError}
      shiftTypesLoadError={shiftTypesLoadError}
    />
  );
}
