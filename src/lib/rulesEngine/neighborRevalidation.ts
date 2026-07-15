// Neighbor revalidation — shared by the manual schedule-assignments route and
// the schedule assistant's assignment tools (lives in lib so lib code never
// imports from app/ route helpers).
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
import { evaluateAssignment } from './evaluate';
import { fetchCommittedAssignments } from './committedAssignments';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

export async function revalidateNeighbors(
  sb: SupabaseClient,
  changedSlotId: string,
  providerId: string | null,
): Promise<string[]> {
  const revalidatedSlotIds: string[] = [];
  if (!providerId) return revalidatedSlotIds;
  try {
    const { data: changedSlot } = await sb
      .from('schedule_slots')
      .select('slot_date, schedule_version_id')
      .eq('id', changedSlotId)
      .maybeSingle();
    if (!changedSlot) return revalidatedSlotIds;
    const center = (changedSlot as { slot_date: string }).slot_date;
    const versionId = (changedSlot as { schedule_version_id?: string | null }).schedule_version_id ?? null;
    const start = shiftDate(center, -7);
    const end = shiftDate(center, 7);

    // Draft isolation (invariant 3): revalidate only the provider's neighbors
    // that are committed (published) or in the version being edited — an edit
    // in one draft must not rewrite a different draft's stored flags.
    const { data: neighbors } = await fetchCommittedAssignments(
      sb,
      'id, schedule_slot_id, schedule_slots!inner(slot_date, schedule_versions!inner(version_status))',
      { providerId, start, end, includeVersionId: versionId },
    );

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
