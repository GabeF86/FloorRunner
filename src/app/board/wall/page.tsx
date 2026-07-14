import { createClient } from '@supabase/supabase-js';
import WallClient from './WallClient';
import { Site, StaffMember, Assignment } from '@/types';

// Never prerender — getData() hits Supabase, which only resolves at request
// time on Vercel (env vars aren't present during static export). Mirrors
// board/page.tsx's TODAY-only fetch.
export const dynamic = 'force-dynamic';

async function getData() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  const today = new Date().toISOString().split('T')[0];

  const [sitesRes, staffRes, assignRes] = await Promise.all([
    sb.from('sites').select('*, rooms(*)').order('position').order('position', { referencedTable: 'rooms' }),
    sb.from('staff').select('*').order('role').order('name'),
    sb.from('assignments').select('*, staff(*)').eq('board_date', today),
  ]);

  return {
    sites:       (sitesRes.data   || []) as Site[],
    staff:       (staffRes.data   || []) as StaffMember[],
    assignments: (assignRes.data  || []) as Assignment[],
    today,
  };
}

// Wall display: /board/wall?hospital=<name>
// The `hospital` query param filters sites/rooms (and the header label) by the
// same identifier BoardClient's facility pills use — the sites.hospital NAME
// (e.g. "Paoli Hospital"). Matching is case-insensitive and accepts a unique
// prefix, so ?hospital=Paoli and ?hospital=Paoli%20Hospital both resolve to
// "Paoli Hospital"; an omitted/unrecognized param shows ALL hospitals. Passed
// through from the server so WallClient needs no useSearchParams/Suspense.
export default async function WallPage({ searchParams }: { searchParams: { hospital?: string } }) {
  const { sites, staff, assignments, today } = await getData();
  return (
    <WallClient
      initialSites={sites}
      initialStaff={staff}
      initialAssignments={assignments}
      today={today}
      hospitalParam={searchParams.hospital ?? ''}
    />
  );
}
