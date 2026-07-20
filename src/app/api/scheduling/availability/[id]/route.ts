import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { validateAvailabilityPatch } from '@/lib/validation/providers';

// PATCH /api/scheduling/availability/:id
// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

// Hardened 2026-07-20 (audit follow-up): the raw body used to be passed
// straight into .update() — mass assignment. Now every request goes through
// validateAvailabilityPatch (src/lib/validation/providers.ts): a strict
// whitelist (start_date, end_date, notes, availability_type within the
// allowed set, approval_status within the enum), ISO-date validation, and a
// 400 on any unknown field or invalid value. end >= start is enforced against
// the MERGED row (a patch may move only one endpoint), which also gives an
// honest 404 for a missing id instead of a downstream 500.
//
// ICU rows (reason_code 'icu_week' / 'icu_post_call') pair a week row with
// its post-ICU Monday row (src/lib/icuRotation.ts). This route stays a dumb
// single-row patch — keeping that pairing consistent is the ICU section's own
// edit flow (which re-derives the Monday); the generic edit UI sends ICU-week
// edits there, not here.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sb = sbSchedulingServer();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be valid JSON' }, { status: 400 });
  }

  const v = validateAvailabilityPatch(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  // Merged-row date-order check (and honest 404 on a missing id).
  const { data: existing, error: readErr } = await sb
    .from('provider_availability')
    .select('id, start_date, end_date')
    .eq('id', id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: 'availability entry not found' }, { status: 404 });

  const mergedStart = (v.fields.start_date as string | undefined) ?? existing.start_date;
  const mergedEnd = (v.fields.end_date as string | undefined) ?? existing.end_date;
  if (mergedEnd < mergedStart) {
    return NextResponse.json(
      { error: 'end_date must be on or after start_date' },
      { status: 400 },
    );
  }

  const { data, error } = await sb
    .from('provider_availability')
    .update(v.fields)
    .eq('id', id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// DELETE /api/scheduling/availability/:id
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sb = sbSchedulingServer();
  const { error } = await sb.from('provider_availability').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
