import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

export async function GET(req: NextRequest) {
  const sb = sbSchedulingServer();
  const ruleSetId = new URL(req.url).searchParams.get('rule_set_id');

  let query = sb
    .from('rule_definitions')
    .select('*')
    .order('priority_rank')
    .order('created_at');

  if (ruleSetId) query = query.eq('rule_set_id', ruleSetId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();

  const { data, error } = await sb
    .from('rule_definitions')
    .insert(body)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
