import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

// PATCH /api/scheduling/open-call/:id — claim, cancel, or expire an offer
// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sb = sbSchedulingServer();
  const body = await req.json();

  const fields: Record<string, unknown> = {};
  if (body.status) fields.status = body.status;

  // Claim: a provider picks up the open call
  if (body.status === 'claimed' && body.picked_up_by) {
    fields.picked_up_by = body.picked_up_by;
    fields.picked_up_at = new Date().toISOString();

    // Also assign the provider on the underlying assignment
    const { data: offer } = await sb
      .from('open_call_offers')
      .select('assignment_id')
      .eq('id', id)
      .single();

    if (offer) {
      await sb
        .from('assignments')
        .update({
          provider_id: body.picked_up_by,
          assignment_status: 'assigned',
          source_type: 'open_call_pickup',
          assigned_at: new Date().toISOString(),
          is_open_call: false,
        })
        .eq('id', (offer as { assignment_id: string }).assignment_id);
    }
  }

  const { data, error } = await sb
    .from('open_call_offers')
    .update(fields)
    .eq('id', id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// DELETE /api/scheduling/open-call/:id
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sb = sbSchedulingServer();
  const { error } = await sb.from('open_call_offers').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
