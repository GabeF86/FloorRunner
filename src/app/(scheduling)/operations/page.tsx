// The operations board — back office's staffing big picture.
//
// Server component: the six reads happen here, on the request, so the browser
// gets HTML with the numbers already in it rather than a shell that fetches
// them. `?date=YYYY-MM-DD` moves the bench and the floor cards (and the week
// the matrix covers); omitted, it is today.

import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { loadOperationsData, type OperationsData } from './queries';
import { OperationsView } from './OperationsView';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Today in the group's local terms. The whole module works in plain
 *  YYYY-MM-DD with no timezone arithmetic — a slot_date is a calendar day, not
 *  an instant — so the only thing that matters is not slipping a day west of
 *  GMT when the server clock is UTC. */
function today(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function OperationsPage(
  { searchParams }: { searchParams?: { date?: string } },
) {
  const raw = searchParams?.date;
  const date = raw && ISO_DATE.test(raw) ? raw : today();

  let data: OperationsData | null = null;
  let fatal: string | null = null;
  try {
    data = await loadOperationsData(sbSchedulingServer(), { date });
  } catch (e) {
    fatal = e instanceof Error ? e.message : 'The operations board could not be loaded.';
  }
  return <OperationsView data={data} fatal={fatal} />;
}
