import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { RuleDefinitionUpsertSchema, formatZodIssues } from '@/lib/validation/scheduling';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

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
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }
  const parsed = RuleDefinitionUpsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(formatZodIssues(parsed.error), { status: 400 });
  }

  const sb = sbSchedulingServer();
  const { data, error } = await sb
    .from('rule_definitions')
    .insert(parsed.data)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
