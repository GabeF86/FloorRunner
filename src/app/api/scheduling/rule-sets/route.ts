import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { listRuleSets, ruleSetFiltersFrom } from '@/lib/queries/config';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // Query logic lives in lib/queries/config.ts so the /rules server component
  // that renders this same list cannot drift from it.
  const { searchParams } = new URL(req.url);
  const result = await listRuleSets(sbSchedulingServer(), ruleSetFiltersFrom(searchParams));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.rows);
}

export async function POST(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();

  const { data, error } = await sb
    .from('rule_sets')
    .insert({
      organization_id: body.organization_id,
      site_id: body.site_id,
      name: body.name,
      status: 'draft',
    })
    .select('*, sites(name)')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
