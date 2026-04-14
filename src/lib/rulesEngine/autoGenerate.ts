// Auto-generation engine.
//
// Given a schedule version, attempt to assign providers to all open call slots
// using:
//   1. Home-site filter — only providers whose home_site_id matches the schedule's site
//   2. Bucket-based quotas — each (provider × day_type × shift_code) has a quota
//      computed as round(total_in_bucket / par_level × FTE) where par_level = 12
//   3. Weekend pairing — Sat C1 ↔ Sun C2 (and Sat C2 ↔ Sun C1), C3 same provider both days
//   4. Hard rule constraints — eligibility, time-off, etc. via evaluateAssignment
//
// Non-call shifts (D-series, day shifts) are NOT auto-assigned here. They flow
// from sequence rules (e.g. provider on C2 → automatically on D1 next day) or
// manual entry by the scheduler.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

import { evaluateAssignment } from './evaluate';

const PAR_LEVEL = 12; // base provider count for quota calculations

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

// Group derived_day_type into bucket buckets used for quotas.
// 'weekday' = Mon-Thu. Friday/Saturday/Sunday/holidays are their own buckets.
function dayTypeBucket(dt: string): string {
  if (dt === 'weekday') return 'weekday';
  if (dt === 'friday') return 'friday';
  if (dt === 'saturday') return 'saturday';
  if (dt === 'sunday') return 'sunday';
  if (dt === 'federal_holiday' || dt === 'major_holiday') return 'holiday';
  return dt;
}

function bucketKey(provider_id: string, day_bucket: string, shift_code: string): string {
  return `${provider_id}|${day_bucket}|${shift_code}`;
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Auto-generate assignments for all open call slots in a schedule version.
 */
export async function autoGenerate(
  sb: SupabaseClient,
  scheduleVersionId: string,
): Promise<GenerationResult> {
  const result: GenerationResult = {
    filled: 0, skipped: 0, errors: [], assignments: [], unfilled: [],
  };

  // 1. Load schedule + site context
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

  // 2. Load all slots for this version
  const { data: rawSlots, error: slotsErr } = await sb
    .from('schedule_slots')
    .select('id, slot_date, shift_type_id, provider_group, required_count, locked, derived_day_type, shift_types(code, category), assignments(id, provider_id, assignment_status)')
    .eq('schedule_version_id', scheduleVersionId)
    .order('slot_date')
    .order('slot_index');

  if (slotsErr || !rawSlots) {
    result.errors.push(`Failed to load slots: ${slotsErr?.message || 'no data'}`);
    return result;
  }

  // Build slots-to-fill (only call category, not yet assigned, not locked)
  const slotsToFill: SlotToFill[] = [];
  // Index: by_date_and_code[date][code] = slot info (used for weekend pairing lookup)
  const slotIndex = new Map<string, Map<string, SlotToFill>>();

  for (const raw of rawSlots as Array<Record<string, unknown>>) {
    if (raw.locked) continue;
    const st = raw.shift_types as { code: string; category: string } | null;
    if (!st) continue;
    if (st.category !== 'call') continue; // Only call shifts get auto-generated

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
    slotsToFill.push(slot);

    if (!slotIndex.has(slot.slot_date)) slotIndex.set(slot.slot_date, new Map());
    slotIndex.get(slot.slot_date)!.set(slot.shift_type_code, slot);
  }

  // Sort: process Saturday weekend pairs before Sunday so we can pre-fill Sundays.
  // Within a date, process backup shifts (C2, C3) BEFORE primary (C1) so that
  // pairing rules ("C1 requires C2 backup") see a satisfied backup when C1
  // is evaluated. Same for D-series ordering when those become auto-fillable.
  const dayOrder: Record<string, number> = {
    saturday: 0, sunday: 1, friday: 2, weekday: 3, holiday: 4,
  };
  // Lower number = process earlier within a date. Backups before primaries.
  const codeOrder: Record<string, number> = {
    C2: 0, C3: 1, C1: 2,
  };
  slotsToFill.sort((a, b) => {
    const da = dayOrder[dayTypeBucket(a.derived_day_type)] ?? 5;
    const db = dayOrder[dayTypeBucket(b.derived_day_type)] ?? 5;
    if (da !== db) return da - db;
    if (a.slot_date !== b.slot_date) return a.slot_date.localeCompare(b.slot_date);
    const ca = codeOrder[a.shift_type_code] ?? 9;
    const cb = codeOrder[b.shift_type_code] ?? 9;
    return ca - cb;
  });

  console.log(`[autoGen] ${slotsToFill.length} call slots to fill from ${(rawSlots as unknown[]).length} total`);
  if (slotsToFill.length === 0) return result;

  // 3. Load providers with home_site_id == siteId
  const { data: profiles } = await sb
    .from('provider_employment_profiles')
    .select('provider_id, home_site_id, fte_value, neuro_eligible')
    .eq('home_site_id', siteId);

  const profileByProviderId = new Map<string, { fte_value: number; neuro_eligible: boolean; home_site_id: string }>();
  for (const p of (profiles || []) as Array<Record<string, unknown>>) {
    profileByProviderId.set(p.provider_id as string, {
      fte_value: (p.fte_value as number) || 1,
      neuro_eligible: !!p.neuro_eligible,
      home_site_id: p.home_site_id as string,
    });
  }
  const providerIds = Array.from(profileByProviderId.keys());
  if (providerIds.length === 0) {
    result.errors.push(`No providers found with home_site_id = ${siteId}`);
    return result;
  }

  const { data: providerRows } = await sb
    .from('providers')
    .select('id, provider_type, short_display_name')
    .in('id', providerIds)
    .eq('status', 'active');

  const providers: CandidateProvider[] = ((providerRows || []) as Array<Record<string, unknown>>).map(p => {
    const prof = profileByProviderId.get(p.id as string)!;
    return {
      id: p.id as string,
      provider_type: p.provider_type as string,
      short_display_name: p.short_display_name as string,
      fte_value: prof.fte_value,
      neuro_eligible: prof.neuro_eligible,
      home_site_id: prof.home_site_id,
    };
  });

  console.log(`[autoGen] ${providers.length} home-site providers eligible`);

  // 4. Compute bucket quotas
  // bucketTotals[day_bucket|shift_code] = total slots in this version
  const bucketTotals = new Map<string, number>();
  for (const s of slotsToFill) {
    const key = `${dayTypeBucket(s.derived_day_type)}|${s.shift_type_code}`;
    bucketTotals.set(key, (bucketTotals.get(key) || 0) + s.required_count);
  }
  // Also include already-assigned slots in totals (so quotas match the schedule)
  for (const raw of rawSlots as Array<Record<string, unknown>>) {
    const st = raw.shift_types as { code: string; category: string } | null;
    if (!st || st.category !== 'call') continue;
    const assignments = (raw.assignments as Array<{ provider_id: string | null }>) || [];
    const assignedCount = assignments.filter(a => a.provider_id).length;
    if (assignedCount > 0) {
      const dt = (raw.derived_day_type as string) || 'weekday';
      const key = `${dayTypeBucket(dt)}|${st.code}`;
      bucketTotals.set(key, (bucketTotals.get(key) || 0) + assignedCount);
    }
  }

  console.log(`[autoGen] bucket totals: ${Array.from(bucketTotals.entries()).map(([k, v]) => `${k}=${v}`).join(', ')}`);

  // bucketTarget[provider_id|day_bucket|shift_code] = fractional target
  // (total / par_level × FTE). A provider remains eligible while their
  // current assigned count is strictly less than this target. This is
  // intentional: target=0.42 means a provider takes 1 then is done
  // (1 >= 0.42), naturally distributing 1-per-provider until the pool
  // runs out — rather than rounding to 0 and leaving everything open.
  const bucketTarget = new Map<string, number>();
  for (const p of providers) {
    for (const [bucketKeyStr, total] of bucketTotals) {
      const target = (total / PAR_LEVEL) * p.fte_value;
      bucketTarget.set(`${p.id}|${bucketKeyStr}`, target);
    }
  }

  // 5. Tracking maps
  const bucketAssigned = new Map<string, number>(); // running count per (provider × bucket)
  const assignedOnDate = new Map<string, Set<string>>(); // date → set of provider_ids

  const markAssigned = (date: string, pid: string) => {
    if (!assignedOnDate.has(date)) assignedOnDate.set(date, new Set());
    assignedOnDate.get(date)!.add(pid);
  };
  const isAssignedOnDate = (date: string, pid: string) => assignedOnDate.get(date)?.has(pid) ?? false;

  const incBucket = (pid: string, dt: string, code: string) => {
    const k = bucketKey(pid, dayTypeBucket(dt), code);
    bucketAssigned.set(k, (bucketAssigned.get(k) || 0) + 1);
  };
  const getBucketAssigned = (pid: string, dt: string, code: string) =>
    bucketAssigned.get(bucketKey(pid, dayTypeBucket(dt), code)) || 0;
  const getBucketTarget = (pid: string, dt: string, code: string) =>
    bucketTarget.get(bucketKey(pid, dayTypeBucket(dt), code)) || 0;

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

  // 6. Helper to perform a single assignment (write to DB + update trackers)
  const doAssign = async (slot: SlotToFill, provider: CandidateProvider): Promise<boolean> => {
    try {
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

  // Track which slots we've already filled via pairing so we skip them in the main loop
  const handledSlotIds = new Set<string>();

  // 7. Main assignment loop
  let slotIdx = 0;
  for (const slot of slotsToFill) {
    slotIdx++;
    if (slotIdx % 10 === 1 || slotIdx === slotsToFill.length) {
      console.log(`[autoGen] ${slotIdx}/${slotsToFill.length}: ${slot.shift_type_code} on ${slot.slot_date} (${slot.derived_day_type})`);
    }

    if (handledSlotIds.has(slot.slot_id)) continue;

    // Filter candidates:
    //   1. Provider group match
    //   2. Not already on this date
    //   3. Has remaining quota in this bucket (>= 1)
    //   4. C3-specific: must be neuro_eligible
    const candidates = providers.filter(p => {
      if (slot.provider_group === 'physician' && p.provider_type !== 'physician') return false;
      if (slot.provider_group === 'crna' && !['crna', 'aa'].includes(p.provider_type)) return false;
      if (isAssignedOnDate(slot.slot_date, p.id)) return false;
      if (slot.shift_type_code === 'C3' && !p.neuro_eligible) return false;
      const assigned = getBucketAssigned(p.id, slot.derived_day_type, slot.shift_type_code);
      const target = getBucketTarget(p.id, slot.derived_day_type, slot.shift_type_code);
      if (assigned >= target) return false;
      return true;
    });

    if (candidates.length === 0) {
      result.unfilled.push({
        slot_id: slot.slot_id,
        slot_date: slot.slot_date,
        shift_type_code: slot.shift_type_code,
        reason: 'No providers under quota / eligible',
      });
      result.skipped++;
      continue;
    }

    // Score: lowest assigned/FTE in this bucket (most under-quota first), then lowest total burden
    const scored = candidates
      .map(p => {
        const assigned = getBucketAssigned(p.id, slot.derived_day_type, slot.shift_type_code);
        return { provider: p, ratio: assigned / Math.max(p.fte_value, 0.01) };
      })
      .sort((a, b) => a.ratio - b.ratio);

    // Run hard-constraint check on candidates in batches
    const BATCH_SIZE = 5;
    let chosen: CandidateProvider | null = null;
    for (let bi = 0; bi * BATCH_SIZE < scored.length; bi++) {
      const batch = scored.slice(bi * BATCH_SIZE, (bi + 1) * BATCH_SIZE);
      for (const { provider } of batch) {
        const ev = await evaluateAssignment(sb, slot.slot_id, provider.id);
        if (ev.hardCount === 0) { chosen = provider; break; }
      }
      if (chosen) break;
    }

    if (!chosen) {
      result.unfilled.push({
        slot_id: slot.slot_id,
        slot_date: slot.slot_date,
        shift_type_code: slot.shift_type_code,
        reason: `${candidates.length} candidates under quota but all have hard rule violations`,
      });
      result.skipped++;
      continue;
    }

    // Perform the assignment
    const assignedOk = await doAssign(slot, chosen);
    if (!assignedOk) continue;
    handledSlotIds.add(slot.slot_id);

    // ── Weekend pairing ────────────────────────────────────────────────────
    // Saturday → Sunday pairing (process the Saturday slot, then auto-fill the
    // matching Sunday slot for the same weekend block).
    const isSat = slot.derived_day_type === 'saturday';
    if (isSat) {
      const sundayDate = addDays(slot.slot_date, 1);
      const sundaySlots = slotIndex.get(sundayDate);

      if (slot.shift_type_code === 'C3' && sundaySlots) {
        // Same provider takes C3 both days
        const sunC3 = sundaySlots.get('C3');
        if (sunC3 && !handledSlotIds.has(sunC3.slot_id)) {
          await doAssign(sunC3, chosen);
          handledSlotIds.add(sunC3.slot_id);
        }
      } else if (slot.shift_type_code === 'C1' && sundaySlots) {
        // Sat C1 = Sun C2 same provider
        const sunC2 = sundaySlots.get('C2');
        if (sunC2 && !handledSlotIds.has(sunC2.slot_id)) {
          await doAssign(sunC2, chosen);
          handledSlotIds.add(sunC2.slot_id);
        }
      } else if (slot.shift_type_code === 'C2' && sundaySlots) {
        // Sat C2 = Sun C1 same provider
        const sunC1 = sundaySlots.get('C1');
        if (sunC1 && !handledSlotIds.has(sunC1.slot_id)) {
          await doAssign(sunC1, chosen);
          handledSlotIds.add(sunC1.slot_id);
        }
      }
    }
  }

  // 8. Final pass: write validation flags
  for (const a of result.assignments) {
    const ev = await evaluateAssignment(sb, a.slot_id, a.provider_id);
    await sb.from('assignments')
      .update({ validation_flags: ev.violations })
      .eq('schedule_slot_id', a.slot_id)
      .eq('provider_id', a.provider_id);
  }

  console.log(`[autoGen] DONE — filled ${result.filled}, skipped ${result.skipped}`);
  return result;
}
