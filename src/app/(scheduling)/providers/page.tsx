// The provider roster.
//
// This page used to be the client component that now lives in
// ProvidersClient.tsx. The HTML arrived empty, the browser hydrated, fetched
// the organization list, and only THEN fetched the roster it was gated behind
// — two round trips before a single row appeared, each one re-entering the
// auth gate on the way.
//
// Now the reads happen here, in the same request that renders the shell, using
// the service client directly: no HTTP hop, no second pass through the
// middleware, and the first response already contains the rows. The client
// component keeps every interactive path it had (search, filters, reload after
// an edit) — it simply starts with data instead of with an empty array.
//
// Query logic is shared with /api/scheduling/providers via lib/queries/roster,
// so the list rendered here and the list fetched after a filter change cannot
// disagree.

import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { listProviders, listSites, firstOrg } from '@/lib/queries/roster';
import ProvidersClient from './ProvidersClient';

// Never prerender — this reads per-request, per-user data.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function ProvidersPage() {
  const sb = sbSchedulingServer();

  let orgId = '';
  let providers: never[] = [];
  let sites: never[] = [];
  let loadError: string | null = null;

  try {
    // firstOrg, not firstOrgId: the flattened form cannot tell "no
    // organization" from "the read failed", and the difference matters here.
    // An empty orgId renders the onboarding branch, which invites creating an
    // organization that already exists — a database blip would quietly offer
    // to duplicate the whole group.
    const org = await firstOrg(sb);
    if (!org.ok) {
      // Left as an ERROR with orgId empty. The client checks loadError before
      // its onboarding branch, so a failed read shows what went wrong instead
      // of an invitation to create something that already exists.
      loadError = org.error;
    } else {
      orgId = org.rows[0]?.id ?? '';
    }
    if (orgId) {
      // The two reads are independent, so they overlap rather than queue.
      const [p, s] = await Promise.all([
        // 'active' mirrors the client's initial statusFilter — the server must
        // render the same list the client believes it is showing, or the first
        // filter interaction would appear to change something it did not.
        listProviders(sb, { orgId, status: 'active' }),
        listSites(sb, orgId),
      ]);
      if (!p.ok) loadError = p.error;
      else providers = p.rows as never[];
      // A failed SITES read only costs the filter dropdown, so it must not
      // blank the roster: the page is still useful without it.
      if (s.ok) sites = s.rows as never[];
    }
  } catch (e) {
    loadError = e instanceof Error ? e.message : 'Providers could not be loaded.';
  }

  return (
    <ProvidersClient
      initialProviders={providers}
      initialSites={sites}
      orgId={orgId}
      loadError={loadError}
    />
  );
}
