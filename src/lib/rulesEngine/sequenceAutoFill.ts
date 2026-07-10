// Sequence auto-fill / cleanup — the manual-edit companion to the generator.
//
// When a manual assignment lands on a shift whose ACTIVE CALL PATTERN declares
// day-chain links (classic: C2 → D1 next day, D3 prior day), we auto-fill the
// linked slots for the same provider; deleting the trigger clears those
// auto-fills again. Structure comes from scheduling.call_patterns
// (CallPatternDoc) — rule_definitions are validation-only and are deliberately
// NOT consulted here (they were pre-scheduling-v2, which let manual edits and
// generation disagree about the chain shape).
//
// Sanctioned I/O module (like genContext/commit). Query budget per invocation:
// one trigger-slot fetch + one provider-wide assignments-window read + one
// availability read + one candidate-slots read, then in-memory evaluation
// (+ the writes). Call sites load the pattern doc once per request and pass it
// in so no call_patterns read happens here.
//
// Suppressed fills are returned as `skips` using the SkippedDerived vocabulary
// (clinical invariant 4: left unassigned AND recorded, never silently dropped).

import { addDays, daysBetween, isBlockingAvailability } from './shared';
import {
  CLASSIC_PATTERN,
  CallPatternDocSchema,
  dayChainsFor,
  type CallPatternDoc,
} from './callPattern';
import type { SkippedDerived } from './genTypes';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

export interface SequenceAutoFillResult {
  filledSlotIds: string[];
  skips: SkippedDerived[];
}

export interface SequenceCleanupResult {
  clearedSlotIds: string[];
}

// ── active call pattern (per-request; call sites pass the doc in) ───────────

/**
 * Load the site's active CallPatternDoc. Mirrors genContext: no active row →
 * CLASSIC_PATTERN silently (normal pre-seed state); invalid definition or
 * query error → CLASSIC_PATTERN with a console warning.
 */
export async function loadActiveCallPattern(
  sb: SupabaseClient,
  siteId: string | null | undefined,
): Promise<CallPatternDoc> {
  if (!siteId) return CLASSIC_PATTERN;
  const { data, error } = await sb
    .from('call_patterns')
    .select('definition')
    .eq('site_id', siteId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) {
    console.warn(`[sequenceAutoFill] call_patterns read failed (${error.message}) — using classic pattern`);
    return CLASSIC_PATTERN;
  }
  const definition = (data as { definition?: unknown } | null)?.definition;
  if (definition == null) return CLASSIC_PATTERN;
  const parsed = CallPatternDocSchema.safeParse(definition);
  if (!parsed.success) {
    console.warn(`[sequenceAutoFill] active call pattern for site ${siteId} failed validation — using classic pattern`);
    return CLASSIC_PATTERN;
  }
  return parsed.data;
}

// ── internal row shapes ──────────────────────────────────────────────────────

interface StRow {
  code?: string;
  category?: string;
  call_rank?: number | null;
  relief_rank?: number | null;
}

interface TriggerSlot {
  id: string;
  site_id: string;
  slot_date: string;
  derived_day_type: string;
  schedule_version_id: string;
  st: StRow;
}

interface WindowAssignment {
  id: string;
  source_type: string;
  slot_id: string;
  slot_date: string;
  site_id: string;
  schedule_version_id: string;
  st: StRow | null;
}

interface CandidateSlot {
  id: string;
  site_id: string;
  slot_date: string;
  locked: boolean;
  st: StRow | null;
  assignments: Array<{ id: string; provider_id: string | null; assignment_status: string; source_type: string }>;
}

interface AvailRow {
  availability_type: string;
  approval_status: string;
  start_date: string;
  end_date: string;
}

// Same-day precedence between pattern fills, from the shift_types rows (never
// code literals): ranked calls (call_rank, lower wins) beat relief shifts
// (relief_rank) beat plain derived codes (D1/D2/D3/…, both ranks null).
// "Lower call_rank trigger wins"; a realized call trigger therefore always
// outranks a derived pre-fill — the old hard-coded "D1 beats D3".
function shiftRank(st: StRow | null | undefined): number {
  if (st?.call_rank != null) return st.call_rank;
  if (st?.relief_rank != null) return 1000 + st.relief_rank;
  return Number.MAX_SAFE_INTEGER;
}

// Codes the pattern fills via NEGATIVE offsets (pre-call fills). These are the
// only occupants a positive-offset (post-call) fill may evict — replaces the
// old literal `code === 'D3'`.
function preFillCodes(doc: CallPatternDoc): Set<string> {
  const out = new Set<string>();
  for (const chain of doc.dayChains) {
    for (const link of chain.links ?? []) {
      if (link.offset < 0) out.add(link.code);
    }
  }
  return out;
}

async function loadTriggerSlot(sb: SupabaseClient, slotId: string): Promise<TriggerSlot | null> {
  const { data } = await sb
    .from('schedule_slots')
    .select('id, site_id, slot_date, derived_day_type, schedule_version_id, shift_types(code, category, call_rank, relief_rank)')
    .eq('id', slotId)
    .maybeSingle();
  if (!data) return null;
  const raw = data as Record<string, unknown>;
  const st = (raw.shift_types as StRow | null) ?? null;
  if (!st?.code) return null;
  return {
    id: raw.id as string,
    site_id: raw.site_id as string,
    slot_date: raw.slot_date as string,
    derived_day_type: (raw.derived_day_type as string) || 'weekday',
    schedule_version_id: raw.schedule_version_id as string,
    st,
  };
}

// Provider-wide assignments window: ANY site, ANY schedule version (clinical
// invariant 3 — the old version-scoped check let cross-site double-bookings
// through). One query; all link evaluation happens in memory.
async function loadAssignmentsWindow(
  sb: SupabaseClient,
  providerId: string,
  start: string,
  end: string,
): Promise<WindowAssignment[]> {
  const { data } = await sb
    .from('assignments')
    .select('id, source_type, schedule_slots!inner(id, slot_date, site_id, schedule_version_id, shift_types(code, category, call_rank, relief_rank))')
    .eq('provider_id', providerId)
    .eq('assignment_status', 'assigned')
    .gte('schedule_slots.slot_date', start)
    .lte('schedule_slots.slot_date', end);
  const out: WindowAssignment[] = [];
  for (const raw of ((data || []) as Array<Record<string, unknown>>)) {
    const ss = raw.schedule_slots as Record<string, unknown> | null;
    if (!ss) continue;
    out.push({
      id: raw.id as string,
      source_type: (raw.source_type as string) ?? 'manual',
      slot_id: ss.id as string,
      slot_date: ss.slot_date as string,
      site_id: (ss.site_id as string) ?? '',
      schedule_version_id: (ss.schedule_version_id as string) ?? '',
      st: (ss.shift_types as StRow | null) ?? null,
    });
  }
  return out;
}

async function loadAvailabilityWindow(
  sb: SupabaseClient,
  providerId: string,
  start: string,
  end: string,
): Promise<AvailRow[]> {
  const { data } = await sb
    .from('provider_availability')
    .select('availability_type, approval_status, start_date, end_date')
    .eq('provider_id', providerId)
    .lte('start_date', end)
    .gte('end_date', start);
  return (data || []) as AvailRow[];
}

async function loadCandidateSlots(
  sb: SupabaseClient,
  versionId: string,
  start: string,
  end: string,
): Promise<CandidateSlot[]> {
  const { data } = await sb
    .from('schedule_slots')
    .select('id, site_id, slot_date, locked, shift_types(code, category, call_rank, relief_rank), assignments(id, provider_id, assignment_status, source_type)')
    .eq('schedule_version_id', versionId)
    .gte('slot_date', start)
    .lte('slot_date', end);
  return ((data || []) as Array<Record<string, unknown>>).map(raw => ({
    id: raw.id as string,
    site_id: (raw.site_id as string) ?? '',
    slot_date: raw.slot_date as string,
    locked: !!raw.locked,
    st: (raw.shift_types as StRow | null) ?? null,
    assignments: (raw.assignments as CandidateSlot['assignments']) || [],
  }));
}

// Revert an assignment row to an open slot. validation_flags goes to null —
// "not validated", never a fake-clean [] the UI would read as checked-and-
// passed (clinical invariant 6 / carried Task 8 finding).
async function revertToOpen(sb: SupabaseClient, assignmentId: string): Promise<boolean> {
  const { error } = await sb
    .from('assignments')
    .update({
      provider_id: null,
      assignment_status: 'open',
      source_type: 'manual',
      assigned_at: null,
      validation_flags: null,
    })
    .eq('id', assignmentId);
  if (error) {
    console.error(`[sequenceAutoFill] failed to revert assignment ${assignmentId} to open: ${error.message}`);
    return false;
  }
  return true;
}

// ── apply ────────────────────────────────────────────────────────────────────

/**
 * After a manual assignment is saved, interpret the site's call pattern and
 * auto-fill the linked slots (dayChain links) for the same provider.
 *
 * Resolution rules:
 *   - Linked slot must exist in the SAME schedule version as the trigger,
 *     match the link code, and currently be unassigned and unlocked. When
 *     several sites have a matching slot, the trigger's own site is preferred;
 *     otherwise a single candidate wins and an ambiguous set is skipped.
 *   - Pre-call links (negative offset) decline when a prior-day call of
 *     equal-or-lower call_rank owns the linked day (post-call beats pre-call).
 *   - Post-call links (positive offset) evict an OUTRANKED auto-generated
 *     pre-fill occupying the day (same version only; never manual rows).
 *   - PTO/unavailability (pending included) and provider-wide same-day
 *     conflicts (any site, any version) block the fill.
 *   - Every suppressed fill is recorded in `skips` (SkippedDerived vocabulary).
 *
 * `doc`: the site's active call pattern, loaded once per request by the route
 * (loadActiveCallPattern). When omitted, it is loaded here as a fallback.
 */
export async function applySequenceAutoFill(
  sb: SupabaseClient,
  triggerSlotId: string,
  providerId: string,
  doc?: CallPatternDoc,
): Promise<SequenceAutoFillResult> {
  const result: SequenceAutoFillResult = { filledSlotIds: [], skips: [] };
  const skip = (date: string, code: string, reason: SkippedDerived['reason']) =>
    result.skips.push({ date, code, provider_id: providerId, reason });

  const trigger = await loadTriggerSlot(sb, triggerSlotId);
  if (!trigger) return result;

  const pattern = doc ?? await loadActiveCallPattern(sb, trigger.site_id);
  const links = dayChainsFor(pattern, trigger.st.code!, trigger.derived_day_type)
    .flatMap(c => c.links ?? []);
  if (links.length === 0) return result;

  // Window bounds: link offsets, the unlessCallWithinDays lookback, and the
  // prior-day post-call-ownership check must all land inside the window.
  const maxAbs = Math.max(...links.map(l => Math.abs(l.offset)));
  const maxUnless = Math.max(0, ...links.map(l => l.unlessCallWithinDays ?? 0));
  const windowStart = addDays(trigger.slot_date, -Math.max(maxAbs + 1, maxUnless));
  const windowEnd = addDays(trigger.slot_date, maxAbs);

  const windowAssignments = await loadAssignmentsWindow(sb, providerId, windowStart, windowEnd);
  const availability = await loadAvailabilityWindow(sb, providerId, windowStart, windowEnd);
  const candidateSlots = await loadCandidateSlots(
    sb, trigger.schedule_version_id, addDays(trigger.slot_date, -maxAbs), windowEnd);

  const triggerRank = shiftRank(trigger.st);
  const evictableCodes = preFillCodes(pattern);
  const evictedIds = new Set<string>();

  for (const link of links) {
    const linkedDate = addDays(trigger.slot_date, link.offset);
    const code = link.code;

    // Link condition (mirrors solve()): no pre-fill when a call precedes the
    // trigger within N days. A condition on the link itself, not a
    // suppression — solve() does not record it either.
    if (link.unlessCallWithinDays != null) {
      const hadRecentCall = windowAssignments.some(a => {
        if (a.st?.category !== 'call' || a.slot_id === trigger.id) return false;
        const gap = daysBetween(a.slot_date, trigger.slot_date);
        return gap > 0 && gap <= link.unlessCallWithinDays!;
      });
      if (hadRecentCall) continue;
    }

    // Pre-call fill declines when the linked day is already post-call: a call
    // on the prior day whose rank is equal-or-lower owns the day ("lower
    // call_rank trigger wins"; ties go to the post-call side — the old
    // hard-coded D1-beats-D3, without literals).
    if (link.offset < 0) {
      const priorDate = addDays(linkedDate, -1);
      const owned = windowAssignments.some(a =>
        a.slot_date === priorDate
        && a.st?.category === 'call'
        && shiftRank(a.st) <= triggerRank);
      if (owned) { skip(linkedDate, code, 'already-handled'); continue; }
    }

    // Post-call fill evicts an OUTRANKED auto-generated pre-fill occupying the
    // linked day. Same schedule version only (never touch other drafts), never
    // manual rows, never calls, and only codes the pattern marks as pre-fills.
    if (link.offset > 0) {
      for (const a of windowAssignments) {
        if (a.slot_date !== linkedDate || evictedIds.has(a.id)) continue;
        if (a.schedule_version_id !== trigger.schedule_version_id) continue;
        if (a.source_type !== 'auto_generated') continue;
        if (a.st?.category === 'call') continue;
        if (!a.st?.code || !evictableCodes.has(a.st.code)) continue;
        if (triggerRank > shiftRank(a.st)) continue; // occupant outranks the incoming fill
        if (await revertToOpen(sb, a.id)) evictedIds.add(a.id);
      }
    }

    // Candidate slot on the linked date, same version, matching code.
    const candidates = candidateSlots.filter(s => s.slot_date === linkedDate && s.st?.code === code);
    if (candidates.length === 0) { skip(linkedDate, code, 'no-slot'); continue; }
    let chosen = candidates.find(s => s.site_id === trigger.site_id);
    if (!chosen) {
      if (candidates.length === 1) chosen = candidates[0];
      else { skip(linkedDate, code, 'ineligible'); continue; } // ambiguous across sites — don't guess
    }
    if (chosen.locked) { skip(linkedDate, code, 'ineligible'); continue; }

    // Slot already held by someone (evicted rows no longer count).
    const occupant = chosen.assignments.find(a => a.provider_id && !evictedIds.has(a.id));
    if (occupant) { skip(linkedDate, code, 'occupied'); continue; }

    // Blocking availability — canonical predicate, PENDING PTO blocks
    // (clinical invariant 2 / spec §6.7).
    const blocked = availability.some(a =>
      isBlockingAvailability(a) && a.start_date <= linkedDate && a.end_date >= linkedDate);
    if (blocked) { skip(linkedDate, code, 'pto'); continue; }

    // Provider-wide same-day conflict — ANY site, ANY schedule version
    // (clinical invariant 3).
    const conflicts = windowAssignments.filter(a =>
      a.slot_date === linkedDate
      && !evictedIds.has(a.id)
      && a.slot_id !== chosen!.id
      && a.slot_id !== trigger.id);
    if (conflicts.length > 0) {
      const crossSite = conflicts.some(c => c.site_id !== trigger.site_id);
      skip(linkedDate, code, crossSite ? 'cross-site' : 'occupied');
      continue;
    }

    // Write the fill. One assignment row per slot (UNIQUE on schedule_slot_id):
    // update the existing open row when present, insert otherwise.
    // validation_flags stays null — the POST route revalidates the provider's
    // neighbors (including this row) right after; null is honest "not yet
    // validated", never a fake-clean [] (invariant 6 / carried Task 8 finding).
    const fillFields = {
      provider_id: providerId,
      assignment_status: 'assigned',
      source_type: 'auto_generated',
      assigned_at: new Date().toISOString(),
      validation_flags: null,
    };
    const openRow = chosen.assignments.find(a => !a.provider_id || evictedIds.has(a.id));
    if (openRow) {
      const { error } = await sb.from('assignments').update(fillFields).eq('id', openRow.id);
      if (error) {
        console.error(`[sequenceAutoFill] fill update failed for slot ${chosen.id}: ${error.message}`);
        continue;
      }
    } else {
      const { error } = await sb.from('assignments').insert({ schedule_slot_id: chosen.id, ...fillFields });
      if (error) {
        console.error(`[sequenceAutoFill] fill insert failed for slot ${chosen.id}: ${error.message}`);
        continue;
      }
    }
    result.filledSlotIds.push(chosen.id);
  }

  return result;
}

// ── cleanup ──────────────────────────────────────────────────────────────────

/**
 * When a trigger assignment is removed, clear the linked auto-generated fills
 * for that provider — same pattern-link derivation as applySequenceAutoFill.
 * Only rows with source_type='auto_generated' AND a matching provider are
 * reverted; manual edits are never touched.
 */
export async function cleanupSequenceAutoFill(
  sb: SupabaseClient,
  triggerSlotId: string,
  providerId: string,
  doc?: CallPatternDoc,
): Promise<SequenceCleanupResult> {
  const cleared: string[] = [];

  const trigger = await loadTriggerSlot(sb, triggerSlotId);
  if (!trigger) return { clearedSlotIds: cleared };

  const pattern = doc ?? await loadActiveCallPattern(sb, trigger.site_id);
  const links = dayChainsFor(pattern, trigger.st.code!, trigger.derived_day_type)
    .flatMap(c => c.links ?? []);
  if (links.length === 0) return { clearedSlotIds: cleared };

  const maxAbs = Math.max(...links.map(l => Math.abs(l.offset)));
  const slots = await loadCandidateSlots(
    sb, trigger.schedule_version_id,
    addDays(trigger.slot_date, -maxAbs), addDays(trigger.slot_date, maxAbs));

  for (const link of links) {
    const linkedDate = addDays(trigger.slot_date, link.offset);
    for (const s of slots) {
      if (s.slot_date !== linkedDate || s.st?.code !== link.code) continue;
      for (const a of s.assignments) {
        if (a.provider_id !== providerId || a.source_type !== 'auto_generated') continue;
        if (await revertToOpen(sb, a.id)) cleared.push(s.id);
      }
    }
  }

  return { clearedSlotIds: cleared };
}
