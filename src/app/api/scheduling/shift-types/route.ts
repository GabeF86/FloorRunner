import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { ShiftTypeUpsertSchema, formatZodIssues } from '@/lib/validation/scheduling';
import { listShiftTypes } from '@/lib/queries/config';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // Query logic lives in lib/queries/config.ts so the /sites server component,
  // which counts these per site, cannot drift from what this route returns.
  const siteId = new URL(req.url).searchParams.get('site_id');
  const result = await listShiftTypes(sbSchedulingServer(), siteId);
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
  const parsed = ShiftTypeUpsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(formatZodIssues(parsed.error), { status: 400 });
  }

  const sb = sbSchedulingServer();
  const { data, error } = await sb
    .from('shift_types')
    .insert(parsed.data)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
