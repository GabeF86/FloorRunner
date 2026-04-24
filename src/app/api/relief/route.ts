import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const sb = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const date    = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const history = searchParams.get('history') === 'true';

  let query = sb().from('relief_log').select('*').order('relieved_at');
  if (!history) {
    query = query.eq('board_date', date);
  } else {
    // Return last 30 days for history view
    const since = new Date();
    since.setDate(since.getDate() - 30);
    query = query.gte('board_date', since.toISOString().split('T')[0]).order('board_date', { ascending: false });
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const date = body.board_date || new Date().toISOString().split('T')[0];
  const { data, error } = await sb()
    .from('relief_log')
    .insert({
      staff_id:       body.staff_id,
      staff_name:     body.staff_name,
      staff_role:     body.staff_role,
      staff_initials: body.staff_initials,
      board_date:     date,
      relieved_at:    new Date().toISOString(),
      designation:    body.designation || null,
      shift_hours:    body.shift_hours || null,
    })
    .select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id');
  const { error } = await sb().from('relief_log').delete().eq('id', id!);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
