import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import {
  IntakeSubmissionSchema, windowNotesTag, callRequestsEnabled,
  countNoCallRequestUnits, weekendGroupKey,
} from '@/lib/validation/requestIntake';
import { formatZodIssues } from '@/lib/validation/scheduling';
import { isMissingColumnError } from '@/lib/rulesEngine/shared';

// PUBLIC intake endpoint — sits outside /api/scheduling deliberately: the
// token in the URL is the trust boundary (this app has no auth; internal
// routes assume a trusted operator, this one assumes a shared link).
// Everything is re-validated server-side against the window row:
//   - token must resolve to a window; the window must be OPEN
//   - no-call AND call dates must fall inside the block
//   - the provider must be on the window site's active roster (home-site)
//   - the per-provider caps (no-call always; call-shift when the admin
//     enabled the category, max_call_requests ≥ 1) are enforced by counting
//     existing window-sourced rows (notes = request_window:<id>). CALL: one
//     request = one requested DATE. NO-CALL: one request = one UNIT — a
//     weekday date is 1, a weekend's Fri/Sat/Sun collectively 1
//     (countNoCallRequestUnits; Gabriel 2026-07-22)
//   - a date submitted as BOTH no-call and call in one POST is contradictory
//     and rejected outright (cross-submission contradictions are the
//     engine's: treated as neither, warned on generation)
//   - site_id always derives from the window; the body's is ignored
//
// Writes:
//   PTO ranges      → provider_requests (request_type 'pto', pending)      — approval queue
//   Days-off ranges → provider_requests (request_type 'availability_change', pending)
//   No-call dates   → provider_availability DIRECTLY (type 'no_call_request',
//                     approved, source 'request_window') — no human approval;
//                     the scheduling engine arbitrates these softly.
//   Call dates      → provider_availability DIRECTLY (type 'call_request',
//                     same shape) — the engine soft-PREFERS them.
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
  const { provider_id, pto, days_off, no_call_dates, call_dates } = parsed.data;

  if (pto.length === 0 && days_off.length === 0 && no_call_dates.length === 0 && call_dates.length === 0) {
    return NextResponse.json({ error: 'Nothing to submit — add at least one entry.' }, { status: 400 });
  }

  // A date asked for as BOTH no-call and call in one submission is a plain
  // input error — reject before any DB work.
  const contradictory = no_call_dates.filter(d => call_dates.includes(d));
  if (contradictory.length > 0) {
    return NextResponse.json(
      { error: `The same date cannot be both a no-call and a call request: ${[...new Set(contradictory)].sort().join(', ')}.` },
      { status: 400 },
    );
  }

  const sb = sbSchedulingServer();

  // 1. Token → window. Unknown token and closed window get distinct statuses
  //    so the form can render a friendly "window closed" state.
  //    max_call_requests is patch36 — on a pre-patch36 DB (missing column)
  //    retry with the legacy column set and treat the cap as null (call
  //    requests OFF), the exact pre-feature behavior.
  let { data: window, error: winErr } = await sb
    .from('request_windows')
    .select('id, site_id, block_start, block_end, max_no_call_requests, max_call_requests, status')
    .eq('token', token)
    .maybeSingle();
  if (winErr && isMissingColumnError(winErr)) {
    ({ data: window, error: winErr } = await sb
      .from('request_windows')
      .select('id, site_id, block_start, block_end, max_no_call_requests, status')
      .eq('token', token)
      .maybeSingle());
    if (window) window = { ...window, max_call_requests: null };
  }
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

  // 3b. Call dates (mirror): only when the admin enabled the category
  //     (max_call_requests ≥ 1); inside the block, deduped, capped.
  const requestedCall = [...new Set(call_dates)].sort();
  if (requestedCall.length > 0 && !callRequestsEnabled(window.max_call_requests)) {
    return NextResponse.json(
      { error: 'Call-shift requests are not enabled for this request window.' },
      { status: 400 },
    );
  }
  for (const d of requestedCall) {
    if (d < window.block_start || d > window.block_end) {
      return NextResponse.json(
        { error: `Call-request date ${d} is outside the block (${window.block_start} – ${window.block_end}).` },
        { status: 400 },
      );
    }
  }

  // Existing window-sourced rows of one request type — the caps count what
  // was already submitted to THIS window (notes = request_window:<id>), each
  // request type independently (call per-date; no-call in weekend units).
  const existingWindowDates = async (type: 'no_call_request' | 'call_request') => {
    const { data, error } = await sb
      .from('provider_availability')
      .select('start_date')
      .eq('provider_id', provider_id)
      .eq('availability_type', type)
      .eq('source', 'request_window')
      .eq('notes', windowNotesTag(window.id));
    if (error) throw new Error(error.message);
    return new Set((data || []).map((r: { start_date: string }) => r.start_date));
  };

  let newNoCall: string[] = [];
  let newCall: string[] = [];
  try {
    if (requestedNoCall.length > 0) {
      const existingDates = await existingWindowDates('no_call_request');
      newNoCall = requestedNoCall.filter(d => !existingDates.has(d));
      const max = window.max_no_call_requests ?? 3;
      // The no-call cap counts REQUESTS (units), not dates (Gabriel
      // 2026-07-22): a weekday date = 1; Fri/Sat/Sun of the SAME weekend = 1
      // total (countNoCallRequestUnits, single-homed in requestIntake.ts).
      // Counted over the UNION of existing window rows and the new dates so
      // resubmitting a weekend — or completing one already partially
      // submitted — never double-counts. CALL requests stay per-date (3b).
      const allDates = [...existingDates, ...requestedNoCall];
      if (countNoCallRequestUnits(allDates) > max) {
        const usedUnits = countNoCallRequestUnits(existingDates);
        const weekendInvolved = allDates.some(d => weekendGroupKey(d) !== null);
        return NextResponse.json(
          {
            error: `No-call limit is ${max} request${max === 1 ? '' : 's'} per provider for this window` +
              (weekendInvolved ? ' — a full weekend (Fri, Sat, Sun) counts as one request' : '') +
              (usedUnits > 0 ? ` — ${usedUnits} already used.` : '.'),
          },
          { status: 400 },
        );
      }
    }
    if (requestedCall.length > 0) {
      const existingDates = await existingWindowDates('call_request');
      newCall = requestedCall.filter(d => !existingDates.has(d));
      const max = window.max_call_requests as number;
      if (existingDates.size + newCall.length > max) {
        return NextResponse.json(
          {
            error: `Call-request limit is ${max} date${max === 1 ? '' : 's'} per provider for this window` +
              (existingDates.size > 0 ? ` (${existingDates.size} already submitted).` : '.'),
          },
          { status: 400 },
        );
      }
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
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

  const availRowFor = (type: 'no_call_request' | 'call_request') => (d: string) => ({
    provider_id,
    site_id: window.site_id,
    availability_type: type,
    start_date: d,
    end_date: d,
    all_day: true,
    source: 'request_window',
    approval_status: 'approved',
    notes: windowNotesTag(window.id),
  });
  if (newNoCall.length > 0) {
    const { error } = await sb.from('provider_availability')
      .insert(newNoCall.map(availRowFor('no_call_request')));
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (newCall.length > 0) {
    const { error } = await sb.from('provider_availability')
      .insert(newCall.map(availRowFor('call_request')));
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
      call: requestedCall.length,
    },
    skipped_no_call: requestedNoCall.length - newNoCall.length,
    skipped_call: requestedCall.length - newCall.length,
  });
}
