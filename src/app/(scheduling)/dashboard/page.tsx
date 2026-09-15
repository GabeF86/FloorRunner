// The whole-group dashboard. Body lives in DashboardView so the per-site
// pages at /dashboard/[siteId] render exactly the same thing.

import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { loadDashboardData, type DashboardData } from './queries';
import { DashboardView } from './DashboardView';

// Never prerender — this page hits Supabase at request time.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function DashboardPage() {
  let data: DashboardData | null = null;
  let fatal: string | null = null;
  try {
    data = await loadDashboardData(sbSchedulingServer());
  } catch (e) {
    fatal = e instanceof Error ? e.message : 'Dashboard data could not be loaded.';
  }
  return <DashboardView data={data} fatal={fatal} />;
}
