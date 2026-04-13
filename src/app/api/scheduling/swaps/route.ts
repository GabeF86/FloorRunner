import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

// GET /api/scheduling/swaps?status=...&provider_id=...
export async function GET(req: NextRequest) {
  const sb = sbSchedulingServer();
  const { searchParams } = new URL(req.url);

  let query = sb
    .from('swap_requests')
    .select(
      '*, initiator:initiating_provider_id(id, short_display_name, initials, provider_type), target:target_provider_id(id, short_display_name, initials, provider_type), slot:schedule_slot_id(id, slot_date, shift_types(code, name)), proposed_slot:proposed_new_schedule_slot_id(id, slot_date, shift_types(code, name))',
    )
    .order('submitted_at', { ascending: false });

  const status = searchParams.get('status');
  if (status) query = query.eq('status', status);

  const providerId = searchParams.get('provider_id');
  if (providerId) {
    query = query.or(`initiating_provider_id.eq.${providerId},target_provider_id.eq.${providerId}`);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// POST /api/scheduling/swaps
export async function POST(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();

  const { data, error } = await sb
    .from('swap_requests')
    .insert({
      initiating_provider_id: body.initiating_provider_id,
      target_provider_id: body.target_provider_id,
      schedule_slot_id: body.schedule_slot_id,
      proposed_new_schedule_slot_id: body.proposed_new_schedule_slot_id || null,
      notes: body.notes || null,
      status: 'pending',
      submitted_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
