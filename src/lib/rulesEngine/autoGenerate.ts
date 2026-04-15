// Auto-generation engine (physician call scheduling).
//
// Strategy:
//   1. Preload all data once (credentials, availability, existing assignments, site par_level).
//   2. Filter candidates in-memory — no DB calls during the scoring loop.
//   3. Greedy assignment with bucket-based quotas and weekend pairing.
//   4. Only run the full rule evaluator on final assignments for validation flags.
//
// Constraints applied during selection:
//   - Home-site filter: provider.home_site_id == schedule.site_id
//   - Site credentials: active, credentialed, can_take_call (+ weekend/holiday variants)
//   - Availability: no approved PTO / sick / unavailable entries covering the date
//   - Same-day conflict: provider not already assigned on this date
//   - Bucket quota: assigned_in_bucket < target where target = total / par_level × FTE
//   - C3 specific: neuro_eligible
//
// Non-call shifts (D1-D8, 7-3, 7-5) are NOT auto-assigned here. They flow from
// sequence rules (e.g. C2 on day N → D1 on day N+1) or manual entry.
//
// Rules are NOT applied to CRNAs — this engine is physician-only for now.
// CRNA rules will live in a separate evaluator when that module lands.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

import { evaluateAssignment } from './evaluate';

const DEFAULT_PAR_LEVEL = 12; // fallback if site.call_par_level is not set
const NEIGHBOR_WINDOW_DAYS = 31;

// Availability types that block any assignment
const BLOCKING_AVAIL = new Set([
  'pto', 'sick', 'fmla', 'parental_leave', 'military_leave', 'jury_duty', 'unavailable', 'blocked',
]);

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
  neuro_eligible: boolean;
  home_site_id: string | null;
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function dayTypeBucket(dt: string): string {
  if (dt === 'weekday') return 'weekday';
  if (dt === 'friday') return 'friday';
  if (dt === 'saturday') return 'saturday';
  if (dt === 'sunday') return 'sunday';
  if (dt === 'federal_holiday' || dt === 'major_holiday') return 'holiday';
  return dt;
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function datesOverlap(availStart: string, availEnd: string, date: string): boolean {
  return availStart <= date && availEnd >= date;
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function autoGenerate(
  sb: SupabaseClient,
  scheduleVersionId: string,
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

  // ── 3. Preload home-site providers ────────────────────────────────────────
  countQ();
  const { data: profiles } = await sb
    .from('provider_employment_profiles')
    .select('provider_id, fte_value, neuro_eligible, home_site_id')
    .eq('home_site_id', siteId);

  const profileByPid = new Map<string, { fte_value: number; neuro_eligible: boolean; home_site_id: string }>();
  for (const p of (profiles || []) as Array<Record<string, unknown>>) {
    profileByPid.set(p.provider_id as string, {
      fte_value: (p.fte_value as number) || 1,
      neuro_eligible: !!p.neuro_eligible,
      home_site_id: p.home_site_id as string,
    });
  }
  const providerIds = Array.from(profileByPid.keys());
  if (providerIds.length === 0) {
    result.errors.push(`No providers found with home_site_id = ${siteId}`);
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
      neuro_eligible: prof.neuro_eligible,
      home_site_id: prof.home_site_id,
    };
  });

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

  const bucketTarget = new Map<string, number>();
  for (const p of providers) {
    for (const [k, total] of bucketTotals) {
      bucketTarget.set(`${p.id}|${k}`, (total / parLevel) * p.fte_value);
    }
  }

  // ── 8. Runtime state (updated during the loop) ───────────────────────────
  const bucketAssigned = new Map<string, number>();
  const assignedOnDate = new Map<string, Set<string>>();
  const handledSlotIds = new Set<string>();

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

    // C1 post-call day-off check: if the provider is already committed to a shift
    // the day AFTER this C1 (e.g. via another call shift's pre-call D-chain), they
    // can't take C1 because they'd be working both days. Saturday C1 is excepted
    // (the weekend swap intentionally puts Sat-C1 person on Sun-C2).
    if (slot.shift_type_code === 'C1' && slot.derived_day_type !== 'saturday') {
      const dayAfter = addDays(slot.slot_date, 1);
      if (isAssignedOnDate(dayAfter, p.id)) return false;
    }

    // Bucket quota
    if (getAssigned(p.id, slot.derived_day_type, slot.shift_type_code) >=
        getTarget(p.id, slot.derived_day_type, slot.shift_type_code)) return false;

    // C3 neuro-eligible
    if (slot.shift_type_code === 'C3' && !p.neuro_eligible) return false;

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

    // Availability (preloaded)
    const entries = availByPid.get(p.id) || [];
    for (const a of entries) {
      if (a.approval_status === 'denied' || a.approval_status === 'canceled') continue;
      if (!datesOverlap(a.start_date, a.end_date, slot.slot_date)) continue;
      if (BLOCKING_AVAIL.has(a.availability_type)) return false;
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

    // Weekday or Friday: normal D-chain
    if (slot.shift_type_code === 'C1') {
      // Pre-call backfill
      await tryFill(addDays(slot.slot_date, -1), 'D2');
      // Post-call day off (block provider from any shift the next day)
      markAssigned(addDays(slot.slot_date, 1), provider.id);
    } else if (slot.shift_type_code === 'C2') {
      // Pre-call backfill
      await tryFill(addDays(slot.slot_date, -1), 'D3');
      // Post-call relief (D1 next day, but stays working — first to leave)
      await tryFill(addDays(slot.slot_date, 1), 'D1');
    }
  };

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

    // Score: lowest bucket-ratio first (most under quota). Fair distribution.
    const scored = candidates
      .map(p => ({ p, ratio: getAssigned(p.id, slot.derived_day_type, slot.shift_type_code) / Math.max(p.fte_value, 0.01) }))
      .sort((a, b) => a.ratio - b.ratio);

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

  // ── 12. Compute validation flags once per final assignment (parallel batches) ──
  // Validation uses the DB-backed evaluator which loads a full context per call.
  // Running in parallel batches so the total wall time scales with batch_count
  // not slot_count.
  console.log(`[autoGen] validating ${result.assignments.length} final assignments...`);
  const VALIDATION_CONCURRENCY = 10;
  for (let i = 0; i < result.assignments.length; i += VALIDATION_CONCURRENCY) {
    const batch = result.assignments.slice(i, i + VALIDATION_CONCURRENCY);
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
