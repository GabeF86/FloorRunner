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
  const sb = server();
  const { searchParams } = new URL(req.url);
  const hospital = searchParams.get('hospital');

  let query = sb.from('staff').select('*').order('role').order('name');
  if (hospital) query = query.eq('hospital', hospital);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const sb   = server();
  const body = await req.json();
  const row: Record<string, unknown> = { name: body.name, initials: body.initials, role: body.role, hours: body.hours };
  if (body.hospital) row.hospital = body.hospital;
  const { data, error } = await sb
    .from('staff')
    .insert(row)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  const sb   = server();
  const body = await req.json();
  const updates: Record<string, unknown> = {};
  if (body.hours !== undefined) updates.hours = body.hours;
  if (body.hospital) updates.hospital = body.hospital;
  const { data, error } = await sb
    .from('staff')
    .update(updates)
    .eq('id', body.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const sb  = server();
  const { searchParams } = new URL(req.url);
  const id  = searchParams.get('id');
  const { error } = await sb.from('staff').delete().eq('id', id!);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
