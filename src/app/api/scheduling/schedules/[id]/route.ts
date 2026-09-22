import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { publishRevalidation, type PublishValidationSummary } from '@/lib/rulesEngine/commit';
import { parseProviderLimits } from '@/lib/providerLimits';
import { parseScheduleName } from '@/lib/scheduleName';
import { validateManifest } from '@/lib/paoliBlock/manifest';
import { currentScheduleActor } from '@/lib/auth/scheduleActor';
import {
  canDeleteSchedule, canRestoreSchedule, type ScheduleStatus,
} from '@/lib/auth/schedulePermissions';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

// Non-blocking post-publish revalidation (draft isolation §3). A validation
// failure must NEVER fail the publish — surface it in the payload instead
// (invariant 6: if it could not run, say so; never report fake-clean).
async function safeRevalidate(
  sb: ReturnType<typeof sbSchedulingServer>,
  siteId: string | null | undefined,
  versionId: string,
): Promise<PublishValidationSummary> {
  if (!siteId) {
    return { hardCount: 0, softCount: 0, errors: ['validation-unavailable — schedule site_id missing'] };
  }
  try {
    return await publishRevalidation(sb, siteId, versionId);
  } catch (e) {
    return {
      hardCount: 0, softCount: 0,
      errors: [`validation-unavailable — revalidation threw: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const sb = sbSchedulingServer();
  const { id } = await params;

  const { data, error } = await sb
    .from('schedules')
    .select('*, sites(name, short_name, timezone)')
    .eq('id', id)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const sb = sbSchedulingServer();
  const { id } = await params;
  const body = await req.json();

  // provider_limits hardening (2026-07-22, patch34): the PATCH is otherwise a
  // passthrough, but this jsonb key is shape-validated (integers >= 0 only,
  // unknown keys stripped, NaN rejected, workingDays/daysOff mutually
  // exclusive) via the shared parseProviderLimits before any write. A
  // malformed shape is a 400 — never stored. Valid shapes are written
  // NORMALIZED (empty map → null).
  if (body && typeof body === 'object' && 'provider_limits' in body) {
    const parsed = parseProviderLimits((body as Record<string, unknown>).provider_limits);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    (body as Record<string, unknown>).provider_limits = parsed.value;
  }

  // schedule_name rename (Gabriel 2026-07-22) — same route-hardening style:
  // when the key is present it must be a non-empty trimmed string ≤ 120 chars
  // (a schedule can never lose its name), validated BEFORE any write. Written
  // TRIMMED; every schedule_name display reads the column, so renames show up
  // everywhere.
  if (body && typeof body === 'object' && 'schedule_name' in body) {
    const parsed = parseScheduleName((body as Record<string, unknown>).schedule_name, { blankIsDefault: false });
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    (body as Record<string, unknown>).schedule_name = parsed.value;
  }

  // scenario_manifest hardening (2026-07-27, the Block Targets panel): same
  // route-hardening style. This one matters more than most — projectScenario
  // rejects the WHOLE manifest on ANY validation failure and generates
  // WITHOUT the scenario, so an unvalidated write means a schedule that
  // silently ignores every target, prohibition and linkage the owner entered.
  // Validated BEFORE any write; a bad shape is a 400 carrying the zod issues.
  //
  // Written VERBATIM, never normalized (contrast provider_limits): the patch37
  // storage decision is that this column holds the artifact AS AUTHORED, and
  // paoliBlockManifestSchema is a non-strict zod object, so writing the parsed
  // copy would silently strip additive keys — the panel's `blockTargets`
  // derived-vs-overridden sidecar first among them. null clears.
  if (body && typeof body === 'object' && 'scenario_manifest' in body) {
    const raw = (body as Record<string, unknown>).scenario_manifest;
    if (raw !== null && raw !== undefined) {
      const parsed = validateManifest(raw);
      if (!parsed.ok) {
        return NextResponse.json({
          error: `scenario_manifest is not a valid block manifest — the engine would reject it and `
            + `generate WITHOUT the scenario: ${parsed.errors.slice(0, 3).join('; ')}`,
          errors: parsed.errors,
        }, { status: 400 });
      }
    }
  }

  const { data, error } = await sb
    .from('schedules')
    .update(body)
    .eq('id', id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // When publishing, also update the latest version
  if (body.status === 'published') {
    const { data: version, error: verErr } = await sb
      .from('schedule_versions')
      .select('id, version_number')
      .eq('schedule_id', id)
      .order('version_number', { ascending: false })
      .limit(1)
      .single();
    if (verErr) return NextResponse.json({ error: verErr.message }, { status: 500 });

    // C1 (draft isolation): "committed = published" makes published-ness
    // load-bearing — a schedule must carry at most ONE published version, or a
    // superseded version keeps counting as phantom committed bookings in every
    // other schedule's conflict scans (and double-counts call history). Demote
    // superseded published siblings to 'archived' before flipping the new one;
    // published_at stays as-is (historical). The .neq guard makes a
    // same-version re-publish a no-op rather than archive-then-publish.
    const { error: demoteErr } = await sb
      .from('schedule_versions')
      .update({ version_status: 'archived' })
      .eq('schedule_id', id)
      .eq('version_status', 'published')
      .neq('id', version.id);
    if (demoteErr) return NextResponse.json({ error: demoteErr.message }, { status: 500 });

    const { error: updErr } = await sb
      .from('schedule_versions')
      .update({ version_status: 'published', published_at: new Date().toISOString() })
      .eq('id', version.id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    // B1 parity fix: keep schedules.published_version_number in sync. The
    // versions route already does this on publish; this UI path did not, leaving
    // a stale pointer. version_status = 'published' is the authoritative
    // committed predicate, but the pointer is still read by other surfaces.
    const { error: pvErr } = await sb
      .from('schedules')
      .update({ published_version_number: (version as { version_number: number }).version_number })
      .eq('id', id);
    if (pvErr) return NextResponse.json({ error: pvErr.message }, { status: 500 });

    const publishValidation = await safeRevalidate(
      sb, (data as { site_id?: string }).site_id, (version as { id: string }).id,
    );
    return NextResponse.json({ ...data, publishValidation });
  }

  return NextResponse.json(data);
}

// DELETE /api/scheduling/schedules/:id
//   default behavior: hard delete (cascades remove versions, slots, assignments)
//   ?archive=true   : soft delete by setting status='archived'
/**
 * Delete a schedule — by HIDING it, never by removing rows.
 *
 * This used to be `sb.from('schedules').delete()`. Assignments, slots and
 * versions all hang off `schedules`, so that took a published block of
 * somebody's working life with it and there was no way back. It now stamps
 * deleted_at (patch62); an admin can restore through PATCH ?restore=true.
 *
 * `?archive=true` is unchanged — archiving is a different act with a different
 * meaning (the schedule happened, it is over) and it stays visible.
 *
 * Permission is checked HERE and not only in the UI: a button that is not
 * rendered is not a control, and this route is reachable by anyone who can
 * reach /api/scheduling/schedules at all.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const sb = sbSchedulingServer();
  const { id } = await params;
  const archive = new URL(req.url).searchParams.get('archive') === 'true';

  if (archive) {
    const { data, error } = await sb
      .from('schedules')
      .update({ status: 'archived' })
      .eq('id', id)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  // Read the subject BEFORE judging: the decision depends on its site and its
  // status, and a schedule that is already deleted must not be deleted twice.
  const { data: target, error: readErr } = await sb
    .from('schedules').select('id, site_id, status, deleted_at').eq('id', id).maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!target) return NextResponse.json({ error: 'No such schedule.' }, { status: 404 });

  const actor = await currentScheduleActor(sb);
  const allowed = canDeleteSchedule(actor, {
    siteId: target.site_id,
    status: target.status as ScheduleStatus,
    deletedAt: target.deleted_at,
  });
  if (!allowed) {
    return NextResponse.json(
      { error: 'Only an admin or a schedule maker may delete a schedule.' },
      { status: 403 },
    );
  }

  const { error } = await sb.from('schedules')
    .update({ deleted_at: new Date().toISOString(), deleted_by: actor.providerId })
    .eq('id', id)
    // Guard against a concurrent delete: only stamp a row that is still live,
    // so two clicks cannot overwrite the first deleter with the second.
    .is('deleted_at', null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, deleted: true, recoverable: true });
}

/**
 * Restore a soft-deleted schedule. Admins only — "so that Admins can find and
 * recover them if needed".
 *
 * Deliberately narrower than the right to delete: the person who can make
 * something disappear should not automatically decide it comes back.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const sb = sbSchedulingServer();
  const { id } = await params;
  if (new URL(req.url).searchParams.get('restore') !== 'true') {
    return NextResponse.json({ error: 'Unsupported operation.' }, { status: 400 });
  }

  const actor = await currentScheduleActor(sb);
  if (!canRestoreSchedule(actor)) {
    return NextResponse.json(
      { error: 'Only an admin may restore a deleted schedule.' }, { status: 403 },
    );
  }

  const { data, error } = await sb.from('schedules')
    .update({ deleted_at: null, deleted_by: null })
    .eq('id', id).not('deleted_at', 'is', null)
    .select('id, schedule_name').maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) {
    return NextResponse.json({ error: 'No deleted schedule with that id.' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, restored: true, schedule: data });
}
