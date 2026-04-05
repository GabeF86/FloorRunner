import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const sb = sbSchedulingServer();
  const { id } = await params;
  const body = await req.json();

  const updates: Record<string, unknown> = {};
  if (body.locked !== undefined) updates.locked = body.locked;
  if (body.slot_label !== undefined) updates.slot_label = body.slot_label;

  const { data, error } = await sb
    .from('schedule_slots')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
