// Post-solve no-call request grant report (2026-07-17).
//
// Pure: derived from a GenerationContext + the FINAL SolutionPlan, so
// autoGenerate computes it AFTER the optimizer picks the plan that will be
// committed — the report always describes what the schedule actually says.
// For every provider with a LIVE no_call_request (isActiveNoCallRequest —
// the same single-home predicate solve's penalty tier and validation's soft
// flag use), the block dates their request(s) cover are partitioned into
//   granted  — no call-category assignment landed (plan or pre-existing seed)
//   violated — a call landed anyway (soft avoidance lost: nobody else passed
//              the gates, or a chain/span/seed structurally owned the date)
// Dates outside the block are ignored — this generation never decided them.
import { datesOverlap, isActiveNoCallRequest } from './shared';
import type { GenerationContext, SolutionPlan } from './genTypes';

export interface RequestGrant {
  provider_id: string;
  provider_name: string;
  requested_dates: string[]; // block dates covered by a live request (sorted)
  granted: string[];         // requested dates with no call landed
  violated: string[];        // requested dates a call landed on
}

export function computeRequestGrants(
  ctx: GenerationContext, plan: SolutionPlan,
): RequestGrant[] {
  const blockDates = ctx.scheduleDates ?? Array.from(ctx.slotIndex.keys()).sort();

  // pid -> dates a call-category assignment lands on (final plan + seeds —
  // a manual call on a requested date is just as real a denial).
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
