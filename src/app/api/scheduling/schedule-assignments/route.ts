import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

export async function POST(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();

  // Update existing assignment for this slot
  const { data: updated, error: updErr } = await sb
    .from('assignments')
    .update({
      provider_id: body.provider_id,
      assignment_status: 'assigned',
      source_type: 'manual',
      assigned_at: new Date().toISOString(),
    })
    .eq('schedule_slot_id', body.schedule_slot_id)
    .select()
    .maybeSingle();

  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  if (updated) return NextResponse.json(updated);

  // No existing assignment — insert new
  const { data, error } = await sb
    .from('assignments')
    .insert({
      schedule_slot_id: body.schedule_slot_id,
      provider_id: body.provider_id,
      assignment_status: 'assigned',
      source_type: 'manual',
      assigned_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();
  const { id, ...fields } = body;

  const { data, error } = await sb
    .from('assignments')
    .update(fields)
    .eq('id', id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const sb = sbSchedulingServer();
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  // Get the slot ID before deleting so we can recreate an open assignment
  const { data: existing } = await sb
    .from('assignments')
    .select('schedule_slot_id')
    .eq('id', id)
    .single();

  // Delete the assignment
  const { error } = await sb.from('assignments').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Recreate as open
  if (existing) {
    const { data: newOpen, error: insertErr } = await sb
      .from('assignments')
      .insert({
        schedule_slot_id: existing.schedule_slot_id,
        assignment_status: 'open',
        source_type: 'manual',
      })
      .select()
      .single();
    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });
    return NextResponse.json(newOpen);
  }

  return NextResponse.json({ ok: true });
}
