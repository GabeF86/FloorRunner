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

export async function POST(req: NextRequest) {
  const sb   = server();
  const body = await req.json();
  const { data, error } = await sb
    .from('rooms')
    .insert({ site_id: body.site_id, name: body.name, position: body.position || 99 })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const sb  = server();
  const { searchParams } = new URL(req.url);
  const id  = searchParams.get('id');
  const { error } = await sb.from('rooms').delete().eq('id', id!);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  const sb   = server();
  const body = await req.json();
  const updates: Record<string, unknown> = {};
  if (body.name      !== undefined) updates.name       = body.name;
  if (body.sort_order !== undefined) updates.sort_order = body.sort_order;
  const { data, error } = await sb
    .from('rooms')
    .update(updates)
    .eq('id', body.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
