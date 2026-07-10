import {
  BOOKEND_EXTENDING_TYPES,
  addDays,
  datesOverlap,
  dayOfWeekUTC,
  effectivePtoRange,
  dayTypeBucket,
  isBlockingAvailability,
} from './shared';
import { CLASSIC_PATTERN, postCallBlockOffsets } from './callPattern';
import type {
  GenerationContext, SlotToFill, CandidateProvider, SolveState,
  GateSet, EligibilityResult,
} from './genTypes';

const PASS: EligibilityResult = { eligible: true };

// Single canonical eligibility gate. `gate === 'call'` applies the full set
// (quota + post-call guard included). `gate === 'derived'` is for structurally
// derived placements (D-chains, weekend non-call fills, D4-D9 relief): it drops
// the bucket-quota and C1 post-call gates but keeps every safety gate
// (credentials, conflicts, weekday availability, weekend-adjacent PTO, and the
// PTO-bookend availability check — the last of which closes the relief-pass H2 bug).
export function evaluateEligibility(
  slot: SlotToFill,
  p: CandidateProvider,
  state: SolveState,
  ctx: GenerationContext,
  gate: GateSet,
): EligibilityResult {
  // Provider group match
  if (slot.provider_group === 'physician' && p.provider_type !== 'physician') {
    return { eligible: false, reason: 'group-mismatch' };
  }
  if (slot.provider_group === 'crna' && !['crna', 'aa'].includes(p.provider_type)) {
    return { eligible: false, reason: 'group-mismatch' };
  }

  // Same-date conflict (this schedule). Overlay slots (is_overlay shift types)
  // neither consume nor collide with the one-assignment-per-day budget.
  const slotOverlay = ctx.shiftTypes?.get(slot.shift_type_code)?.is_overlay ?? false;
  if (!slotOverlay && state.assignedOnDate.get(slot.slot_date)?.has(p.id)) {
    return { eligible: false, reason: 'same-date' };
  }

  // Cross-site conflict (preloaded)
  if (ctx.crossSiteByDate.get(p.id)?.has(slot.slot_date)) {
    return { eligible: false, reason: 'cross-site' };
  }

  // Weekday availability. Index is Sun..Sat.
  const dow = dayOfWeekUTC(slot.slot_date);
  if (p.available_weekdays[dow] === false) {
    return { eligible: false, reason: 'weekday-unavailable' };
  }

  // Post-call day-off guard (call gate only), pattern-driven: a code whose
  // day-chain blocks the NEXT day must not be placed when the provider is
  // already busy that next day. Day-type scoping (e.g. the classic Saturday C1
  // exemption) falls out of the pattern doc's dayChain blocks.
  const doc = ctx.callPattern ?? CLASSIC_PATTERN;
  if (gate === 'call'
    && postCallBlockOffsets(doc, slot.shift_type_code, slot.derived_day_type).includes(1)) {
    const dayAfter = addDays(slot.slot_date, 1);
    if (state.assignedOnDate.get(dayAfter)?.has(p.id)) {
      return { eligible: false, reason: 'post-call-guard' };
    }
  }

  // Bucket quota (call gate only): "would one more push us past target?"
  if (gate === 'call') {
    const k = `${p.id}|${dayTypeBucket(slot.derived_day_type)}|${slot.shift_type_code}`;
    const assigned = state.bucketAssigned.get(k) || 0;
    const target = ctx.bucketTarget.get(k) ?? 0;
    if (assigned + 1 > target) {
      return { eligible: false, reason: 'bucket-quota' };
    }
  }

  // Site credentials
  const cred = ctx.credByPid.get(p.id);
  if (cred) {
    if (!cred.is_active) return { eligible: false, reason: 'credential' };
    if (!cred.credentialed) return { eligible: false, reason: 'credential' };
    if (cred.excluded_shift_types.includes(slot.shift_type_code)) {
      return { eligible: false, reason: 'credential' };
    }
    if (cred.allowed_shift_types.length > 0
      && !cred.allowed_shift_types.includes(slot.shift_type_code)) {
      return { eligible: false, reason: 'credential' };
    }
    if (slot.shift_type_category === 'call') {
      if (!cred.can_take_call) return { eligible: false, reason: 'credential' };
      const dt = slot.derived_day_type;
      if ((dt === 'saturday' || dt === 'sunday') && !cred.can_take_weekend_call) {
        return { eligible: false, reason: 'credential' };
      }
      if ((dt === 'federal_holiday' || dt === 'major_holiday') && !cred.can_take_holiday_call) {
        return { eligible: false, reason: 'credential' };
      }
    }
  }
  // Missing credentials row = "not yet configured", treated as passing.

  // Saturday/Sunday adjacent-week PTO exclusion.
  if (slot.derived_day_type === 'saturday' || slot.derived_day_type === 'sunday') {
    const satDate = slot.derived_day_type === 'saturday'
      ? slot.slot_date
      : addDays(slot.slot_date, -1);
    const weekBeforeStart = addDays(satDate, -5); // Mon before the weekend
    const weekBeforeEnd = addDays(satDate, -1);   // Fri before the weekend
    const weekAfterStart = addDays(satDate, 2);   // Mon after the weekend
    const weekAfterEnd = addDays(satDate, 6);     // Fri after the weekend
    const entries = ctx.availByPid.get(p.id) || [];
    for (const a of entries) {
      // Canonical predicate (pending blocks — spec §6.7), narrowed to the
      // bookend-extending subset: only multi-day planned leave pulls the
      // adjacent weekend out of contention.
      if (!isBlockingAvailability(a)) continue;
      if (!BOOKEND_EXTENDING_TYPES.has(a.availability_type)) continue;
      if (a.start_date <= weekBeforeEnd && a.end_date >= weekBeforeStart) {
        return { eligible: false, reason: 'weekend-adjacent-pto' };
      }
      if (a.start_date <= weekAfterEnd && a.end_date >= weekAfterStart) {
        return { eligible: false, reason: 'weekend-adjacent-pto' };
      }
    }
  }

  // Availability with PTO bookend (pending blocks — spec §6.7).
  const entries = ctx.availByPid.get(p.id) || [];
  for (const a of entries) {
    if (!isBlockingAvailability(a)) continue;
    const { start, end } = effectivePtoRange(a);
    if (datesOverlap(start, end, slot.slot_date)) {
      return { eligible: false, reason: 'availability-blocked' };
    }
  }

  return PASS;
}
