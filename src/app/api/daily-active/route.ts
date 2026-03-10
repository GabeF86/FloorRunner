import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const sb = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET(req: NextRequest) {
  const date = new URL(req.url).searchParams.get('date') || new Date().toISOString().split('T')[0];
  const { data, error } = await sb().from('daily_active').select('*').eq('board_date', date);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const date = body.board_date || new Date().toISOString().split('T')[0];
  const { data, error } = await sb()
    .from('daily_active')
    .upsert({ staff_id: body.staff_id, board_date: date }, { onConflict: 'staff_id,board_date' })
    .select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const staff_id   = searchParams.get('staff_id');
  const board_date = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const { error }  = await sb().from('daily_active').delete()
    .eq('staff_id', staff_id!).eq('board_date', board_date);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
