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
import { currentScheduleActor } from '@/lib/auth/scheduleActor';
import {
  visibleSchedules, canSeeDeleted, canDeleteSchedule, type ScheduleStatus,
} from '@/lib/auth/schedulePermissions';
import SchedulesClient from './SchedulesClient';

// Never prerender — this reads per-request, per-user data.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function SchedulesPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const sb = sbSchedulingServer();

  // A site chosen in the nav arrives as ?site_id=. Applied HERE as well as in
  // the client, so the first paint is already the filtered list — reading it
  // only on the client would render every site's schedules and then replace
  // them, which is the waterfall this page was converted to remove.
  const sp = await searchParams;
  const rawSite = sp.site_id;
  const siteId = (Array.isArray(rawSite) ? rawSite[0] : rawSite) || '';

  let orgId = '';
  let schedules: never[] = [];
  let allSchedules: never[] = [];
  let sites: never[] = [];
  let loadError: string | null = null;
  // Who is reading, so the list can be scoped and the delete control only
  // offered where it would actually work.
  const actor = await currentScheduleActor(sb);

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
      // TWO lists, and they are not interchangeable:
      //   · the TABLE honours the site filter the nav arrived with
      //   · the BOARD below it is deliberately unfiltered and always shows
      //     real state across the group
      // With no site chosen they are the same query, so only one read is made
      // — the page was converted away from a waterfall and a second identical
      // round trip would put part of it back.
      const [s, all, si] = await Promise.all([
        listSchedules(sb, { orgId, siteId: siteId || null }),
        siteId ? listSchedules(sb, { orgId }) : Promise.resolve(null),
        listSites(sb, orgId),
      ]);

      // A PROVIDER SEES PUBLISHED SCHEDULES ONLY. Scoped on the server, in the
      // request that renders the page — not hidden in the client, where the
      // rows would still have been shipped to the browser.
      const scope = (rows: Array<Record<string, unknown>>) => visibleSchedules(
        actor,
        rows.map(r => ({
          ...r,
          siteId: String(r.site_id ?? ''),
          status: String(r.status ?? 'draft') as ScheduleStatus,
          deletedAt: (r.deleted_at as string | null) ?? null,
        })),
      ) as never[];

      if (!s.ok) loadError = s.error;
      else {
        schedules = scope(s.rows);
        for (const w of s.warnings ?? []) console.warn(`[schedules] ${w}`);
      }
      // The board falls back to the filtered list rather than rendering empty
      // if its own read failed — showing less is better than showing nothing,
      // and loadError already carries the failure when the table's read broke.
      allSchedules = all && all.ok ? scope(all.rows) : schedules;

      // A failed SITES read costs the filter dropdown, not the list itself.
      if (si.ok) sites = si.rows as never[];
    }
  } catch (e) {
    loadError = e instanceof Error ? e.message : 'Schedules could not be loaded.';
  }

  return (
    <SchedulesClient
      initialSchedules={schedules}
      initialAllSchedules={allSchedules}
      initialSites={sites}
      orgId={orgId}
      loadError={loadError}
      initialSiteFilter={siteId}
      // Whether to render the delete control at all. The route checks the same
      // rule again — this only avoids offering a button that would 403.
      canDelete={schedules.some(r => canDeleteSchedule(actor, {
        siteId: String((r as Record<string, unknown>).site_id ?? ''),
        status: String((r as Record<string, unknown>).status ?? 'draft') as ScheduleStatus,
        deletedAt: null,
      }))}
      canSeeDeleted={canSeeDeleted(actor)}
    />
  );
}
