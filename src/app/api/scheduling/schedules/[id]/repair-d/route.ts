// POST /api/scheduling/schedules/:id/repair-d — apply a D-assignment audit.
//
// Takes the placement list dAssignmentAudit produced and writes it in ONE
// batch. A batch, not N calls through the ordinary assignment endpoint,
// because a ladder fix is a PERMUTATION: writing p1 into D4 while p1 still
// holds D6 would leave them momentarily double-booked, and any per-write
// validation in between would see a state neither the before nor the after.
// Vacates land before fills for the same reason.
//
// Snapshots first, so the whole repair is one undo (the generation-undo
// machinery, scope 'assignments' — this writes nothing else).
import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { takeSnapshot } from '@/lib/scheduleAssistant/snapshot';
import { batchValidateVersion } from '@/lib/rulesEngine/batchValidate';
import { loadSiteValidationContext } from '@/lib/rulesEngine/loadContext';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface Placement { slotId: string; providerId: string | null }

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: scheduleId } = await params;
  const sb = sbSchedulingServer();

  let body: { versionId?: unknown; placements?: unknown } | null = null;
  try { body = await req.json(); } catch { /* handled below */ }
  const versionId = typeof body?.versionId === 'string' ? body.versionId : null;
  const raw = Array.isArray(body?.placements) ? body!.placements : [];
  const placements: Placement[] = raw
    .filter((p): p is Placement =>
      !!p && typeof (p as Placement).slotId === 'string'
      && (typeof (p as Placement).providerId === 'string' || (p as Placement).providerId === null))
    .map(p => ({ slotId: p.slotId, providerId: p.providerId }));

  if (!versionId) return NextResponse.json({ error: 'versionId is required' }, { status: 400 });
  if (placements.length === 0) {
    return NextResponse.json({ ok: true, applied: 0, undoActionId: null, errors: [] });
  }

  // Every slot must belong to this version — a stale id from another draft
  // must not be writable through here (invariant 3's draft isolation).
  const { data: owned, error: ownErr } = await sb
    .from('schedule_slots')
    .select('id')
    .eq('schedule_version_id', versionId)
    .in('id', placements.map(p => p.slotId));
  if (ownErr) return NextResponse.json({ error: ownErr.message }, { status: 500 });
  const ownedIds = new Set((owned ?? []).map(r => (r as { id: string }).id));
  const foreign = placements.filter(p => !ownedIds.has(p.slotId));
  if (foreign.length > 0) {
    return NextResponse.json(
      { error: `${foreign.length} slot(s) are not in this version` }, { status: 400 });
  }

  let undoActionId: string | null = null;
  try {
    undoActionId = await takeSnapshot(sb, scheduleId, versionId, 'Before D-assignment repair', null);
  } catch (err) {
    // Same best-effort rule the generate route states: a convenience snapshot
    // failing must not block the repair, but the caller is told there is no
    // undo rather than shown a button that does nothing.
    console.error('[repair-d] undo snapshot failed:', err instanceof Error ? err.message : err);
  }

  const errors: string[] = [];
  const vacate = placements.filter(p => p.providerId === null);
  const fill = placements.filter(p => p.providerId !== null);

  // ORDER IS LOAD-BEARING: vacates first, so a permutation never transiently
  // double-books anyone.
  for (const group of [vacate, fill]) {
    for (const p of group) {
      const { error } = await sb.from('assignments').upsert({
        schedule_slot_id: p.slotId,
        provider_id: p.providerId,
        assignment_status: p.providerId ? 'assigned' : 'open',
        source_type: 'auto_generated',
        assigned_at: p.providerId ? new Date().toISOString() : null,
        validation_flags: null,
        highlight_color: null,
      }, { onConflict: 'schedule_slot_id' });
      if (error) errors.push(`${p.slotId}: ${error.message}`);
    }
  }

  // Stored flags now describe a state that no longer exists — revalidate the
  // whole version rather than guessing which rows moved.
  try {
    const { data: sched } = await sb
      .from('schedules').select('site_id').eq('id', scheduleId).maybeSingle();
    const siteId = (sched as { site_id?: string } | null)?.site_id;
    if (!siteId) throw new Error('schedule site not found');
    const siteCtx = await loadSiteValidationContext(sb, siteId);
    const batch = await batchValidateVersion(sb, versionId, siteCtx);
    errors.push(...batch.errors);
  } catch (err) {
    errors.push(`revalidation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return NextResponse.json({
    ok: errors.length === 0,
    applied: placements.length - errors.length,
    undoActionId,
    errors,
  }, { status: errors.length === 0 ? 200 : 500 });
}
