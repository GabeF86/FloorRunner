import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

function server() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

interface BaselineSite {
  name: string; color: string; icon: string; rooms: string[];
}

export async function POST(req: NextRequest) {
  const sb = server();
  const body = await req.json();
  const { hospital, date, siteIdsToDelete, baseline }: {
    hospital: string; date: string; siteIdsToDelete: string[]; baseline: BaselineSite[];
  } = body;

  // 1. Clear all assignments for this date
  const { error: aErr } = await sb.from('assignments').delete().eq('board_date', date);
  if (aErr) return NextResponse.json({ error: aErr.message }, { status: 500 });

  // 2. Delete all non-float sites for this hospital
  if (siteIdsToDelete.length > 0) {
    const { error: sErr } = await sb.from('sites').delete().in('id', siteIdsToDelete);
    if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 });
  }

  // 3. Create baseline sites and rooms
  const createdSites = [];
  for (let i = 0; i < baseline.length; i++) {
    const b = baseline[i];
    const { data: site, error: siteErr } = await sb
      .from('sites')
      .insert({ name: b.name, color: b.color, icon: b.icon, position: i, hospital })
      .select().single();
    if (siteErr || !site) continue;
    const roomInserts = b.rooms.map((name: string, j: number) => ({ site_id: site.id, name, position: j }));
    const { data: rooms } = await sb.from('rooms').insert(roomInserts).select();
    createdSites.push({ ...site, rooms: rooms || [] });
  }

  return NextResponse.json({ sites: createdSites });
}
