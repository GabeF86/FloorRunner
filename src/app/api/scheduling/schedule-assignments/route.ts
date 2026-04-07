import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { evaluateAssignment } from '@/lib/rulesEngine/evaluate';
import { applySequenceAutoFill, cleanupSequenceAutoFill } from '@/lib/rulesEngine/sequenceAutoFill';

export async function POST(req: NextRequest) {
  const sb = sbSchedulingServer();
  const body = await req.json();

  // Run rules engine BEFORE persisting so we can store violations alongside
  // the assignment in a single round-trip.
  const evalResult = await evaluateAssignment(sb, body.schedule_slot_id, body.provider_id);

  // Update existing assignment for this slot
  const { data: updated, error: updErr } = await sb
    .from('assignments')
    .update({
      provider_id: body.provider_id,
      assignment_status: 'assigned',
      source_type: 'manual',
      assigned_at: new Date().toISOString(),
      validation_flags: evalResult.violations,
    })
    .eq('schedule_slot_id', body.schedule_slot_id)
    .select()
    .maybeSingle();

  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  if (updated) {
    await applySequenceAutoFill(sb, body.schedule_slot_id, body.provider_id);
    await revalidateNeighbors(sb, body.schedule_slot_id, body.provider_id);
    return NextResponse.json({ ...updated, validation: evalResult });
  }

  // No existing assignment — insert new
  const { data, error } = await sb
    .from('assignments')
    .insert({
      schedule_slot_id: body.schedule_slot_id,
      provider_id: body.provider_id,
      assignment_status: 'assigned',
      source_type: 'manual',
      assigned_at: new Date().toISOString(),
      validation_flags: evalResult.violations,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await applySequenceAutoFill(sb, body.schedule_slot_id, body.provider_id);
  await revalidateNeighbors(sb, body.schedule_slot_id, body.provider_id);
  return NextResponse.json({ ...data, validation: evalResult });
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

  // Get the slot ID + provider before deleting so we can recreate an open
  // assignment AND revalidate that provider's neighbors.
  const { data: existing } = await sb
    .from('assignments')
    .select('schedule_slot_id, provider_id')
    .eq('id', id)
    .single();

  // Clean up any sequence auto-fills BEFORE deleting the trigger row,
  // since cleanup needs to know which provider triggered the auto-fill.
  if (existing?.provider_id) {
    await cleanupSequenceAutoFill(sb, existing.schedule_slot_id, existing.provider_id);
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
    return NextResponse.json(newOpen);
  }

  return NextResponse.json({ ok: true });
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
