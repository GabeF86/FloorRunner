import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { IntakeSubmissionSchema, windowNotesTag } from '@/lib/validation/requestIntake';
import { formatZodIssues } from '@/lib/validation/scheduling';

// PUBLIC intake endpoint — sits outside /api/scheduling deliberately: the
// token in the URL is the trust boundary (this app has no auth; internal
// routes assume a trusted operator, this one assumes a shared link).
// Everything is re-validated server-side against the window row:
//   - token must resolve to a window; the window must be OPEN
//   - the provider must be on the window site's active roster (home-site)
//   - no-call dates must fall inside the block
//   - the per-provider no-call cap is enforced by counting existing
//     window-sourced rows (notes = request_window:<id>)
//   - site_id always derives from the window; the body's is ignored
//
// Writes:
//   PTO ranges      → provider_requests (request_type 'pto', pending)      — approval queue
//   Days-off ranges → provider_requests (request_type 'availability_change', pending)
//   No-call dates   → provider_availability DIRECTLY (type 'no_call_request',
//                     approved, source 'request_window') — no human approval;
//                     the scheduling engine arbitrates these softly.
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }
  const parsed = IntakeSubmissionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(formatZodIssues(parsed.error), { status: 400 });
  }
  const { provider_id, pto, days_off, no_call_dates } = parsed.data;

  if (pto.length === 0 && days_off.length === 0 && no_call_dates.length === 0) {
    return NextResponse.json({ error: 'Nothing to submit — add at least one entry.' }, { status: 400 });
  }

  const sb = sbSchedulingServer();

  // 1. Token → window. Unknown token and closed window get distinct statuses
  //    so the form can render a friendly "window closed" state.
  const { data: window, error: winErr } = await sb
    .from('request_windows')
    .select('id, site_id, block_start, block_end, max_no_call_requests, status')
    .eq('token', token)
    .maybeSingle();
  if (winErr) return NextResponse.json({ error: winErr.message }, { status: 500 });
  if (!window) return NextResponse.json({ error: 'This request link is not valid.' }, { status: 404 });
  if (window.status !== 'open') {
    return NextResponse.json({ error: 'This request window has closed.' }, { status: 410 });
  }

  // 2. Roster gate: active provider whose home site is the window's site.
  const [{ data: provider }, { data: profile }] = await Promise.all([
    sb.from('providers').select('id, status').eq('id', provider_id).maybeSingle(),
    sb.from('provider_employment_profiles').select('home_site_id').eq('provider_id', provider_id).maybeSingle(),
  ]);
  if (!provider || provider.status !== 'active' || profile?.home_site_id !== window.site_id) {
    return NextResponse.json(
      { error: 'This provider is not on the active roster for this site.' },
      { status: 403 },
    );
  }

  // 3. No-call dates: inside the block, deduped, capped per provider.
  const requestedNoCall = [...new Set(no_call_dates)].sort();
  for (const d of requestedNoCall) {
    if (d < window.block_start || d > window.block_end) {
      return NextResponse.json(
        { error: `No-call date ${d} is outside the block (${window.block_start} – ${window.block_end}).` },
        { status: 400 },
      );
    }
  }

  let newNoCall: string[] = [];
  if (requestedNoCall.length > 0) {
    const { data: existingRows, error: existErr } = await sb
      .from('provider_availability')
      .select('start_date')
      .eq('provider_id', provider_id)
      .eq('availability_type', 'no_call_request')
      .eq('source', 'request_window')
      .eq('notes', windowNotesTag(window.id));
    if (existErr) return NextResponse.json({ error: existErr.message }, { status: 500 });
    const existingDates = new Set((existingRows || []).map((r: { start_date: string }) => r.start_date));
    newNoCall = requestedNoCall.filter(d => !existingDates.has(d));
    const max = window.max_no_call_requests ?? 3;
    if (existingDates.size + newNoCall.length > max) {
      return NextResponse.json(
        {
          error: `No-call limit is ${max} date${max === 1 ? '' : 's'} per provider for this window` +
            (existingDates.size > 0 ? ` (${existingDates.size} already submitted).` : '.'),
        },
        { status: 400 },
      );
    }
  }

  // 4. Writes. PTO + days-off feed the existing Requests approval queue;
  //    no-call rows land directly as approved availability (soft — the
  //    engine avoids them when it can, validation flags them when it can't).
  const submittedAt = new Date().toISOString();
  const requestRows = [
    ...pto.map(r => ({
      provider_id,
      site_id: window.site_id,
      request_type: 'pto',
      start_date: r.start_date,
      end_date: r.end_date,
      status: 'pending',
      submitted_at: submittedAt,
      notes: `Submitted via request window (block ${window.block_start} – ${window.block_end})`,
    })),
    ...days_off.map(r => ({
      provider_id,
      site_id: window.site_id,
      request_type: 'availability_change',
      start_date: r.start_date,
      end_date: r.end_date,
      status: 'pending',
      submitted_at: submittedAt,
      notes: `Days off (recurring non-work days) — submitted via request window (block ${window.block_start} – ${window.block_end})`,
    })),
  ];

  if (requestRows.length > 0) {
    const { error } = await sb.from('provider_requests').insert(requestRows);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (newNoCall.length > 0) {
    const availRows = newNoCall.map(d => ({
      provider_id,
      site_id: window.site_id,
      availability_type: 'no_call_request',
      start_date: d,
      end_date: d,
      all_day: true,
      source: 'request_window',
      approval_status: 'approved',
      notes: windowNotesTag(window.id),
    }));
    const { error } = await sb.from('provider_availability').insert(availRows);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    created: {
      pto: pto.length,
      days_off: days_off.length,
      // Count what the provider ASKED for as honored, including dates they
      // had already submitted (idempotent resubmits shouldn't look like
      // failures) — but report skips separately for transparency.
      no_call: requestedNoCall.length,
    },
    skipped_no_call: requestedNoCall.length - newNoCall.length,
  });
}
