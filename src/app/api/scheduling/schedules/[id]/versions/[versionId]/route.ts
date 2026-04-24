import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

// PATCH /api/scheduling/schedules/:id/versions/:versionId
// Update version status (draft → review → published → archived)
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  const { id: scheduleId, versionId } = await params;
  const sb = sbSchedulingServer();
  const body = await req.json();

  const fields: Record<string, unknown> = {};
  if (body.version_status) {
    fields.version_status = body.version_status;
    if (body.version_status === 'published') {
      fields.published_at = new Date().toISOString();

      // Also update the parent schedule
      const { data: version } = await sb
        .from('schedule_versions')
        .select('version_number')
        .eq('id', versionId)
        .single();
      if (version) {
        await sb
          .from('schedules')
          .update({
            status: 'published',
            published_version_number: (version as { version_number: number }).version_number,
          })
          .eq('id', scheduleId);
      }
    }
  }
  if (body.notes !== undefined) fields.notes = body.notes;

  const { data, error } = await sb
    .from('schedule_versions')
    .update(fields)
    .eq('id', versionId)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
