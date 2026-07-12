import { addDays, daysBetween, dayTypeBucket, buildPrePtoByThursday } from './shared';
import { evaluateEligibility } from './eligibility';
import { emptySolveState } from './genTypes';
import { CLASSIC_PATTERN, dayChainsFor, postCallBlockOffsets, blockChainsFor } from './callPattern';
import type { CallPatternDoc } from './callPattern';
import type {
  GenerationContext, SlotToFill, CandidateProvider, SolveState,
  SolutionPlan, PlacementSource, AssignmentExplanation, CandidateRejection,
  SolveOptions, SkippedDerived, ShiftTypeInfo,
} from './genTypes';

// Relief codes are derived from ctx.shiftTypes (relief_rank ordering). That map
// is stable across the optimizer's re-solves, so memoize on its identity; the
// no-shiftTypes fixtures use a constant fallback (nothing to cache).
const LEGACY_RELIEF_CODES = ['D4', 'D5', 'D6', 'D7', 'D8', 'D9'];
const reliefCodesCache = new WeakMap<Map<string, ShiftTypeInfo>, string[]>();
function reliefCodesFor(shiftTypes: Map<string, ShiftTypeInfo> | undefined): string[] {
  if (!shiftTypes) return LEGACY_RELIEF_CODES; // legacy fallback (no shiftTypes in ctx)
  let cached = reliefCodesCache.get(shiftTypes);
  if (!cached) {
    cached = [...shiftTypes.values()].filter(s => s.relief_rank != null)
      .sort((a, b) => a.relief_rank! - b.relief_rank!).map(s => s.code);
    reliefCodesCache.set(shiftTypes, cached);
  }
  return cached;
}

// solve() interprets the site's CallPatternDoc (ctx.callPattern ?? CLASSIC_PATTERN):
// blocks, dayChains, spans, placement passes and relief config are all data —
// there are NO structural shift-code literals here. The two remaining code
// literals are marked legacy fallbacks used only when ctx.shiftTypes is absent
// (pure fixtures). Behavior with the classic pattern is byte-identical to
// solveLegacy (golden-parity net) except five intentional fixes:
//   IF-1 seeded call blocks its post-call day  IF-2 relief D6+ reachability/rescan
//   IF-3 quota relaxation                       IF-4 skippedDerived reporting
//   IF-5 pending PTO drives the pre-PTO Thursday placement (spec §6.7)
export function solve(ctx: GenerationContext, opts: SolveOptions = {}): SolutionPlan {
  const plan: SolutionPlan = { assignments: [], unfilled: [], skippedDerived: [] };
  const skippedDerived = plan.skippedDerived!;

  const doc = ctx.callPattern ?? CLASSIC_PATTERN;
  const shiftInfo = (code: string) => ctx.shiftTypes?.get(code);
  const isOverlay = (code: string) => shiftInfo(code)?.is_overlay ?? false;
  const callRank = (code: string) =>
    shiftInfo(code)?.call_rank ?? (code === 'C1' ? 0 : code === 'C2' ? 1 : 2); // legacy fallback (no shiftTypes in ctx)
  const reliefCodes = reliefCodesFor(ctx.shiftTypes);

  // Opt-in in-house-first ordering (pattern doc callFillOrder: 'call_rank').
  // Consistent total order: the date-sequence key preserves the incoming
  // (weekend-first) date order from genContext, and callRank — with its
  // legacy C1/C2 fallback for null-ranked codes — breaks ties within each
  // date so in-house call fills first. Absent flag = untouched legacy order.
  // Only the main fill loop below consumes this list; every other pass keys
  // off dates.
  let slotsToFill = ctx.slotsToFill;
  if (doc.callFillOrder === 'call_rank') {
    const dateSeq = new Map<string, number>();
    for (const s of ctx.slotsToFill)
      if (!dateSeq.has(s.slot_date)) dateSeq.set(s.slot_date, dateSeq.size);
    slotsToFill = [...ctx.slotsToFill].sort((a, b) =>
      (dateSeq.get(a.slot_date)! - dateSeq.get(b.slot_date)!)
      || (callRank(a.shift_type_code) - callRank(b.shift_type_code)));
  }

  // Seed pre-existing assignments into state (shared with optimize's pre-gate).
  const state = seedSolveState(ctx, doc);

  const providerById = ctx.providerById ?? new Map(ctx.providers.map(p => [p.id, p]));

  const overrides = opts.callOverrides;
  // Resolve a call slot's override: undefined → not overridden; null → forced
  // provider ineligible (leave unfilled); provider → forced and eligible.
  const overrideFor = (slot: SlotToFill): CandidateProvider | null | undefined => {
    if (!overrides || !overrides.has(slot.slot_id)) return undefined;
    const p = providerById.get(overrides.get(slot.slot_id)!);
    if (!p) return null;
    return evaluateEligibility(slot, p, state, ctx, 'call').eligible ? p : null;
  };

  const record = (
    slot: SlotToFill, p: CandidateProvider, source: PlacementSource,
    explanation?: AssignmentExplanation,
  ) => {
    // Overlay placements do NOT consume the one-assignment-per-day budget.
    if (!isOverlay(slot.shift_type_code)) markAssigned(state, slot.slot_date, p.id);
    // Overlay call slots still count toward buckets and call recency — only the
    // one-assignment-per-day budget is exempt.
    if (slot.shift_type_category === 'call') {
      incBucket(state, p.id, slot.derived_day_type, slot.shift_type_code);
      addCallDate(state, p.id, slot.slot_date);
    }
    state.handledSlotIds.add(slot.slot_id);
    plan.assignments.push({
      slot_id: slot.slot_id, slot_date: slot.slot_date,
      shift_type_code: slot.shift_type_code,
      shift_type_category: slot.shift_type_category,
      derived_day_type: slot.derived_day_type,
      provider_id: p.id, provider_name: p.short_display_name,
      existing_assignment_id: slot.existing_assignment_id, source, explanation,
    });
  };

  // Main-loop scoring tuple: lowest lifetime bucket-ratio, then least-recently
  // called, then id. Shared by the main loop, spans, and quota relaxation.
  const scoreCall = (cands: CandidateProvider[], slot: SlotToFill) => {
    const k = `${dayTypeBucket(slot.derived_day_type)}|${slot.shift_type_code}`;
    return cands.map(p => {
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
      a.p.id.localeCompare(b.p.id),
    );
  };

  // ── derived (D-chain / span) fills — record every suppression (IF-4) ──
  const tryFillDerived = (date: string, code: string, p: CandidateProvider) => {
    const target = ctx.slotIndex.get(date)?.get(code);
    if (!target) { skippedDerived.push({ date, code, provider_id: p.id, reason: 'no-slot' }); return; }
    if (state.handledSlotIds.has(target.slot_id)) {
      skippedDerived.push({ date, code, provider_id: p.id, reason: 'already-handled' }); return;
    }
    const elig = evaluateEligibility(target, p, state, ctx, 'derived');
    if (!elig.eligible) {
      skippedDerived.push({ date, code, provider_id: p.id, reason: skipReasonFrom(elig.reason) });
      return;
    }
    record(target, p, 'd-chain');
  };

  // dayChains: per-code pre/post fills (links) and post-call blocks for the
  // provider who was just placed on `slot`.
  const applyDayChains = (slot: SlotToFill, p: CandidateProvider) => {
    for (const chain of dayChainsFor(doc, slot.shift_type_code, slot.derived_day_type)) {
      for (const link of chain.links ?? []) {
        if (link.unlessCallWithinDays != null
          && hadCallWithin(state, p.id, slot.slot_date, link.unlessCallWithinDays)) continue;
        tryFillDerived(addDays(slot.slot_date, link.offset), link.code, p);
      }
      for (const block of chain.blocks ?? []) {
        markAssigned(state, addDays(slot.slot_date, block.offset), p.id);
      }
    }
  };

  // blocks: same-provider multi-day chains anchored on the placed slot's day
  // type (classic Saturday weekend chain; proposed friday chain).
  const applyBlockChains = (slot: SlotToFill, chosen: CandidateProvider) => {
    const links = blockChainsFor(doc, slot.derived_day_type).get(slot.shift_type_code);
    if (!links) return;
    for (const link of links) {
      const target = ctx.slotIndex.get(addDays(slot.slot_date, link.offset))?.get(link.code);
      if (!target) continue;
      // IF-4: a suppressed NON-call chain fill must be recorded (invariant #4).
      // Call targets stay unrecorded — they fall through to the main loop and are
      // not dropped.
      if (state.handledSlotIds.has(target.slot_id)) {
        if (target.shift_type_category !== 'call') {
          skippedDerived.push({
            date: target.slot_date, code: target.shift_type_code,
            provider_id: chosen.id, reason: 'already-handled',
          });
        }
        continue;
      }
      if (overrides?.has(target.slot_id)) {
        const f = overrideFor(target);
        if (f) { record(target, f, 'weekend-chain'); applyDayChains(target, f); }
        continue; // overridden slot handled (placed if eligible, else left for main loop/unfilled)
      }
      // Call targets use the 'call' gate (quota + weekend-call cred + adjacent
      // PTO); non-call chain fills use 'derived'.
      const gate = target.shift_type_category === 'call' ? 'call' : 'derived';
      const elig = evaluateEligibility(target, chosen, state, ctx, gate);
      if (!elig.eligible) {
        if (target.shift_type_category !== 'call') {
          skippedDerived.push({
            date: target.slot_date, code: target.shift_type_code,
            provider_id: chosen.id, reason: skipReasonFrom(elig.reason),
          });
        }
        continue;
      }
      record(target, chosen, 'weekend-chain');
      applyDayChains(target, chosen);
    }
  };

  // ── configurable placement passes (pre-PTO Thursday, etc.) ──
  // Thursday -> providers with blocking PTO that week — PENDING included
  // (isBlockingAvailability, spec §6.7: pending blocks everywhere, so pending
  // also drives placement). genContext precomputes this; bare fixtures don't,
  // so fall back to the shared builder (identical predicate).
  const prePtoByThursday = ctx.prePtoByThursday
    ?? buildPrePtoByThursday(ctx.providers, ctx.availByPid, ctx.slotIndex);
  const tryPlacePrePto = (slot: SlotToFill | undefined, p: CandidateProvider): boolean => {
    if (!slot) return false;
    if (overrides?.has(slot.slot_id)) return false; // override authoritative; main loop handles it
    if (state.handledSlotIds.has(slot.slot_id)) return false;
    if (!evaluateEligibility(slot, p, state, ctx, 'call').eligible) return false;
    record(slot, p, 'pre-pto-thursday');
    applyDayChains(slot, p);
    return true;
  };
  for (const pass of doc.placementPasses) {
    if (pass.kind !== 'pre_pto' || !pass.enabled) continue;
    for (const [thuDate, pidSet] of prePtoByThursday) {
      const codeMap = ctx.slotIndex.get(thuDate);
      if (!codeMap) continue;
      const ranked = Array.from(pidSet).sort()
        .map(pid => providerById.get(pid))
        .filter((p): p is CandidateProvider => !!p);
      // Each PTO-bound provider (up to maxProviders) takes the first available
      // pass code (classic: C1 preferred, else C2). See ALGORITHM.md §7.
      for (const p of ranked.slice(0, pass.maxProviders)) {
        for (const code of pass.codes) {
          if (tryPlacePrePto(codeMap.get(code), p)) break;
        }
      }
    }
  }

  const scheduleDates = ctx.scheduleDates ?? Array.from(ctx.slotIndex.keys()).sort();
  const dayTypeOfDate = (date: string): string | undefined => {
    for (const s of ctx.slotIndex.get(date)?.values() ?? []) return s.derived_day_type;
    return undefined;
  };

  // ── spans: multi-day same-provider obligations (e.g. Neuro beeper) ──
  for (const span of doc.spans) {
    for (const date of scheduleDates) {
      if (dayTypeOfDate(date) !== span.anchorDayType) continue;
      const spanSlots: SlotToFill[] = [];
      for (const off of span.offsets) {
        const s = ctx.slotIndex.get(addDays(date, off))?.get(span.code);
        if (s && !state.handledSlotIds.has(s.slot_id)) spanSlots.push(s);
      }
      if (spanSlots.length === 0) continue;
      const candidates = ctx.providers.filter(p => spanSlots.every(
        s => evaluateEligibility(s, p, state, ctx,
          s.shift_type_category === 'call' ? 'call' : 'derived').eligible));
      if (candidates.length === 0) {
        for (const s of spanSlots) {
          plan.unfilled.push({
            slot_id: s.slot_id, slot_date: s.slot_date,
            shift_type_code: s.shift_type_code, shift_type_category: s.shift_type_category,
            reason: 'No provider can cover full span',
          });
        }
        continue;
      }
      const winner = scoreCall(candidates, spanSlots[0])[0].p;
      for (const s of spanSlots) { record(s, winner, 'span'); applyDayChains(s, winner); }
    }
  }

  // ── main construction loop (CALL slots only) ──
  for (const slot of slotsToFill) {
    if (state.handledSlotIds.has(slot.slot_id)) continue;
    if (slot.shift_type_category !== 'call') continue;

    const forced = overrideFor(slot);
    if (forced === null) {
      plan.unfilled.push({
        slot_id: slot.slot_id, slot_date: slot.slot_date,
        shift_type_code: slot.shift_type_code, shift_type_category: slot.shift_type_category,
        reason: 'Forced provider ineligible',
      });
      continue;
    }
    if (forced) {
      record(slot, forced, 'main-loop');
      applyDayChains(slot, forced);
      applyBlockChains(slot, forced);
      continue;
    }

    // Single eligibility sweep: capture each provider's result once, reuse it
    // for both candidate selection and (if none) rejection reporting.
    const sweep = ctx.providers.map(p => ({ p, r: evaluateEligibility(slot, p, state, ctx, 'call') }));
    const candidates = sweep.filter(x => x.r.eligible).map(x => x.p);

    if (candidates.length === 0) {
      const rejections = sweep.map(x => x.r.reason ?? 'group-mismatch');
      // IF-3 quota relaxation: when every sweep rejection is 'bucket-quota',
      // place the lowest-lifetime-ratio provider anyway — but 'bucket-quota'
      // is only the FIRST failure (the quota gate runs before credentials/
      // adjacent-PTO/availability in evaluateEligibility), so re-gate with
      // the quota waived ('call-no-quota') and relax only within that set.
      // Relaxation may waive the quota, never a safety gate (invariant 2).
      if (rejections.length > 0 && rejections.every(r => r === 'bucket-quota')) {
        const relaxSweep = ctx.providers.map(p => ({
          p, r: evaluateEligibility(slot, p, state, ctx, 'call-no-quota'),
        }));
        const relaxable = relaxSweep.filter(x => x.r.eligible).map(x => x.p);
        if (relaxable.length > 0) {
          const winner = scoreCall(relaxable, slot)[0];
          record(slot, winner.p, 'quota-relaxed', {
            ratioAtAssignment: winner.ratio,
            daysSinceLastCall: Number.isFinite(winner.recency) ? winner.recency : null,
            competingCandidates: relaxable.length,
          });
          applyDayChains(slot, winner.p);
          applyBlockChains(slot, winner.p);
          continue;
        }
        // Nobody is placeable even with the quota waived. Report the REAL
        // blockers (a quota-only rejection stays 'bucket-quota').
        plan.unfilled.push({
          slot_id: slot.slot_id, slot_date: slot.slot_date,
          shift_type_code: slot.shift_type_code, shift_type_category: slot.shift_type_category,
          reason: 'No eligible providers',
          candidates: relaxSweep.map(x => ({
            provider_id: x.p.id, provider_name: x.p.short_display_name,
            reason: x.r.reason ?? 'bucket-quota',
          })),
        });
        continue;
      }
      const candidateReasons: CandidateRejection[] = sweep.map(x => ({
        provider_id: x.p.id, provider_name: x.p.short_display_name,
        reason: x.r.reason ?? 'group-mismatch',
      }));
      plan.unfilled.push({
        slot_id: slot.slot_id, slot_date: slot.slot_date,
        shift_type_code: slot.shift_type_code, shift_type_category: slot.shift_type_category,
        reason: 'No eligible providers', candidates: candidateReasons,
      });
      continue;
    }

    const scored = scoreCall(candidates, slot);
    const winner = scored[0];
    record(slot, winner.p, 'main-loop', {
      ratioAtAssignment: winner.ratio,
      daysSinceLastCall: Number.isFinite(winner.recency) ? winner.recency : null,
      competingCandidates: candidates.length,
    });
    applyDayChains(slot, winner.p);
    applyBlockChains(slot, winner.p);
  }

  // ── relief pass (codes + day types from the pattern; IF-2 fixes) ──
  if (doc.reliefPass?.enabled) {
    const reliefDayTypes = doc.reliefPass.dayTypes as string[];
    // "Next call" per provider, from this block's assignments + seeds (any call
    // category, not a code literal).
    const providerCalls = new Map<string, Array<{ date: string; code: string }>>();
    const pushCall = (pid: string, date: string, code: string) => {
      if (!providerCalls.has(pid)) providerCalls.set(pid, []);
      providerCalls.get(pid)!.push({ date, code });
    };
    for (const a of plan.assignments) if (a.shift_type_category === 'call') pushCall(a.provider_id, a.slot_date, a.shift_type_code);
    for (const seed of ctx.seedAssignments) if (seed.shift_type_category === 'call') pushCall(seed.provider_id, seed.slot_date, seed.shift_type_code);
    for (const arr of providerCalls.values()) arr.sort((a, b) => a.date.localeCompare(b.date));

    for (const date of scheduleDates) {
      const codeMap = ctx.slotIndex.get(date);
      if (!codeMap) continue;
      // IF-2: sample from ANY open relief slot (not just D4/D5) so dates whose
      // only relief slots are D6-D9 are no longer skipped.
      const sampleD = reliefCodes.map(c => codeMap.get(c)).find((s): s is SlotToFill => !!s);
      if (!sampleD) continue;
      if (!reliefDayTypes.includes(sampleD.derived_day_type)) continue;

      const available = ctx.providers.filter(
        p => evaluateEligibility(sampleD, p, state, ctx, 'derived').eligible);
      const scored = available.map(p => {
        const nextCall = (providerCalls.get(p.id) || []).find(c => c.date > date);
        return {
          p,
          distance: nextCall ? daysBetween(date, nextCall.date) : Infinity,
          tier: nextCall ? callRank(nextCall.code) : 99,
          recency: daysSinceLastCall(state, p.id, date),
        };
      }).sort((a, b) =>
        a.distance - b.distance || a.tier - b.tier ||
        a.recency - b.recency || a.p.id.localeCompare(b.p.id),
      );
      // Rank: soonest next call (most needs relief), then call tier, then
      // most-recently-called, then id.

      for (const code of reliefCodes) {
        const slot = codeMap.get(code);
        if (!slot) continue;
        if (state.handledSlotIds.has(slot.slot_id)) continue;
        // IF-2: rescan from rank 0 per code — skip anyone already placed this
        // date or ineligible for THIS specific slot (per-code credential lists
        // differ). A provider skipped for one code is reconsidered for later ones.
        const pick = scored.find(s => !state.assignedOnDate.get(date)?.has(s.p.id)
          && evaluateEligibility(slot, s.p, state, ctx, 'derived').eligible);
        if (!pick) {
          plan.unfilled.push({
            slot_id: slot.slot_id, slot_date: slot.slot_date,
            shift_type_code: slot.shift_type_code, shift_type_category: slot.shift_type_category,
            reason: 'No eligible relief provider',
          });
          continue;
        }
        record(slot, pick.p, 'relief-order');
      }
    }
  }

  return plan;
}

// Seed pre-existing assignments into a fresh SolveState — exactly what solve()
// starts from before ANY placement pass. Exported for the optimizer's
// eligibility pre-gate: because solve() only ever ADDS to this state, a
// provider ineligible against it is ineligible at every later point in every
// re-solve, no matter what call overrides the trial forces.
export function seedSolveState(ctx: GenerationContext, doc: CallPatternDoc): SolveState {
  const state = emptySolveState();
  const isOverlay = (code: string) => ctx.shiftTypes?.get(code)?.is_overlay ?? false;
  for (const seed of ctx.seedAssignments) {
    // Overlay seeds do NOT consume the one-assignment-per-day budget (mirrors
    // record()); the post-call block offsets below STILL apply unconditionally.
    if (!isOverlay(seed.shift_type_code)) markAssigned(state, seed.slot_date, seed.provider_id);
    if (seed.shift_type_category === 'call') {
      incBucket(state, seed.provider_id, seed.derived_day_type, seed.shift_type_code);
      addCallDate(state, seed.provider_id, seed.slot_date);
    }
    // IF-1: a seeded call blocks its pattern post-call day(s) before solve runs,
    // so the same provider can't be scored onto the blocked next day.
    for (const off of postCallBlockOffsets(doc, seed.shift_type_code, seed.derived_day_type)) {
      markAssigned(state, addDays(seed.slot_date, off), seed.provider_id);
    }
  }
  return state;
}

// Map an eligibility rejection reason to a skippedDerived reason.
function skipReasonFrom(reason: string | undefined): SkippedDerived['reason'] {
  if (reason === 'availability-blocked' || reason === 'weekend-adjacent-pto') return 'pto';
  if (reason === 'cross-site') return 'cross-site';
  if (reason === 'same-date') return 'occupied';
  return 'ineligible';
}

// ── pure state helpers ──
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
// Did the provider have a call within `n` days BEFORE `date`? Generalizes the
// legacy "had a call exactly two days before" suppression check.
// NOTE: wider than legacy's exact-gap check (gap ∈ 1..n, not gap === n). Parity
// holds because classic uses this only on offset:-1 links where gap===1 is masked
// by the same-date guard — keep in mind for positive-offset links.
function hadCallWithin(s: SolveState, pid: string, date: string, n: number): boolean {
  for (const d of s.callDatesByProvider.get(pid) || []) {
    const gap = daysBetween(d, date);
    if (gap > 0 && gap <= n) return true;
  }
  return false;
}
