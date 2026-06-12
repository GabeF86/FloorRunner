import {
  BLOCKING_AVAIL,
  BOOKEND_EXTENDING_TYPES,
  addDays,
  datesOverlap,
  dayOfWeekUTC,
  effectivePtoRange,
  dayTypeBucket,
} from './shared';
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

  // Same-date conflict (this schedule)
  if (state.assignedOnDate.get(slot.slot_date)?.has(p.id)) {
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

  // C1 post-call day-off guard (call gate only). Saturday C1 is excepted.
  if (gate === 'call'
    && slot.shift_type_code === 'C1'
    && slot.derived_day_type !== 'saturday') {
    const dayAfter = addDays(slot.slot_date, 1);
    if (state.assignedOnDate.get(dayAfter)?.has(p.id)) {
      return { eligible: false, reason: 'post-call-guard' };
    }
  }

  // Bucket quota (call gate only): "would one more push us past target?"
  if (gate === 'call') {
    const k = `${p.id}|${dayTypeBucket(slot.derived_day_type)}|${slot.shift_type_code}`;
    const assigned = state.bucketAssigned.get(k) || 0;
    const target = ctx.bucketTarget.get(k) || 0;
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
    const weekBeforeStart = addDays(satDate, -5);
    const weekBeforeEnd = addDays(satDate, -1);
    const weekAfterStart = addDays(satDate, 2);
    const weekAfterEnd = addDays(satDate, 6);
    const entries = ctx.availByPid.get(p.id) || [];
    for (const a of entries) {
      if (a.approval_status === 'denied' || a.approval_status === 'canceled') continue;
      if (!BOOKEND_EXTENDING_TYPES.has(a.availability_type)) continue;
      if (a.start_date <= weekBeforeEnd && a.end_date >= weekBeforeStart) {
        return { eligible: false, reason: 'weekend-adjacent-pto' };
      }
      if (a.start_date <= weekAfterEnd && a.end_date >= weekAfterStart) {
        return { eligible: false, reason: 'weekend-adjacent-pto' };
      }
    }
  }

  // Availability with PTO bookend.
  const entries = ctx.availByPid.get(p.id) || [];
  for (const a of entries) {
    if (a.approval_status === 'denied' || a.approval_status === 'canceled') continue;
    if (!BLOCKING_AVAIL.has(a.availability_type)) continue;
    const { start, end } = effectivePtoRange(a);
    if (datesOverlap(start, end, slot.slot_date)) {
      return { eligible: false, reason: 'availability-blocked' };
    }
  }

  return PASS;
}
