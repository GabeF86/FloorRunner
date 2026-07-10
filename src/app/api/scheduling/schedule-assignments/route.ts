import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { evaluateAssignment, validationFlagsFor } from '@/lib/rulesEngine/evaluate';
import {
  applySequenceAutoFill,
  cleanupSequenceAutoFill,
  loadActiveCallPattern,
} from '@/lib/rulesEngine/sequenceAutoFill';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();

  // Run rules engine BEFORE persisting so we can store violations alongside
  // the assignment in a single round-trip. If the evaluation was incomplete
  // (context unavailable / evaluator threw), the assignment still saves but
  // its flags become a SENTINEL warning ('validation unavailable — needs
  // re-validation') — never a fake-clean [], and never the previous
  // provider's stale violations on a reassignment (the conflict-update flips
  // provider_id, so omitting the column would leave provider A's flags on
  // provider B's row).
  const evalResult = await evaluateAssignment(sb, body.schedule_slot_id, body.provider_id);
  if (!evalResult.evaluated) {
    console.error(`[rulesEngine] validation unavailable for slot ${body.schedule_slot_id} — writing needs-re-validation sentinel`);
  }

  // One assignment row per slot, enforced by assignments_schedule_slot_id_key
  // (migration 20260524000000_add_assignment_unique_constraints.sql). Upsert
  // is atomic, so two concurrent edits can't both insert a duplicate row for
  // the same slot (the previous update-else-insert raced).
  const { data, error } = await sb
    .from('assignments')
    .upsert(
      {
        schedule_slot_id: body.schedule_slot_id,
        provider_id: body.provider_id,
        assignment_status: 'assigned',
        source_type: 'manual',
        assigned_at: new Date().toISOString(),
        validation_flags: validationFlagsFor(evalResult),
      },
      { onConflict: 'schedule_slot_id' },
    )
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Sequence auto-fill reads the site's ACTIVE CALL PATTERN (loaded once per
  // request here and passed in — rule_definitions are validation-only). The
  // auto-filled rows are left with validation_flags null; revalidateNeighbors
  // below evaluates them (same provider, within ±7 days) and stores real flags.
  const { data: slotRow } = await sb
    .from('schedule_slots')
    .select('site_id')
    .eq('id', body.schedule_slot_id)
    .maybeSingle();
  const pattern = await loadActiveCallPattern(sb, (slotRow as { site_id?: string } | null)?.site_id);
  const fill = await applySequenceAutoFill(sb, body.schedule_slot_id, body.provider_id, pattern);
  await revalidateNeighbors(sb, body.schedule_slot_id, body.provider_id);
  // Backward-compatible response: existing fields plus the auto-fill outcome
  // (skips use the SkippedDerived vocabulary — clinical invariant 4).
  return NextResponse.json({
    ...data,
    validation: evalResult,
    filledSlotIds: fill.filledSlotIds,
    skips: fill.skips,
  });
}

export async function PATCH(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();
  const { id, ...fields } = body;

  const { data, error } = await sb
    .from('assignments')
    .update(fields)
    .eq('id', id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const sb = sbSchedulingServer();
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  // Get the slot ID + provider (+ site for the call-pattern load) before
  // deleting so we can recreate an open assignment AND revalidate that
  // provider's neighbors.
  const { data: existing } = await sb
    .from('assignments')
    .select('schedule_slot_id, provider_id, schedule_slots(site_id)')
    .eq('id', id)
    .single();

  // Clean up any sequence auto-fills BEFORE deleting the trigger row,
  // since cleanup needs to know which provider triggered the auto-fill.
  // Cleanup derives the linked slots from the same active call pattern the
  // fill path uses (loaded once per request, passed in).
  let clearedSlotIds: string[] = [];
  if (existing?.provider_id) {
    const siteId = (existing as { schedule_slots?: { site_id?: string } | null }).schedule_slots?.site_id;
    const pattern = await loadActiveCallPattern(sb, siteId);
    ({ clearedSlotIds } = await cleanupSequenceAutoFill(
      sb, existing.schedule_slot_id, existing.provider_id, pattern));
  }

  // Delete the assignment
  const { error } = await sb.from('assignments').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Recreate as open
  if (existing) {
    const { data: newOpen, error: insertErr } = await sb
      .from('assignments')
      .insert({
        schedule_slot_id: existing.schedule_slot_id,
        assignment_status: 'open',
        source_type: 'manual',
      })
      .select()
      .single();
    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });
    if (existing.provider_id) {
      await revalidateNeighbors(sb, existing.schedule_slot_id, existing.provider_id);
    }
    // Backward-compatible: the recreated open row plus which linked auto-fills
    // were cleared alongside the delete.
    return NextResponse.json({ ...newOpen, clearedSlotIds });
  }

  return NextResponse.json({ ok: true, clearedSlotIds });
}

// ── Neighbor revalidation ──────────────────────────────────────────────────
//
// When an assignment changes, the same provider's nearby assignments may
// gain or lose violations (e.g. a new C2 on Monday creates a sequence
// expectation for Tuesday's slot). After every write we re-evaluate the
// provider's other assignments within ±7 days and update their stored
// validation_flags. Quiet on errors — best-effort, never blocks the response.

async function revalidateNeighbors(
  sb: ReturnType<typeof sbSchedulingServer>,
  changedSlotId: string,
  providerId: string | null,
) {
  if (!providerId) return;
  try {
    const { data: changedSlot } = await sb
      .from('schedule_slots')
      .select('slot_date')
      .eq('id', changedSlotId)
      .maybeSingle();
    if (!changedSlot) return;
    const center = (changedSlot as { slot_date: string }).slot_date;
    const start = shiftDate(center, -7);
    const end = shiftDate(center, 7);

    const { data: neighbors } = await sb
      .from('assignments')
      .select('id, schedule_slot_id, schedule_slots!inner(slot_date)')
      .eq('provider_id', providerId)
      .eq('assignment_status', 'assigned')
      .gte('schedule_slots.slot_date', start)
      .lte('schedule_slots.slot_date', end);

    for (const row of (neighbors || []) as Array<{
      id: string;
      schedule_slot_id: string;
    }>) {
      if (row.schedule_slot_id === changedSlotId) continue;
      const result = await evaluateAssignment(sb, row.schedule_slot_id, providerId);
      // Invariant 6: an incomplete evaluation must not overwrite stored flags
      // with something that looks like a clean re-validation.
      if (!result.evaluated) {
        console.error(`[rulesEngine] neighbor revalidation unavailable for assignment ${row.id} — validation_flags not updated`);
        continue;
      }
      await sb
        .from('assignments')
        .update({ validation_flags: result.violations })
        .eq('id', row.id);
    }
  } catch (err) {
    console.error('[rulesEngine] neighbor revalidation failed:', err);
  }
}

function shiftDate(iso: string, delta: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
