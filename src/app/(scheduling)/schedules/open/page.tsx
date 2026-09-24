// Jump straight from the nav to a site's CURRENT schedule for one discipline.
//
// Gabriel 2026-09-24: picking a site in the Schedules nav used to land on the
// list of every site's cards, which is two more clicks and a hunt from the
// thing he actually wanted — this site, this discipline, open, at this week.
// The nav now asks Physicians or CRNAs and sends you here; this page works out
// WHICH schedule that is and redirects.
//
// ── WHY A SERVER REDIRECT AND NOT A CLIENT FETCH ───────────────────────────
// The answer is one row of the database and the user is already mid-navigation.
// Fetching it in the flyout would mean a spinner in a popover, then a second
// navigation. Here the browser is told the real destination once.
//
// ── THE THING THIS PAGE MUST NOT DO ────────────────────────────────────────
// Silently land somewhere plausible. Two sites (JSCNY, RH) have NO CRNA
// schedule at all, and a read can fail. Dropping the user on the list page in
// either case looks identical to "you asked for the list" — so an unresolved
// jump says what happened and offers the list as a link, and a FAILED read
// never claims the schedule is missing.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { Card, Banner, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Today as a calendar day, not an instant — the same helper the operations
 *  board uses, for the same reason: a slot_date has no timezone, and a UTC
 *  server clock must not read as tomorrow to somebody on the east coast. */
function today(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/** Published beats draft beats archived. A provider following this link should
 *  land on the schedule the group is actually working to; the draft is only a
 *  better answer when nothing is published over today. */
const STATUS_RANK: Record<string, number> = { published: 0, draft: 1, archived: 2 };

interface Row {
  id: string;
  schedule_name: string | null;
  date_start: string;
  date_end: string;
  status: string;
}

export default async function OpenSchedulePage(
  { searchParams }: { searchParams?: { site_id?: string; group?: string } },
) {
  const siteId = searchParams?.site_id;
  const group = searchParams?.group === 'crna' ? 'crna' : 'physician';
  const label = group === 'crna' ? 'CRNA' : 'physician';
  if (!siteId) redirect('/schedules');

  const sb = sbSchedulingServer();
  const day = today();

  const [siteRes, listRes] = await Promise.all([
    sb.from('sites').select('name, short_name').eq('id', siteId).maybeSingle(),
    sb.from('schedules')
      .select('id, schedule_name, date_start, date_end, status')
      .eq('site_id', siteId)
      .eq('provider_group', group)
      .is('deleted_at', null)
      .order('date_start', { ascending: false }),
  ]);

  const siteName = siteRes.data?.short_name || siteRes.data?.name || 'this site';

  // A failed read is NOT an empty result. Saying "no CRNA schedule exists"
  // because the query errored would send a chief looking for a schedule that
  // is sitting right there.
  if (listRes.error) {
    return (
      <>
        <PageHeader title={`${siteName} — ${label} schedule`} />
        <Banner tone="error">
          The schedules for {siteName} could not be read, so the current one could not
          be found. This is a read failure, not an empty schedule list.{' '}
          {listRes.error.message}
        </Banner>
        <p style={{ marginTop: 'var(--space-3)' }}>
          <Link href={`/schedules?site_id=${siteId}`}>Open the schedules list instead</Link>
        </p>
      </>
    );
  }

  const rows = (listRes.data ?? []) as Row[];

  // 1. Covering today — what "current" means.
  const covering = rows
    .filter(r => r.date_start <= day && day <= r.date_end)
    .sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
      || b.date_start.localeCompare(a.date_start));
  if (covering[0]) redirect(`/schedules/${covering[0].id}?week=current`);

  // 2. Nothing covers today: the next block that starts. Better than the list
  //    page — it is still the answer to "show me this site's schedule" — but
  //    it is NOT silently pretended to be current, so ?week=current is left
  //    off and the grid opens where it naturally starts.
  const upcoming = rows
    .filter(r => r.date_start > day)
    .sort((a, b) => a.date_start.localeCompare(b.date_start)
      || (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9));
  if (upcoming[0]) redirect(`/schedules/${upcoming[0].id}`);

  // 3. Genuinely nothing. Say which of the two cases it is.
  return (
    <>
      <PageHeader title={`${siteName} — ${label} schedule`} />
      <Card>
        <p style={{ margin: 0, lineHeight: 1.6 }}>
          {rows.length === 0
            ? `No ${label} schedule has been built for ${siteName} yet.`
            : `${siteName} has ${rows.length} ${label} schedule${rows.length === 1 ? '' : 's'}, `
              + `but none of them covers today or any future date.`}
        </p>
        <p style={{ marginTop: 'var(--space-3)', marginBottom: 0 }}>
          <Link href={`/schedules?site_id=${siteId}`}>
            See every schedule for {siteName}
          </Link>
        </p>
      </Card>
    </>
  );
}
