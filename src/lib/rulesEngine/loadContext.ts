// Loosely-typed Supabase client — the project uses a non-default schema
// ("scheduling") so we accept any schema parameterization.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
import type {
  EvaluationContext,
  RuleDefinition,
  ShiftTypeRow,
  SlotRow,
  ProviderSiteCredentials,
  AvailabilityRow,
  DayType,
} from './types';

const NEIGHBOR_WINDOW_DAYS = 14;

function addDays(iso: string, delta: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// Pre-loaded per-site validation context. When provided to loadContext, the
// shift-type and rule-definition queries are skipped (N+1 fix for batch validation).
export interface SiteValidationContext {
  shiftTypesById: Map<string, ShiftTypeRow>;
  shiftTypesByCode: Map<string, ShiftTypeRow>;
  rules: RuleDefinition[];
}

// Load the per-site shift-types + active rules ONCE, for reuse across a batch
// of evaluateAssignment calls on the same site.
export async function loadSiteValidationContext(
  sb: SupabaseClient,
  siteId: string,
): Promise<SiteValidationContext> {
  const { data: shiftTypes } = await sb
    .from('shift_types')
    .select('id, site_id, code, name, category, requires_credential, requires_specific_skills')
    .eq('site_id', siteId);
  const shiftTypeRows: ShiftTypeRow[] = (shiftTypes || []).map((s: Record<string, unknown>) => ({
    id: s.id as string,
    site_id: s.site_id as string,
    code: s.code as string,
    name: s.name as string,
    category: s.category as ShiftTypeRow['category'],
    requires_credential: (s.requires_credential as string | null) ?? null,
    requires_specific_skills: Array.isArray(s.requires_specific_skills)
      ? (s.requires_specific_skills as string[]) : [],
  }));
  const { data: ruleSets } = await sb
    .from('rule_sets').select('id').eq('site_id', siteId).eq('status', 'active');
  const ruleSetIds = (ruleSets || []).map((r: { id: string }) => r.id);
  let rules: RuleDefinition[] = [];
  if (ruleSetIds.length > 0) {
    const { data: ruleRows } = await sb
      .from('rule_definitions')
      .select('id, rule_set_id, rule_name, rule_category, hard_constraint, priority_rank, applies_to_provider_group, applies_to_shift_types, applies_to_day_types, condition, action, explanation_text, is_active')
      .in('rule_set_id', ruleSetIds).eq('is_active', true);
    rules = (ruleRows || []) as RuleDefinition[];
  }
  return {
    shiftTypesById: new Map(shiftTypeRows.map(s => [s.id, s])),
    shiftTypesByCode: new Map(shiftTypeRows.map(s => [s.code, s])),
    rules,
  };
}

/**
 * Load everything an evaluator might need to validate a single (slot, provider).
 * One round-trip per logical entity — we accept the chattiness for clarity.
 *
 * When `siteCtx` is provided, the shift-types and rule-definitions queries are
 * skipped and the preloaded maps/rules are used instead (N+1 fix for batch validation).
 */
export async function loadContext(
  sb: SupabaseClient,
  slotId: string,
  providerId: string | null,
  siteCtx?: SiteValidationContext,
): Promise<EvaluationContext | null> {
  // 1. The slot itself
  const { data: slot, error: slotErr } = await sb
    .from('schedule_slots')
    .select('id, site_id, slot_date, shift_type_id, provider_group, derived_day_type, schedule_version_id, required_count')
    .eq('id', slotId)
    .maybeSingle();
  if (slotErr || !slot) return null;
  const slotRow = slot as SlotRow;
  const scheduleVersionId = (slot as Record<string, unknown>).schedule_version_id as string | null;

  // 2. All shift types for this site + active rules.
  //    When a preloaded siteCtx is provided, skip both queries (N+1 fix).
  let shiftTypesById: Map<string, ShiftTypeRow>;
  let shiftTypesByCode: Map<string, ShiftTypeRow>;
  let rules: RuleDefinition[];

  if (siteCtx) {
    // Fast path: reuse the caller-supplied preloaded context.
    shiftTypesById = siteCtx.shiftTypesById;
    shiftTypesByCode = siteCtx.shiftTypesByCode;
    rules = siteCtx.rules;
  } else {
    // Slow path: query inline (preserves behavior for non-batched callers).
    const { data: shiftTypes } = await sb
      .from('shift_types')
      .select('id, site_id, code, name, category, requires_credential, requires_specific_skills')
      .eq('site_id', slotRow.site_id);
    const shiftTypeRows: ShiftTypeRow[] = (shiftTypes || []).map((s: Record<string, unknown>) => ({
      id: s.id as string,
      site_id: s.site_id as string,
      code: s.code as string,
      name: s.name as string,
      category: s.category as ShiftTypeRow['category'],
      requires_credential: (s.requires_credential as string | null) ?? null,
      requires_specific_skills: Array.isArray(s.requires_specific_skills)
        ? (s.requires_specific_skills as string[])
        : [],
    }));
    shiftTypesById = new Map(shiftTypeRows.map(s => [s.id, s]));
    shiftTypesByCode = new Map(shiftTypeRows.map(s => [s.code, s]));

    const { data: ruleSets } = await sb
      .from('rule_sets')
      .select('id')
      .eq('site_id', slotRow.site_id)
      .eq('status', 'active');
    const ruleSetIds = (ruleSets || []).map((r: { id: string }) => r.id);

    rules = [];
    if (ruleSetIds.length > 0) {
      const { data: ruleRows } = await sb
        .from('rule_definitions')
        .select(
          'id, rule_set_id, rule_name, rule_category, hard_constraint, priority_rank, applies_to_provider_group, applies_to_shift_types, applies_to_day_types, condition, action, explanation_text, is_active',
        )
        .in('rule_set_id', ruleSetIds)
        .eq('is_active', true);
      rules = (ruleRows || []) as RuleDefinition[];
    }
  }

  const shiftType = shiftTypesById.get(slotRow.shift_type_id);
  if (!shiftType) return null;

  // 4. Provider-specific data (only if a provider is assigned)
  let credentials: ProviderSiteCredentials | null = null;
  let providerGroup: EvaluationContext['providerGroup'] = null;
  let neighborAssignments: EvaluationContext['neighborAssignments'] = [];
  let availability: AvailabilityRow[] = [];

  if (providerId) {
    // Provider basic info (for provider_group)
    const { data: provider } = await sb
      .from('providers')
      .select('id, provider_type')
      .eq('id', providerId)
      .maybeSingle();
    if (provider) {
      const t = (provider as { provider_type: string }).provider_type;
      providerGroup = t === 'physician' ? 'physician' : t === 'crna' || t === 'aa' ? 'crna' : 'both';
    }

    // Site credentials
    const { data: cred } = await sb
      .from('provider_site_credentials')
      .select(
        'provider_id, site_id, is_active, credentialed, can_take_call, can_take_weekend_call, can_take_holiday_call, can_take_backup_call, allowed_shift_types, excluded_shift_types, skill_tags',
      )
      .eq('provider_id', providerId)
      .eq('site_id', slotRow.site_id)
      .maybeSingle();
    if (cred) {
      const c = cred as Record<string, unknown>;
      credentials = {
        provider_id: c.provider_id as string,
        site_id: c.site_id as string,
        is_active: !!c.is_active,
        credentialed: !!c.credentialed,
        can_take_call: !!c.can_take_call,
        can_take_weekend_call: !!c.can_take_weekend_call,
        can_take_holiday_call: !!c.can_take_holiday_call,
        can_take_backup_call: !!c.can_take_backup_call,
        allowed_shift_types: Array.isArray(c.allowed_shift_types) ? (c.allowed_shift_types as string[]) : [],
        excluded_shift_types: Array.isArray(c.excluded_shift_types) ? (c.excluded_shift_types as string[]) : [],
        skill_tags: Array.isArray(c.skill_tags) ? (c.skill_tags as string[]) : [],
      };
    }

    // Neighbor assignments — look at a wider window (±31 days) so frequency
    // checks have a full month on each side. Cheap query.
    const winStart = addDays(slotRow.slot_date, -31);
    const winEnd = addDays(slotRow.slot_date, 31);

    const { data: neighbors } = await sb
      .from('assignments')
      .select(
        'id, schedule_slot_id, schedule_slots!inner(id, slot_date, shift_type_id, derived_day_type, site_id)',
      )
      .eq('provider_id', providerId)
      .eq('assignment_status', 'assigned')
      .gte('schedule_slots.slot_date', winStart)
      .lte('schedule_slots.slot_date', winEnd);

    neighborAssignments = ((neighbors || []) as Record<string, unknown>[])
      .map(row => {
        const slot = row.schedule_slots as Record<string, unknown> | null;
        if (!slot) return null;
        const st = shiftTypesById.get(slot.shift_type_id as string);
        if (!st) return null;
        // Skip the slot under evaluation — it's not a "neighbor" of itself
        if ((slot.id as string) === slotId) return null;
        return {
          assignment_id: row.id as string,
          slot_date: slot.slot_date as string,
          shift_type_code: st.code,
          shift_type_category: st.category,
          day_type: (slot.derived_day_type as DayType | null) ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    // Availability overlapping the immediate ±NEIGHBOR_WINDOW_DAYS window
    const availStart = addDays(slotRow.slot_date, -NEIGHBOR_WINDOW_DAYS);
    const availEnd = addDays(slotRow.slot_date, NEIGHBOR_WINDOW_DAYS);
    const { data: avail } = await sb
      .from('provider_availability')
      .select('id, provider_id, availability_type, start_date, end_date, approval_status')
      .eq('provider_id', providerId)
      .lte('start_date', availEnd)
      .gte('end_date', availStart);
    availability = (avail || []) as AvailabilityRow[];
  }

  // 5. All assignments on the same date in the same schedule version
  //    (for coverage and pairing checks — "are enough providers filling this day?")
  let sameDayAssignments: EvaluationContext['sameDayAssignments'] = [];
  if (scheduleVersionId) {
    const { data: sameDay } = await sb
      .from('schedule_slots')
      .select('id, slot_date, shift_type_id, required_count, assignments(provider_id)')
      .eq('schedule_version_id', scheduleVersionId)
      .eq('slot_date', slotRow.slot_date);

    sameDayAssignments = ((sameDay || []) as Array<Record<string, unknown>>).flatMap(s => {
      const st = shiftTypesById.get(s.shift_type_id as string);
      if (!st) return [];
      const assignments = (s.assignments as Array<{ provider_id: string | null }>) || [];
      return assignments.map(a => ({
        slot_id: s.id as string,
        slot_date: s.slot_date as string,
        shift_type_code: st.code,
        shift_type_category: st.category,
        provider_id: a.provider_id,
        required_count: (s.required_count as number) || 1,
      }));
    });
  }

  // 6. Cross-site assignments for this provider on the same date
  //    (across ALL schedules, not just this version — to detect double-booking)
  let crossSiteAssignments: EvaluationContext['crossSiteAssignments'] = [];
  if (providerId) {
    const { data: crossSite } = await sb
      .from('assignments')
      .select('id, schedule_slots!inner(site_id, slot_date, shift_type_id)')
      .eq('provider_id', providerId)
      .eq('assignment_status', 'assigned')
      .eq('schedule_slots.slot_date', slotRow.slot_date);

    crossSiteAssignments = ((crossSite || []) as Array<Record<string, unknown>>)
      .map(row => {
        const s = row.schedule_slots as Record<string, unknown> | null;
        if (!s) return null;
        const st = shiftTypesById.get(s.shift_type_id as string);
        return {
          assignment_id: row.id as string,
          site_id: s.site_id as string,
          slot_date: s.slot_date as string,
          shift_type_code: st?.code || 'unknown',
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }

  return {
    slot: slotRow,
    shiftType,
    providerId,
    providerGroup,
    credentials,
    neighborAssignments,
    availability,
    sameDayAssignments,
    crossSiteAssignments,
    scheduleVersionId,
    rules,
    shiftTypesByCode,
    shiftTypesById,
  };
}
