import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { writeSiteCredential } from './route.helpers';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

// POST creates a credential, or PARTIALLY updates an existing one: only the
// columns the body names are written. The merge semantics and the reasoning
// live in route.helpers.ts, where they are testable — in short, the previous
// full-row upsert defaulted every absent boolean to TRUE and every absent array
// to EMPTY, so a caller could not change one flag without resending the other
// ten, and a client resending a stale copy silently reverted concurrent edits.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: providerId } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const { status, body: payload } = await writeSiteCredential(
    sbSchedulingServer(), providerId, body as Record<string, unknown>,
  );
  return NextResponse.json(payload, { status });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: providerId } = await params;
  const sb = sbSchedulingServer();
  const { data, error } = await sb
    .from('provider_site_credentials')
    .select('*, sites:site_id(id, name, short_name)')
    .eq('provider_id', providerId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// DELETE /api/scheduling/providers/:id/site-credentials?site_id=...
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: providerId } = await params;
  const sb = sbSchedulingServer();
  const siteId = new URL(req.url).searchParams.get('site_id');
  if (!siteId) return NextResponse.json({ error: 'site_id is required' }, { status: 400 });

  const { error } = await sb
    .from('provider_site_credentials')
    .delete()
    .eq('provider_id', providerId)
    .eq('site_id', siteId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
