import { addDays, isActiveNoCallRequest } from './shared';
import { evaluateEligibility } from './eligibility';
import { computeObligations } from './obligation';
import { computeSequenceOwnedSlotIds } from './sequenceOwnership';
import { exceedsWorkDayCap, creditsAsWorkedAvailability } from './workDays';
import {
  emptySolveState, markAssigned, markBlocked, creditWorkDay,
  incBucket, addCallDate,
} from './solveState';
import { CLASSIC_PATTERN, postCallBlockOffsets } from './callPattern';
import type { CallPatternDoc } from './callPattern';
import {
  record, overrideFor, scoreCall, applyDayChains, applyBlockChains,
  capRoom, chainCallNeeds, noteViolation, buildProviderCalls, pushUnfilled,
} from './solveKernel';
import type { SolverRun } from './solveKernel';
import { runPrePtoPass } from './passes/prePto';
import { runSpansPass } from './passes/spans';
import { runReliefPass } from './passes/relief';
import { runMopUpPass } from './passes/mopUp';
import type {
  GenerationContext, SolveState,
  SolutionPlan, CandidateRejection,
  SolveOptions, ShiftTypeInfo, SlotToFill,
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

// Sequence-owned slot ids are a pure function of (doc, slotIndex) — two
// objects that are IDENTICAL across all of optimize()'s thousands of
// re-solves — so memoize on their identities (same idiom as reliefCodesCache;
// the inner doc check guards the rare same-slotIndex/different-doc caller).
// Consumers only read the set (`.has`), never mutate it, so sharing one Set
// across re-solves is behavior-identical by construction.
const sequenceOwnedCache = new WeakMap<
  Map<string, Map<string, SlotToFill>>,
  { doc: CallPatternDoc; owned: Set<string> }
>();
function sequenceOwnedFor(
  doc: CallPatternDoc,
  slotIndex: Map<string, Map<string, SlotToFill>>,
): Set<string> {
  const hit = sequenceOwnedCache.get(slotIndex);
  if (hit && hit.doc === doc) return hit.owned;
  const owned = computeSequenceOwnedSlotIds(doc, slotIndex);
  sequenceOwnedCache.set(slotIndex, { doc, owned });
  return owned;
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
//
// Structure (2026-07-20 decomposition): solve() builds a SolverRun (bundled
// inputs + mutable products) and orchestrates the passes; the placement
// kernel (record / chains / scoring) lives in solveKernel.ts.
export function solve(ctx: GenerationContext, opts: SolveOptions = {}): SolutionPlan {
  const plan: SolutionPlan = {
    assignments: [], unfilled: [], skippedDerived: [], chainAnchorSlotIds: [],
  };

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

  // ── sequence-owned slots (2026-07-17, live bug: 27 violating rows) ──
  // Slots the ACTIVE pattern doc could target as a chain link (dayChains /
  // block-chain links — computeSequenceOwnedSlotIds, single home). They belong
  // to the chain's provider and NOBODY else: when the chain breaks (source
  // call unfilled, holder blocked next day) they stay UNASSIGNED and the
  // orphan is REPORTED — the relief pass and the mop-up sweep below must
  // never hand them out. Chain fills (applyDayChains/applyBlockChains),
  // sequenceAutoFill and seeds remain the only legitimate writers. Computed
  // unconditionally (pure, pattern-data-driven): under the classic pattern no
  // relief code is ever a chain target, so parity-era fixtures are untouched.
  // Memoized across optimizer re-solves (sequenceOwnedFor above).
  const sequenceOwnedSlotIds = sequenceOwnedFor(doc, ctx.slotIndex);

  const providerById = ctx.providerById ?? new Map(ctx.providers.map(p => [p.id, p]));

  // ── FTE working-days cap (2026-07-17) ──
  // budget present ⇒ every WEEKDAY placement credits a worked day and the cap
  // binds (eligibility gate). Absent ⇒ nothing here fires, byte-identical.
  const budget = ctx.workDayBudget;
  // Would placing pid on `date` be refused by the cap? Mirrors the eligibility
  // gate; used to re-apply the cap inside quota relaxation (which runs on the
  // cap-waiving 'call-no-quota' gate).
  const workDayCapped = (pid: string, date: string): boolean => {
    if (!budget) return false;
    const b = budget.byProvider.get(pid);
    return !!b && exceedsWorkDayCap(date, budget.workingDaySet, state.creditedWorkDays.get(pid), b.required);
  };

  // ── no-call request soft avoidance (2026-07-17) ──
  // LIVE (non-dismissed) no_call_request entries per provider
  // (isActiveNoCallRequest — the same single-home predicate validation's
  // soft flag uses). NOT a gate: a live request on the slot date drops the
  // candidate a SORT TIER in scoreCall, so a requester is chosen only when
  // no unpenalized candidate passes the safety gates ("grant if possible" —
  // explicitly SOFT, avoid but allow). With zero live request rows every
  // tier is 0 and the ordering tuple degenerates to the pre-change
  // ratio/recency/id sort — byte-identical plans (pinned against
  // fillAllPlan.golden.json in obligatoryMode + noCallRequests tests).
  const noCallByPid = new Map<string, Array<{ start_date: string; end_date: string }>>();
  for (const [pid, entries] of ctx.availByPid) {
    const live = entries.filter(isActiveNoCallRequest);
    if (live.length > 0) noCallByPid.set(pid, live);
  }

  // ── obligatory fill mode (2026-07-17) ──
  // Cap each provider's CALL assignments at their rounded TOTAL obligation
  // (obligation.ts). Seeded/manual calls consume the cap too — the obligation
  // is the provider's total call load for the block, however it got there.
  // Everything below is gated on the flag: fillMode 'all' (default) is the
  // pre-change engine byte for byte (pinned in obligatoryMode.test.ts).
  const obligatory = opts.fillMode === 'obligatory';
  const obligationByPid = obligatory ? computeObligations(ctx) : null;
  const callCountByPid = new Map<string, number>();
  if (obligatory) {
    for (const seed of ctx.seedAssignments) {
      if (seed.shift_type_category === 'call') {
        callCountByPid.set(seed.provider_id, (callCountByPid.get(seed.provider_id) || 0) + 1);
      }
    }
  }

  // The bundled run context every kernel function and pass consumes.
  // waivedLinkKeys: (date|code) keys of chain links WAIVED by
  // unlessCallWithinDays — the anchor filled but the link deliberately did
  // not fire (the holder had a recent call). NOT a suppression event — no
  // skippedDerived record (that would repurpose invariant-4's vocabulary and
  // shift the golden plan pin) — but the mop-up needs it to report the open
  // slot honestly: the chain source is NOT unfilled and no link was severed.
  const run: SolverRun = {
    ctx, doc, plan, state, budget,
    isOverlay, callRank, reliefCodes,
    obligatory, obligationByPid, callCountByPid,
    noCallByPid, noCallViolated: new Map<string, number>(),
    waivedLinkKeys: new Set<string>(),
    sequenceOwnedSlotIds, providerById,
    overrides: opts.callOverrides,
    skippedDerived: plan.skippedDerived!,
    chainAnchorSlotIds: plan.chainAnchorSlotIds!,
    providerCalls: new Map(),
  };
  // Fair denial seeding: seeded/manual calls on requested dates count — that
  // provider has already absorbed a denial this block.
  for (const seed of ctx.seedAssignments) {
    if (seed.shift_type_category === 'call') noteViolation(run, seed.provider_id, seed.slot_date);
  }

  // Configurable placement passes (pre-PTO Thursday — passes/prePto.ts, §7),
  // then spans (multi-day same-provider obligations — passes/spans.ts).
  runPrePtoPass(run);

  const scheduleDates = ctx.scheduleDates ?? Array.from(ctx.slotIndex.keys()).sort();
  runSpansPass(run, scheduleDates);

  // ── main construction loop (CALL slots only) ──
  for (const slot of slotsToFill) {
    if (state.handledSlotIds.has(slot.slot_id)) continue;
    if (slot.shift_type_category !== 'call') continue;

    const forced = overrideFor(run, slot);
    if (forced === null) {
      pushUnfilled(run, slot, 'Forced provider ineligible');
      continue;
    }
    if (forced) {
      record(run, slot, forced, 'main-loop');
      applyDayChains(run, slot, forced);
      applyBlockChains(run, slot, forced);
      continue;
    }

    // Single eligibility sweep: capture each provider's result once, reuse it
    // for both candidate selection and (if none) rejection reporting.
    const sweep = ctx.providers.map(p => ({ p, r: evaluateEligibility(slot, p, state, ctx, 'call') }));
    const eligible = sweep.filter(x => x.r.eligible).map(x => x.p);

    // Obligatory mode: charge the whole prospective block against the cap
    // upfront (1 for this slot + its live call-category chain links). When
    // nobody has room, the slot is DELIBERATELY left open — no relaxation,
    // reason 'obligation-cap' when the cap was the binding constraint.
    const candidates = obligatory
      ? eligible.filter(p => capRoom(run, p.id) >= 1 + chainCallNeeds(run, slot))
      : eligible;
    if (obligatory && candidates.length === 0) {
      pushUnfilled(run, slot,
        eligible.length > 0 ? 'obligation-cap' : 'No eligible providers',
        sweep.map(x => ({
          provider_id: x.p.id, provider_name: x.p.short_display_name,
          reason: x.r.eligible ? 'obligation-cap' as const : (x.r.reason ?? 'bucket-quota'),
        })));
      continue;
    }

    if (candidates.length === 0) {
      // IF-3 quota relaxation, UNCONDITIONAL since 2026-07-16: quotas must
      // never leave a fillable slot empty — only hard clinical blocks may.
      // The old trigger (`every rejection === 'bucket-quota'`) was poisoned by
      // a single hard-blocked provider in the sweep (one placed C1's post-call
      // block, one PTO…), permanently stranding slots that quota-blocked-but-
      // otherwise-eligible providers could legally take. Whenever the full
      // sweep is empty, re-gate with ONLY the bucket quota waived
      // ('call-no-quota'): every safety gate still runs (PTO incl. pending,
      // same-date/post-call, cross-site, weekday availability, credentials,
      // adjacent-PTO weekend rules). Relaxation may waive the quota, never a
      // safety gate (invariant 2).
      const relaxSweep = ctx.providers.map(p => ({
        p, r: evaluateEligibility(slot, p, state, ctx, 'call-no-quota'),
      }));
      const relaxable = relaxSweep.filter(x => x.r.eligible).map(x => x.p);
      // Re-apply the workdays cap here: eligibility waives it under
      // 'call-no-quota' (so optimizer pins never self-reject), but quota
      // relaxation must still honor it — a slot left open by the cap is
      // legitimate, exactly like obligatory mode's obligation-cap. Weekend /
      // holiday slots are never capped (workDayCapped short-circuits).
      const relaxableUncapped = budget
        ? relaxable.filter(p => !workDayCapped(p.id, slot.slot_date))
        : relaxable;
      if (relaxableUncapped.length > 0) {
        const winner = scoreCall(run, relaxableUncapped, slot)[0];
        record(run, slot, winner.p, 'quota-relaxed', {
          ratioAtAssignment: winner.ratio,
          daysSinceLastCall: Number.isFinite(winner.recency) ? winner.recency : null,
          competingCandidates: relaxableUncapped.length,
        });
        applyDayChains(run, slot, winner.p);
        applyBlockChains(run, slot, winner.p);
        continue;
      }
      // Nobody is placeable even with the quota waived. When the ONLY reason the
      // relaxable set emptied is the workdays cap (relaxable existed pre-filter,
      // all capped), the binding reason is 'workdays-cap' — otherwise report the
      // REAL per-candidate blockers (a quota-only rejection stays 'bucket-quota',
      // though such a provider would have been relaxable — belt-and-suspenders).
      const capBound = !!budget && relaxable.length > 0;
      const candidateReasons: CandidateRejection[] = relaxSweep.map(x => ({
        provider_id: x.p.id, provider_name: x.p.short_display_name,
        reason: capBound && x.r.eligible ? 'workdays-cap' : (x.r.reason ?? 'bucket-quota'),
      }));
      pushUnfilled(run, slot,
        capBound ? 'workdays-cap' : 'No eligible providers', candidateReasons);
      continue;
    }

    const scored = scoreCall(run, candidates, slot);
    const winner = scored[0];
    record(run, slot, winner.p, 'main-loop', {
      ratioAtAssignment: winner.ratio,
      daysSinceLastCall: Number.isFinite(winner.recency) ? winner.recency : null,
      competingCandidates: candidates.length,
    });
    applyDayChains(run, slot, winner.p);
    applyBlockChains(run, slot, winner.p);
  }

  // "Next call" per provider (solveKernel.buildProviderCalls) — built once
  // after every call placement pass; shared by the relief pass and the mop-up
  // sweep (both place only NON-call slots, so the map never goes stale
  // between them).
  buildProviderCalls(run);

  // Relief pass (passes/relief.ts, §10 + IF-2 fixes), then the mop-up sweep
  // for orphaned call-engine-owned day slots (passes/mopUp.ts, §10.5 — incl.
  // the sequence-orphan reporting).
  runReliefPass(run, scheduleDates);
  runMopUpPass(run, scheduleDates);

  return plan;
}

// Seed pre-existing assignments into a fresh SolveState — exactly what solve()
// starts from before ANY placement pass. Exported for the optimizer's
// eligibility pre-gate: because solve() only ever ADDS to this state, a
// provider ineligible against it is ineligible at every later point in every
// re-solve, no matter what call overrides the trial forces.
export function seedSolveState(ctx: GenerationContext, doc: CallPatternDoc): SolveState {
  const state = emptySolveState();
  const budget = ctx.workDayBudget;
  const isOverlay = (code: string) => ctx.shiftTypes?.get(code)?.is_overlay ?? false;
  for (const seed of ctx.seedAssignments) {
    // Overlay seeds do NOT consume the one-assignment-per-day budget (mirrors
    // record()); the post-call block offsets below STILL apply unconditionally.
    if (!isOverlay(seed.shift_type_code)) markAssigned(state, seed.slot_date, seed.provider_id);
    if (seed.shift_type_category === 'call') {
      incBucket(state, seed.provider_id, seed.derived_day_type, seed.shift_type_code);
      addCallDate(state, seed.provider_id, seed.slot_date);
    }
    // Working-days credit: a seeded/manual assignment on a working day is a
    // worked day (any category — a seeded day shift counts too).
    creditWorkDay(state, budget, seed.provider_id, seed.slot_date);
    // IF-1: a seeded call blocks its pattern post-call day(s) before solve runs,
    // so the same provider can't be scored onto the blocked next day. Also
    // recorded in blockedOnDate so OVERLAY placements (which skip the
    // assignedOnDate budget) still respect the blocked day (invariant 1 —
    // review finding 2).
    for (const off of postCallBlockOffsets(doc, seed.shift_type_code, seed.derived_day_type)) {
      const blockedDate = addDays(seed.slot_date, off);
      markAssigned(state, blockedDate, seed.provider_id);
      markBlocked(state, blockedDate, seed.provider_id);
      // The post-call rest day on a working day is credited (mandated rest is
      // earned), mirroring applyDayChains.
      creditWorkDay(state, budget, seed.provider_id, blockedDate);
    }
  }
  // ICU-week weekdays credit as worked (the provider is working the ICU
  // elsewhere / on earned ICU post-call rest). These come from availability
  // rows, not placements, so they are seeded up front. Only when a budget is
  // present (bare fixtures never carry ICU credit).
  if (budget) {
    for (const p of ctx.providers) {
      for (const a of ctx.availByPid.get(p.id) ?? []) {
        if (!creditsAsWorkedAvailability(a)) continue;
        for (const d of budget.workingDaySet) {
          if (a.start_date <= d && d <= a.end_date) creditWorkDay(state, budget, p.id, d);
        }
      }
    }
  }
  return state;
}
