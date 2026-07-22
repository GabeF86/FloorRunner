// Post-solve request grant reports (no-call 2026-07-17; call 2026-07-22).
//
// Pure: derived from a GenerationContext + the FINAL SolutionPlan, so
// autoGenerate computes them AFTER the optimizer picks the plan that will be
// committed — the reports always describe what the schedule actually says.
//
// No-call: for every provider with a LIVE no_call_request
// (isActiveNoCallRequest — the same single-home predicate solve's penalty
// tier and validation's soft flag use), the block dates their request(s)
// cover are partitioned into
//   granted  — no call-category assignment landed (plan or pre-existing seed)
//   violated — a call landed anyway (soft avoidance lost: nobody else passed
//              the gates, or a chain/span/seed structurally owned the date)
//
// Call (mirror image, computeCallRequestGrants): for every provider with a
// LIVE call_request (isActiveCallRequest — the predicate solve's preferred
// tier uses), the covered block dates are partitioned into
//   granted     — a call-category assignment landed (plan or seed)
//   not_granted — no call landed (preference lost: someone neutral was never
//                 outranked because the requester failed a gate/quota/cap)
// Contradictory dates (both request types live — solve treats them as
// neither, plan.requestWarnings) are EXCLUDED from the call report; the
// no-call report is deliberately untouched (its shipped semantics predate
// call requests and validation's soft flag still keys off the no-call row).
//
// Dates outside the block are ignored — this generation never decided them.
import { datesOverlap, isActiveNoCallRequest, isActiveCallRequest } from './shared';
import type { GenerationContext, SolutionPlan } from './genTypes';

export interface RequestGrant {
  provider_id: string;
  provider_name: string;
  requested_dates: string[]; // block dates covered by a live request (sorted)
  granted: string[];         // requested dates with no call landed
  violated: string[];        // requested dates a call landed on
}

export interface CallRequestGrant {
  provider_id: string;
  provider_name: string;
  requested_dates: string[]; // block dates covered by a live call request (sorted)
  granted: string[];         // requested dates a call landed on
  not_granted: string[];     // requested dates with no call landed
}

// pid -> dates a call-category assignment lands on (final plan + seeds —
// a manual call counts exactly like a placed one for both reports).
function callDatesByPid(ctx: GenerationContext, plan: SolutionPlan): Map<string, Set<string>> {
  const callDates = new Map<string, Set<string>>();
  const addCall = (pid: string, date: string) => {
    const set = callDates.get(pid) ?? new Set<string>();
    set.add(date);
    callDates.set(pid, set);
  };
  for (const a of plan.assignments) {
    if (a.shift_type_category === 'call') addCall(a.provider_id, a.slot_date);
  }
  for (const s of ctx.seedAssignments) {
    if (s.shift_type_category === 'call') addCall(s.provider_id, s.slot_date);
  }
  return callDates;
}

export function computeRequestGrants(
  ctx: GenerationContext, plan: SolutionPlan,
): RequestGrant[] {
  const blockDates = ctx.scheduleDates ?? Array.from(ctx.slotIndex.keys()).sort();
  const callDates = callDatesByPid(ctx, plan);

  const out: RequestGrant[] = [];
  // Deterministic id order (matches the engine's tiebreak convention).
  for (const p of [...ctx.providers].sort((a, b) => a.id.localeCompare(b.id))) {
    const live = (ctx.availByPid.get(p.id) || []).filter(isActiveNoCallRequest);
    if (live.length === 0) continue;
    const requested = blockDates.filter(
      d => live.some(e => datesOverlap(e.start_date, e.end_date, d)));
    if (requested.length === 0) continue; // request entirely outside this block
    const calls = callDates.get(p.id);
    out.push({
      provider_id: p.id,
      provider_name: p.short_display_name,
      requested_dates: requested,
      granted: requested.filter(d => !calls?.has(d)),
      violated: requested.filter(d => calls?.has(d) ?? false),
    });
  }
  return out;
}

// Mirror image of computeRequestGrants for call requests: granted = a call
// LANDED on the requested date. Contradictory dates (also covered by a live
// no-call request — the engine treated them as neither) are excluded here,
// matching solve()'s contraReqDates rule; plan.requestWarnings carries the
// once-per-provider advisory.
export function computeCallRequestGrants(
  ctx: GenerationContext, plan: SolutionPlan,
): CallRequestGrant[] {
  const blockDates = ctx.scheduleDates ?? Array.from(ctx.slotIndex.keys()).sort();
  const callDates = callDatesByPid(ctx, plan);

  const out: CallRequestGrant[] = [];
  for (const p of [...ctx.providers].sort((a, b) => a.id.localeCompare(b.id))) {
    const avail = ctx.availByPid.get(p.id) || [];
    const live = avail.filter(isActiveCallRequest);
    if (live.length === 0) continue;
    const liveNoCall = avail.filter(isActiveNoCallRequest);
    const requested = blockDates.filter(d =>
      live.some(e => datesOverlap(e.start_date, e.end_date, d))
      && !liveNoCall.some(e => datesOverlap(e.start_date, e.end_date, d)));
    if (requested.length === 0) continue; // outside the block or fully contradictory
    const calls = callDates.get(p.id);
    out.push({
      provider_id: p.id,
      provider_name: p.short_display_name,
      requested_dates: requested,
      granted: requested.filter(d => calls?.has(d) ?? false),
      not_granted: requested.filter(d => !calls?.has(d)),
    });
  }
  return out;
}
