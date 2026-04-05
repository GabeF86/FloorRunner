import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

export async function POST(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();

  // Check if an assignment already exists for this slot
  const { data: existing, error: checkErr } = await sb
    .from('assignments')
    .select('id, assignment_status')
    .eq('schedule_slot_id', body.schedule_slot_id)
    .limit(1)
    .maybeSingle();
  if (checkErr) return NextResponse.json({ error: checkErr.message }, { status: 500 });

  if (existing && existing.assignment_status === 'open') {
    // Update existing open assignment
    const { data, error } = await sb
      .from('assignments')
      .update({
        provider_id: body.provider_id,
        assignment_status: 'assigned',
        source_type: 'manual',
        assigned_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  // Insert new assignment
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

  const { data, error } = await sb
    .from('assignments')
    .update({
      assignment_status: 'open',
      provider_id: null,
      assigned_at: null,
    })
    .eq('id', id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
