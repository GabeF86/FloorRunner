// FTE working-days report (2026-07-17). Per provider, reconstructs the
// working-days accounting from the FINAL plan (post-optimize) + seeds + ICU
// availability so it always describes what was actually committed. Independent
// of the solve-state credit ledger (which only exists during solving) but uses
// the SAME classification rules, so report and engine agree by construction.
//
// Audience: the call-taker pool (ctx.providers). Day-pool shifts placed by the
// separate dayShiftAutoGen pass in the same run are NOT reflected here — they
// go to a DIFFERENT pool (Day Docs) and enforce their own working-days cap.

import { addDays } from './shared';
import { CLASSIC_PATTERN, postCallBlockOffsets } from './callPattern';
import { creditsAsWorkedAvailability, ptoWeekdaysCovered } from './workDays';
import { computeSequenceOwnedSlotIds } from './sequenceOwnership';
import { evaluateEligibility } from './eligibility';
import { seedSolveState } from './solve';
import { markAssigned, markBlocked, creditWorkDay, addCallDate } from './solveState';
import type { GenerationContext, SolutionPlan, SolveState, CandidateProvider } from './genTypes';

// Completeness check (work-to-required, 2026-07-24 — Gabriel: "make sure the
// scheduler checks to make sure everyone is working the maximum number of
// obligatory work days"): every under-required provider's idle working days,
// classified honestly:
//   engineGapDates — an open ENGINE-ADDRESSABLE slot the provider was eligible
//     for remained on the date ("under-scheduled: engine gap"). Addressable =
//     an open call slot, or an open call-engine day slot (relief/mop-up
//     inventory) that is NOT sequence-owned (chain-owned slots belong to the
//     chain's provider and are reported as orphans by the mop-up, never
//     direct-fill inventory).
//   noSlotDates — no open compatible slot existed ("no open compatible slots —
//     staffing reality": the block simply has fewer slots than obligations, or
//     the provider was blocked/ineligible for everything open that day).
// Never silent, never conflated. PTO-netting days are excluded from both lists
// (they already reduced `required` 1:1 — not idle days). Partials may list
// more idle days than `days` (their entitledOff is idle by design); `days` is
// the true deficit count.
export interface WorkDayShortfall {
  days: number;               // required − credited.total (> 0)
  engineGapDates: string[];   // idle working days with ≥1 open compatible slot
  noSlotDates: string[];      // idle working days with none
}

export interface WorkDayReportRow {
  provider_id: string;
  provider_name: string;
  fte: number;
  workingDays: number;
  ptoDays: number;    // PTO-netting working days (reduced `required` 1:1)
  required: number;
  credited: {
    assignments: number; // distinct working days with an assignment (any engine)
    postCall: number;    // distinct working days that are a post-call rest day
    icu: number;         // distinct working days on ICU rotation
    total: number;       // = assignments + postCall + icu (disjoint sets)
  };
  entitledOff: number;
  delta: number;         // credited.total − required (positive = over, negative = under)
  // Present ONLY when credited.total < required (delta < 0): the completeness
  // classification above. Absent otherwise so at/over rows stay unchanged.
  shortfall?: WorkDayShortfall;
}

// Reconstruct the END state of the plan (seeds + every plan assignment with
// its post-call blocks) so shortfall classification can ask the SAME
// eligibility gate the engine uses: "could this provider have taken that open
// slot, given everything that was actually placed?" Buckets are not replayed —
// call slots are checked with 'call-no-quota' (quota can never be the honest
// reason an UNDER-required provider idled; IF-3 relaxation waives it anyway).
function reconstructFinalState(ctx: GenerationContext, plan: SolutionPlan): SolveState {
  const doc = ctx.callPattern ?? CLASSIC_PATTERN;
  const state = seedSolveState(ctx, doc);
  const isOverlay = (code: string) => ctx.shiftTypes?.get(code)?.is_overlay ?? false;
  for (const a of plan.assignments) {
    if (!isOverlay(a.shift_type_code)) markAssigned(state, a.slot_date, a.provider_id);
    state.handledSlotIds.add(a.slot_id);
    creditWorkDay(state, ctx.workDayBudget, a.provider_id, a.slot_date);
    if (a.shift_type_category === 'call') {
      addCallDate(state, a.provider_id, a.slot_date);
      for (const off of postCallBlockOffsets(doc, a.shift_type_code, a.derived_day_type)) {
        const bd = addDays(a.slot_date, off);
        markAssigned(state, bd, a.provider_id);
        markBlocked(state, bd, a.provider_id);
        creditWorkDay(state, ctx.workDayBudget, a.provider_id, bd);
      }
    }
  }
  return state;
}

// Is there an open engine-addressable slot on `date` the provider could have
// taken? Open = in slotIndex (open at generation time) and not filled by the
// plan. Addressable: call slots always (checked 'call-no-quota'); non-call
// slots only when their shift type is call-engine-owned ('derived' — the
// relief/mop-up path) and not sequence-owned. Day-pool slots belong to the
// other engine's accounting and are deliberately out of scope here.
function hasOpenCompatibleSlot(
  ctx: GenerationContext,
  p: CandidateProvider,
  date: string,
  finalState: SolveState,
  filledSlotIds: ReadonlySet<string>,
  sequenceOwned: ReadonlySet<string>,
): boolean {
  const codeMap = ctx.slotIndex.get(date);
  if (!codeMap) return false;
  for (const slot of codeMap.values()) {
    if (filledSlotIds.has(slot.slot_id)) continue;
    if (slot.shift_type_category === 'call') {
      if (evaluateEligibility(slot, p, finalState, ctx, 'call-no-quota').eligible) return true;
      continue;
    }
    if (ctx.shiftTypes?.get(slot.shift_type_code)?.generation_engine !== 'call') continue;
    if (sequenceOwned.has(slot.slot_id)) continue;
    if (evaluateEligibility(slot, p, finalState, ctx, 'derived').eligible) return true;
  }
  return false;
}

// Empty when ctx carries no working-days budget (bare / parity fixtures).
export function computeWorkDayReport(ctx: GenerationContext, plan: SolutionPlan): WorkDayReportRow[] {
  const budget = ctx.workDayBudget;
  if (!budget) return [];
  const doc = ctx.callPattern ?? CLASSIC_PATTERN;
  const wd = budget.workingDaySet;

  // Gather every provider's placements once (plan + seeds).
  const placementsByPid = new Map<string, Array<{ date: string; code: string; category: string; dayType: string }>>();
  const push = (pid: string, date: string, code: string, category: string, dayType: string) => {
    const list = placementsByPid.get(pid) ?? [];
    list.push({ date, code, category, dayType });
    placementsByPid.set(pid, list);
  };
  for (const a of plan.assignments) {
    push(a.provider_id, a.slot_date, a.shift_type_code, a.shift_type_category, a.derived_day_type);
  }
  for (const s of ctx.seedAssignments) {
    push(s.provider_id, s.slot_date, s.shift_type_code, s.shift_type_category, s.derived_day_type);
  }

  // Shortfall classification inputs, built lazily (only when someone is under).
  let finalState: SolveState | null = null;
  let filledSlotIds: Set<string> | null = null;
  let sequenceOwned: Set<string> | null = null;

  const rows: WorkDayReportRow[] = [];
  for (const p of ctx.providers) {
    const b = budget.byProvider.get(p.id);
    if (!b) continue;
    const events = placementsByPid.get(p.id) ?? [];

    // 1. Assignment working days (any engine).
    const assignmentDays = new Set<string>();
    for (const e of events) if (wd.has(e.date)) assignmentDays.add(e.date);

    // 2. Post-call rest working days (from each call's pattern block offsets),
    //    excluding days already counted as an assignment.
    const postCallDays = new Set<string>();
    for (const e of events) {
      if (e.category !== 'call') continue;
      for (const off of postCallBlockOffsets(doc, e.code, e.dayType)) {
        const bd = addDays(e.date, off);
        if (wd.has(bd) && !assignmentDays.has(bd)) postCallDays.add(bd);
      }
    }

    // 3. ICU working days, excluding days already counted above.
    const icuDays = new Set<string>();
    for (const a of ctx.availByPid.get(p.id) ?? []) {
      if (!creditsAsWorkedAvailability(a)) continue;
      for (const d of wd) {
        if (a.start_date <= d && d <= a.end_date && !assignmentDays.has(d) && !postCallDays.has(d)) {
          icuDays.add(d);
        }
      }
    }

    const total = assignmentDays.size + postCallDays.size + icuDays.size;
    const row: WorkDayReportRow = {
      provider_id: p.id,
      provider_name: p.short_display_name,
      fte: b.fte,
      workingDays: b.workingDays,
      ptoDays: b.ptoWeekdays,
      required: b.required,
      credited: {
        assignments: assignmentDays.size,
        postCall: postCallDays.size,
        icu: icuDays.size,
        total,
      },
      entitledOff: b.entitledOff,
      delta: total - b.required,
    };

    // Completeness (work-to-required, 2026-07-24): classify every idle working
    // day of an under-required provider — engine gap vs staffing reality.
    if (total < b.required) {
      finalState ??= reconstructFinalState(ctx, plan);
      filledSlotIds ??= new Set(plan.assignments.map(a => a.slot_id));
      sequenceOwned ??= computeSequenceOwnedSlotIds(ctx.callPattern ?? CLASSIC_PATTERN, ctx.slotIndex);
      // Netting-PTO days are not idle: they already reduced `required` 1:1.
      const ptoDates = ptoWeekdaysCovered(ctx.availByPid.get(p.id) ?? [], wd);
      const engineGapDates: string[] = [];
      const noSlotDates: string[] = [];
      for (const date of [...wd].sort()) {
        if (assignmentDays.has(date) || postCallDays.has(date) || icuDays.has(date)) continue;
        if (ptoDates.has(date)) continue;
        (hasOpenCompatibleSlot(ctx, p, date, finalState, filledSlotIds, sequenceOwned)
          ? engineGapDates : noSlotDates).push(date);
      }
      row.shortfall = { days: b.required - total, engineGapDates, noSlotDates };
    }
    rows.push(row);
  }
  return rows;
}
