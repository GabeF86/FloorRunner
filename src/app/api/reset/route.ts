import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { safeJson, missingFields } from '@/lib/boardApi';
import { readAllRows } from '@/lib/pagedRead';

function server() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

interface BaselineSite {
  name: string; color: string; icon: string; rooms: string[];
}

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await safeJson(req);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  // A reset is destructive and hospital-scoped. Without a hospital there is no
  // scope to delete within, so refuse rather than fall back to "everything".
  const missing = missingFields(body, ['hospital', 'date']);
  if (missing.length) return NextResponse.json({ error: `Missing: ${missing.join(', ')}` }, { status: 400 });

  const hospital       = body.hospital as string;
  const date           = body.date as string;
  const siteIdsToDelete = Array.isArray(body.siteIdsToDelete) ? body.siteIdsToDelete as string[] : [];
  const baseline        = Array.isArray(body.baseline) ? body.baseline as BaselineSite[] : [];

  const sb = server();

  // 1. Clear this hospital's assignments for this date.
  //    Assignments carry no hospital column, so the scope comes from the room →
  //    site → hospital chain. Paged because a partial room list would leave the
  //    board half-cleared with no error; readAllRows returns NO rows with an
  //    error instead, so a failed read can never look like "no rooms here".
  const { rows: hospitalSites, error: sitesReadErr } = await readAllRows<{ id: string }>(
    (from, to) => sb
      .from('sites')
      .select('id', { count: 'exact' })
      .eq('hospital', hospital)
      .order('id')
      .range(from, to),
    'reset: sites for hospital',
  );
  if (sitesReadErr) return NextResponse.json({ error: sitesReadErr }, { status: 500 });

  const siteIds = hospitalSites.map((s) => s.id);
  let roomIds: string[] = [];
  if (siteIds.length > 0) {
    const { rows, error: roomsReadErr } = await readAllRows<{ id: string }>(
      (from, to) => sb
        .from('rooms')
        .select('id', { count: 'exact' })
        .in('site_id', siteIds)
        .order('id')
        .range(from, to),
      'reset: rooms for hospital',
    );
    if (roomsReadErr) return NextResponse.json({ error: roomsReadErr }, { status: 500 });
    roomIds = rows.map((r) => r.id);
  }

  // The float site is shared by every hospital (hospital IS NULL) and its
  // assignments are keyed by the SITE id, not a room id — so they are outside
  // this hospital's scope and are deliberately left alone. Clearing them here
  // would wipe the other hospitals' floats, which is the bug this scoping fixes.
  if (roomIds.length > 0) {
    const { error: aErr } = await sb
      .from('assignments').delete()
      .eq('board_date', date)
      .in('room_id', roomIds);
    if (aErr) return NextResponse.json({ error: aErr.message }, { status: 500 });
  }

  // 2. Delete this hospital's non-float sites. The `.eq('hospital', ...)` is a
  //    server-side guard: the id list comes from the client, and a stale or
  //    wrong list must not be able to delete another hospital's sites.
  if (siteIdsToDelete.length > 0) {
    const { error: sErr } = await sb
      .from('sites').delete()
      .in('id', siteIdsToDelete)
      .eq('hospital', hospital);
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
    // A skipped site is a missing OR on the floor board. Report it instead of
    // returning a short list that reads as a successful reset.
    if (siteErr || !site) {
      return NextResponse.json(
        { error: `Failed to create baseline site "${b.name}": ${siteErr?.message ?? 'no row returned'}`, sites: createdSites },
        { status: 500 },
      );
    }
    const roomInserts = b.rooms.map((name: string, j: number) => ({ site_id: site.id, name, position: j }));
    const { data: rooms, error: roomErr } = await sb.from('rooms').insert(roomInserts).select();
    if (roomErr) {
      return NextResponse.json(
        { error: `Failed to create rooms for "${b.name}": ${roomErr.message}`, sites: createdSites },
        { status: 500 },
      );
    }
    createdSites.push({ ...site, rooms: rooms || [] });
  }

  return NextResponse.json({ sites: createdSites });
}
