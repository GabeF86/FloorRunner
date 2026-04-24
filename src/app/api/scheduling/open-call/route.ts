import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

// GET /api/scheduling/open-call?status=...&site_id=...
export async function GET(req: NextRequest) {
  const sb = sbSchedulingServer();
  const { searchParams } = new URL(req.url);

  let query = sb
    .from('open_call_offers')
    .select(
      '*, assignments:assignment_id(id, schedule_slots(slot_date, shift_types(code, name))), sites:site_id(id, name, short_name), claimer:picked_up_by(id, short_display_name, initials)',
    )
    .order('posted_at', { ascending: false });

  const status = searchParams.get('status');
  if (status) query = query.eq('status', status);

  const siteId = searchParams.get('site_id');
  if (siteId) query = query.eq('site_id', siteId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// POST /api/scheduling/open-call — post an open-call offer for an assignment
export async function POST(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();

  const { data, error } = await sb
    .from('open_call_offers')
    .insert({
      assignment_id: body.assignment_id,
      site_id: body.site_id,
      posted_at: new Date().toISOString(),
      status: 'open',
      eligible_pool: body.eligible_pool || [],
      premium_type: body.premium_type || null,
      premium_amount: body.premium_amount || null,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Mark the assignment as open_call
  if (body.assignment_id) {
    await sb
      .from('assignments')
      .update({ is_open_call: true })
      .eq('id', body.assignment_id);
  }

  return NextResponse.json(data);
}
