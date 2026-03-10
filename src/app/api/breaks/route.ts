import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const sb = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

export async function GET(req: NextRequest) {
  const date = new URL(req.url).searchParams.get('date') || new Date().toISOString().split('T')[0];
  const { data, error } = await sb().from('breaks').select('*').eq('board_date', date);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const body    = await req.json();
  const date    = body.board_date || new Date().toISOString().split('T')[0];
  const taken_at = body.taken ? new Date().toISOString() : null;
  const { data, error } = await sb()
    .from('breaks')
    .upsert(
      { staff_id: body.staff_id, board_date: date, break_type: body.break_type, taken: body.taken, taken_at },
      { onConflict: 'staff_id,board_date,break_type' }
    )
    .select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
