// Auto-generation engine for physician call schedules.
//
// Handles category='call' slots only. Day shifts (7-3, 7-5) are handled by
// dayShiftAutoGen.ts, which runs as a second pass in the /generate route.
// CRNA scheduling is out of scope today.
//
// High-level flow:
//   1. Preload everything in one pass (slots, pool, credentials, availability,
//      cross-site conflicts, historical counts).
//   2. Compute FTE-weighted bucket quotas with historical deficit carried
//      forward so part-timers catch up across blocks.
//   3. Pre-PTO Thursday pass — give providers a long weekend before vacation.
//   4. Main greedy loop: for each call slot, pick the eligible provider with
//      the lowest lifetime-ratio, chain D-shifts inline, pair weekend blocks.
//   5. D4–D9 relief pass for the remaining "first on out-list" assignments.
//   6. Write validation flags for every call assignment in parallel batches.
//
// See /ALGORITHM.md for a fuller explanation.

import { evaluateAssignment } from './evaluate';
import {
  BLOCKING_AVAIL,
  BOOKEND_EXTENDING_TYPES,
  addDays,
  dayTypeBucket,
  datesOverlap,
  effectivePtoRange,
  normalizeWeekdays,
  thursdayBeforeWeekOf,
  type SupabaseClient,
} from './shared';

const DEFAULT_PAR_LEVEL = 12; // fallback when site.call_par_level isn't set
const NEIGHBOR_WINDOW_DAYS = 31;

interface SlotToFill {
  slot_id: string;
  slot_date: string;
  shift_type_id: string;
  shift_type_code: string;
  shift_type_category: string;
  derived_day_type: string;
  provider_group: 'physician' | 'crna' | 'both';
  required_count: number;
  existing_assignment_id: string | null;
}

interface CandidateProvider {
  id: string;
  provider_type: string;
  short_display_name: string;
  fte_value: number;
  home_site_id: string | null;
  // 7 booleans indexed Sun..Sat (matches JS Date.getDay). Defaults to
  // all-true for call-takers who never edit it.
  available_weekdays: boolean[];
}

interface SiteCredentials {
  is_active: boolean;
  credentialed: boolean;
  can_take_call: boolean;
  can_take_weekend_call: boolean;
  can_take_holiday_call: boolean;
  allowed_shift_types: string[];
  excluded_shift_types: string[];
  skill_tags: string[];
}

interface AvailabilityEntry {
  availability_type: string;
  start_date: string;
  end_date: string;
  approval_status: string;
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
  perf?: {
    par_level: number;
    total_slots: number;
    call_slots: number;
    providers: number;
    elapsed_ms: number;
    db_queries: number;
  };
}

// (Helpers now live in ./shared.ts — imported at the top.)

// ── Entry point ──────────────────────────────────────────────────────────────

export interface AutoGenerateOptions {
  // Optional pool override. When provided, the candidate pool is exactly
  // these provider UUIDs (still subject to credentials / availability /
  // conflict checks). When omitted or empty, the default rule-based pool
  // is used: home_site_id match + call_taker or partial_call_taker.
  overrideProviderIds?: string[];
}

export async function autoGenerate(
  sb: SupabaseClient,
  scheduleVersionId: string,
  options: AutoGenerateOptions = {},
): Promise<GenerationResult> {
  const t0 = Date.now();
  let dbQueries = 0;
  const countQ = () => { dbQueries++; };

  const result: GenerationResult = {
    filled: 0, skipped: 0, errors: [], assignments: [], unfilled: [],
  };

  // ── 1. Preload schedule + site + slots ────────────────────────────────────
  countQ();
  const { data: rawSlots, error: slotsErr } = await sb
    .from('schedule_slots')
    .select('id, slot_date, shift_type_id, provider_group, required_count, locked, derived_day_type, site_id, shift_types(code, category), assignments(id, provider_id, assignment_status)')
    .eq('schedule_version_id', scheduleVersionId)
    .order('slot_date')
    .order('slot_index');

  if (slotsErr || !rawSlots || rawSlots.length === 0) {
    result.errors.push(`Failed to load slots: ${slotsErr?.message || 'no slots in version'}`);
    return result;
  }
  const siteId = (rawSlots[0] as { site_id: string }).site_id;

  // Load site to get call_par_level (gracefully fallback if column doesn't exist yet)
  let parLevel = DEFAULT_PAR_LEVEL;
  try {
    countQ();
    const { data: site } = await sb.from('sites').select('call_par_level').eq('id', siteId).single();
    if (site && typeof site.call_par_level === 'number' && site.call_par_level > 0) {
      parLevel = site.call_par_level;
    }
  } catch { /* column may not exist yet — use default */ }

  // ── 2. Build slot index ───────────────────────────────────────────────────
  // slotsToFill = call-category slots that need assignment (main loop)
  // slotIndex   = ALL open slots by date+code (used for weekend chaining and D-fill)
  const slotsToFill: SlotToFill[] = [];
  const slotIndex = new Map<string, Map<string, SlotToFill>>();

  for (const raw of rawSlots as Array<Record<string, unknown>>) {
    if (raw.locked) continue;
    const st = raw.shift_types as { code: string; category: string } | null;
    if (!st) continue;

    const assignments = (raw.assignments as Array<{ id: string; provider_id: string | null }>) || [];
    const required = (raw.required_count as number) || 1;
    const assignedCount = assignments.filter(a => a.provider_id).length;
    if (assignedCount >= required) continue;

    const openRow = assignments.find(a => !a.provider_id);
    const slot: SlotToFill = {
      slot_id: raw.id as string,
      slot_date: raw.slot_date as string,
      shift_type_id: raw.shift_type_id as string,
      shift_type_code: st.code,
      shift_type_category: st.category,
      derived_day_type: (raw.derived_day_type as string) || 'weekday',
      provider_group: raw.provider_group as SlotToFill['provider_group'],
      required_count: required,
      existing_assignment_id: openRow?.id || null,
    };

    // Index every open slot for cross-shift lookups
    if (!slotIndex.has(slot.slot_date)) slotIndex.set(slot.slot_date, new Map());
    slotIndex.get(slot.slot_date)!.set(slot.shift_type_code, slot);

    // Only call slots go through the quota-based main loop.
    // D-slots are filled deterministically in the post-pass from the call schedule.
    if (st.category === 'call') slotsToFill.push(slot);
  }

  // Sort: weekends first (Sat then Sun), then friday, then weekday — by date.
  // Within a date, backup (C2, C3) before primary (C1) so pairing rules pass.
  const dayOrder: Record<string, number> = { saturday: 0, sunday: 1, friday: 2, weekday: 3, holiday: 4 };
  const codeOrder: Record<string, number> = { C2: 0, C3: 1, C1: 2 };
  slotsToFill.sort((a, b) => {
    const da = dayOrder[dayTypeBucket(a.derived_day_type)] ?? 5;
    const db = dayOrder[dayTypeBucket(b.derived_day_type)] ?? 5;
    if (da !== db) return da - db;
    if (a.slot_date !== b.slot_date) return a.slot_date.localeCompare(b.slot_date);
    const ca = codeOrder[a.shift_type_code] ?? 9;
    const cb = codeOrder[b.shift_type_code] ?? 9;
    return ca - cb;
  });

  console.log(`[autoGen] ${slotsToFill.length} call slots to fill, par_level=${parLevel}`);
  if (slotsToFill.length === 0) return result;

  // ── 3. Preload pool providers ─────────────────────────────────────────────
  countQ();
  // Default pool = providers whose home site is this site AND who are flagged
  // as a call-taker or partial call-taker. `can_take_call` on the per-site
  // credential is only an "eligible for extras" flag and does NOT pull
  // someone into the auto-assignment pool.
  //
  // Override pool: when the caller passes overrideProviderIds, the pool is
  // exactly those UUIDs. The home_site/call_taker gates are skipped — the
  // scheduler (a human) has made a deliberate call about who to include.
  // Eligibility checks (credentials, availability, conflicts, FTE quotas)
  // still apply later in the pipeline.
  const override = options.overrideProviderIds && options.overrideProviderIds.length > 0
    ? options.overrideProviderIds
    : null;

  let profilesQuery = sb
    .from('provider_employment_profiles')
    .select('provider_id, fte_value, home_site_id, call_taker, partial_call_taker, available_weekdays');
  if (override) {
    profilesQuery = profilesQuery.in('provider_id', override);
  } else {
    profilesQuery = profilesQuery
      .eq('home_site_id', siteId)
      .or('call_taker.eq.true,partial_call_taker.eq.true');
  }
  const { data: profiles } = await profilesQuery;

  const profileByPid = new Map<string, { fte_value: number; home_site_id: string; available_weekdays: boolean[] }>();
  for (const p of (profiles || []) as Array<Record<string, unknown>>) {
    profileByPid.set(p.provider_id as string, {
      fte_value: (p.fte_value as number) || 1,
      home_site_id: p.home_site_id as string,
      available_weekdays: normalizeWeekdays(p.available_weekdays),
    });
  }
  const providerIds = Array.from(profileByPid.keys());
  if (providerIds.length === 0) {
    result.errors.push(
      override
        ? `Override pool is empty or none of the selected providers have an employment profile.`
        : `No call-takers found at this site. ` +
          `Providers must have home_site_id set to this site AND "Call Taker" ` +
          `or "Partial Call Taker" checked on their Employment & Scheduling tab.`,
    );
    return result;
  }

  countQ();
  const { data: providerRows } = await sb
    .from('providers')
    .select('id, provider_type, short_display_name')
    .in('id', providerIds)
    .eq('status', 'active');

  const providers: CandidateProvider[] = ((providerRows || []) as Array<Record<string, unknown>>).map(p => {
    const prof = profileByPid.get(p.id as string)!;
    return {
      id: p.id as string,
      provider_type: p.provider_type as string,
      short_display_name: p.short_display_name as string,
      fte_value: prof.fte_value,
      home_site_id: prof.home_site_id,
      available_weekdays: prof.available_weekdays,
    };
  });
  const providerById = new Map(providers.map(p => [p.id, p]));

  // ── 4. Preload site credentials for all home-site providers ───────────────
  countQ();
  const { data: creds } = await sb
    .from('provider_site_credentials')
    .select('provider_id, is_active, credentialed, can_take_call, can_take_weekend_call, can_take_holiday_call, allowed_shift_types, excluded_shift_types, skill_tags')
    .eq('site_id', siteId)
    .in('provider_id', providerIds);

  const credByPid = new Map<string, SiteCredentials>();
  for (const c of (creds || []) as Array<Record<string, unknown>>) {
    credByPid.set(c.provider_id as string, {
      is_active: !!c.is_active,
      credentialed: !!c.credentialed,
      can_take_call: !!c.can_take_call,
      can_take_weekend_call: !!c.can_take_weekend_call,
      can_take_holiday_call: !!c.can_take_holiday_call,
      allowed_shift_types: Array.isArray(c.allowed_shift_types) ? (c.allowed_shift_types as string[]) : [],
      excluded_shift_types: Array.isArray(c.excluded_shift_types) ? (c.excluded_shift_types as string[]) : [],
      skill_tags: Array.isArray(c.skill_tags) ? (c.skill_tags as string[]) : [],
    });
  }

  // ── 5. Preload availability for the schedule date range ───────────────────
  const dates = Array.from(new Set(slotsToFill.map(s => s.slot_date))).sort();
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  const availRangeStart = addDays(minDate, -NEIGHBOR_WINDOW_DAYS);
  const availRangeEnd = addDays(maxDate, NEIGHBOR_WINDOW_DAYS);

  countQ();
  const { data: avail } = await sb
    .from('provider_availability')
    .select('provider_id, availability_type, start_date, end_date, approval_status')
    .in('provider_id', providerIds)
    .lte('start_date', availRangeEnd)
    .gte('end_date', availRangeStart);

  const availByPid = new Map<string, AvailabilityEntry[]>();
  for (const a of (avail || []) as Array<Record<string, unknown>>) {
    const list = availByPid.get(a.provider_id as string) || [];
    list.push({
      availability_type: a.availability_type as string,
      start_date: a.start_date as string,
      end_date: a.end_date as string,
      approval_status: a.approval_status as string,
    });
    availByPid.set(a.provider_id as string, list);
  }

  // ── 6. Preload existing cross-site assignments for these providers ────────
  // Anything assigned to these providers on dates in the schedule range, at
  // OTHER sites — used for same-day cross-site conflict checks.
  countQ();
  const { data: crossSite } = await sb
    .from('assignments')
    .select('provider_id, schedule_slots!inner(slot_date, site_id)')
    .in('provider_id', providerIds)
    .eq('assignment_status', 'assigned')
    .gte('schedule_slots.slot_date', minDate)
    .lte('schedule_slots.slot_date', maxDate)
    .neq('schedule_slots.site_id', siteId);

  // crossSiteByDate[pid][date] = true if provider is already on a different site that day
  const crossSiteByDate = new Map<string, Set<string>>();
  for (const a of (crossSite || []) as Array<Record<string, unknown>>) {
    const s = a.schedule_slots as { slot_date: string };
    const pid = a.provider_id as string;
    if (!crossSiteByDate.has(pid)) crossSiteByDate.set(pid, new Set());
    crossSiteByDate.get(pid)!.add(s.slot_date);
  }

  // ── 6.5. Preload historical call assignments ─────────────────────────────
  //
  // Cross-block memory. Per provider, count how many call shifts they've
  // already taken in past schedules at this site, keyed by bucket + code.
  // This lets us (a) score providers by lifetime fairness (not just
  // within-block) and (b) widen a provider's block-level cap to let them
  // catch up if they've been under-allocated historically.
  //
  // "Past" = anything with slot_date strictly before this schedule starts.
  // So schedules that were cancelled / replaced mid-way won't get counted
  // twice, and we automatically ignore the schedule we're generating right
  // now.
  countQ();
  const historicalAssignedByPid = new Map<string, Map<string, number>>();
  const historicalTotalByBucket = new Map<string, number>();
  {
    const { data: hist } = await sb
      .from('assignments')
      .select('provider_id, schedule_slots!inner(slot_date, site_id, derived_day_type, shift_types!inner(code, category))')
      .in('provider_id', providerIds)
      .eq('assignment_status', 'assigned')
      .eq('schedule_slots.site_id', siteId)
      .eq('schedule_slots.shift_types.category', 'call')
      .lt('schedule_slots.slot_date', minDate);

    for (const row of (hist || []) as Array<Record<string, unknown>>) {
      const pid = row.provider_id as string | null;
      const ss = row.schedule_slots as {
        derived_day_type?: string;
        shift_types?: { code?: string };
      } | null;
      if (!pid || !ss) continue;
      const code = ss.shift_types?.code;
      if (!code) continue;
      const key = `${dayTypeBucket(ss.derived_day_type || 'weekday')}|${code}`;
      const byProv = historicalAssignedByPid.get(pid) || new Map<string, number>();
      byProv.set(key, (byProv.get(key) || 0) + 1);
      historicalAssignedByPid.set(pid, byProv);
      historicalTotalByBucket.set(key, (historicalTotalByBucket.get(key) || 0) + 1);
    }
  }
  const getHistorical = (pid: string, dt: string, code: string) =>
    historicalAssignedByPid.get(pid)?.get(`${dayTypeBucket(dt)}|${code}`) || 0;

  // ── 7. Compute bucket totals & targets ────────────────────────────────────
  const bucketTotals = new Map<string, number>();
  for (const s of slotsToFill) {
    const key = `${dayTypeBucket(s.derived_day_type)}|${s.shift_type_code}`;
    bucketTotals.set(key, (bucketTotals.get(key) || 0) + s.required_count);
  }
  // Include already-assigned slots so targets reflect total schedule load
  for (const raw of rawSlots as Array<Record<string, unknown>>) {
    const st = raw.shift_types as { code: string; category: string } | null;
    if (!st || st.category !== 'call') continue;
    const assignments = (raw.assignments as Array<{ provider_id: string | null }>) || [];
    const n = assignments.filter(a => a.provider_id).length;
    if (n > 0) {
      const dt = (raw.derived_day_type as string) || 'weekday';
      const key = `${dayTypeBucket(dt)}|${st.code}`;
      bucketTotals.set(key, (bucketTotals.get(key) || 0) + n);
    }
  }

  // Per-provider block target = base share of THIS block + deficit carried
  // forward from past blocks at this site.
  //
  //   base_i_B     = (block_total_B / par_level) * fte_i
  //   expected_i_B = (hist_total_B / par_level) * fte_i   [what they *should* have]
  //   actual_i_B   = hist_assigned_i_B                    [what they got]
  //   deficit_i_B  = max(0, expected_i_B - actual_i_B)
  //
  //   target_i_B = base_i_B + deficit_i_B
  //
  // The `max(0, …)` means providers who've been OVER-allocated historically
  // don't get their block target shrunk — they just get scored worse so the
  // greedy loop hands slots to under-allocated providers first. A hard
  // shrink of their cap could leave slots unfilled for no good reason.
  const bucketTarget = new Map<string, number>();
  for (const p of providers) {
    for (const [k, blockTotal] of bucketTotals) {
      const base = (blockTotal / parLevel) * p.fte_value;
      const histTotal = historicalTotalByBucket.get(k) || 0;
      const histExpected = (histTotal / parLevel) * p.fte_value;
      const histActual = historicalAssignedByPid.get(p.id)?.get(k) || 0;
      const deficit = Math.max(0, histExpected - histActual);
      bucketTarget.set(`${p.id}|${k}`, base + deficit);
    }
  }

  // ── 8. Runtime state (updated during the loop) ───────────────────────────
  const bucketAssigned = new Map<string, number>();
  const assignedOnDate = new Map<string, Set<string>>();
  const handledSlotIds = new Set<string>();
  // Sorted list of call dates per provider (for burnout / next-call scoring)
  const callDatesByProvider = new Map<string, string[]>();
  const addCallDate = (pid: string, date: string) => {
    const list = callDatesByProvider.get(pid) || [];
    if (list.includes(date)) return;
    list.push(date);
    list.sort();
    callDatesByProvider.set(pid, list);
  };

  // Helper: days from provider's nearest prior call to `date` (Infinity if none)
  const daysSinceLastCall = (pid: string, date: string): number => {
    const list = callDatesByProvider.get(pid) || [];
    let best = Infinity;
    for (const d of list) {
      if (d >= date) break;
      const gap = Math.round((new Date(date + 'T00:00:00Z').getTime() - new Date(d + 'T00:00:00Z').getTime()) / 86400000);
      if (gap < best) best = gap;
    }
    return best;
  };

  const markAssigned = (date: string, pid: string) => {
    if (!assignedOnDate.has(date)) assignedOnDate.set(date, new Set());
    assignedOnDate.get(date)!.add(pid);
  };
  const isAssignedOnDate = (date: string, pid: string) => assignedOnDate.get(date)?.has(pid) ?? false;

  const bucketKey = (pid: string, dt: string, code: string) => `${pid}|${dayTypeBucket(dt)}|${code}`;
  const getAssigned = (pid: string, dt: string, code: string) => bucketAssigned.get(bucketKey(pid, dt, code)) || 0;
  const getTarget = (pid: string, dt: string, code: string) => bucketTarget.get(bucketKey(pid, dt, code)) || 0;
  const incBucket = (pid: string, dt: string, code: string) => {
    const k = bucketKey(pid, dt, code);
    bucketAssigned.set(k, (bucketAssigned.get(k) || 0) + 1);
  };

  // Pre-populate from existing assignments
  for (const raw of rawSlots as Array<Record<string, unknown>>) {
    const st = raw.shift_types as { code: string; category: string } | null;
    const assignments = (raw.assignments as Array<{ provider_id: string | null }>) || [];
    for (const a of assignments) {
      if (a.provider_id) {
        markAssigned(raw.slot_date as string, a.provider_id);
        if (st && st.category === 'call') {
          incBucket(a.provider_id, (raw.derived_day_type as string) || 'weekday', st.code);
          addCallDate(a.provider_id, raw.slot_date as string);
        }
      }
    }
  }

  // ── 9. In-memory eligibility check ────────────────────────────────────────
  const isEligible = (slot: SlotToFill, p: CandidateProvider): boolean => {
    // Provider group match
    if (slot.provider_group === 'physician' && p.provider_type !== 'physician') return false;
    if (slot.provider_group === 'crna' && !['crna', 'aa'].includes(p.provider_type)) return false;

    // Same-date conflict (this schedule)
    if (isAssignedOnDate(slot.slot_date, p.id)) return false;

    // Cross-site conflict (preloaded)
    if (crossSiteByDate.get(p.id)?.has(slot.slot_date)) return false;

    // Weekday availability (only non-call-takers edit this; call-takers are
    // stored as all-true so this is a no-op for them). Index is Sun..Sat.
    const dow = new Date(slot.slot_date + 'T12:00:00Z').getUTCDay();
    if (p.available_weekdays[dow] === false) return false;

    // C1 post-call day-off check: if the provider is already committed to a shift
    // the day AFTER this C1 (e.g. via another call shift's pre-call D-chain), they
    // can't take C1 because they'd be working both days. Saturday C1 is excepted
    // (the weekend swap intentionally puts Sat-C1 person on Sun-C2).
    if (slot.shift_type_code === 'C1' && slot.derived_day_type !== 'saturday') {
      const dayAfter = addDays(slot.slot_date, 1);
      if (isAssignedOnDate(dayAfter, p.id)) return false;
    }

    // Bucket quota. Old rule was `assigned >= target`, which with integer
    // assigned and float target meant any 0 < target ≤ N allowed up to N
    // assignments — so 0.6 FTE (target 1.44) capped at 2, same as 1.0 FTE
    // (target 2.0). Fractional FTE was not actually enforced.
    //
    // New rule: "would one more assignment push us past target?" — i.e.,
    // assigned + 1 > target. This caps at floor(target), so:
    //   - 1.0 FTE weekend target 2.0 → max 2  ✓
    //   - 0.6 FTE weekend target 1.44 → max 1  ✓
    //   - 0.5 FTE weekend target 1.0 → max 1  ✓
    //   - 0.3 FTE weekend target 0.72 → max 0 (picks up in future blocks
    //     once cross-block memory is wired)
    const assigned = getAssigned(p.id, slot.derived_day_type, slot.shift_type_code);
    const target = getTarget(p.id, slot.derived_day_type, slot.shift_type_code);
    if (assigned + 1 > target) return false;

    // Site credentials
    const cred = credByPid.get(p.id);
    if (cred) {
      if (!cred.is_active) return false;
      if (!cred.credentialed) return false;
      if (cred.excluded_shift_types.includes(slot.shift_type_code)) return false;
      if (cred.allowed_shift_types.length > 0 && !cred.allowed_shift_types.includes(slot.shift_type_code)) return false;
      if (slot.shift_type_category === 'call') {
        if (!cred.can_take_call) return false;
        const dt = slot.derived_day_type;
        if ((dt === 'saturday' || dt === 'sunday') && !cred.can_take_weekend_call) return false;
        if ((dt === 'federal_holiday' || dt === 'major_holiday') && !cred.can_take_holiday_call) return false;
      }
    }
    // Missing credentials row = "not yet configured", treat as passing (matches evaluator behavior)

    // Saturday/Sunday adjacent-week PTO exclusion.
    // Hard rule: if the provider has planned leave (PTO / FMLA / parental /
    // military) covering any day of the Mon-Fri week immediately BEFORE the
    // weekend OR the Mon-Fri week immediately AFTER the weekend, they are
    // not eligible for Sat or Sun call. The existing bookend rule only
    // catches leave that touches Mon or Fri; this closes the mid-week gap
    // (e.g. PTO Tue-Thu the week prior).
    // Friday call is intentionally NOT gated here — a provider may take the
    // Friday immediately before their PTO week in extenuating circumstances.
    if (slot.derived_day_type === 'saturday' || slot.derived_day_type === 'sunday') {
      const satDate = slot.derived_day_type === 'saturday'
        ? slot.slot_date
        : addDays(slot.slot_date, -1);
      const weekBeforeStart = addDays(satDate, -5); // Mon before the weekend
      const weekBeforeEnd = addDays(satDate, -1);   // Fri before the weekend
      const weekAfterStart = addDays(satDate, 2);   // Mon after the weekend
      const weekAfterEnd = addDays(satDate, 6);     // Fri after the weekend
      const entries = availByPid.get(p.id) || [];
      for (const a of entries) {
        if (a.approval_status === 'denied' || a.approval_status === 'canceled') continue;
        if (!BOOKEND_EXTENDING_TYPES.has(a.availability_type)) continue;
        // Range overlap: entry [start, end] intersects window [ws, we]
        // iff start <= we AND end >= ws.
        if (a.start_date <= weekBeforeEnd && a.end_date >= weekBeforeStart) return false;
        if (a.start_date <= weekAfterEnd && a.end_date >= weekAfterStart) return false;
      }
    }

    // Availability (preloaded). Planned-leave (PTO/FMLA/parental/military)
    // gets a weekend-bookend extension via effectivePtoRange() — Sat before
    // if PTO starts Monday, Sun after if PTO ends Friday.
    const entries = availByPid.get(p.id) || [];
    for (const a of entries) {
      if (a.approval_status === 'denied' || a.approval_status === 'canceled') continue;
      if (!BLOCKING_AVAIL.has(a.availability_type)) continue;
      const { start, end } = effectivePtoRange(a);
      if (datesOverlap(start, end, slot.slot_date)) return false;
    }

    return true;
  };

  // ── 10. DB write for a single assignment (updates in-memory state) ───────
  // doAssign for a CALL shift triggers inline D-chains so the post-call/pre-call
  // D shifts get reserved BEFORE adjacent call slots are processed. This stops
  // a provider from being picked for tomorrow's call when they're already
  // committed to tomorrow's D1 (post-call) — the bug where Sun-C2 person ended
  // up on Mon-C2 instead of Mon-D1.
  const doAssign = async (slot: SlotToFill, provider: CandidateProvider): Promise<boolean> => {
    try {
      countQ();
      if (slot.existing_assignment_id) {
        await sb.from('assignments').update({
          provider_id: provider.id,
          assignment_status: 'assigned',
          source_type: 'auto_generated',
          assigned_at: new Date().toISOString(),
        }).eq('id', slot.existing_assignment_id);
      } else {
        await sb.from('assignments').insert({
          schedule_slot_id: slot.slot_id,
          provider_id: provider.id,
          assignment_status: 'assigned',
          source_type: 'auto_generated',
          assigned_at: new Date().toISOString(),
        });
      }
      markAssigned(slot.slot_date, provider.id);
      incBucket(provider.id, slot.derived_day_type, slot.shift_type_code);
      if (['C1', 'C2', 'C3'].includes(slot.shift_type_code)) {
        addCallDate(provider.id, slot.slot_date);
      }
      handledSlotIds.add(slot.slot_id);
      result.assignments.push({
        slot_id: slot.slot_id,
        slot_date: slot.slot_date,
        shift_type_code: slot.shift_type_code,
        provider_id: provider.id,
        provider_name: provider.short_display_name,
      });
      result.filled++;
      return true;
    } catch (err) {
      result.errors.push(`Failed to assign ${slot.shift_type_code} on ${slot.slot_date}: ${err}`);
      result.skipped++;
      return false;
    }
  };

  // chainDFills — called after a successful call-shift doAssign. Reserves the
  // pre-call/post-call D shifts for the same provider AND blocks the provider
  // from the post-call day-off so they can't be picked for adjacent call slots.
  //
  // Weekday/Friday call:
  //   C1 day N → backfill D2 on day N-1; mark provider unavailable day N+1
  //   C2 day N → backfill D3 on day N-1; forward-fill D1 on day N+1
  //
  // Saturday call (weekend swap pattern handles D-relationships):
  //   No D-chain — the weekend block already assigns Fri-D2 from Sat-C2,
  //   and the rest is implicit.
  //
  // Sunday call:
  //   Sun-C1 → mark provider unavailable Monday (post-call day off)
  //   Sun-C2 → forward-fill Mon-D1 (post-call, "first on outlist")
  const chainDFills = async (slot: SlotToFill, provider: CandidateProvider): Promise<void> => {
    const tryFill = async (date: string, code: string) => {
      const target = slotIndex.get(date)?.get(code);
      if (!target) return;
      if (handledSlotIds.has(target.slot_id)) return;
      if (isAssignedOnDate(date, provider.id)) return;
      if (crossSiteByDate.get(provider.id)?.has(date)) return;
      await doAssign(target, provider);
    };

    const dt = slot.derived_day_type;

    // Saturday call shifts: nothing to chain (weekend block handles cross-day).
    if (dt === 'saturday') return;

    // Sunday call shifts: limited chain.
    if (dt === 'sunday') {
      if (slot.shift_type_code === 'C1') {
        // Post-call day off Monday — block provider from any Monday shift
        markAssigned(addDays(slot.slot_date, 1), provider.id);
      } else if (slot.shift_type_code === 'C2') {
        // Post-call to Mon-D1 (first on outlist)
        await tryFill(addDays(slot.slot_date, 1), 'D1');
      }
      return;
    }

    // Weekday or Friday: normal D-chain.
    //
    // Precedence: D1 (post-call relief) always beats D3 (pre-call backfill)
    // when both could apply to the same day for the same provider. Without
    // this, a provider on C2 Mon + C2 Wed would get Tue-D3 (pre-call for
    // Wed) instead of Tue-D1 (post-call for Mon), which is incorrect
    // because post-call relief is the stronger signal — they actually
    // worked the night before.
    const dayBefore = addDays(slot.slot_date, -1);
    const twoDaysBefore = addDays(slot.slot_date, -2);
    const hadCallTwoDaysBefore =
      (callDatesByProvider.get(provider.id) || []).includes(twoDaysBefore);

    if (slot.shift_type_code === 'C1') {
      // Pre-call backfill: D2 — but skip if yesterday is their post-call
      // day from a prior call shift (D1 already owns that day).
      if (!hadCallTwoDaysBefore) {
        await tryFill(dayBefore, 'D2');
      }
      // Post-call day off (block provider from any shift the next day)
      markAssigned(addDays(slot.slot_date, 1), provider.id);
    } else if (slot.shift_type_code === 'C2') {
      // Pre-call backfill: D3 — but skip if yesterday is post-call for
      // this provider, in which case D1 is the correct label and was
      // already placed by the earlier call shift's chainDFills.
      if (!hadCallTwoDaysBefore) {
        await tryFill(dayBefore, 'D3');
      }
      // Post-call relief (D1 next day, but stays working — first to leave)
      await tryFill(addDays(slot.slot_date, 1), 'D1');
    }
  };

  // ── 10.5. Pre-PTO Thursday placement rule ────────────────────────────────
  // If a provider is going on PTO, try to give them the Thursday C1 prior
  // to the week of PTO. If two providers have PTO starting in the same
  // week, one gets that Thursday's C1 and the other gets C2. Soft
  // placement: silently skipped when the provider isn't eligible (missing
  // credentials, weekday unavailability, cross-site conflict, etc.) or
  // when the Thursday falls outside this schedule.
  //
  // Rationale: a Thursday C1 means they finish call Friday morning, so
  // they get Fri-Sun off, then PTO Mon-Fri — effectively a 10-day break
  // instead of just the 5-day PTO window. A common ask.
  const prePtoByThursday = new Map<string, Set<string>>();
  for (const p of providers) {
    const entries = availByPid.get(p.id) || [];
    for (const a of entries) {
      if (a.approval_status !== 'approved') continue;
      if (!BLOCKING_AVAIL.has(a.availability_type)) continue;
      const thu = thursdayBeforeWeekOf(a.start_date);
      if (!slotIndex.has(thu)) continue;
      const set = prePtoByThursday.get(thu) || new Set<string>();
      set.add(p.id);
      prePtoByThursday.set(thu, set);
    }
  }

  const tryPlacePrePto = async (
    slot: SlotToFill | undefined,
    provider: CandidateProvider,
  ): Promise<boolean> => {
    if (!slot) return false;
    if (handledSlotIds.has(slot.slot_id)) return false;
    if (!isEligible(slot, provider)) return false;
    const ok = await doAssign(slot, provider);
    if (ok) await chainDFills(slot, provider);
    return ok;
  };

  let prePtoPlacements = 0;
  for (const [thuDate, pidSet] of prePtoByThursday) {
    const codeMap = slotIndex.get(thuDate);
    if (!codeMap) continue;
    const c1 = codeMap.get('C1');
    const c2 = codeMap.get('C2');

    // Deterministic ordering so two runs produce the same assignment. When
    // two providers want the same Thursday, whichever sorts first (by
    // provider id) gets first pick — usually C1, falling back to C2 if
    // they aren't eligible for C1. The other provider takes whatever's
    // left. Third+ providers intentionally fall through to the main loop.
    const ranked = Array.from(pidSet).sort()
      .map(pid => providerById.get(pid))
      .filter((p): p is CandidateProvider => !!p);

    if (ranked[0]) {
      const placed = (await tryPlacePrePto(c1, ranked[0]))
        || (await tryPlacePrePto(c2, ranked[0]));
      if (placed) prePtoPlacements++;
    }
    if (ranked[1]) {
      const placed = (await tryPlacePrePto(c1, ranked[1]))
        || (await tryPlacePrePto(c2, ranked[1]));
      if (placed) prePtoPlacements++;
    }
  }
  if (prePtoPlacements > 0) {
    console.log(`[autoGen] pre-PTO rule placed ${prePtoPlacements} Thursday call shifts`);
  }

  // ── 11. Main assignment loop ─────────────────────────────────────────────
  let slotIdx = 0;
  for (const slot of slotsToFill) {
    slotIdx++;
    if (slotIdx % 20 === 1 || slotIdx === slotsToFill.length) {
      console.log(`[autoGen] ${slotIdx}/${slotsToFill.length}`);
    }
    if (handledSlotIds.has(slot.slot_id)) continue;

    const candidates = providers.filter(p => isEligible(slot, p));
    if (candidates.length === 0) {
      result.unfilled.push({
        slot_id: slot.slot_id,
        slot_date: slot.slot_date,
        shift_type_code: slot.shift_type_code,
        reason: 'No eligible providers',
      });
      result.skipped++;
      continue;
    }

    // Score candidates:
    //   primary: lowest LIFETIME bucket-ratio first. "Lifetime" = historical
    //     assignments at this site + assignments made in this block so far.
    //     This ensures a 0.3 FTE who got zero weekends last block gets
    //     priority next block, rather than being hard-locked at 0 every
    //     block and never taking any. Per-FTE normalization means
    //     part-timers still don't take more than their proportional share
    //     over time.
    //   tie-break: MORE days since last call (avoid burnout / back-to-back)
    const scored = candidates
      .map(p => {
        const lifetime = getHistorical(p.id, slot.derived_day_type, slot.shift_type_code)
          + getAssigned(p.id, slot.derived_day_type, slot.shift_type_code);
        return {
          p,
          ratio: lifetime / Math.max(p.fte_value, 0.01),
          recency: daysSinceLastCall(p.id, slot.slot_date),
        };
      })
      .sort((a, b) => a.ratio - b.ratio || b.recency - a.recency);

    const chosen = scored[0].p;
    const ok = await doAssign(slot, chosen);
    if (!ok) continue;

    // Reserve pre/post-call D shifts immediately
    await chainDFills(slot, chosen);

    // ── Weekend block chains (Paoli-specific 3-day pattern) ─────────────────
    // Two physicians cover the weekend with overlapping roles:
    //   Provider A: Fri-C2 → Sat-C1 → Sun-C2  (backup-call-backup)
    //   Provider B: Fri-D2 → Sat-C2 → Sun-C1
    //   Provider C: Sat-C3 → Sun-C3            (neuro)
    if (slot.derived_day_type === 'saturday') {
      const sundayDate = addDays(slot.slot_date, 1);
      const fridayDate = addDays(slot.slot_date, -1);
      const sundayMap = slotIndex.get(sundayDate);
      const fridayMap = slotIndex.get(fridayDate);

      const chainAssign = async (slotMap: Map<string, SlotToFill> | undefined, code: string) => {
        if (!slotMap) return;
        const target = slotMap.get(code);
        if (target && !handledSlotIds.has(target.slot_id)) {
          await doAssign(target, chosen);
          // Chained call shifts also trigger their D-chain (e.g. Sun-C2 → Mon-D1)
          await chainDFills(target, chosen);
        }
      };

      if (slot.shift_type_code === 'C3') {
        // C3 same provider both weekend days
        await chainAssign(sundayMap, 'C3');
      } else if (slot.shift_type_code === 'C1') {
        // Sat-C1 person → Sun-C2 (post-call from Sat) AND Fri-C2 (the backup-call-backup chain)
        await chainAssign(sundayMap, 'C2');
        await chainAssign(fridayMap, 'C2');
      } else if (slot.shift_type_code === 'C2') {
        // Sat-C2 person → Sun-C1 AND Fri-D2 (the D2-call-call chain)
        await chainAssign(sundayMap, 'C1');
        await chainAssign(fridayMap, 'D2');
      }
    }
  }

  // ── 11c. D4-D9 relief-order pass ─────────────────────────────────────────
  // For every weekday/friday, any provider who is home-site, available, and
  // NOT already assigned something that day gets placed onto D4, D5, D6, ...
  // in order of how soon their next call is (closer → lower D number).
  // Tie-break: upcoming C1 outranks C2 outranks C3 (higher-priority call
  // = earlier relief).
  const RELIEF_CODES = ['D4', 'D5', 'D6', 'D7', 'D8', 'D9'];

  // Index all provider call assignments (including pre-existing + newly made)
  const providerCalls = new Map<string, Array<{ date: string; code: string }>>();
  const pushCall = (pid: string, date: string, code: string) => {
    if (!providerCalls.has(pid)) providerCalls.set(pid, []);
    providerCalls.get(pid)!.push({ date, code });
  };
  for (const a of result.assignments) {
    if (['C1', 'C2', 'C3'].includes(a.shift_type_code)) pushCall(a.provider_id, a.slot_date, a.shift_type_code);
  }
  for (const raw of rawSlots as Array<Record<string, unknown>>) {
    const st = raw.shift_types as { code: string; category: string } | null;
    if (!st || !['C1', 'C2', 'C3'].includes(st.code)) continue;
    for (const a of (raw.assignments as Array<{ provider_id: string | null }>) || []) {
      if (a.provider_id) pushCall(a.provider_id, raw.slot_date as string, st.code);
    }
  }
  for (const arr of providerCalls.values()) arr.sort((a, b) => a.date.localeCompare(b.date));

  const callTierPriority = (code: string) => code === 'C1' ? 0 : code === 'C2' ? 1 : 2;
  const daysBetween = (from: string, to: string) => {
    const f = new Date(from + 'T00:00:00Z').getTime();
    const t = new Date(to + 'T00:00:00Z').getTime();
    return Math.round((t - f) / 86400000);
  };

  // Per-day credential / availability check (non-call checks only)
  const isAvailableForReliefDay = (date: string, p: CandidateProvider): boolean => {
    if (isAssignedOnDate(date, p.id)) return false;
    if (crossSiteByDate.get(p.id)?.has(date)) return false;
    const cred = credByPid.get(p.id);
    if (cred) {
      if (!cred.is_active) return false;
      if (!cred.credentialed) return false;
    }
    const entries = availByPid.get(p.id) || [];
    for (const a of entries) {
      if (a.approval_status === 'denied' || a.approval_status === 'canceled') continue;
      if (!datesOverlap(a.start_date, a.end_date, date)) continue;
      if (BLOCKING_AVAIL.has(a.availability_type)) return false;
    }
    return true;
  };

  const scheduleDates = Array.from(slotIndex.keys()).sort();
  let reliefFilled = 0;
  for (const date of scheduleDates) {
    const codeMap = slotIndex.get(date);
    if (!codeMap) continue;
    const sampleD = codeMap.get('D4') || codeMap.get('D5');
    if (!sampleD) continue;
    const dt = sampleD.derived_day_type;
    if (dt !== 'weekday' && dt !== 'friday') continue;

    const available = providers.filter(p => isAvailableForReliefDay(date, p));
    const scored = available.map(p => {
      const nextCall = (providerCalls.get(p.id) || []).find(c => c.date > date);
      return {
        p,
        distance: nextCall ? daysBetween(date, nextCall.date) : Infinity,
        tier: nextCall ? callTierPriority(nextCall.code) : 99,
        // Fewer days since last call = more tired = earlier relief (lower D)
        recency: daysSinceLastCall(p.id, date),
      };
    }).sort((a, b) =>
      a.distance - b.distance ||
      a.tier - b.tier ||
      a.recency - b.recency
    );

    let idx = 0;
    for (const code of RELIEF_CODES) {
      if (idx >= scored.length) break;
      const slot = codeMap.get(code);
      if (!slot) continue;
      if (handledSlotIds.has(slot.slot_id)) continue;
      const ok = await doAssign(slot, scored[idx].p);
      if (ok) reliefFilled++;
      idx++;
    }
  }
  console.log(`[autoGen] relief pass: filled ${reliefFilled} D4-D9 slots`);

  // ── 12. Compute validation flags for call shifts only (parallel batches) ──
  // D-shifts are deterministic chains or relief assignments — no rules target
  // them in the current rule set. Skip their validation to keep the wall time
  // bounded by the number of call shifts, which is the only interesting set.
  const toValidate = result.assignments.filter(a => ['C1', 'C2', 'C3'].includes(a.shift_type_code));
  console.log(`[autoGen] validating ${toValidate.length} call assignments (skipping ${result.assignments.length - toValidate.length} D-shifts)...`);
  const VALIDATION_CONCURRENCY = 10;
  for (let i = 0; i < toValidate.length; i += VALIDATION_CONCURRENCY) {
    const batch = toValidate.slice(i, i + VALIDATION_CONCURRENCY);
    await Promise.all(batch.map(async a => {
      countQ();
      const ev = await evaluateAssignment(sb, a.slot_id, a.provider_id);
      countQ();
      await sb.from('assignments')
        .update({ validation_flags: ev.violations })
        .eq('schedule_slot_id', a.slot_id)
        .eq('provider_id', a.provider_id);
    }));
  }

  const elapsed = Date.now() - t0;
  result.perf = {
    par_level: parLevel,
    total_slots: (rawSlots as unknown[]).length,
    call_slots: slotsToFill.length,
    providers: providers.length,
    elapsed_ms: elapsed,
    db_queries: dbQueries,
  };
  console.log(`[autoGen] DONE — filled ${result.filled}, skipped ${result.skipped}, elapsed ${(elapsed/1000).toFixed(1)}s, ${dbQueries} DB queries`);
  return result;
}
