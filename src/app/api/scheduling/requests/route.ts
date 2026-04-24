import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

// GET /api/scheduling/requests?provider_id=...&status=...&org_id=...
export async function GET(req: NextRequest) {
  const sb = sbSchedulingServer();
  const { searchParams } = new URL(req.url);

  let query = sb
    .from('provider_requests')
    .select('*, providers:provider_id(id, first_name, last_name, short_display_name, initials, provider_type)')
    .order('submitted_at', { ascending: false });

  const providerId = searchParams.get('provider_id');
  if (providerId) query = query.eq('provider_id', providerId);

  const status = searchParams.get('status');
  if (status) query = query.eq('status', status);

  const requestType = searchParams.get('request_type');
  if (requestType) query = query.eq('request_type', requestType);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// POST /api/scheduling/requests
export async function POST(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();

  const row = {
    provider_id: body.provider_id,
    site_id: body.site_id || null,
    request_type: body.request_type,
    start_date: body.start_date,
    end_date: body.end_date,
    part_of_day: body.part_of_day || null,
    recurrence_rule: body.recurrence_rule || null,
    notes: body.notes || null,
    status: 'pending',
    submitted_at: new Date().toISOString(),
  };

  const { data, error } = await sb
    .from('provider_requests')
    .insert(row)
    .select('*, providers:provider_id(id, first_name, last_name, short_display_name, initials, provider_type)')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
