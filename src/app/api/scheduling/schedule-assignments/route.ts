import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { evaluateAssignment, validationFlagsFor } from '@/lib/rulesEngine/evaluate';
import { applySequenceAutoFill, cleanupSequenceAutoFill } from '@/lib/rulesEngine/sequenceAutoFill';
import {
  GRID_ASSIGNMENT_COLUMNS,
  withValidationSummary,
  type ValidationSummary,
} from '../schedules/[id]/grid/route.helpers';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

// A re-selected assignment row in the same column shape the grid route
// returns, so the client can patch the affected cells in place instead of
// refetching the whole grid.
type JoinedAssignmentRow = {
  schedule_slot_id: string;
  validation_flags?: unknown;
  validation_summary: ValidationSummary | null;
  [key: string]: unknown;
};

// Re-select every affected assignment row (the edited slot + auto-filled /
// evicted / cleared siblings) in the grid column shape. Best-effort: on a
// query error it returns { assignment: null, siblings: [] } and the client
// falls back to a full grid reload.
async function selectAffectedRows(
  sb: ReturnType<typeof sbSchedulingServer>,
  triggerSlotId: string,
  siblingSlotIds: string[],
): Promise<{ assignment: JoinedAssignmentRow | null; siblings: JoinedAssignmentRow[] }> {
  const slotIds = [...new Set([triggerSlotId, ...siblingSlotIds])];
  const { data, error } = await sb
    .from('assignments')
    .select(GRID_ASSIGNMENT_COLUMNS)
    .in('schedule_slot_id', slotIds);
  if (error) {
    console.error('[schedule-assignments] affected-row re-select failed:', error.message);
    return { assignment: null, siblings: [] };
  }
  const rows: JoinedAssignmentRow[] = ((data ?? []) as unknown as Array<{
    schedule_slot_id: string; validation_flags?: unknown; [key: string]: unknown;
  }>).map(withValidationSummary);
  return {
    assignment: rows.find(r => r.schedule_slot_id === triggerSlotId) ?? null,
    siblings: rows.filter(r => r.schedule_slot_id !== triggerSlotId),
  };
}

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

  // Sequence auto-fill reads the site's ACTIVE CALL PATTERN (loaded once
  // inside the module off the trigger slot's site — rule_definitions are
  // validation-only). The auto-filled rows are left with validation_flags
  // null; revalidateNeighbors below evaluates them (same provider, within
  // ±7 days) and stores real flags.
  const fill = await applySequenceAutoFill(sb, body.schedule_slot_id, body.provider_id);
  await revalidateNeighbors(sb, body.schedule_slot_id, body.provider_id);
  // Re-select AFTER revalidateNeighbors so the returned rows carry fresh
  // validation_flags for the auto-filled siblings too.
  const { assignment, siblings } = await selectAffectedRows(
    sb, body.schedule_slot_id, [...fill.filledSlotIds, ...fill.evictedSlotIds]);
  // Backward-compatible response: existing fields plus the auto-fill outcome
  // (skips use the SkippedDerived vocabulary — clinical invariant 4;
  // evictedSlotIds reports pre-fills reverted by a higher-precedence fill;
  // patternWarnings surfaces call-pattern load problems, genContext-style)
  // plus the re-selected joined rows so the client can patch cells in place.
  return NextResponse.json({
    ...data,
    validation: evalResult,
    filledSlotIds: fill.filledSlotIds,
    evictedSlotIds: fill.evictedSlotIds,
    skips: fill.skips,
    patternWarnings: fill.patternWarnings,
    assignment,
    siblings,
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

  // Re-select the row in the grid column shape (providers join +
  // validation_summary) so the client can patch the cell without a refetch.
  // Best-effort: on failure `assignment` is null and the client falls back.
  const { data: joinedRow, error: joinErr } = await sb
    .from('assignments')
    .select(GRID_ASSIGNMENT_COLUMNS)
    .eq('id', id)
    .single();
  if (joinErr) {
    console.error('[schedule-assignments] PATCH re-select failed:', joinErr.message);
  }
  return NextResponse.json({
    ...data,
    assignment: joinedRow
      ? withValidationSummary(joinedRow as Record<string, unknown> & { validation_flags?: unknown })
      : null,
  });
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
  // Cleanup derives the linked slots from the same active call pattern the
  // fill path uses (loaded inside the module off the trigger slot's site).
  let clearedSlotIds: string[] = [];
  let patternWarnings: string[] = [];
  if (existing?.provider_id) {
    ({ clearedSlotIds, patternWarnings } = await cleanupSequenceAutoFill(
      sb, existing.schedule_slot_id, existing.provider_id));
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
    // Re-select the recreated open row + the cleared auto-fill rows in the
    // grid column shape so the client can patch every affected cell.
    const { assignment, siblings } = await selectAffectedRows(
      sb, existing.schedule_slot_id, clearedSlotIds);
    // Backward-compatible: the recreated open row plus which linked auto-fills
    // were cleared alongside the delete (and any call-pattern load warnings).
    return NextResponse.json({ ...newOpen, clearedSlotIds, patternWarnings, assignment, siblings });
  }

  return NextResponse.json({ ok: true, clearedSlotIds, patternWarnings });
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
