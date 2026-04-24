import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

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
  const sb   = server();
  const body = await req.json();
  const date = body.board_date || new Date().toISOString().split('T')[0];

  // Physicians can cover multiple rooms simultaneously — don't remove their other assignments.
  // All other roles move from room to room (one assignment at a time).
  if (body.role !== 'physician') {
    await sb
      .from('assignments')
      .delete()
      .eq('staff_id', body.staff_id)
      .eq('board_date', date);
  }

  // Prevent duplicate: physician already in this exact room today
  if (body.role === 'physician') {
    const { data: existing } = await sb
      .from('assignments')
      .select('id')
      .eq('staff_id', body.staff_id)
      .eq('room_id', body.room_id)
      .eq('board_date', date)
      .maybeSingle();
    if (existing) {
      // Already assigned here — return it as-is
      const { data: full } = await sb
        .from('assignments')
        .select('*, staff(*)')
        .eq('id', existing.id)
        .single();
      return NextResponse.json(full);
    }
  }

  const { data, error } = await sb
    .from('assignments')
    .insert({ room_id: body.room_id, staff_id: body.staff_id, board_date: date })
    .select('*, staff(*)')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const sb  = server();
  const { searchParams } = new URL(req.url);
  const id  = searchParams.get('id');
  const { error } = await sb.from('assignments').delete().eq('id', id!);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
