import {
  BOOKEND_EXTENDING_TYPES,
  addDays,
  dayOfWeekUTC,
  dayTypeBucket,
  isBlockingAvailability,
  isDateBlocked,
} from './shared';
import { CLASSIC_PATTERN, postCallBlockOffsets } from './callPattern';
import { exceedsWorkDayCap } from './workDays';
import type {
  GenerationContext, SlotToFill, CandidateProvider, SolveState,
  GateSet, EligibilityResult,
} from './genTypes';

const PASS: EligibilityResult = { eligible: true };

// Single canonical eligibility gate. `gate === 'call'` applies the full set
// (quota + post-call guard + workdays cap included). `gate === 'call-no-quota'`
// is 'call' minus the bucket quota and the workdays cap (quota relaxation,
// block-chain call links, optimizer pre-gate + pin re-validation — see GateSet
// in genTypes.ts). `gate === 'derived'` is for structurally derived placements
// (D-chains, weekend non-call fills, relief codes from shift_types.relief_rank
// ordering — D4-D9 is only the legacy fallback when ctx.shiftTypes is absent):
// it drops the bucket-quota and the pattern-driven post-call guard (a code
// whose day-chain blocks the next day — not a C1 literal) but keeps every
// safety gate (credentials, conflicts, weekday availability, weekend-adjacent
// PTO, and the PTO-bookend availability check — the last of which closes the
// relief-pass H2 bug) plus the workdays cap.
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

  // Same-date conflict (this schedule). The overlay exemption is NARROW:
  // is_overlay exempts REGULAR↔OVERLAY-CALL coexistence only (Doc C's Fri D4
  // day shift + Fri C3 evening neuro call). It is NOT a general free pass —
  // two same-date CALLS never stack, and post-call blocked days always bind
  // (both checks below; review findings 1+2).
  //
  // This trio realizes the canonical overlayMayCoexist decision table
  // (shared.ts) INCREMENTALLY against SolveState maps — the existing side is
  // implicit in map membership (overlay placements never enter assignedOnDate;
  // callDatesByProvider holds every call, overlay included; blockedOnDate
  // holds post-call blocks, which aren't assignments at all), so the
  // two-object predicate cannot be consumed literally here. Keep the three
  // checks in sync with that table.
  const slotOverlay = ctx.shiftTypes?.get(slot.shift_type_code)?.is_overlay ?? false;
  if (!slotOverlay && state.assignedOnDate.get(slot.slot_date)?.has(p.id)) {
    return { eligible: false, reason: 'same-date' };
  }
  // Call-on-call: a CALL-category placement collides with ANY same-date call,
  // overlay or not, in either placement order. callDatesByProvider records
  // every call placement and seed (overlay included), so it sees calls the
  // assignedOnDate budget missed (overlay ones). For non-overlay pairs this is
  // shadowed by the assignedOnDate check above (golden parity unaffected).
  if (slot.shift_type_category === 'call'
    && state.callDatesByProvider.get(p.id)?.includes(slot.slot_date)) {
    return { eligible: false, reason: 'same-date' };
  }
  // Overlay placements skip the assignedOnDate budget, so they must separately
  // respect pattern post-call BLOCKED days (day off after a rest-requiring
  // call — clinical invariant 1). blockedOnDate is written alongside
  // markAssigned at the two block-marking sites (solve.applyDayChains blocks;
  // seedSolveState IF-1). Non-overlay placements already collide via
  // assignedOnDate (blocks are markAssigned entries too).
  if (slotOverlay && state.blockedOnDate.get(slot.slot_date)?.has(p.id)) {
    return { eligible: false, reason: 'post-call-guard' };
  }

  // Cross-site conflict (preloaded). DELIBERATELY overlay-blind (conservative,
  // spec 2026-07-15 §Changes/2): the same-date overlay exemption above is a
  // SAME-SITE block-design affordance (Doc C's Fri D4 + Fri C3 coexist because
  // one is a day shift, the other evening neuro call at the SAME site). A
  // published assignment at ANOTHER site on the same day is a genuine two-places
  // conflict regardless of overlay, so it still blocks. Revisit only if a
  // cross-site overlay coexistence case is actually specified.
  if (ctx.crossSiteByDate.get(p.id)?.has(slot.slot_date)) {
    return { eligible: false, reason: 'cross-site' };
  }

  // Weekday availability. Index is Sun..Sat.
  const dow = dayOfWeekUTC(slot.slot_date);
  if (p.available_weekdays[dow] === false) {
    return { eligible: false, reason: 'weekday-unavailable' };
  }

  // 'call-no-quota' is the IF-3 quota-relaxation gate: identical to 'call'
  // except the bucket-quota check below — relaxation may only waive the
  // quota, never a safety gate (invariant 2).
  const callGate = gate === 'call' || gate === 'call-no-quota';

  // Post-call day-off guard (call gates only), pattern-driven: a code whose
  // day-chain blocks the NEXT day must not be placed when the provider is
  // already busy that next day. Day-type scoping (e.g. the classic Saturday C1
  // exemption) falls out of the pattern doc's dayChain blocks.
  const doc = ctx.callPattern ?? CLASSIC_PATTERN;
  if (callGate
    && postCallBlockOffsets(doc, slot.shift_type_code, slot.derived_day_type).includes(1)) {
    const dayAfter = addDays(slot.slot_date, 1);
    if (state.assignedOnDate.get(dayAfter)?.has(p.id)) {
      return { eligible: false, reason: 'post-call-guard' };
    }
  }

  // Bucket quota (the full 'call' gate ONLY — waived under 'call-no-quota'):
  // "would one more push us past target?"
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

  // Saturday/Sunday adjacent-week PTO exclusion. Deliberately ROW-based, not
  // routed through isDateBlocked: a sold-back day INSIDE the adjacent PTO week
  // does not resurrect weekend eligibility — the surrounding planned leave
  // still exists (v1 simplification, stated in ALGORITHM.md §6).
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

  // Availability with PTO bookend (pending blocks — spec §6.7), single-homed
  // per-date decision (isDateBlocked, shared.ts): a live pto_sellback row
  // covering the slot date OVERRIDES any blocking coverage — the provider is
  // working that day (ALGORITHM.md §6). Zero-sellback inputs take exactly the
  // pre-change bookended any-blocking-row-covers path.
  if (isDateBlocked(ctx.availByPid.get(p.id) || [], slot.slot_date, { bookend: true })) {
    return { eligible: false, reason: 'availability-blocked' };
  }

  // FTE working-days cap (2026-07-17). Opt-in via ctx.workDayBudget (absent on
  // bare/parity fixtures → this gate never fires → byte-identical no-cap path).
  // Placed AFTER every safety gate so a safety block always wins the reported
  // reason: the cap is a NEW restriction that only ever ADDS ineligibility, it
  // must never override a safety gate (all gates are AND).
  //   • Applies to the full 'call' gate AND the 'derived' gate (relief, mop-up,
  //     d-chains — every weekday placement).
  //   • WAIVED under 'call-no-quota': that gate re-asserts an already-made
  //     placement (optimizer pins, chain call links) — enforcing the cap there
  //     would self-reject an incumbent. Quota relaxation, which also uses
  //     'call-no-quota', re-applies the cap explicitly in solve() instead.
  //   • Weekend / major-holiday slots are exempt (not working days → the
  //     placement consumes no credit → exceedsWorkDayCap returns false).
  if ((gate === 'call' || gate === 'derived') && ctx.workDayBudget) {
    const b = ctx.workDayBudget.byProvider.get(p.id);
    if (b && exceedsWorkDayCap(
      slot.slot_date, ctx.workDayBudget.workingDaySet,
      state.creditedWorkDays.get(p.id), b.required,
    )) {
      return { eligible: false, reason: 'workdays-cap' };
    }
  }

  return PASS;
}
