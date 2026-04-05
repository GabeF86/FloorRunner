import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

function server() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

export async function GET() {
  const sb = server();
  const { data, error } = await sb
    .from('sites')
    .select('*, rooms(*)')
    .order('position')
    .order('position', { referencedTable: 'rooms' });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const sb   = server();
  const body = await req.json();
  const row: Record<string, unknown> = { name: body.name, color: body.color, icon: body.icon || '◈', position: body.position || 99 };
  if (body.hospital) row.hospital = body.hospital;
  const { data, error } = await sb
    .from('sites')
    .insert(row)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const sb  = server();
  const { searchParams } = new URL(req.url);
  const id  = searchParams.get('id');
  const { error } = await sb.from('sites').delete().eq('id', id!);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  const sb   = server();
  const body = await req.json();
  const { data, error } = await sb.from('sites').update({ position: body.position }).eq('id', body.id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
