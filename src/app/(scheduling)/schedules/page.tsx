// The schedules index.
//
// Converted from a client component: it used to fetch the organization list,
// then gate the schedule list and the site list behind it, so nothing appeared
// until two sequential round trips had completed — each one re-entering the
// auth gate. The reads now happen here, in the request that renders the shell.
//
// Query logic is shared with /api/scheduling/schedules via lib/queries/roster,
// because the client still calls that route on every filter change and after
// every edit; two implementations of "which schedules count" would drift.

import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { listSchedules, listSites, firstOrg } from '@/lib/queries/roster';
import SchedulesClient from './SchedulesClient';

// Never prerender — this reads per-request, per-user data.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function SchedulesPage() {
  const sb = sbSchedulingServer();

  let orgId = '';
  let schedules: never[] = [];
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
      // The client starts with NO filters set, so the server renders the
      // unfiltered list — the same list the client believes it is showing.
      // That also means the table and the board start from one read rather
      // than two: the board is deliberately unfiltered, and with no filters
      // applied the two lists are identical.
      const [s, si] = await Promise.all([
        listSchedules(sb, { orgId }),
        listSites(sb, orgId),
      ]);
      if (!s.ok) loadError = s.error;
      else {
        schedules = s.rows as never[];
        for (const w of s.warnings ?? []) console.warn(`[schedules] ${w}`);
      }
      // A failed SITES read costs the filter dropdown, not the list itself.
      if (si.ok) sites = si.rows as never[];
    }
  } catch (e) {
    loadError = e instanceof Error ? e.message : 'Schedules could not be loaded.';
  }

  return (
    <SchedulesClient
      initialSchedules={schedules}
      initialAllSchedules={schedules}
      initialSites={sites}
      orgId={orgId}
      loadError={loadError}
    />
  );
}
