// Loosely-typed Supabase client — the project uses a non-default schema
// ("scheduling") so we accept any schema parameterization.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
import { addDays, NEIGHBOR_WINDOW_DAYS, AVAIL_WINDOW_DAYS } from './shared';
import { fetchCommittedAssignments } from './committedAssignments';
import { embedArray } from '@/lib/embed';
import type {
  EvaluationContext,
  RuleDefinition,
  ShiftTypeRow,
  SlotRow,
  ProviderSiteCredentials,
  AvailabilityRow,
  DayType,
} from './types';

// ── Shared row → context mappers ─────────────────────────────────────────────
// Used by BOTH the serial path (below) and batchValidate so the two cannot
// drift — batch/serial parity depends on identical mapping semantics.

// providers.provider_type → the coarse provider_group used by rule scoping.
export function providerGroupFromType(t: string): 'physician' | 'crna' | 'both' {
  return t === 'physician' ? 'physician' : t === 'crna' || t === 'aa' ? 'crna' : 'both';
}

// Parse the provider_employment_profiles(fte_value) embed off a providers row.
// PostgREST returns an object for the one-to-one relation, but be tolerant of
// an array shape (and of numeric-as-string serialization).
export function parseEmbeddedFte(rel: unknown): number | null {
  const row = Array.isArray(rel) ? rel[0] : rel;
  if (!row || typeof row !== 'object') return null;
  const v = (row as Record<string, unknown>).fte_value;
  const n = typeof v === 'number' ? v : v != null ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

// Parse the provider_employment_profiles(call_taker, partial_call_taker,
// is_day_doc) embed into the pool flags the poolEligibility evaluator needs.
// Same object-or-array tolerance as parseEmbeddedFte. Returns null when there
// is NO profile row (evaluator treats null as ineligible for both pools —
// never a silent pass); a present row defaults absent booleans to false.
export function parseEmbeddedPoolFlags(rel: unknown): EvaluationContext['poolFlags'] {
  const row = Array.isArray(rel) ? rel[0] : rel;
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  return {
    call_taker: !!r.call_taker,
    partial_call_taker: !!r.partial_call_taker,
    is_day_doc: !!r.is_day_doc,
  };
}

export function mapCredentialsRow(row: Record<string, unknown>): ProviderSiteCredentials {
  return {
    provider_id: row.provider_id as string,
    site_id: row.site_id as string,
    is_active: !!row.is_active,
    credentialed: !!row.credentialed,
    can_take_call: !!row.can_take_call,
    can_take_weekend_call: !!row.can_take_weekend_call,
    can_take_holiday_call: !!row.can_take_holiday_call,
    can_take_backup_call: !!row.can_take_backup_call,
    allowed_shift_types: Array.isArray(row.allowed_shift_types) ? (row.allowed_shift_types as string[]) : [],
    excluded_shift_types: Array.isArray(row.excluded_shift_types) ? (row.excluded_shift_types as string[]) : [],
    skill_tags: Array.isArray(row.skill_tags) ? (row.skill_tags as string[]) : [],
  };
}

// An assignments row with its joined schedule_slots record.
export interface JoinedAssignmentRow {
  id: string;
  schedule_slots: Record<string, unknown> | null;
}

// Map a joined assignment row to a neighbor entry. Returns null for rows
// with no joined slot, an unknown shift type, or the slot under evaluation
// itself (a slot is not its own neighbor).
export function mapNeighborRow(
  row: JoinedAssignmentRow,
  shiftTypesById: Map<string, ShiftTypeRow>,
  excludeSlotId: string,
): EvaluationContext['neighborAssignments'][number] | null {
  const slot = row.schedule_slots;
  if (!slot) return null;
  const st = shiftTypesById.get(slot.shift_type_id as string);
  if (!st) return null;
  if ((slot.id as string) === excludeSlotId) return null;
  return {
    assignment_id: row.id,
    slot_date: slot.slot_date as string,
    shift_type_code: st.code,
    shift_type_category: st.category,
    day_type: (slot.derived_day_type as DayType | null) ?? null,
  };
}

// Map a joined assignment row to a cross-site entry. Unknown shift types are
// KEPT (code 'unknown') — a double-booking must not hide behind a missing
// shift-type row. Only rows with no joined slot are dropped.
export function mapCrossSiteRow(
  row: JoinedAssignmentRow,
  shiftTypesById: Map<string, ShiftTypeRow>,
): EvaluationContext['crossSiteAssignments'][number] | null {
  const s = row.schedule_slots;
  if (!s) return null;
  const st = shiftTypesById.get(s.shift_type_id as string);
  return {
    assignment_id: row.id,
    site_id: s.site_id as string,
    slot_date: s.slot_date as string,
    shift_type_code: st?.code || 'unknown',
  };
}

// Pre-loaded per-site validation context. When provided to loadContext, the
// shift-type and rule-definition queries are skipped (N+1 fix for batch validation).
export interface SiteValidationContext {
  shiftTypesById: Map<string, ShiftTypeRow>;
  shiftTypesByCode: Map<string, ShiftTypeRow>;
  rules: RuleDefinition[];
  // Set when any of the site-context queries failed. Consumers must treat the
  // context as unusable (evaluated:false / no writes) — empty maps or rules:[]
  // from a failed query must NEVER read as "no rules configured" (invariant 6).
  loadError?: string;
}

// Load the per-site shift-types + active rules ONCE, for reuse across a batch
// of evaluateAssignment calls on the same site. A query failure returns a
// context with `loadError` set — never silently-empty maps/rules.
export async function loadSiteValidationContext(
  sb: SupabaseClient,
  siteId: string,
): Promise<SiteValidationContext> {
  const fail = (msg: string): SiteValidationContext => ({
    shiftTypesById: new Map(),
    shiftTypesByCode: new Map(),
    rules: [],
    loadError: msg,
  });

  const { data: shiftTypes, error: stErr } = await sb
    .from('shift_types')
    .select('id, site_id, code, name, category, requires_credential, requires_specific_skills, generation_engine')
    .eq('site_id', siteId);
  if (stErr) return fail(`shift_types load failed: ${stErr.message}`);
  const shiftTypeRows: ShiftTypeRow[] = (shiftTypes || []).map((s: Record<string, unknown>) => ({
    id: s.id as string,
    site_id: s.site_id as string,
    code: s.code as string,
    name: s.name as string,
    category: s.category as ShiftTypeRow['category'],
    requires_credential: (s.requires_credential as string | null) ?? null,
    requires_specific_skills: Array.isArray(s.requires_specific_skills)
      ? (s.requires_specific_skills as string[]) : [],
    generation_engine: (s.generation_engine as string | null) ?? null,
  }));
  const { data: ruleSets, error: rsErr } = await sb
    .from('rule_sets').select('id').eq('site_id', siteId).eq('status', 'active');
  if (rsErr) return fail(`rule_sets load failed: ${rsErr.message}`);
  const ruleSetIds = (ruleSets || []).map((r: { id: string }) => r.id);
  let rules: RuleDefinition[] = [];
  if (ruleSetIds.length > 0) {
    const { data: ruleRows, error: rdErr } = await sb
      .from('rule_definitions')
      .select('id, rule_set_id, rule_name, rule_category, hard_constraint, priority_rank, applies_to_provider_group, applies_to_shift_types, applies_to_day_types, condition, action, explanation_text, is_active')
      .in('rule_set_id', ruleSetIds).eq('is_active', true);
    if (rdErr) return fail(`rule_definitions load failed: ${rdErr.message}`);
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

  // Site-level validation context: reuse the caller's preloaded copy when
  // present (the N+1 fast path), otherwise load it for this slot's site.
  // A context that failed to load is unusable — returning null makes the
  // evaluation come back evaluated:false so no caller persists fake-clean flags.
  const siteVal = siteCtx ?? await loadSiteValidationContext(sb, slotRow.site_id);
  if (siteVal.loadError) return null;
  const { shiftTypesById, shiftTypesByCode, rules } = siteVal;
  const shiftType = shiftTypesById.get(slotRow.shift_type_id);
  if (!shiftType) return null;

  // 4. Provider-specific data (only if a provider is assigned)
  let credentials: ProviderSiteCredentials | null = null;
  let providerGroup: EvaluationContext['providerGroup'] = null;
  let fteValue: number | null = null;
  let poolFlags: EvaluationContext['poolFlags'] = null;
  let neighborAssignments: EvaluationContext['neighborAssignments'] = [];
  let availability: AvailabilityRow[] = [];

  // FAIL CLOSED on every context query below: a transient failure that
  // silently emptied availability/neighbors/cross-site/same-day data would let
  // the evaluators report clean over real PTO or double-booking violations
  // (invariants 2/3/6). Returning null makes the evaluation come back
  // evaluated:false, so guarded write-sites decline (or write the sentinel).
  if (providerId) {
    // Provider basic info (provider_group + FTE for fairness scaling).
    // A MISSING row is tolerated (group stays null); a query ERROR is not.
    const { data: provider, error: providerErr } = await sb
      .from('providers')
      .select('id, provider_type, provider_employment_profiles(fte_value, call_taker, partial_call_taker, is_day_doc)')
      .eq('id', providerId)
      .maybeSingle();
    if (providerErr) return null;
    if (provider) {
      const p = provider as Record<string, unknown>;
      providerGroup = providerGroupFromType(p.provider_type as string);
      fteValue = parseEmbeddedFte(p.provider_employment_profiles);
      poolFlags = parseEmbeddedPoolFlags(p.provider_employment_profiles);
    }

    // Site credentials (missing row = not-yet-configured, tolerated)
    const { data: cred, error: credErr } = await sb
      .from('provider_site_credentials')
      .select(
        'provider_id, site_id, is_active, credentialed, can_take_call, can_take_weekend_call, can_take_holiday_call, can_take_backup_call, allowed_shift_types, excluded_shift_types, skill_tags',
      )
      .eq('provider_id', providerId)
      .eq('site_id', slotRow.site_id)
      .maybeSingle();
    if (credErr) return null;
    if (cred) credentials = mapCredentialsRow(cred as Record<string, unknown>);

    // Neighbor assignments — look at a wider window (±NEIGHBOR_WINDOW_DAYS)
    // so frequency checks have a full month on each side. Scoped to THIS
    // slot's schedule version + site: sequence/rest/frequency checks must not
    // see other versions' drafts or other sites' schedules as "neighbors".
    // (Cross-site double-booking is detected separately by the
    // deliberately-unscoped cross-site query below.)
    const winStart = addDays(slotRow.slot_date, -NEIGHBOR_WINDOW_DAYS);
    const winEnd = addDays(slotRow.slot_date, NEIGHBOR_WINDOW_DAYS);

    const { data: neighbors, error: neighborsErr } = await sb
      .from('assignments')
      .select(
        'id, schedule_slot_id, schedule_slots!inner(id, slot_date, shift_type_id, derived_day_type, site_id)',
      )
      .eq('provider_id', providerId)
      .eq('assignment_status', 'assigned')
      .eq('schedule_slots.schedule_version_id', scheduleVersionId)
      .eq('schedule_slots.site_id', slotRow.site_id)
      .gte('schedule_slots.slot_date', winStart)
      .lte('schedule_slots.slot_date', winEnd);
    if (neighborsErr) return null;

    neighborAssignments = ((neighbors || []) as JoinedAssignmentRow[])
      .map(row => mapNeighborRow(row, shiftTypesById, slotId))
      .filter((x): x is NonNullable<typeof x> => x !== null);

    // Availability overlapping the immediate ±AVAIL_WINDOW_DAYS window
    const availStart = addDays(slotRow.slot_date, -AVAIL_WINDOW_DAYS);
    const availEnd = addDays(slotRow.slot_date, AVAIL_WINDOW_DAYS);
    const { data: avail, error: availErr } = await sb
      .from('provider_availability')
      .select('id, provider_id, availability_type, start_date, end_date, approval_status')
      .eq('provider_id', providerId)
      .lte('start_date', availEnd)
      .gte('end_date', availStart);
    if (availErr) return null; // PENDING/approved PTO must never silently vanish
    availability = (avail || []) as AvailabilityRow[];
  }

  // 5. All assignments on the same date in the same schedule version
  //    (for coverage and pairing checks — "are enough providers filling this day?")
  let sameDayAssignments: EvaluationContext['sameDayAssignments'] = [];
  if (scheduleVersionId) {
    const { data: sameDay, error: sameDayErr } = await sb
      .from('schedule_slots')
      .select('id, slot_date, shift_type_id, required_count, assignments(provider_id)')
      .eq('schedule_version_id', scheduleVersionId)
      .eq('slot_date', slotRow.slot_date);
    if (sameDayErr) return null;

    sameDayAssignments = ((sameDay || []) as Array<Record<string, unknown>>).flatMap(s => {
      const st = shiftTypesById.get(s.shift_type_id as string);
      if (!st) return [];
      // UNIQUE(schedule_slot_id) → PostgREST returns this embed as a single
      // OBJECT (or null) against the live DB; dev fakes return arrays.
      const assignments = embedArray(s.assignments) as Array<{ provider_id: string | null }>;
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

  // 6. Cross-site assignments for this provider on the same date — every
  //    PUBLISHED (committed) version plus THIS slot's version (draft isolation,
  //    invariant 3). The self row is included via includeVersionId; an
  //    overlapping *other* draft is invisible (resolved at publish time).
  let crossSiteAssignments: EvaluationContext['crossSiteAssignments'] = [];
  if (providerId) {
    const { data: crossSite, error: crossSiteErr } = await fetchCommittedAssignments(
      sb,
      'id, schedule_slots!inner(site_id, slot_date, shift_type_id, schedule_versions!inner(version_status))',
      {
        providerId,
        start: slotRow.slot_date,
        end: slotRow.slot_date,
        includeVersionId: scheduleVersionId,
      },
    );
    if (crossSiteErr) return null; // a hidden double-booking is invariant 3 broken

    crossSiteAssignments = ((crossSite ?? []) as unknown as JoinedAssignmentRow[])
      .map(row => mapCrossSiteRow(row, shiftTypesById))
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }

  return {
    slot: slotRow,
    shiftType,
    providerId,
    providerGroup,
    credentials,
    fte_value: fteValue,
    poolFlags,
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
