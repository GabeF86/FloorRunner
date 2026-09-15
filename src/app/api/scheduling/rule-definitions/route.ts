import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { RuleDefinitionUpsertSchema, formatZodIssues } from '@/lib/validation/scheduling';
import { listRuleDefinitions } from '@/lib/queries/config';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // Query logic lives in lib/queries/config.ts so the /rules server component,
  // which reads these to count rules per rule set, cannot drift from it.
  const ruleSetId = new URL(req.url).searchParams.get('rule_set_id');
  const result = await listRuleDefinitions(sbSchedulingServer(), ruleSetId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.rows);
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
