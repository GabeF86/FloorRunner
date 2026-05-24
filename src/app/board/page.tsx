import { createClient } from '@supabase/supabase-js';
import BoardClient from './BoardClient';
import { Site, StaffMember, Assignment } from '@/types';

// Never prerender — getData() hits Supabase, which only resolves at request
// time on Vercel (env vars aren't present during static export).
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

export default async function BoardPage() {
  const { sites, staff, assignments, today } = await getData();
  return <BoardClient initialSites={sites} initialStaff={staff} initialAssignments={assignments} today={today} />;
}
