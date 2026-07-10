// Neighbor revalidation, extracted from route.ts so the schedule assistant's
// assignment tools (src/lib/scheduleAssistant/mutations.ts) run the exact same
// post-write path as manual UI edits (route files may only export HTTP verbs).
//
// When an assignment changes, the same provider's nearby assignments may gain
// or lose violations (e.g. a new C2 on Monday creates a sequence expectation
// for Tuesday's slot). After every write we re-evaluate the provider's other
// assignments within ±7 days and update their stored validation_flags. Quiet
// on errors — best-effort, never blocks the response.
//
// Returns the slot ids whose stored flags were actually rewritten so callers
// can include them in the affected-row re-select — otherwise a neighbor cell
// whose violations just changed would keep stale flags client-side until the
// next full grid load.
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { evaluateAssignment } from '@/lib/rulesEngine/evaluate';

export async function revalidateNeighbors(
  sb: ReturnType<typeof sbSchedulingServer>,
  changedSlotId: string,
  providerId: string | null,
): Promise<string[]> {
  const revalidatedSlotIds: string[] = [];
  if (!providerId) return revalidatedSlotIds;
  try {
    const { data: changedSlot } = await sb
      .from('schedule_slots')
      .select('slot_date')
      .eq('id', changedSlotId)
      .maybeSingle();
    if (!changedSlot) return revalidatedSlotIds;
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
      const { error: updateErr } = await sb
        .from('assignments')
        .update({ validation_flags: result.violations })
        .eq('id', row.id);
      if (!updateErr) revalidatedSlotIds.push(row.schedule_slot_id);
    }
  } catch (err) {
    console.error('[rulesEngine] neighbor revalidation failed:', err);
  }
  return revalidatedSlotIds;
}

export function shiftDate(iso: string, delta: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
