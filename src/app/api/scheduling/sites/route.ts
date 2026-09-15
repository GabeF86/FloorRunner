import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { listSites } from '@/lib/queries/roster';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const orgId = new URL(req.url).searchParams.get('org_id');
  const result = await listSites(sbSchedulingServer(), orgId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.rows);
}

export async function POST(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();
  const { data, error } = await sb
    .from('sites')
    .insert({
      organization_id: body.organization_id,
      name: body.name,
      short_name: body.short_name || null,
      site_type: body.site_type || 'hospital',
      address: body.address || null,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
