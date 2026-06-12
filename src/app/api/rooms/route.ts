import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { safeJson, missingFields, nextPosition } from '@/lib/boardApi';

function server() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await safeJson(req);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  const missing = missingFields(body, ['site_id', 'name']);
  if (missing.length) return NextResponse.json({ error: `Missing: ${missing.join(', ')}` }, { status: 400 });

  const sb = server();
  // Give the new room the next free position in its site (the client sends a
  // placeholder 99; computing max+1 prevents every new room colliding).
  // Surface a failed sibling lookup rather than silently inserting at 0.
  const { data: siblings, error: sibErr } = await sb
    .from('rooms').select('position').eq('site_id', body.site_id);
  if (sibErr) return NextResponse.json({ error: sibErr.message }, { status: 500 });
  const position = nextPosition((siblings as Array<{ position: number | null }> | null) ?? []);

  const { data, error } = await sb
    .from('rooms')
    .insert({ site_id: body.site_id, name: body.name, position, sort_order: position })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  const { error } = await server().from('rooms').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  const body = await safeJson(req);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  if (!body.id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  // Reorder fix: the board reads rooms by `position`, so an order change must
  // land in `position`. We accept either key from the client and write BOTH so
  // the two columns stay in sync and the new order actually persists.
  const order = body.sort_order ?? body.position;
  if (order !== undefined) { updates.position = order; updates.sort_order = order; }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  const { data, error } = await server()
    .from('rooms').update(updates).eq('id', body.id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
