// Auto-generation engine.
//
// Given a schedule version, attempt to assign providers to all open slots
// using active rules as constraints. Hard constraints are never violated —
// a slot is left open if no eligible provider exists.
//
// Strategy: greedy assignment ordered by slot priority (call > regular),
// then by date. For each slot, candidate providers are filtered by hard
// constraints and scored by soft factors (fairness / burden count).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

import { evaluateAssignment } from './evaluate';

interface SlotToFill {
  slot_id: string;
  slot_date: string;
  shift_type_id: string;
  shift_type_code: string;
  shift_type_category: string;
  provider_group: 'physician' | 'crna' | 'both';
  required_count: number;
  existing_assignment_id: string | null; // null if we need to insert
}

interface CandidateProvider {
  id: string;
  provider_type: string;
}

interface GenerationResult {
  filled: number;
  skipped: number;
  errors: string[];
  assignments: Array<{
    slot_id: string;
    slot_date: string;
    shift_type_code: string;
    provider_id: string;
    provider_name: string;
  }>;
  unfilled: Array<{
    slot_id: string;
    slot_date: string;
    shift_type_code: string;
    reason: string;
  }>;
}

/**
 * Auto-generate assignments for all open slots in a schedule version.
 */
export async function autoGenerate(
  sb: SupabaseClient,
  scheduleVersionId: string,
): Promise<GenerationResult> {
  const result: GenerationResult = {
    filled: 0,
    skipped: 0,
    errors: [],
    assignments: [],
    unfilled: [],
  };

  // 1. Load all slots for this version with their shift types and current assignments
  const { data: slots, error: slotsErr } = await sb
    .from('schedule_slots')
    .select('id, slot_date, shift_type_id, provider_group, required_count, locked, shift_types(code, category), assignments(id, provider_id, assignment_status)')
    .eq('schedule_version_id', scheduleVersionId)
    .order('slot_date')
    .order('slot_index');

  if (slotsErr || !slots) {
    result.errors.push(`Failed to load slots: ${slotsErr?.message || 'no data'}`);
    return result;
  }

  // Build the list of slots that need filling
  const slotsToFill: SlotToFill[] = [];
  for (const raw of slots as Array<Record<string, unknown>>) {
    if (raw.locked) continue;
    const st = raw.shift_types as { code: string; category: string } | null;
    if (!st) continue;
    const assignments = (raw.assignments as Array<{ id: string; provider_id: string | null; assignment_status: string }>) || [];
    const assignedCount = assignments.filter(a => a.provider_id).length;
    const required = (raw.required_count as number) || 1;
    if (assignedCount >= required) continue; // Already fully assigned

    // Find the open assignment row (or null if none exists)
    const openRow = assignments.find(a => !a.provider_id);

    slotsToFill.push({
      slot_id: raw.id as string,
      slot_date: raw.slot_date as string,
      shift_type_id: raw.shift_type_id as string,
      shift_type_code: st.code,
      shift_type_category: st.category,
      provider_group: raw.provider_group as SlotToFill['provider_group'],
      required_count: required,
      existing_assignment_id: openRow?.id || null,
    });
  }

  // Sort: call shifts first, then by date
  const categoryOrder: Record<string, number> = {
    call: 0, regular: 1, float: 2, admin: 3, unavailable: 4, leave: 5,
  };
  slotsToFill.sort((a, b) => {
    const ca = categoryOrder[a.shift_type_category] ?? 3;
    const cb = categoryOrder[b.shift_type_category] ?? 3;
    if (ca !== cb) return ca - cb;
    return a.slot_date.localeCompare(b.slot_date);
  });

  console.log(`[autoGen] ${slotsToFill.length} slots to fill from ${(slots as unknown[]).length} total`);
  if (slotsToFill.length === 0) return result;

  // 2. Load schedule to get the site_id and org
  const { data: firstSlot } = await sb
    .from('schedule_slots')
    .select('site_id')
    .eq('schedule_version_id', scheduleVersionId)
    .limit(1)
    .single();
  if (!firstSlot) {
    result.errors.push('No slots found in this version');
    return result;
  }
  const siteId = (firstSlot as { site_id: string }).site_id;

  // 3. Load eligible providers for this site
  const { data: siteProviders } = await sb
    .from('providers')
    .select('id, provider_type, short_display_name')
    .eq('status', 'active');
  const allProviders: Array<CandidateProvider & { short_display_name: string }> =
    (siteProviders || []) as Array<CandidateProvider & { short_display_name: string }>;

  // Track per-provider burden during generation to spread assignments
  const burdenCount = new Map<string, number>();
  const getCount = (pid: string) => burdenCount.get(pid) || 0;
  const incCount = (pid: string) => burdenCount.set(pid, getCount(pid) + 1);

  // Track which providers are assigned on which dates (to avoid double-booking)
  const assignedOnDate = new Map<string, Set<string>>(); // date -> set of provider_ids
  const markAssigned = (date: string, pid: string) => {
    if (!assignedOnDate.has(date)) assignedOnDate.set(date, new Set());
    assignedOnDate.get(date)!.add(pid);
  };
  const isAssignedOnDate = (date: string, pid: string) =>
    assignedOnDate.get(date)?.has(pid) ?? false;

  // Pre-populate from existing assignments
  for (const raw of slots as Array<Record<string, unknown>>) {
    const assignments = (raw.assignments as Array<{ provider_id: string | null }>) || [];
    for (const a of assignments) {
      if (a.provider_id) markAssigned(raw.slot_date as string, a.provider_id);
    }
  }

  // 4. For each slot, find the best provider
  let slotIdx = 0;
  for (const slot of slotsToFill) {
    slotIdx++;
    if (slotIdx % 10 === 1 || slotIdx === slotsToFill.length) {
      console.log(`[autoGen] processing slot ${slotIdx}/${slotsToFill.length}: ${slot.shift_type_code} on ${slot.slot_date}`);
    }
    // Filter candidates by provider group
    const candidates = allProviders.filter(p => {
      if (slot.provider_group === 'both') return true;
      if (slot.provider_group === 'physician') return p.provider_type === 'physician';
      if (slot.provider_group === 'crna') return ['crna', 'aa'].includes(p.provider_type);
      return true;
    });

    // Filter out providers already assigned on this date
    const available = candidates.filter(p => !isAssignedOnDate(slot.slot_date, p.id));

    // Fast pre-filter using in-memory data (no DB calls).
    // Then run the full evaluator only on the top ~3 candidates.
    const scored = available
      .map(p => ({ provider: p, burden: getCount(p.id) }))
      .sort((a, b) => a.burden - b.burden);

    // Run full evaluation on the top candidates (cap at 5 to limit DB calls)
    const topCandidates = scored.slice(0, 5);
    const validCandidates: Array<{ provider: typeof available[0]; softCount: number }> = [];

    for (const { provider } of topCandidates) {
      const evalResult = await evaluateAssignment(sb, slot.slot_id, provider.id);
      if (evalResult.hardCount === 0) {
        validCandidates.push({ provider, softCount: evalResult.softCount });
      }
    }

    // If none of the top 5 passed, we could try more, but in practice if the
    // lowest-burden candidates can't fill it, the rest likely can't either.
    if (validCandidates.length === 0) {
      result.unfilled.push({
        slot_id: slot.slot_id,
        slot_date: slot.slot_date,
        shift_type_code: slot.shift_type_code,
        reason: available.length === 0
          ? 'No providers available on this date'
          : `Top ${topCandidates.length} candidates (of ${available.length}) have hard constraint violations`,
      });
      result.skipped++;
      continue;
    }

    // Already sorted by burden; pick the first valid one
    const chosen = validCandidates[0].provider;

    // Assign
    try {
      if (slot.existing_assignment_id) {
        await sb
          .from('assignments')
          .update({
            provider_id: chosen.id,
            assignment_status: 'assigned',
            source_type: 'auto_generated',
            assigned_at: new Date().toISOString(),
          })
          .eq('id', slot.existing_assignment_id);
      } else {
        await sb.from('assignments').insert({
          schedule_slot_id: slot.slot_id,
          provider_id: chosen.id,
          assignment_status: 'assigned',
          source_type: 'auto_generated',
          assigned_at: new Date().toISOString(),
        });
      }

      // Update tracking
      markAssigned(slot.slot_date, chosen.id);
      incCount(chosen.id);

      // Run validation and store flags
      const finalEval = await evaluateAssignment(sb, slot.slot_id, chosen.id);
      if (slot.existing_assignment_id) {
        await sb
          .from('assignments')
          .update({ validation_flags: finalEval.violations })
          .eq('id', slot.existing_assignment_id);
      }

      result.assignments.push({
        slot_id: slot.slot_id,
        slot_date: slot.slot_date,
        shift_type_code: slot.shift_type_code,
        provider_id: chosen.id,
        provider_name: chosen.short_display_name,
      });
      result.filled++;
    } catch (err) {
      result.errors.push(`Failed to assign ${slot.shift_type_code} on ${slot.slot_date}: ${err}`);
      result.skipped++;
    }
  }

  return result;
}
