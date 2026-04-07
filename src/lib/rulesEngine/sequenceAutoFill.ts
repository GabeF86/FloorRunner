// Sequence rule auto-fill / cleanup.
//
// When a manual assignment matches the trigger of an active sequence rule,
// we look for the linked-shift slot on the next/prev day in the same
// schedule version and auto-assign the same provider to it. The reverse
// also runs on DELETE: removing the trigger removes any linked auto-fills
// for that provider.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

interface SequenceRule {
  id: string;
  trigger_shift_code: string;
  linked_shift_code: string;
  relationship: 'post_call' | 'pre_call';
  applies_to_provider_group: 'physician' | 'crna' | 'both';
}

function shiftDate(iso: string, delta: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function loadActiveSequenceRulesForSite(
  sb: SupabaseClient,
  siteId: string,
): Promise<SequenceRule[]> {
  const { data: ruleSets } = await sb
    .from('rule_sets')
    .select('id')
    .eq('site_id', siteId)
    .eq('status', 'active');
  const ids = (ruleSets || []).map((r: { id: string }) => r.id);
  if (ids.length === 0) return [];
  const { data: defs } = await sb
    .from('rule_definitions')
    .select('id, rule_category, condition, action, applies_to_provider_group, is_active')
    .in('rule_set_id', ids)
    .eq('is_active', true)
    .eq('rule_category', 'sequence');
  return ((defs || []) as Array<Record<string, unknown>>)
    .map(d => {
      const cond = (d.condition as Record<string, unknown>) || {};
      const action = (d.action as Record<string, unknown>) || {};
      const trigger = cond.trigger_shift_code as string | undefined;
      const linked = action.linked_shift_code as string | undefined;
      if (!trigger || !linked) return null;
      return {
        id: d.id as string,
        trigger_shift_code: trigger,
        linked_shift_code: linked,
        relationship: ((cond.relationship as string) || 'post_call') as 'post_call' | 'pre_call',
        applies_to_provider_group: (d.applies_to_provider_group as SequenceRule['applies_to_provider_group']) || 'both',
      } satisfies SequenceRule;
    })
    .filter((r): r is SequenceRule => r !== null);
}

async function getProviderHomeSiteId(sb: SupabaseClient, providerId: string): Promise<string | null> {
  const { data } = await sb
    .from('provider_employment_profiles')
    .select('home_site_id')
    .eq('provider_id', providerId)
    .maybeSingle();
  return (data as { home_site_id: string | null } | null)?.home_site_id ?? null;
}

interface AutoFillResult {
  filledSlotIds: string[];
}

/**
 * After a manual assignment is saved, look for sequence rules that the
 * trigger shift matches and auto-fill the linked slot the next/prev day.
 *
 * Resolution rules:
 *   - Linked slot must exist in the SAME schedule version as the trigger
 *   - Linked slot must currently be unassigned (no provider) and unlocked
 *   - If multiple linked slots exist on that day, prefer the one whose
 *     site_id matches the provider's home_site_id; otherwise skip (we
 *     don't guess across sites)
 *   - If the provider already has an assignment that day, skip (the
 *     validator will surface a sequence conflict instead)
 *   - If the provider has approved PTO/sick/etc on that day, skip
 *     (per the D1 post-call edge case — leave unassigned and flag)
 */
export async function applySequenceAutoFill(
  sb: SupabaseClient,
  triggerSlotId: string,
  providerId: string,
): Promise<AutoFillResult> {
  const filled: string[] = [];

  // Load the trigger slot + its shift type code + schedule version
  const { data: triggerSlot } = await sb
    .from('schedule_slots')
    .select('id, site_id, slot_date, schedule_version_id, shift_type_id, shift_types(code)')
    .eq('id', triggerSlotId)
    .maybeSingle();
  if (!triggerSlot) return { filledSlotIds: filled };

  const ts = triggerSlot as Record<string, unknown>;
  const triggerCode = (ts.shift_types as { code?: string } | null)?.code;
  if (!triggerCode) return { filledSlotIds: filled };
  const siteId = ts.site_id as string;
  const triggerDate = ts.slot_date as string;
  const versionId = ts.schedule_version_id as string;

  const rules = await loadActiveSequenceRulesForSite(sb, siteId);
  const matching = rules.filter(r => r.trigger_shift_code === triggerCode);
  if (matching.length === 0) return { filledSlotIds: filled };

  const homeSiteId = await getProviderHomeSiteId(sb, providerId);

  for (const rule of matching) {
    const offset = rule.relationship === 'pre_call' ? -1 : 1;
    const linkedDate = shiftDate(triggerDate, offset);

    // Find candidate linked slots on the linked date in the same version
    const { data: candidates } = await sb
      .from('schedule_slots')
      .select('id, site_id, locked, shift_type_id, shift_types(code), assignments(id, provider_id, assignment_status)')
      .eq('schedule_version_id', versionId)
      .eq('slot_date', linkedDate);

    const candidateRows = ((candidates || []) as Array<Record<string, unknown>>).filter(c => {
      const code = (c.shift_types as { code?: string } | null)?.code;
      return code === rule.linked_shift_code;
    });

    if (candidateRows.length === 0) continue;

    // Prefer the slot at the provider's home site (if more than one match)
    let chosen = candidateRows.find(c => homeSiteId && (c.site_id as string) === homeSiteId);
    if (!chosen) {
      // Single candidate is fine without home-site disambiguation
      if (candidateRows.length === 1) {
        chosen = candidateRows[0];
      } else {
        // Multiple candidates and no home-site match — skip (ambiguous)
        continue;
      }
    }

    if (chosen.locked) continue;

    // Skip if already assigned to someone (or even to this provider)
    const assignments = (chosen.assignments as Array<{
      id: string;
      provider_id: string | null;
      assignment_status: string;
    }>) || [];
    const occupied = assignments.find(a => a.provider_id);
    if (occupied) continue;

    // Skip if provider has approved time off on that day
    const { data: pto } = await sb
      .from('provider_availability')
      .select('id, availability_type, approval_status')
      .eq('provider_id', providerId)
      .lte('start_date', linkedDate)
      .gte('end_date', linkedDate);
    const blocked = ((pto || []) as Array<{ availability_type: string; approval_status: string }>).some(
      a =>
        a.approval_status !== 'denied' &&
        a.approval_status !== 'canceled' &&
        ['pto', 'sick', 'fmla', 'parental_leave', 'military_leave', 'jury_duty', 'unavailable', 'blocked'].includes(
          a.availability_type,
        ),
    );
    if (blocked) continue;

    // Skip if provider already has an assignment on that day in this version
    const { data: sameDay } = await sb
      .from('assignments')
      .select('id, schedule_slots!inner(slot_date, schedule_version_id)')
      .eq('provider_id', providerId)
      .eq('assignment_status', 'assigned')
      .eq('schedule_slots.schedule_version_id', versionId)
      .eq('schedule_slots.slot_date', linkedDate);
    if ((sameDay || []).length > 0) continue;

    // Upsert the assignment on the linked slot
    const chosenSlotId = chosen.id as string;
    const existingOpen = assignments.find(a => !a.provider_id);
    if (existingOpen) {
      await sb
        .from('assignments')
        .update({
          provider_id: providerId,
          assignment_status: 'assigned',
          source_type: 'auto_generated',
          assigned_at: new Date().toISOString(),
        })
        .eq('id', existingOpen.id);
    } else {
      await sb.from('assignments').insert({
        schedule_slot_id: chosenSlotId,
        provider_id: providerId,
        assignment_status: 'assigned',
        source_type: 'auto_generated',
        assigned_at: new Date().toISOString(),
      });
    }
    filled.push(chosenSlotId);
  }

  return { filledSlotIds: filled };
}

/**
 * When a trigger assignment is removed, also clear out any linked
 * auto-generated assignments for that provider on the linked day.
 * Only removes rows where source_type='auto_generated' AND provider matches —
 * never touches manual edits.
 */
export async function cleanupSequenceAutoFill(
  sb: SupabaseClient,
  triggerSlotId: string,
  providerId: string,
): Promise<void> {
  const { data: triggerSlot } = await sb
    .from('schedule_slots')
    .select('id, site_id, slot_date, schedule_version_id, shift_types(code)')
    .eq('id', triggerSlotId)
    .maybeSingle();
  if (!triggerSlot) return;

  const ts = triggerSlot as Record<string, unknown>;
  const triggerCode = (ts.shift_types as { code?: string } | null)?.code;
  if (!triggerCode) return;
  const siteId = ts.site_id as string;
  const triggerDate = ts.slot_date as string;
  const versionId = ts.schedule_version_id as string;

  const rules = await loadActiveSequenceRulesForSite(sb, siteId);
  const matching = rules.filter(r => r.trigger_shift_code === triggerCode);
  if (matching.length === 0) return;

  for (const rule of matching) {
    const offset = rule.relationship === 'pre_call' ? -1 : 1;
    const linkedDate = shiftDate(triggerDate, offset);

    const { data: linkedSlots } = await sb
      .from('schedule_slots')
      .select('id, shift_types(code), assignments(id, provider_id, source_type)')
      .eq('schedule_version_id', versionId)
      .eq('slot_date', linkedDate);

    for (const slot of (linkedSlots || []) as Array<Record<string, unknown>>) {
      const code = (slot.shift_types as { code?: string } | null)?.code;
      if (code !== rule.linked_shift_code) continue;
      const assignments =
        (slot.assignments as Array<{ id: string; provider_id: string | null; source_type: string }>) ||
        [];
      for (const a of assignments) {
        if (a.provider_id === providerId && a.source_type === 'auto_generated') {
          // Convert back to an open slot
          await sb
            .from('assignments')
            .update({
              provider_id: null,
              assignment_status: 'open',
              source_type: 'manual',
              assigned_at: null,
              validation_flags: [],
            })
            .eq('id', a.id);
        }
      }
    }
  }
}
