import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const sb = sbSchedulingServer();
  const { id } = params;
  const body = await req.json();

  const { data, error } = await sb
    .from('rule_definitions')
    .update(body)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const sb = sbSchedulingServer();
  const { id } = params;

  const { error } = await sb
    .from('rule_definitions')
    .delete()
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
