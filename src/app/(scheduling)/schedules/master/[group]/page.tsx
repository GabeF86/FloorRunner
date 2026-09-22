// Master Physician / Master CRNA schedule — every site in one document.
//
// Viewable by everyone signed in: it is built from PUBLISHED schedules only,
// which is precisely the set a provider is already entitled to see, so no
// per-row permission scoping is needed here. Drafts never reach it.

import { notFound } from 'next/navigation';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import type { CoverageGroup } from '@/lib/operationsBoard';
import { loadMasterSchedule } from './queries';
import { MasterScheduleView } from './MasterScheduleView';

// Never prerender — per-request data, and the window moves with today.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const GROUPS: Record<string, CoverageGroup> = {
  physician: 'physician',
  crna: 'crna',
};

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default async function MasterSchedulePage(
  { params }: { params: Promise<{ group: string }> },
) {
  const { group: raw } = await params;
  const group = GROUPS[raw];
  // An unknown discipline is a 404, not an empty sheet — "/schedules/master/
  // surgeons" rendering a blank physician schedule would be a lie.
  if (!group) notFound();

  const sb = sbSchedulingServer();
  let data;
  let fatal: string | null = null;
  try {
    data = await loadMasterSchedule(sb, group, todayISO());
  } catch (e) {
    fatal = e instanceof Error ? e.message : 'The master schedule could not be loaded.';
  }

  return (
    <MasterScheduleView
      group={group}
      data={data ?? null}
      fatal={fatal}
    />
  );
}
