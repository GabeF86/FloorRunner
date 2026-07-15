import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { publishRevalidation, type PublishValidationSummary } from '@/lib/rulesEngine/commit';

// PATCH /api/scheduling/schedules/:id/versions/:versionId
// Update version status (draft → review → published → archived)
// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  const { id: scheduleId, versionId } = await params;
  const sb = sbSchedulingServer();
  const body = await req.json();

  const publishing = body.version_status === 'published';
  const fields: Record<string, unknown> = {};
  if (body.version_status) {
    fields.version_status = body.version_status;
    if (publishing) {
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

      // C1 (draft isolation): "committed = published" makes published-ness
      // load-bearing — at most ONE published version per schedule, or a
      // superseded version keeps counting as phantom committed bookings in
      // every other schedule's conflict scans (and double-counts call
      // history). Demote superseded published siblings to 'archived' before
      // this version flips below; published_at stays as-is (historical). The
      // .neq guard makes a same-version re-publish a no-op rather than
      // archive-then-publish.
      const { error: demoteErr } = await sb
        .from('schedule_versions')
        .update({ version_status: 'archived' })
        .eq('schedule_id', scheduleId)
        .eq('version_status', 'published')
        .neq('id', versionId);
      if (demoteErr) return NextResponse.json({ error: demoteErr.message }, { status: 500 });
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

  // Non-blocking post-publish revalidation (draft isolation §3) — runs AFTER the
  // status is persisted so draft-vs-draft overlaps against other published
  // schedules surface as hard flags. NEVER fails the publish (invariant 6: if it
  // could not run, say so in the payload; never report fake-clean).
  if (publishing) {
    const { data: sched } = await sb
      .from('schedules')
      .select('site_id')
      .eq('id', scheduleId)
      .single();
    let publishValidation: PublishValidationSummary;
    const siteId = (sched as { site_id?: string } | null)?.site_id;
    if (!siteId) {
      publishValidation = { hardCount: 0, softCount: 0, errors: ['validation-unavailable — schedule site_id missing'] };
    } else {
      try {
        publishValidation = await publishRevalidation(sb, siteId, versionId);
      } catch (e) {
        publishValidation = {
          hardCount: 0, softCount: 0,
          errors: [`validation-unavailable — revalidation threw: ${e instanceof Error ? e.message : String(e)}`],
        };
      }
    }
    return NextResponse.json({ ...data, publishValidation });
  }

  return NextResponse.json(data);
}
