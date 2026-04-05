import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

export async function GET(req: NextRequest) {
  const sb = sbSchedulingServer();
  const siteId = new URL(req.url).searchParams.get('site_id');

  let query = sb
    .from('shift_templates')
    .select('*, shift_types(name, code, color_hex)')
    .order('generation_priority');
  if (siteId) query = query.eq('site_id', siteId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();

  const { data, error } = await sb
    .from('shift_templates')
    .insert(body)
    .select('*, shift_types(name, code, color_hex)')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
