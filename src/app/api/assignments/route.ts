import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { safeJson, missingFields } from '@/lib/boardApi';

function server() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const sb   = server();
  const date = new URL(req.url).searchParams.get('date') || new Date().toISOString().split('T')[0];
  const { data, error } = await sb
    .from('assignments')
    .select('*, staff(*)')
    .eq('board_date', date);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const body = await safeJson(req);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  const missing = missingFields(body, ['staff_id', 'room_id']);
  if (missing.length) return NextResponse.json({ error: `Missing: ${missing.join(', ')}` }, { status: 400 });

  const sb = server();
  const date = (body.board_date as string) || new Date().toISOString().split('T')[0];

  // Physicians can cover multiple rooms simultaneously — keep their other
  // assignments. Everyone else moves room-to-room: clear prior, then place.
  if (body.role !== 'physician') {
    const { error: delErr } = await sb
      .from('assignments').delete()
      .eq('staff_id', body.staff_id).eq('board_date', date);
    // Surface the delete failure instead of silently upserting on top of it.
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  const { data, error } = await sb
    .from('assignments')
    .upsert(
      { room_id: body.room_id, staff_id: body.staff_id, board_date: date },
      { onConflict: 'staff_id,room_id,board_date' },
    )
    .select('*, staff(*)')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  const { error } = await server().from('assignments').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
