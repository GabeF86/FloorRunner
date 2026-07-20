import {
  addDays, daysBetween, dayTypeBucket, buildPrePtoByThursday,
  datesOverlap, isActiveNoCallRequest,
} from './shared';
import { evaluateEligibility } from './eligibility';
import { computeObligations } from './obligation';
import { computeSequenceOwnedSlotIds } from './sequenceOwnership';
import { exceedsWorkDayCap, creditsAsWorkedAvailability, creditWorkedDay } from './workDays';
import { emptySolveState } from './genTypes';
import { CLASSIC_PATTERN, dayChainsFor, postCallBlockOffsets, blockChainsFor } from './callPattern';
import type { CallPatternDoc } from './callPattern';
import type {
  GenerationContext, SlotToFill, CandidateProvider, SolveState,
  SolutionPlan, PlacementSource, AssignmentExplanation, CandidateRejection,
  SolveOptions, SkippedDerived, ShiftTypeInfo, WorkDayBudget,
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
  const plan: SolutionPlan = {
    assignments: [], unfilled: [], skippedDerived: [], chainAnchorSlotIds: [],
  };
  const skippedDerived = plan.skippedDerived!;
  const chainAnchorSlotIds = plan.chainAnchorSlotIds!;

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
  const sequenceOwnedSlotIds = computeSequenceOwnedSlotIds(doc, ctx.slotIndex);
  // (date|code) keys of chain links WAIVED by unlessCallWithinDays: the anchor
  // filled but the link deliberately did not fire (the holder had a recent
  // call). NOT a suppression event — no skippedDerived record (that would
  // repurpose invariant-4's vocabulary and shift the golden plan pin) — but
  // the mop-up needs it to report the open slot honestly: the chain source is
  // NOT unfilled and no link was severed.
  const waivedLinkKeys = new Set<string>();

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
  const hasNoCallRequest = (pid: string, date: string): boolean => {
    const live = noCallByPid.get(pid);
    if (!live) return false;
    return live.some(e => datesOverlap(e.start_date, e.end_date, date));
  };
  // Fairness of denial: per-provider count of requests already VIOLATED in
  // this run (a call landed on a requested date). Among penalized candidates
  // the fewest-violated wins; existing scoring breaks ties. Seeded/manual
  // calls on requested dates count — that provider has already absorbed a
  // denial this block. Every real call placement (chain links, spans,
  // pre-PTO, relaxation included) increments via record().
  const noCallViolated = new Map<string, number>();
  const noteViolation = (pid: string, date: string) => {
    if (hasNoCallRequest(pid, date)) {
      noCallViolated.set(pid, (noCallViolated.get(pid) || 0) + 1);
    }
  };
  for (const seed of ctx.seedAssignments) {
    if (seed.shift_type_category === 'call') noteViolation(seed.provider_id, seed.slot_date);
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
  const capRoom = (pid: string): number =>
    (obligationByPid!.get(pid) ?? 0) - (callCountByPid.get(pid) || 0);
  // Chain-block atomicity: the WHOLE block counts against the cap upfront —
  // an anchor is only eligible when cap-room >= 1 + its LIVE call-category
  // links (target slot exists, unhandled, category 'call'). Links that later
  // sever don't consume the cap (only real placements increment the counter),
  // so reserved-but-unused room frees back up for later slots.
  const chainCallNeeds = (slot: SlotToFill): number => {
    const links = blockChainsFor(doc, slot.derived_day_type).get(slot.shift_type_code);
    if (!links) return 0;
    let n = 0;
    for (const link of links) {
      const t = ctx.slotIndex.get(addDays(slot.slot_date, link.offset))?.get(link.code);
      if (t && !state.handledSlotIds.has(t.slot_id) && t.shift_type_category === 'call') n++;
    }
    return n;
  };

  const overrides = opts.callOverrides;
  // Resolve a call slot's override: undefined → not overridden; null → forced
  // provider ineligible (leave unfilled); provider → forced and eligible.
  // Gate 'call-no-quota' (2026-07-16): a pin re-asserts an ALREADY-MADE
  // placement (the optimizer only pins providers a previous solve chose —
  // 'quota-relaxed' ones included). Re-validating with the quota-inclusive
  // gate made every quota-relaxed pin self-reject by construction ('Forced
  // provider ineligible', no fallback). Every SAFETY gate still runs.
  const overrideFor = (slot: SlotToFill): CandidateProvider | null | undefined => {
    if (!overrides || !overrides.has(slot.slot_id)) return undefined;
    const p = providerById.get(overrides.get(slot.slot_id)!);
    if (!p) return null;
    return evaluateEligibility(slot, p, state, ctx, 'call-no-quota').eligible ? p : null;
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
      // Obligatory mode: every REAL call placement (any source — chain links
      // included) consumes the provider's cap.
      if (obligatory) callCountByPid.set(p.id, (callCountByPid.get(p.id) || 0) + 1);
      // Fair denial: a call landing on the provider's live no-call-request
      // date is a violated request — count it so later penalized-vs-penalized
      // choices prefer someone not yet denied. In obligatory mode the same
      // placement ALSO consumed the cap above: a violated request is still an
      // obligation call.
      noteViolation(p.id, slot.slot_date);
    }
    state.handledSlotIds.add(slot.slot_id);
    // Working-days credit: any placement (call / d-chain / relief / mop-up /
    // span) on a WORKING day is a worked day. Weekend / major-holiday dates are
    // not in workingDaySet, so they consume nothing (weekend-call exemption).
    creditWorkDay(state, budget, p.id, slot.slot_date);
    plan.assignments.push({
      slot_id: slot.slot_id, slot_date: slot.slot_date,
      shift_type_code: slot.shift_type_code,
      shift_type_category: slot.shift_type_category,
      derived_day_type: slot.derived_day_type,
      provider_id: p.id, provider_name: p.short_display_name,
      existing_assignment_id: slot.existing_assignment_id, source, explanation,
    });
  };

  // Main-loop scoring tuple: no-call-request sort tier first (soft avoidance
  // — never a gate), then fair-denial count within the penalized tier, then
  // lowest lifetime bucket-ratio, then least-recently called, then id.
  // Shared by the main loop, spans, and quota relaxation. `violated` is 0 for
  // every unpenalized candidate by construction, so both new keys are inert
  // outside the penalized tier — and with no live requests at all the tuple
  // is the pre-change ratio/recency/id sort, byte for byte.
  const scoreCall = (cands: CandidateProvider[], slot: SlotToFill) => {
    const k = `${dayTypeBucket(slot.derived_day_type)}|${slot.shift_type_code}`;
    return cands.map(p => {
      const lifetime = (ctx.historicalAssignedByPid.get(p.id)?.get(k) || 0)
        + (state.bucketAssigned.get(`${p.id}|${k}`) || 0);
      const penalized = hasNoCallRequest(p.id, slot.slot_date);
      return {
        p,
        tier: penalized ? 1 : 0,
        violated: penalized ? (noCallViolated.get(p.id) || 0) : 0,
        ratio: lifetime / Math.max(p.fte_value, 0.01),
        recency: daysSinceLastCall(state, p.id, slot.slot_date),
      };
    }).sort((a, b) =>
      a.tier - b.tier ||
      a.violated - b.violated ||
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
          && hadCallWithin(state, p.id, slot.slot_date, link.unlessCallWithinDays)) {
          waivedLinkKeys.add(`${addDays(slot.slot_date, link.offset)}|${link.code}`);
          continue;
        }
        tryFillDerived(addDays(slot.slot_date, link.offset), link.code, p);
      }
      for (const block of chain.blocks ?? []) {
        const blockedDate = addDays(slot.slot_date, block.offset);
        markAssigned(state, blockedDate, p.id);
        // Also record it as a BLOCK (post-call day off): overlay placements
        // skip the assignedOnDate budget, so they need this separate map to
        // still respect blocked days (invariant 1 — review finding 2).
        markBlocked(state, blockedDate, p.id);
        // A post-call rest day on a WORKING day is credited as worked (mandated
        // rest is earned). This is the "weekend call's post-call Monday consumes
        // a credit when marked" rule — the block itself bypasses the cap, but
        // the credit still lands so later placements see it.
        creditWorkDay(state, budget, p.id, blockedDate);
      }
    }
  };

  // blocks: same-provider multi-day chains anchored on the placed slot's day
  // type (classic Saturday weekend chain; proposed friday chain).
  const applyBlockChains = (slot: SlotToFill, chosen: CandidateProvider) => {
    const links = blockChainsFor(doc, slot.derived_day_type).get(slot.shift_type_code);
    if (!links) return;
    // This placement is a CHAIN ANCHOR: record it on the plan so the optimizer
    // never moves it (its chain partner is pinned separately — moving the
    // anchor severs the designed same-provider pairing). Each slot is placed
    // at most once, so no dedup needed.
    chainAnchorSlotIds.push(slot.slot_id);
    for (const link of links) {
      const date = addDays(slot.slot_date, link.offset);
      const target = ctx.slotIndex.get(date)?.get(link.code);
      // Invariant #4: a link whose target slot doesn't exist is recorded for
      // BOTH call and non-call codes — with no slot there is no main loop to
      // fall through to, so silence here would drop the obligation entirely.
      if (!target) {
        skippedDerived.push({ date, code: link.code, provider_id: chosen.id, reason: 'no-slot' });
        continue;
      }
      // IF-4: a suppressed NON-call chain fill must be recorded (invariant #4).
      // EXISTING call targets stay unrecorded — they fall through to the main
      // loop and are not dropped (that rationale only holds when a slot exists;
      // missing targets are recorded above).
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
        if (f) {
          // Invariant 4, eligible-pin half (2026-07-16 final PROOF run): the
          // optimizer pins EVERY incumbent call fill on each trial re-solve,
          // so a pairing greedy severed on a hard block gets refilled HERE —
          // and the severance record vanished from the final committed plan.
          // When the pin differs from the designed chain partner, re-run the
          // same quota-free gate the un-overridden link would have used and
          // record the partner's real block ('overridden' when the partner
          // had no block at all — pin itself severed a healthy pairing).
          if (f.id !== chosen.id) {
            const partnerElig = evaluateEligibility(target, chosen, state, ctx, 'call-no-quota');
            skippedDerived.push({
              date: target.slot_date, code: target.shift_type_code,
              provider_id: chosen.id,
              reason: partnerElig.eligible ? 'overridden' : skipReasonFrom(partnerElig.reason),
            });
          }
          record(target, f, 'weekend-chain'); applyDayChains(target, f);
        } else {
          // Invariant 4 (2026-07-16): the override pins a provider who cannot
          // take the chain target — the designed pairing severs through the
          // OVERRIDE path. Record it with the real reason (re-run the same
          // 'call-no-quota' gate overrideFor used); the slot itself is still
          // reported by the main loop ('Forced provider ineligible'). This
          // was previously a silent continue.
          const pinnedId = overrides.get(target.slot_id)!;
          const pinned = providerById.get(pinnedId);
          skippedDerived.push({
            date: target.slot_date, code: target.shift_type_code,
            provider_id: pinnedId,
            reason: pinned
              ? skipReasonFrom(evaluateEligibility(target, pinned, state, ctx, 'call-no-quota').reason)
              : 'ineligible',
          });
        }
        continue; // overridden slot handled (placed if eligible, else left for main loop/unfilled)
      }
      // Call targets use 'call-no-quota' (2026-07-16): a chain link is a
      // structural same-provider obligation whose anchor was already
      // fairness-scored — re-checking the bucket quota on the link severed the
      // designed pairing exactly when quota math ran dry. Weekend-call
      // credential, adjacent PTO and every other safety gate still run.
      // Non-call chain fills use 'derived' (also quota-free).
      const gate = target.shift_type_category === 'call' ? 'call-no-quota' : 'derived';
      const elig = evaluateEligibility(target, chosen, state, ctx, gate);
      if (!elig.eligible) {
        // Invariant 4, EXTENDED 2026-07-16: record EVERY severed link — call
        // targets included. A safety-severed call link still falls through to
        // the main loop (never dropped), but the severance itself must be
        // observable: it silently destroyed the Doc A pairing before.
        skippedDerived.push({
          date: target.slot_date, code: target.shift_type_code,
          provider_id: chosen.id, reason: skipReasonFrom(elig.reason),
        });
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
    // Obligatory mode: a pre-PTO placement is a call assignment like any
    // other — it needs cap-room. (tryPlacePrePto never fires block chains,
    // so one slot of room suffices.)
    if (obligatory && capRoom(p.id) < 1) return false;
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
      const eligibleForSpan = ctx.providers.filter(p => spanSlots.every(
        s => evaluateEligibility(s, p, state, ctx,
          s.shift_type_category === 'call' ? 'call' : 'derived').eligible));
      // Obligatory mode: a span is one atomic multi-call obligation — charge
      // its call slots against the cap upfront, same rule as chain blocks.
      const spanCallCount = spanSlots.filter(s => s.shift_type_category === 'call').length;
      const candidates = obligatory
        ? eligibleForSpan.filter(p => capRoom(p.id) >= spanCallCount)
        : eligibleForSpan;
      if (candidates.length === 0) {
        // 'obligation-cap' only when the cap was the sole blocker (someone
        // was otherwise able to cover the whole span). The slots stay in
        // slotsToFill, so the main loop still attempts them individually
        // (within caps) — mirroring the existing severed-span fallback.
        const reason = obligatory && eligibleForSpan.length > 0
          ? 'obligation-cap' : 'No provider can cover full span';
        for (const s of spanSlots) {
          plan.unfilled.push({
            slot_id: s.slot_id, slot_date: s.slot_date,
            shift_type_code: s.shift_type_code, shift_type_category: s.shift_type_category,
            reason,
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
    const eligible = sweep.filter(x => x.r.eligible).map(x => x.p);

    // Obligatory mode: charge the whole prospective block against the cap
    // upfront (1 for this slot + its live call-category chain links). When
    // nobody has room, the slot is DELIBERATELY left open — no relaxation,
    // reason 'obligation-cap' when the cap was the binding constraint.
    const candidates = obligatory
      ? eligible.filter(p => capRoom(p.id) >= 1 + chainCallNeeds(slot))
      : eligible;
    if (obligatory && candidates.length === 0) {
      plan.unfilled.push({
        slot_id: slot.slot_id, slot_date: slot.slot_date,
        shift_type_code: slot.shift_type_code, shift_type_category: slot.shift_type_category,
        reason: eligible.length > 0 ? 'obligation-cap' : 'No eligible providers',
        candidates: sweep.map(x => ({
          provider_id: x.p.id, provider_name: x.p.short_display_name,
          reason: x.r.eligible ? 'obligation-cap' as const : (x.r.reason ?? 'bucket-quota'),
        })),
      });
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
        const winner = scoreCall(relaxableUncapped, slot)[0];
        record(slot, winner.p, 'quota-relaxed', {
          ratioAtAssignment: winner.ratio,
          daysSinceLastCall: Number.isFinite(winner.recency) ? winner.recency : null,
          competingCandidates: relaxableUncapped.length,
        });
        applyDayChains(slot, winner.p);
        applyBlockChains(slot, winner.p);
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
      plan.unfilled.push({
        slot_id: slot.slot_id, slot_date: slot.slot_date,
        shift_type_code: slot.shift_type_code, shift_type_category: slot.shift_type_category,
        reason: capBound ? 'workdays-cap' : 'No eligible providers', candidates: candidateReasons,
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

  // "Next call" per provider, from this block's assignments + seeds (any call
  // category, not a code literal). Built once after every call placement pass;
  // shared by the relief pass and the mop-up sweep (both place only NON-call
  // slots, so the map never goes stale between them).
  const providerCalls = new Map<string, Array<{ date: string; code: string }>>();
  {
    const pushCall = (pid: string, date: string, code: string) => {
      if (!providerCalls.has(pid)) providerCalls.set(pid, []);
      providerCalls.get(pid)!.push({ date, code });
    };
    for (const a of plan.assignments) if (a.shift_type_category === 'call') pushCall(a.provider_id, a.slot_date, a.shift_type_code);
    for (const seed of ctx.seedAssignments) if (seed.shift_type_category === 'call') pushCall(seed.provider_id, seed.slot_date, seed.shift_type_code);
    for (const arr of providerCalls.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
  }
  // "First on out-list" ranking (relief + mop-up): soonest next call (most
  // needs relief), then that call's rank tier, then most-recently-called,
  // then id.
  const rankByNextCall = (cands: CandidateProvider[], date: string) =>
    cands.map(p => {
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

  // ── relief pass (codes + day types from the pattern; IF-2 fixes) ──
  if (doc.reliefPass?.enabled) {
    const reliefDayTypes = doc.reliefPass.dayTypes as string[];
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
      const scored = rankByNextCall(available, date);

      for (const code of reliefCodes) {
        const slot = codeMap.get(code);
        if (!slot) continue;
        if (state.handledSlotIds.has(slot.slot_id)) continue;
        // Sequence-owned relief-code slot (e.g. weekend-v2's Friday D4, the
        // Sat-C3 block-chain link): NOT relief inventory. If its chain fired,
        // it is already handled above; if the chain broke, it must stay open
        // — the mop-up sweep reports the orphan (never fills it).
        if (sequenceOwnedSlotIds.has(slot.slot_id)) continue;
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

  // ── mop-up sweep: orphaned call-engine-owned day slots (2026-07-16) ──
  // Non-call slots whose shift type belongs to the CALL engine
  // (generation_engine 'call': the D-chain + relief codes) are normally
  // claimed by day chains, block chains, or the relief pass. When the trigger
  // call goes unfilled or a chain severs, the orphan slot used to vanish from
  // ALL reporting — the day-pool engine skips call-owned slots, so nothing
  // ever filled OR reported it. Sweep every remaining open one:
  //   • SEQUENCE-OWNED slots (2026-07-17) are NEVER filled here — D1 belongs
  //     to yesterday's C2 person, D2/D3 to tomorrow's C1/C2 person, Friday D4
  //     to the Sat-C3 chain provider; a broken chain leaves them open. They
  //     are reported in plan.unfilled (the single reporting home for open
  //     slots) exactly once, with an honest reason (precedence: severed >
  //     waived > source unfilled): 'sequence-orphan: chain link severed' when
  //     skippedDerived records the designated provider's suppression for that
  //     (date, code); 'sequence-orphan: pre-call fill waived' when the link
  //     was skipped by unlessCallWithinDays (anchor filled, by-design skip);
  //     else 'sequence-orphan: chain source unfilled'. skippedDerived keeps
  //     its existing role (the suppression event itself, invariant 4) — a
  //     different fact about the same slot, not a duplicate open-slot report.
  //   • everything else is filled via the 'derived' gate (every safety gate
  //     runs; no quota) with the relief-style ranking; anything still open is
  //     reported in plan.unfilled.
  // Requires ctx.shiftTypes — pure legacy fixtures without it keep
  // byte-identical output (golden parity).
  if (ctx.shiftTypes) {
    const alreadyReported = new Set(plan.unfilled.map(u => u.slot_id));
    const skippedKeys = new Set(skippedDerived.map(s => `${s.date}|${s.code}`));
    for (const date of scheduleDates) {
      const codeMap = ctx.slotIndex.get(date);
      if (!codeMap) continue;
      for (const code of [...codeMap.keys()].sort()) {
        const slot = codeMap.get(code)!;
        if (slot.shift_type_category === 'call') continue;           // call slots: main loop reports
        if (shiftInfo(code)?.generation_engine !== 'call') continue; // day_pool/none: other engines own it
        if (state.handledSlotIds.has(slot.slot_id)) continue;
        if (alreadyReported.has(slot.slot_id)) continue;             // relief pass already reported it
        if (sequenceOwnedSlotIds.has(slot.slot_id)) {
          const key = `${slot.slot_date}|${slot.shift_type_code}`;
          plan.unfilled.push({
            slot_id: slot.slot_id, slot_date: slot.slot_date,
            shift_type_code: slot.shift_type_code, shift_type_category: slot.shift_type_category,
            reason: skippedKeys.has(key)
              ? 'sequence-orphan: chain link severed'
              : waivedLinkKeys.has(key)
                ? 'sequence-orphan: pre-call fill waived'
                : 'sequence-orphan: chain source unfilled',
          });
          continue;
        }
        const available = ctx.providers.filter(
          p => evaluateEligibility(slot, p, state, ctx, 'derived').eligible);
        if (available.length === 0) {
          plan.unfilled.push({
            slot_id: slot.slot_id, slot_date: slot.slot_date,
            shift_type_code: slot.shift_type_code, shift_type_category: slot.shift_type_category,
            reason: 'No eligible provider for call-engine day slot',
          });
          continue;
        }
        record(slot, rankByNextCall(available, date)[0].p, 'day-mop-up');
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
// Post-call BLOCK marker (day off), kept alongside markAssigned at the two
// block-marking sites only (applyDayChains blocks; seedSolveState IF-1).
// Overlay eligibility reads this map because overlays skip assignedOnDate.
function markBlocked(s: SolveState, date: string, pid: string) {
  if (!s.blockedOnDate.has(date)) s.blockedOnDate.set(date, new Set());
  s.blockedOnDate.get(date)!.add(pid);
}
// FTE working-days credit wrapper. A no-op unless a budget is present — the
// no-budget path is byte-identical; the working-day filter + (provider, date)
// dedupe live in the shared creditWorkedDay ledger writer (workDays.ts).
function creditWorkDay(s: SolveState, budget: WorkDayBudget | undefined, pid: string, date: string) {
  if (!budget) return;
  creditWorkedDay(s.creditedWorkDays, budget.workingDaySet, pid, date);
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
