import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

// PATCH /api/scheduling/requests/:id — update or approve/deny a request
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sb = sbSchedulingServer();
  const body = await req.json();

  const fields: Record<string, unknown> = {};

  // Allow editing notes, dates, type while still pending
  for (const key of ['request_type', 'start_date', 'end_date', 'part_of_day', 'notes', 'site_id']) {
    if (body[key] !== undefined) fields[key] = body[key];
  }

  // Approval flow: status + decision_reason + reviewed_at
  if (body.status) {
    fields.status = body.status;
    fields.reviewed_at = new Date().toISOString();
    if (body.decision_reason !== undefined) fields.decision_reason = body.decision_reason;

    // When approved, auto-create a matching availability record
    if (body.status === 'approved') {
      const { data: request } = await sb
        .from('provider_requests')
        .select('provider_id, request_type, start_date, end_date, site_id')
        .eq('id', id)
        .single();

      if (request) {
        // Map request_type → availability_type
        const typeMap: Record<string, string> = {
          pto: 'pto',
          no_call: 'no_call_request',
          extra_call: 'call_request',
          availability_change: 'unavailable',
        };
        const availType = typeMap[request.request_type] || 'unavailable';

        await sb.from('provider_availability').insert({
          provider_id: request.provider_id,
          site_id: request.site_id || null,
          availability_type: availType,
          start_date: request.start_date,
          end_date: request.end_date,
          all_day: true,
          source: 'request',
          approval_status: 'approved',
        });
      }
    }
  }

  const { data, error } = await sb
    .from('provider_requests')
    .update(fields)
    .eq('id', id)
    .select('*, providers:provider_id(id, first_name, last_name, short_display_name, initials, provider_type)')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// DELETE /api/scheduling/requests/:id
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sb = sbSchedulingServer();
  const { error } = await sb.from('provider_requests').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
