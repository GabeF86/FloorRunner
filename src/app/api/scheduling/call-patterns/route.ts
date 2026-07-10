// GET/PUT /api/scheduling/call-patterns — the site's CallPatternDoc store.
//
// GET  ?site_id=…            → { active: row|null, history: row[] } (last 10 archived)
// PUT  { site_id, definition, name?, source? }
//                            → replaces the site's active pattern: archives the
//                              current active row, inserts the new one as active,
//                              returns the inserted row (replaceActivePattern in
//                              src/lib/scheduleAssistant/mutations.ts — shared
//                              with the assistant's update_call_pattern tool).
//   400 { error, issues }    — invalid body / definition fails CallPatternDocSchema
//   500 { error }            — Supabase failure
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { CallPatternDocSchema } from '@/lib/rulesEngine/callPattern';
import { formatZodIssues } from '@/lib/validation/scheduling';
import { replaceActivePattern } from '@/lib/scheduleAssistant/mutations';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

const PutBodySchema = z.object({
  site_id: z.string().min(1),
  definition: CallPatternDocSchema,
  name: z.string().min(1).optional(),
  // 'seed' is migration-only provenance — runtime writers are manual|assistant.
  source: z.enum(['manual', 'assistant']).optional(),
}).strict();

export async function GET(req: NextRequest) {
  const siteId = new URL(req.url).searchParams.get('site_id');
  if (!siteId) {
    return NextResponse.json({ error: 'Query param `site_id` is required.' }, { status: 400 });
  }
  const sb = sbSchedulingServer();

  const { data: active, error: activeErr } = await sb
    .from('call_patterns')
    .select('*')
    .eq('site_id', siteId)
    .eq('status', 'active')
    .maybeSingle();
  if (activeErr) return NextResponse.json({ error: activeErr.message }, { status: 500 });

  const { data: history, error: historyErr } = await sb
    .from('call_patterns')
    .select('*')
    .eq('site_id', siteId)
    .eq('status', 'archived')
    .order('updated_at', { ascending: false })
    .limit(10);
  if (historyErr) return NextResponse.json({ error: historyErr.message }, { status: 500 });

  return NextResponse.json({ active: active ?? null, history: history ?? [] });
}

export async function PUT(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  const parsed = PutBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(formatZodIssues(parsed.error), { status: 400 });
  }

  const sb = sbSchedulingServer();
  const { site_id, definition, name, source } = parsed.data;
  const { data, error } = await replaceActivePattern(sb, site_id, definition, { name, source });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
