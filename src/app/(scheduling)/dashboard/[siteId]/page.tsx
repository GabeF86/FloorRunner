// One site's dashboard. Same body as the group view (DashboardView), with
// every panel scoped to this site by loadDashboardData's siteId argument.

import { notFound } from 'next/navigation';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { loadDashboardData, loadSiteCallObligation, type DashboardData } from '../queries';
import { DashboardView } from '../DashboardView';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function SiteDashboardPage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = await params;
  const sb = sbSchedulingServer();

  // Resolve the site FIRST. A dashboard headed with a bare UUID — or worse,
  // headed with nothing while showing another site's numbers — is the failure
  // mode worth spending a round-trip to avoid.
  const { data: site, error } = await sb
    .from('sites')
    .select('id, name')
    .eq('id', siteId)
    .maybeSingle();

  if (error) {
    return (
      <DashboardView
        data={null}
        fatal={error.message}
        site={{ id: siteId, name: 'Site' }}
      />
    );
  }
  if (!site) notFound();

  let data: DashboardData | null = null;
  let fatal: string | null = null;
  // The obligation is its own panel and fails on its own: a template read that
  // goes wrong must not take the whole page down with it.
  let obligation: Awaited<ReturnType<typeof loadSiteCallObligation>> | null = null;

  const year = new Date().getUTCFullYear();
  try {
    [data, obligation] = await Promise.all([
      loadDashboardData(sb, undefined, siteId),
      loadSiteCallObligation(sb, siteId, year),
    ]);
  } catch (e) {
    fatal = e instanceof Error ? e.message : 'Dashboard data could not be loaded.';
  }

  return (
    <DashboardView
      data={data}
      fatal={fatal}
      site={{ id: site.id as string, name: site.name as string }}
      obligation={obligation}
    />
  );
}
