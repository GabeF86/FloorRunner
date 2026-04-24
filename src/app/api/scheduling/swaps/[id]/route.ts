import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

// PATCH /api/scheduling/swaps/:id — approve/deny/cancel swap + execute if approved
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sb = sbSchedulingServer();
  const body = await req.json();

  const fields: Record<string, unknown> = {};
  if (body.status) {
    fields.status = body.status;
    if (body.status === 'approved') {
      fields.approved_at = new Date().toISOString();
    }
    if (body.status !== 'pending') {
      fields.responded_at = new Date().toISOString();
    }
  }
  if (body.notes !== undefined) fields.notes = body.notes;

  const { data: updated, error } = await sb
    .from('swap_requests')
    .update(fields)
    .eq('id', id)
    .select('*, initiating_provider_id, target_provider_id, schedule_slot_id, proposed_new_schedule_slot_id')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // If approved, execute the swap: swap the provider_ids on the two assignments
  if (body.status === 'approved' && updated) {
    const swap = updated as {
      initiating_provider_id: string;
      target_provider_id: string;
      schedule_slot_id: string;
      proposed_new_schedule_slot_id: string | null;
    };

    // Update the initiator's slot to the target provider
    await sb
      .from('assignments')
      .update({
        provider_id: swap.target_provider_id,
        source_type: 'swap',
        assigned_at: new Date().toISOString(),
      })
      .eq('schedule_slot_id', swap.schedule_slot_id)
      .eq('provider_id', swap.initiating_provider_id);

    // If there's a proposed counter-slot, assign the initiator there
    if (swap.proposed_new_schedule_slot_id) {
      await sb
        .from('assignments')
        .update({
          provider_id: swap.initiating_provider_id,
          source_type: 'swap',
          assigned_at: new Date().toISOString(),
        })
        .eq('schedule_slot_id', swap.proposed_new_schedule_slot_id)
        .eq('provider_id', swap.target_provider_id);
    }
  }

  return NextResponse.json(updated);
}

// DELETE /api/scheduling/swaps/:id
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sb = sbSchedulingServer();
  const { error } = await sb.from('swap_requests').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
