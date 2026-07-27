import { addDays, datesOverlap, isActiveNoCallRequest, isActiveCallRequest } from './shared';
import { evaluateEligibility } from './eligibility';
import { computeObligations } from './obligation';
import { computeSequenceOwnedSlotIds } from './sequenceOwnership';
import { exceedsWorkDayCap, creditsAsWorkedAvailability } from './workDays';
import {
  emptySolveState, markAssigned, markBlocked, creditWorkDay,
  incBucketBy, addCallDate,
} from './solveState';
import { callBurdenWeight, parentCallCodeOf } from '@/lib/callBurden';
import { CLASSIC_PATTERN, postCallBlockOffsets, dayChainsFor } from './callPattern';
import type { CallPatternDoc } from './callPattern';
import {
  record, overrideFor, scoreCall, applyDayChains, applyBlockChains,
  capRoom, chainCallNeeds, noteViolation, noteGrant, buildProviderCalls, pushUnfilled,
  admitsUnderCallCaps, preferScenarioChainClean,
} from './solveKernel';
import { mergedCallCapsForCtx, tallyCallsByPidCode } from './providerCaps';
import type { SolverRun } from './solveKernel';
import { runPrePtoPass } from './passes/prePto';
import { runSpansPass } from './passes/spans';
import { runReliefPass } from './passes/relief';
import { runMopUpPass } from './passes/mopUp';
import type {
  GenerationContext, SolveState,
  SolutionPlan, CandidateRejection,
  SolveOptions, ShiftTypeInfo, SlotToFill,
  AwaitingContinueSlot,
} from './genTypes';

// Weekend-only fill scope (FillMode 'weekend-only', 2026-07-21): the day
// types the main loop attempts. Holiday day types are deliberately OUT —
// the staged Continue run ('all') handles them.
const WEEKEND_ONLY_DAY_TYPES = new Set(['saturday', 'sunday', 'friday']);

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

  // ── call-request soft preference (2026-07-22) ──
  // MIRROR of the no-call tier: LIVE (non-dismissed) call_request entries per
  // provider (isActiveCallRequest — the same single-home predicate the grant
  // report uses). NOT a gate-waiver: a live request on the slot date LIFTS
  // the candidate a sort tier in scoreCall (preferred, before tier 0), so a
  // requester wins call slots they already pass every safety gate, quota,
  // cap and fill-mode rule for. With zero live call_request rows the map and
  // the contradiction set below are empty, every new branch is inert and the
  // plan is byte-identical (pinned against fillAllPlan.golden.json in
  // callRequests.test.ts).
  const callReqByPid = new Map<string, Array<{ start_date: string; end_date: string }>>();
  for (const [pid, entries] of ctx.availByPid) {
    const live = entries.filter(isActiveCallRequest);
    if (live.length > 0) callReqByPid.set(pid, live);
  }

  const scheduleDates = ctx.scheduleDates ?? Array.from(ctx.slotIndex.keys()).sort();

  // Contradictory requests: a provider with BOTH a live call request and a
  // live no-call request covering the same block date asked for opposite
  // things — treat the date as NEITHER (excluded from both tiers, both
  // fairness counters and the grant reports) and warn ONCE per provider on
  // plan.requestWarnings (lazily materialized so request-free plans stay
  // byte-identical to the golden pin). Deterministic id order.
  const contraReqDates = new Map<string, Set<string>>();
  for (const pid of [...callReqByPid.keys()].sort()) {
    const noCall = noCallByPid.get(pid);
    if (!noCall) continue;
    const callReq = callReqByPid.get(pid)!;
    const dates = scheduleDates.filter(d =>
      callReq.some(e => datesOverlap(e.start_date, e.end_date, d))
      && noCall.some(e => datesOverlap(e.start_date, e.end_date, d)));
    if (dates.length === 0) continue;
    contraReqDates.set(pid, new Set(dates));
    const name = providerById.get(pid)?.short_display_name ?? pid;
    (plan.requestWarnings ??= []).push(
      `Contradictory requests: ${name} has both a call request and a no-call request on ${dates.join(', ')} — treated as neither.`);
  }

  // ── obligatory fill mode (2026-07-17) ──
  // Cap each provider's CALL assignments at their rounded TOTAL obligation
  // (obligation.ts). Seeded/manual calls consume the cap too — the obligation
  // is the provider's total call load for the block, however it got there.
  // Everything below is gated on the flag: fillMode 'all' (default) is the
  // pre-change engine byte for byte (pinned in obligatoryMode.test.ts).
  const obligatory = opts.fillMode === 'obligatory';
  // ── weekend-only fill mode (2026-07-21, staged weekend fill) ──
  // Main loop attempts ONLY Sat/Sun/Fri call slots; out-of-scope call slots
  // land in plan.awaitingContinue (deferred, NOT failed). Chains from weekend
  // placements are never scope-clipped. The weekday-targeted pre-PTO pass and
  // the relief/mop-up sweeps are skipped whole — they belong to the Continue
  // run, which is an ordinary 'all' generation over the committed weekend
  // placements as seeds. Quota/scoring semantics are IDENTICAL to 'all'
  // (relaxation enabled, no obligation caps — modes never compose in v1).
  // plan.awaitingContinue is only materialized here so the fill-all golden
  // JSON pin (fillAllPlan.golden.json) stays byte-identical.
  const weekendOnly = opts.fillMode === 'weekend-only';
  const awaitingContinue: AwaitingContinueSlot[] | null = weekendOnly ? [] : null;
  if (awaitingContinue) plan.awaitingContinue = awaitingContinue;
  const obligationByPid = obligatory ? computeObligations(ctx) : null;
  // Segment seeds (call splits, 2026-07-22) consume the obligation cap and the
  // per-code call caps at their fractional weight, under the PARENT code —
  // whole-call seeds keep weight 1 / their own code, byte-identical.
  const seedWeight = (code: string) => callBurdenWeight(shiftInfo(code));
  const callCountByPid = new Map<string, number>();
  if (obligatory) {
    for (const seed of ctx.seedAssignments) {
      if (seed.shift_type_category === 'call') {
        callCountByPid.set(seed.provider_id,
          (callCountByPid.get(seed.provider_id) || 0) + seedWeight(seed.shift_type_code));
      }
    }
  }

  // ── provider call caps (2026-07-22, patch34 provider_limits; generalized
  //    2026-07-26 with the scenario per-(bucket,code)/NEURO/either-or keys) ──
  // HARD CEILINGS for auto-generation, in EVERY fill mode. null when neither
  // the schedule nor the scenario states any cap — every cap branch below and
  // in the kernel/passes is then inert, byte-identical to the pre-limits
  // engine (blank-fallback pin). Seeds consume the caps up front (weighted,
  // parent-mapped, all key kinds — tallyCallsByPidCode is the one tally
  // home); record() maintains the tally for every real call placement.
  const scenario = ctx.scenario ?? null;
  const callCaps = mergedCallCapsForCtx(ctx);
  const callCodeTally = callCaps
    ? tallyCallsByPidCode([], ctx.seedAssignments, ctx.shiftTypes, scenario)
    : new Map<string, number>();

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
    callCaps, callCodeTally,
    scenario, tieBreakSeed: opts.tieBreakSeed ?? 0,
    noCallByPid, noCallViolated: new Map<string, number>(),
    callReqByPid, callReqGranted: new Map<string, number>(), contraReqDates,
    waivedLinkKeys: new Set<string>(),
    sequenceOwnedSlotIds, providerById,
    overrides: opts.callOverrides,
    skippedDerived: plan.skippedDerived!,
    chainAnchorSlotIds: plan.chainAnchorSlotIds!,
    providerCalls: new Map(),
  };
  // Fair denial seeding: seeded/manual calls on requested dates count — that
  // provider has already absorbed a denial this block. Fair GRANT seeding
  // mirrors it: a seeded call on a live call-request date is a grant already
  // received.
  for (const seed of ctx.seedAssignments) {
    if (seed.shift_type_category === 'call') {
      noteViolation(run, seed.provider_id, seed.slot_date);
      noteGrant(run, seed.provider_id, seed.slot_date);
    }
  }

  // Configurable placement passes (pre-PTO Thursday — passes/prePto.ts, §7),
  // then spans (multi-day same-provider obligations — passes/spans.ts).
  // Weekend-only skips pre-PTO (it targets a weekday Thursday — the Continue
  // run places it) but KEEPS spans: like chains, a span is a structural
  // same-provider obligation, and no shipped pattern carries one anchored off
  // the weekend (a weekday-anchored span would place weekday calls here —
  // accepted v1 simplicity, mirroring chains-never-scope-clipped).
  if (!weekendOnly) runPrePtoPass(run);

  runSpansPass(run, scheduleDates); // scheduleDates hoisted above (request maps)

  // ── main construction loop (CALL slots only) ──
  for (const slot of slotsToFill) {
    if (state.handledSlotIds.has(slot.slot_id)) continue;
    if (slot.shift_type_category !== 'call') continue;
    // Weekend-only scope gate — AFTER the handled check (an out-of-scope call
    // slot a chain already filled is handled, not awaiting) and BEFORE the
    // override resolution (overrides are an optimizer seam; the optimizer
    // never runs in weekend-only mode). Deferred slots are counted, never
    // reported as unfilled failures.
    if (awaitingContinue && !WEEKEND_ONLY_DAY_TYPES.has(slot.derived_day_type)) {
      awaitingContinue.push({
        slot_id: slot.slot_id, slot_date: slot.slot_date,
        shift_type_code: slot.shift_type_code, derived_day_type: slot.derived_day_type,
      });
      continue;
    }

    const forced = overrideFor(run, slot);
    if (forced === null) {
      pushUnfilled(run, slot, 'Forced provider ineligible');
      continue;
    }
    if (forced) {
      // Obligation cap gates EVERY call-placing path — pins included
      // (2026-07-24, Gabriel: obligation calls are OWED; anything past the
      // cap is a PAID pickup a human places after the schedule is made — the
      // engine must never auto-place it). Whole-block admission, same charge
      // as the un-forced path below: the pin is refused unless the anchor
      // AND its live call-category chain links all fit. The slot stays open,
      // reported 'obligation-cap' (the pickup layer the banner counts).
      if (obligatory && capRoom(run, forced.id) < 1 + chainCallNeeds(run, slot, forced)) {
        pushUnfilled(run, slot, 'obligation-cap');
        continue;
      }
      record(run, slot, forced, 'main-loop');
      applyDayChains(run, slot, forced);
      applyBlockChains(run, slot, forced);
      continue;
    }

    // Single eligibility sweep: capture each provider's result once, reuse it
    // for both candidate selection and (if none) rejection reporting.
    const sweep = ctx.providers.map(p => ({ p, r: evaluateEligibility(slot, p, state, ctx, 'call') }));
    const eligible = sweep.filter(x => x.r.eligible).map(x => x.p);

    // Provider call caps: WHOLE-BLOCK admission (anchor + every live
    // call-category chain link, per KEY — per (bucket,code) for scenario
    // ceilings; admitsUnderCallCaps). Applied BEFORE the obligatory filter so
    // a cap-blocked candidate reports 'provider-cap', an obligation-blocked
    // one 'obligation-cap'. Inert (capAdmitted === eligible) when no caps are
    // stated. preferScenarioChainClean then steers the anchor toward
    // candidates whose designed chain links don't land on their OWN scenario
    // prohibitions (a filter, never a gate — when nobody is clean the full
    // set stays and a severed link is recorded downstream).
    const capAdmitted = preferScenarioChainClean(run,
      callCaps ? eligible.filter(p => admitsUnderCallCaps(run, p.id, slot)) : eligible,
      slot);
    // Obligatory mode: charge the whole prospective block against the cap
    // upfront (1 for this slot + its live call-category chain links — block
    // AND dayChain). When nobody has room, the slot is DELIBERATELY left
    // open — reason 'obligation-cap' when the cap was the binding constraint.
    // DO NOT confuse this cap with the fairness quota: the fill-overhaul rule
    // "quota never blocks fills" (2026-07-16, IF-3 below) waives the FAIRNESS
    // bucket quota only. The obligation cap is a Gabriel-stated ceiling
    // exactly like provider_limits — relaxation must never fill past it
    // (hence the `continue` on the obligatory branch below, BEFORE the
    // relaxation sweep: structurally unreachable, pinned in
    // obligatoryMode.test.ts). Open capped slots are the paid-pickup layer,
    // not failures.
    const candidates = obligatory
      ? capAdmitted.filter(p => capRoom(run, p.id) >= 1 + chainCallNeeds(run, slot, p))
      : capAdmitted;
    if (obligatory && candidates.length === 0) {
      pushUnfilled(run, slot,
        capAdmitted.length > 0 ? 'obligation-cap'
          : eligible.length > 0 ? 'provider-cap' : 'No eligible providers',
        sweep.map(x => ({
          provider_id: x.p.id, provider_name: x.p.short_display_name,
          reason: x.r.eligible
            ? (admitsUnderCallCaps(run, x.p.id, slot) ? 'obligation-cap' as const : 'provider-cap' as const)
            : (x.r.reason ?? 'bucket-quota'),
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
      // Provider call caps bind under relaxation too: relaxation may waive the
      // QUOTA, never a stated maximum (scenario ceilings included) — a slot
      // only cap-holders could take stays open ('provider-cap'), never
      // silently reassigned past the cap. Chain-clean steering applies here
      // exactly as in the main sweep.
      const relaxAdmitted = preferScenarioChainClean(run,
        callCaps ? relaxable.filter(p => admitsUnderCallCaps(run, p.id, slot)) : relaxable,
        slot);
      // Re-apply the workdays cap here: eligibility waives it under
      // 'call-no-quota' (so optimizer pins never self-reject), but quota
      // relaxation must still honor it — a slot left open by the cap is
      // legitimate, exactly like obligatory mode's obligation-cap. Weekend /
      // holiday slots are never capped (workDayCapped short-circuits).
      const relaxableUncapped = budget
        ? relaxAdmitted.filter(p => !workDayCapped(p.id, slot.slot_date))
        : relaxAdmitted;
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
      // relaxable set emptied is the workdays cap (cap-admitted candidates
      // existed pre-filter, all workday-capped), the binding reason is
      // 'workdays-cap'; when it emptied at the CALL-cap filter (relaxable
      // existed, none admitted), it is 'provider-cap' — otherwise report the
      // REAL per-candidate blockers (a quota-only rejection stays 'bucket-quota',
      // though such a provider would have been relaxable — belt-and-suspenders).
      const capBound = !!budget && relaxAdmitted.length > 0;
      const providerCapBound = !!callCaps && relaxable.length > 0 && relaxAdmitted.length === 0;
      const candidateReasons: CandidateRejection[] = relaxSweep.map(x => ({
        provider_id: x.p.id, provider_name: x.p.short_display_name,
        reason: x.r.eligible
          ? (callCaps && !admitsUnderCallCaps(run, x.p.id, slot) ? 'provider-cap'
            : capBound ? 'workdays-cap' : (x.r.reason ?? 'bucket-quota'))
          : (x.r.reason ?? 'bucket-quota'),
      }));
      pushUnfilled(run, slot,
        capBound ? 'workdays-cap' : providerCapBound ? 'provider-cap' : 'No eligible providers',
        candidateReasons);
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
  // between them). Weekend-only defers all three to the Continue run: relief
  // and mop-up rank against the FULL call schedule ("first on out-list"), and
  // a weekend-only plan doesn't have one yet — running them here would both
  // mis-rank and prematurely report orphans whose weekday triggers simply
  // haven't been attempted.
  if (!weekendOnly) {
    buildProviderCalls(run);

    // Relief pass (passes/relief.ts, §10 + IF-2 fixes), then the mop-up sweep
    // for orphaned call-engine-owned day slots (passes/mopUp.ts, §10.5 — incl.
    // the sequence-orphan reporting).
    runReliefPass(run, scheduleDates);
    runMopUpPass(run, scheduleDates);
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
  const budget = ctx.workDayBudget;
  const infoOf = (code: string) => ctx.shiftTypes?.get(code);
  const isOverlay = (code: string) => infoOf(code)?.is_overlay ?? false;
  for (const seed of ctx.seedAssignments) {
    const info = infoOf(seed.shift_type_code);
    // Overlay seeds do NOT consume the one-assignment-per-day budget (mirrors
    // record()); the post-call block offsets below STILL apply unconditionally.
    if (!isOverlay(seed.shift_type_code)) markAssigned(state, seed.slot_date, seed.provider_id);
    if (seed.shift_type_category === 'call') {
      // Call splits (2026-07-22): a SEGMENT seed counts under its PARENT code
      // at its fractional weight (a C1N12 seed = 0.5 of C1 toward buckets and
      // fairness). Whole calls: parent = own code, weight 1 — byte-identical.
      // The parent code also rides into the realized-call ledger (2026-07-26,
      // scenario linkage/NEURO decisions read it — a seeded Sun C2 segment
      // realizes SUN:C2).
      incBucketBy(state, seed.provider_id, seed.derived_day_type,
        parentCallCodeOf(seed.shift_type_code, info), callBurdenWeight(info));
      addCallDate(state, seed.provider_id, seed.slot_date,
        parentCallCodeOf(seed.shift_type_code, info));
    }
    // Working-days credit: a seeded/manual assignment on a working day is a
    // worked day (any category — a seeded day shift counts too).
    creditWorkDay(state, budget, seed.provider_id, seed.slot_date);
    // IF-1: a seeded call blocks its pattern post-call day(s) before solve runs,
    // so the same provider can't be scored onto the blocked next day. Also
    // recorded in blockedOnDate so OVERLAY placements (which skip the
    // assignedOnDate budget) still respect the blocked day (invariant 1 —
    // review finding 2).
    //
    // SEGMENT rest inheritance (2026-07-22, decision 3: post-call rest goes to
    // the OVERNIGHT segment holder only): a SEGMENT seed (parent_call_code
    // set) whose type carries requires_post_call_rule and whose OWN code has
    // no chain data in the doc rides the PARENT code's post-call blocks — a
    // seeded C1 overnight segment blocks its holder's next day exactly like a
    // seeded C1 (invariant 1 includes seeds). Segment codes the doc DOES
    // handle (patch35's C2N12/C2N8 +1 D1 links) mirror their parent's fill-
    // not-block semantics and never reach the fallback. Day/evening segments
    // (requires_post_call_rule false) block nothing. Non-segment seeds
    // (parent_call_code null — every pre-patch35 shape) never take this path.
    let blockCode = seed.shift_type_code;
    if (info?.parent_call_code && info.requires_post_call_rule
      && dayChainsFor(doc, seed.shift_type_code, seed.derived_day_type).length === 0) {
      blockCode = info.parent_call_code;
    }
    for (const off of postCallBlockOffsets(doc, blockCode, seed.derived_day_type)) {
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
