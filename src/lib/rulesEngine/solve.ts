import { addDays, daysBetween, dayTypeBucket, thursdayBeforeWeekOf, BLOCKING_AVAIL } from './shared';
import { evaluateEligibility } from './eligibility';
import { emptySolveState } from './genTypes';
import type {
  GenerationContext, SlotToFill, CandidateProvider, SolveState,
  SolutionPlan, PlacementSource,
} from './genTypes';

export function solve(ctx: GenerationContext): SolutionPlan {
  const plan: SolutionPlan = { assignments: [], unfilled: [] };
  const state = emptySolveState();

  // ── seed pre-existing assignments into state ──
  for (const seed of ctx.seedAssignments) {
    markAssigned(state, seed.slot_date, seed.provider_id);
    if (seed.shift_type_category === 'call') {
      incBucket(state, seed.provider_id, seed.derived_day_type, seed.shift_type_code);
      addCallDate(state, seed.provider_id, seed.slot_date);
    }
  }

  const RELIEF_CODES = ['D4', 'D5', 'D6', 'D7', 'D8', 'D9'];

  const providerById = new Map(ctx.providers.map(p => [p.id, p]));

  const record = (slot: SlotToFill, p: CandidateProvider, source: PlacementSource) => {
    markAssigned(state, slot.slot_date, p.id);
    if (slot.shift_type_category === 'call') {
      incBucket(state, p.id, slot.derived_day_type, slot.shift_type_code);
    }
    if (['C1', 'C2', 'C3'].includes(slot.shift_type_code)) {
      addCallDate(state, p.id, slot.slot_date);
    }
    state.handledSlotIds.add(slot.slot_id);
    plan.assignments.push({
      slot_id: slot.slot_id, slot_date: slot.slot_date,
      shift_type_code: slot.shift_type_code,
      shift_type_category: slot.shift_type_category,
      derived_day_type: slot.derived_day_type,
      provider_id: p.id, provider_name: p.short_display_name,
      existing_assignment_id: slot.existing_assignment_id, source,
    });
  };

  const tryFillDerived = (date: string, code: string, p: CandidateProvider) => {
    const target = ctx.slotIndex.get(date)?.get(code);
    if (!target) return;
    if (state.handledSlotIds.has(target.slot_id)) return;
    if (!evaluateEligibility(target, p, state, ctx, 'derived').eligible) return;
    record(target, p, 'd-chain');
  };

  const chainDFills = (slot: SlotToFill, p: CandidateProvider) => {
    const dt = slot.derived_day_type;
    if (dt === 'saturday') return;                       // weekend block handles it
    if (dt === 'sunday') {
      if (slot.shift_type_code === 'C1') {
        markAssigned(state, addDays(slot.slot_date, 1), p.id); // block Monday
      } else if (slot.shift_type_code === 'C2') {
        tryFillDerived(addDays(slot.slot_date, 1), 'D1', p);
      }
      return;
    }
    const twoDaysBefore = addDays(slot.slot_date, -2);
    const hadCallTwoDaysBefore =
      (state.callDatesByProvider.get(p.id) || []).includes(twoDaysBefore);
    const dayBefore = addDays(slot.slot_date, -1);
    if (slot.shift_type_code === 'C1') {
      if (!hadCallTwoDaysBefore) tryFillDerived(dayBefore, 'D2', p);
      markAssigned(state, addDays(slot.slot_date, 1), p.id); // post-call day off
    } else if (slot.shift_type_code === 'C2') {
      if (!hadCallTwoDaysBefore) tryFillDerived(dayBefore, 'D3', p);
      tryFillDerived(addDays(slot.slot_date, 1), 'D1', p);
    }
  };

  // ── pre-PTO Thursday pass (before main loop) ──
  // Build Thursday -> providers-with-PTO-that-week map.
  const prePtoByThursday = new Map<string, Set<string>>();
  for (const p of ctx.providers) {
    for (const a of ctx.availByPid.get(p.id) || []) {
      if (a.approval_status !== 'approved') continue;
      if (!BLOCKING_AVAIL.has(a.availability_type)) continue;
      const thu = thursdayBeforeWeekOf(a.start_date);
      if (!ctx.slotIndex.has(thu)) continue;
      const set = prePtoByThursday.get(thu) || new Set<string>();
      set.add(p.id);
      prePtoByThursday.set(thu, set);
    }
  }
  const tryPlacePrePto = (slot: SlotToFill | undefined, p: CandidateProvider): boolean => {
    if (!slot) return false;
    if (state.handledSlotIds.has(slot.slot_id)) return false;
    if (!evaluateEligibility(slot, p, state, ctx, 'call').eligible) return false;
    record(slot, p, 'pre-pto-thursday');
    chainDFills(slot, p);
    return true;
  };
  for (const [thuDate, pidSet] of prePtoByThursday) {
    const codeMap = ctx.slotIndex.get(thuDate);
    if (!codeMap) continue;
    const c1 = codeMap.get('C1');
    const c2 = codeMap.get('C2');
    const ranked = Array.from(pidSet).sort()
      .map(pid => providerById.get(pid))
      .filter((p): p is CandidateProvider => !!p);
    // A Thursday offers only C1 + C2, so at most two PTO-bound providers get a
    // pre-PTO placement here (first → C1, second → C2). A 3rd+ provider with PTO
    // the same week falls through to the main loop. See ALGORITHM.md §7.
    if (ranked[0]) { tryPlacePrePto(c1, ranked[0]) || tryPlacePrePto(c2, ranked[0]); }
    if (ranked[1]) { tryPlacePrePto(c1, ranked[1]) || tryPlacePrePto(c2, ranked[1]); }
  }

  // ── main construction loop ──
  for (const slot of ctx.slotsToFill) {
    if (state.handledSlotIds.has(slot.slot_id)) continue;
    // The main loop assigns CALL shifts only. In production loadGenerationContext
    // puts only call-category slots in slotsToFill; this guard makes that invariant
    // explicit and keeps derived (D-shift) slots out of the call-scoring path.
    if (slot.shift_type_category !== 'call') continue;

    const candidates = ctx.providers.filter(
      p => evaluateEligibility(slot, p, state, ctx, 'call').eligible,
    );
    if (candidates.length === 0) {
      plan.unfilled.push({
        slot_id: slot.slot_id, slot_date: slot.slot_date,
        shift_type_code: slot.shift_type_code, reason: 'No eligible providers',
      });
      continue;
    }

    const scored = candidates.map(p => {
      const k = `${dayTypeBucket(slot.derived_day_type)}|${slot.shift_type_code}`;
      const lifetime = (ctx.historicalAssignedByPid.get(p.id)?.get(k) || 0)
        + (state.bucketAssigned.get(`${p.id}|${k}`) || 0);
      return {
        p,
        ratio: lifetime / Math.max(p.fte_value, 0.01),
        recency: daysSinceLastCall(state, p.id, slot.slot_date),
      };
    }).sort((a, b) =>
      a.ratio - b.ratio ||
      b.recency - a.recency ||
      a.p.id.localeCompare(b.p.id),   // M5: stable final tiebreak
    );

    record(slot, scored[0].p, 'main-loop');
    chainDFills(slot, scored[0].p);

    // ── weekend block chain (H1 fix) ──
    if (slot.derived_day_type === 'saturday') {
      const sundayMap = ctx.slotIndex.get(addDays(slot.slot_date, 1));
      const fridayMap = ctx.slotIndex.get(addDays(slot.slot_date, -1));
      const chosen = scored[0].p;

      const chainAssign = (
        slotMap: Map<string, SlotToFill> | undefined, code: string,
      ) => {
        const target = slotMap?.get(code);
        if (!target) return;
        if (state.handledSlotIds.has(target.slot_id)) return;
        // H1 FIX: route through the canonical predicate. Call slots use the
        // 'call' gate (quota + weekend-call credential + adjacent PTO); the
        // Fri-D2 non-call fill uses 'derived'.
        const gate = target.shift_type_category === 'call' ? 'call' : 'derived';
        if (!evaluateEligibility(target, chosen, state, ctx, gate).eligible) return;
        record(target, chosen, 'weekend-chain');
        chainDFills(target, chosen);
      };

      if (slot.shift_type_code === 'C3') {
        chainAssign(sundayMap, 'C3');
      } else if (slot.shift_type_code === 'C1') {
        chainAssign(sundayMap, 'C2');
        chainAssign(fridayMap, 'C2');
      } else if (slot.shift_type_code === 'C2') {
        chainAssign(sundayMap, 'C1');
        chainAssign(fridayMap, 'D2');
      }
    }
  }

  // ── D4–D9 relief pass (H2 fix) ──
  const callTierPriority = (code: string) => code === 'C1' ? 0 : code === 'C2' ? 1 : 2;

  const providerCalls = new Map<string, Array<{ date: string; code: string }>>();
  const pushCall = (pid: string, date: string, code: string) => {
    if (!providerCalls.has(pid)) providerCalls.set(pid, []);
    providerCalls.get(pid)!.push({ date, code });
  };
  for (const a of plan.assignments) {
    if (['C1', 'C2', 'C3'].includes(a.shift_type_code)) pushCall(a.provider_id, a.slot_date, a.shift_type_code);
  }
  for (const seed of ctx.seedAssignments) {
    if (['C1', 'C2', 'C3'].includes(seed.shift_type_code)) pushCall(seed.provider_id, seed.slot_date, seed.shift_type_code);
  }
  for (const arr of providerCalls.values()) arr.sort((a, b) => a.date.localeCompare(b.date));

  const scheduleDates = Array.from(ctx.slotIndex.keys()).sort();
  for (const date of scheduleDates) {
    const codeMap = ctx.slotIndex.get(date);
    if (!codeMap) continue;
    const sampleD = codeMap.get('D4') || codeMap.get('D5');
    if (!sampleD) continue;
    const dt = sampleD.derived_day_type;
    if (dt !== 'weekday' && dt !== 'friday') continue;

    const available = ctx.providers.filter(
      p => evaluateEligibility(sampleD, p, state, ctx, 'derived').eligible,
    );
    const scored = available.map(p => {
      const nextCall = (providerCalls.get(p.id) || []).find(c => c.date > date);
      return {
        p,
        distance: nextCall ? daysBetween(date, nextCall.date) : Infinity,
        tier: nextCall ? callTierPriority(nextCall.code) : 99,
        recency: daysSinceLastCall(state, p.id, date),
      };
    }).sort((a, b) =>
      a.distance - b.distance || a.tier - b.tier ||
      a.recency - b.recency || a.p.id.localeCompare(b.p.id),
    );
    // Rank: soonest next call first (most needs relief), then call tier,
    // then most-recently-called (smallest recency) as a tiebreak, then id.

    let idx = 0;
    for (const code of RELIEF_CODES) {
      const slot = codeMap.get(code);
      if (!slot) continue;
      if (state.handledSlotIds.has(slot.slot_id)) continue;
      // Re-check the SPECIFIC slot: D4–D9 share date-level gates (already in
      // `scored`), but per-code credential allow/exclude lists differ. Advance
      // past any provider not eligible for this exact code.
      while (idx < scored.length
        && !evaluateEligibility(slot, scored[idx].p, state, ctx, 'derived').eligible) {
        idx++;
      }
      if (idx >= scored.length) break;
      record(slot, scored[idx].p, 'relief-order');
      idx++;
    }
  }

  return plan;
}

// ── pure state helpers (lifted from autoGenerate.ts:453-506) ──
function markAssigned(s: SolveState, date: string, pid: string) {
  if (!s.assignedOnDate.has(date)) s.assignedOnDate.set(date, new Set());
  s.assignedOnDate.get(date)!.add(pid);
}
function incBucket(s: SolveState, pid: string, dt: string, code: string) {
  const k = `${pid}|${dayTypeBucket(dt)}|${code}`;
  s.bucketAssigned.set(k, (s.bucketAssigned.get(k) || 0) + 1);
}
function addCallDate(s: SolveState, pid: string, date: string) {
  const list = s.callDatesByProvider.get(pid) || [];
  if (list.includes(date)) return;
  list.push(date); list.sort();
  s.callDatesByProvider.set(pid, list);
}
function daysSinceLastCall(s: SolveState, pid: string, date: string): number {
  const list = s.callDatesByProvider.get(pid) || [];
  let best = Infinity;
  for (const d of list) {
    if (d >= date) break;
    const gap = daysBetween(d, date);
    if (gap < best) best = gap;
  }
  return best;
}
