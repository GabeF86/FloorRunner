import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import {
  APPROVAL_STATUSES,
  AVAILABILITY_TYPES,
  isValidDate,
} from '@/lib/validation/providers';

// Availability data changes out of band of the schedule grid — the Next
// default caching would happily serve an old version for up to an hour
// otherwise. Force every request through.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
  if (from) {
    if (!isValidDate(from)) return NextResponse.json({ error: 'from must be YYYY-MM-DD' }, { status: 400 });
    query = query.gte('end_date', from);
  }
  if (to) {
    if (!isValidDate(to)) return NextResponse.json({ error: 'to must be YYYY-MM-DD' }, { status: 400 });
    query = query.lte('start_date', to);
  }

  const status = searchParams.get('approval_status');
  if (status) {
    if (!(APPROVAL_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json(
        { error: `approval_status must be one of: ${APPROVAL_STATUSES.join(', ')}` },
        { status: 400 },
      );
    }
    query = query.eq('approval_status', status);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}

// POST /api/scheduling/availability
export async function POST(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();

  if (!body.provider_id || typeof body.provider_id !== 'string') {
    return NextResponse.json({ error: 'provider_id is required' }, { status: 400 });
  }
  if (!(AVAILABILITY_TYPES as readonly string[]).includes(body.availability_type)) {
    return NextResponse.json(
      { error: `availability_type must be one of: ${AVAILABILITY_TYPES.join(', ')}` },
      { status: 400 },
    );
  }
  if (!isValidDate(body.start_date)) {
    return NextResponse.json({ error: 'start_date must be YYYY-MM-DD' }, { status: 400 });
  }
  if (!isValidDate(body.end_date)) {
    return NextResponse.json({ error: 'end_date must be YYYY-MM-DD' }, { status: 400 });
  }
  if (body.end_date < body.start_date) {
    return NextResponse.json(
      { error: 'end_date must be on or after start_date' },
      { status: 400 },
    );
  }
  if (body.approval_status &&
      !(APPROVAL_STATUSES as readonly string[]).includes(body.approval_status)) {
    return NextResponse.json(
      { error: `approval_status must be one of: ${APPROVAL_STATUSES.join(', ')}` },
      { status: 400 },
    );
  }

  // If site_id is provided, confirm it belongs to the provider's org.
  if (body.site_id) {
    const [{ data: prov }, { data: site }] = await Promise.all([
      sb.from('providers').select('organization_id').eq('id', body.provider_id).maybeSingle(),
      sb.from('sites').select('organization_id').eq('id', body.site_id).maybeSingle(),
    ]);
    if (!prov || !site || prov.organization_id !== site.organization_id) {
      return NextResponse.json(
        { error: 'site_id does not belong to this provider\u2019s organization' },
        { status: 400 },
      );
    }
  }

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
