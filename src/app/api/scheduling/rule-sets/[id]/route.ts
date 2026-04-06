import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const sb = sbSchedulingServer();
  const { id } = params;

  const { data, error } = await sb
    .from('rule_sets')
    .select('*, sites(name), rule_definitions(*)')
    .eq('id', id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const sb = sbSchedulingServer();
  const { id } = params;
  const body = await req.json();

  // When activating, set approved_at
  if (body.status === 'active') {
    body.approved_at = new Date().toISOString();
  }

  const { data, error } = await sb
    .from('rule_sets')
    .update(body)
    .eq('id', id)
    .select('*, sites(name), rule_definitions(*)')
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

  const { data, error } = await sb
    .from('rule_sets')
    .update({ status: 'archived' })
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
