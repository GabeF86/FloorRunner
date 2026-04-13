import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

// GET /api/scheduling/availability?provider_id=...&from=...&to=...
export async function GET(req: NextRequest) {
  const sb = sbSchedulingServer();
  const { searchParams } = new URL(req.url);
  const providerId = searchParams.get('provider_id');

  let query = sb
    .from('provider_availability')
    .select('*')
    .order('start_date', { ascending: true });

  if (providerId) query = query.eq('provider_id', providerId);

  const from = searchParams.get('from');
  const to = searchParams.get('to');
  if (from) query = query.gte('end_date', from);
  if (to) query = query.lte('start_date', to);

  const status = searchParams.get('approval_status');
  if (status) query = query.eq('approval_status', status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// POST /api/scheduling/availability
export async function POST(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();

  const row = {
    provider_id: body.provider_id,
    site_id: body.site_id || null,
    availability_type: body.availability_type,
    start_date: body.start_date,
    end_date: body.end_date,
    all_day: body.all_day ?? true,
    recurrence_rule: body.recurrence_rule || null,
    reason_code: body.reason_code || null,
    notes: body.notes || null,
    source: body.source || 'manual',
    approval_status: body.approval_status || 'approved',
  };

  const { data, error } = await sb
    .from('provider_availability')
    .insert(row)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
