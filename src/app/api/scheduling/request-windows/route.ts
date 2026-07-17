import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { RequestWindowCreateSchema } from '@/lib/validation/requestIntake';
import { formatZodIssues } from '@/lib/validation/scheduling';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

// GET /api/scheduling/request-windows?site_id=...&status=open
export async function GET(req: NextRequest) {
  const sb = sbSchedulingServer();
  const { searchParams } = new URL(req.url);

  let query = sb
    .from('request_windows')
    .select('*')
    .order('opened_at', { ascending: false });

  const siteId = searchParams.get('site_id');
  if (siteId) query = query.eq('site_id', siteId);

  const status = searchParams.get('status');
  if (status) {
    if (status !== 'open' && status !== 'closed') {
      return NextResponse.json({ error: 'status must be open or closed' }, { status: 400 });
    }
    query = query.eq('status', status);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}

// POST /api/scheduling/request-windows
// Opens a submission window for a site. The share token is generated HERE —
// crypto-random, never client-supplied — because the token is the only gate
// on the public intake page (no auth in this app).
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }
  const parsed = RequestWindowCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(formatZodIssues(parsed.error), { status: 400 });
  }

  const sb = sbSchedulingServer();

  // One open window per site (also a partial unique index in patch29 —
  // this check just turns the constraint violation into a friendly 409).
  const { data: existing, error: existErr } = await sb
    .from('request_windows')
    .select('id')
    .eq('site_id', parsed.data.site_id)
    .eq('status', 'open')
    .maybeSingle();
  if (existErr) return NextResponse.json({ error: existErr.message }, { status: 500 });
  if (existing) {
    return NextResponse.json(
      { error: 'This site already has an open request window. Close it before opening a new one.' },
      { status: 409 },
    );
  }

  const row = {
    site_id: parsed.data.site_id,
    block_start: parsed.data.block_start,
    block_end: parsed.data.block_end,
    max_no_call_requests: parsed.data.max_no_call_requests ?? 3,
    token: randomBytes(18).toString('base64url'), // 24 url-safe chars
    status: 'open',
  };

  const { data, error } = await sb
    .from('request_windows')
    .insert(row)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
