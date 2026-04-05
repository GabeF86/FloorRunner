import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

export async function GET(req: NextRequest) {
  const sb = sbSchedulingServer();
  const orgId = new URL(req.url).searchParams.get('org_id');

  let query = sb.from('sites').select('*').order('display_order');
  if (orgId) query = query.eq('organization_id', orgId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
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
