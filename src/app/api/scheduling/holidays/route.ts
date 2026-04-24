import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const sb = sbSchedulingServer();
  const url = new URL(req.url);
  const orgId = url.searchParams.get('org_id');
  const siteId = url.searchParams.get('site_id');

  let query = sb
    .from('holiday_calendars')
    .select('*')
    .order('holiday_date');

  if (orgId) query = query.eq('organization_id', orgId);
  if (siteId) query = query.eq('site_id', siteId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();

  const { data, error } = await sb
    .from('holiday_calendars')
    .insert(body)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
