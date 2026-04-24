import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { validateCompensation } from '@/lib/validation/compensation';

// GET /api/scheduling/providers/:id/compensation
// Returns the provider's compensation row, or an empty object if not yet set.
// NOTE: there is no authz enforcement here today — this is currently returned
// to anyone who can reach the endpoint. When auth + RLS land, gate this table
// behind an "admin" role.
// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: providerId } = await params;
  const sb = sbSchedulingServer();

  const { data: provider } = await sb
    .from('providers')
    .select('id')
    .eq('id', providerId)
    .maybeSingle();
  if (!provider) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });

  const { data, error } = await sb
    .from('provider_compensation')
    .select('*')
    .eq('provider_id', providerId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? {});
}

// PUT /api/scheduling/providers/:id/compensation
// Full-upsert semantics: the request body is the single source of truth for
// this provider's comp row. Omitted fields are left untouched if the row
// already exists, or default to NULL on first insert. That matches the UI
// pattern of editing one section at a time.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: providerId } = await params;
  const sb = sbSchedulingServer();
  const body = await req.json();

  const v = validateCompensation(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const { data: provider } = await sb
    .from('providers')
    .select('id')
    .eq('id', providerId)
    .maybeSingle();
  if (!provider) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });

  const { data, error } = await sb
    .from('provider_compensation')
    .upsert({ provider_id: providerId, ...v.row }, { onConflict: 'provider_id' })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
