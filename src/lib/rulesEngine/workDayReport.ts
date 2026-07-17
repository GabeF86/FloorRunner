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
import { creditsAsWorkedAvailability } from './workDays';
import type { GenerationContext, SolutionPlan } from './genTypes';

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
    rows.push({
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
    });
  }
  return rows;
}
