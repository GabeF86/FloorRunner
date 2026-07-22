// The solve kernel (2026-07-20 solve decomposition): the SolverRun context
// object bundling one solve() invocation's inputs + mutable products, and the
// placement kernel formerly written as closures inside solve() —
// record / tryFillDerived / applyDayChains / applyBlockChains / scoreCall /
// rankByNextCall plus their small helpers. Bodies are the closure bodies,
// mechanically converted to take the run object; behavior is byte-identical.
// solve.ts builds the run and orchestrates; the pass modules (passes/) and
// the main loop consume these functions.
import { addDays, daysBetween, dayTypeBucket, datesOverlap } from './shared';
import { evaluateEligibility } from './eligibility';
import { dayChainsFor, blockChainsFor } from './callPattern';
import { mayEvictPreFill, preFillCodes, shiftRank } from './preFillEviction';
import type { RankableShiftType } from './preFillEviction';
import type { CallPatternDoc } from './callPattern';
import { creditWorkDay, markAssigned, markBlocked, incBucket, addCallDate, daysSinceLastCall, hadCallWithin } from './solveState';
import type { SolveState } from './solveState';
import type {
  GenerationContext, SlotToFill, CandidateProvider, SolutionPlan,
  PlacementSource, AssignmentExplanation, SkippedDerived, WorkDayBudget,
  CandidateRejection,
} from './genTypes';

// One solve() invocation's bundled context: immutable inputs (ctx, doc,
// derived shift-type helpers, option-derived flags) plus the mutable products
// (plan, state, counters, bookkeeping sets) every pass reads and writes.
// skippedDerived / chainAnchorSlotIds alias plan.skippedDerived /
// plan.chainAnchorSlotIds (same array references).
export interface SolverRun {
  ctx: GenerationContext;
  doc: CallPatternDoc;
  plan: SolutionPlan;
  state: SolveState;
  budget: WorkDayBudget | undefined;
  // Derived shift-type helpers (ctx.shiftTypes with legacy fallbacks).
  isOverlay: (code: string) => boolean;
  callRank: (code: string) => number;
  reliefCodes: string[];
  // Obligatory fill mode (§4.5).
  obligatory: boolean;
  obligationByPid: Map<string, number> | null;
  callCountByPid: Map<string, number>;
  // No-call request soft avoidance (§11 tier 0).
  noCallByPid: Map<string, Array<{ start_date: string; end_date: string }>>;
  noCallViolated: Map<string, number>;
  // Structural bookkeeping.
  waivedLinkKeys: Set<string>;
  sequenceOwnedSlotIds: Set<string>;
  providerById: Map<string, CandidateProvider>;
  overrides: Map<string, string> | undefined;
  skippedDerived: SkippedDerived[];
  chainAnchorSlotIds: string[];
  // "Next call" per provider — built by buildProviderCalls AFTER every call
  // placement pass; consumed by the relief pass + mop-up sweep ranking.
  providerCalls: Map<string, Array<{ date: string; code: string }>>;
}

// Report an open slot on the plan — ONE shape for every reporting site
// (main loop, spans, relief, mop-up). Reason strings are assertion-pinned
// and pass through BYTE-EXACT; `candidates` is only attached when the caller
// provides one (key-presence preserved).
export function pushUnfilled(
  run: SolverRun, slot: SlotToFill, reason: string, candidates?: CandidateRejection[],
) {
  run.plan.unfilled.push({
    slot_id: slot.slot_id, slot_date: slot.slot_date,
    shift_type_code: slot.shift_type_code, shift_type_category: slot.shift_type_category,
    reason,
    ...(candidates !== undefined ? { candidates } : {}),
  });
}

export function hasNoCallRequest(run: SolverRun, pid: string, date: string): boolean {
  const live = run.noCallByPid.get(pid);
  if (!live) return false;
  return live.some(e => datesOverlap(e.start_date, e.end_date, date));
}

// Fairness of denial: a call landing on the provider's live no-call-request
// date is a violated request — count it so later penalized-vs-penalized
// choices prefer someone not yet denied.
export function noteViolation(run: SolverRun, pid: string, date: string) {
  if (hasNoCallRequest(run, pid, date)) {
    run.noCallViolated.set(pid, (run.noCallViolated.get(pid) || 0) + 1);
  }
}

// Obligatory mode: remaining cap-room under the provider's rounded TOTAL
// obligation. Only meaningful when run.obligatory (obligationByPid non-null).
export function capRoom(run: SolverRun, pid: string): number {
  return (run.obligationByPid!.get(pid) ?? 0) - (run.callCountByPid.get(pid) || 0);
}

// Chain-block atomicity: the WHOLE block counts against the cap upfront —
// an anchor is only eligible when cap-room >= 1 + its LIVE call-category
// links (target slot exists, unhandled, category 'call'). Links that later
// sever don't consume the cap (only real placements increment the counter),
// so reserved-but-unused room frees back up for later slots.
export function chainCallNeeds(run: SolverRun, slot: SlotToFill): number {
  const links = blockChainsFor(run.doc, slot.derived_day_type).get(slot.shift_type_code);
  if (!links) return 0;
  let n = 0;
  for (const link of links) {
    const t = run.ctx.slotIndex.get(addDays(slot.slot_date, link.offset))?.get(link.code);
    if (t && !run.state.handledSlotIds.has(t.slot_id) && t.shift_type_category === 'call') n++;
  }
  return n;
}

// Resolve a call slot's override: undefined → not overridden; null → forced
// provider ineligible (leave unfilled); provider → forced and eligible.
// Gate 'call-no-quota' (2026-07-16): a pin re-asserts an ALREADY-MADE
// placement (the optimizer only pins providers a previous solve chose —
// 'quota-relaxed' ones included). Re-validating with the quota-inclusive
// gate made every quota-relaxed pin self-reject by construction ('Forced
// provider ineligible', no fallback). Every SAFETY gate still runs.
export function overrideFor(run: SolverRun, slot: SlotToFill): CandidateProvider | null | undefined {
  const { overrides } = run;
  if (!overrides || !overrides.has(slot.slot_id)) return undefined;
  const p = run.providerById.get(overrides.get(slot.slot_id)!);
  if (!p) return null;
  return evaluateEligibility(slot, p, run.state, run.ctx, 'call-no-quota').eligible ? p : null;
}

export function record(
  run: SolverRun,
  slot: SlotToFill, p: CandidateProvider, source: PlacementSource,
  explanation?: AssignmentExplanation,
) {
  const { state } = run;
  // Overlay placements do NOT consume the one-assignment-per-day budget.
  if (!run.isOverlay(slot.shift_type_code)) markAssigned(state, slot.slot_date, p.id);
  // Overlay call slots still count toward buckets and call recency — only the
  // one-assignment-per-day budget is exempt.
  if (slot.shift_type_category === 'call') {
    incBucket(state, p.id, slot.derived_day_type, slot.shift_type_code);
    addCallDate(state, p.id, slot.slot_date);
    // Obligatory mode: every REAL call placement (any source — chain links
    // included) consumes the provider's cap.
    if (run.obligatory) run.callCountByPid.set(p.id, (run.callCountByPid.get(p.id) || 0) + 1);
    // Fair denial: a call landing on the provider's live no-call-request
    // date is a violated request — count it so later penalized-vs-penalized
    // choices prefer someone not yet denied. In obligatory mode the same
    // placement ALSO consumed the cap above: a violated request is still an
    // obligation call.
    noteViolation(run, p.id, slot.slot_date);
  }
  state.handledSlotIds.add(slot.slot_id);
  // Working-days credit: any placement (call / d-chain / relief / mop-up /
  // span) on a WORKING day is a worked day. Weekend / major-holiday dates are
  // not in workingDaySet, so they consume nothing (weekend-call exemption).
  creditWorkDay(state, run.budget, p.id, slot.slot_date);
  run.plan.assignments.push({
    slot_id: slot.slot_id, slot_date: slot.slot_date,
    shift_type_code: slot.shift_type_code,
    shift_type_category: slot.shift_type_category,
    derived_day_type: slot.derived_day_type,
    provider_id: p.id, provider_name: p.short_display_name,
    existing_assignment_id: slot.existing_assignment_id, source, explanation,
  });
}

// Main-loop scoring tuple: no-call-request sort tier first (soft avoidance
// — never a gate), then fair-denial count within the penalized tier, then
// lowest lifetime bucket-ratio, then least-recently called, then id.
// Shared by the main loop, spans, and quota relaxation. `violated` is 0 for
// every unpenalized candidate by construction, so both new keys are inert
// outside the penalized tier — and with no live requests at all the tuple
// is the pre-change ratio/recency/id sort, byte for byte.
export function scoreCall(run: SolverRun, cands: CandidateProvider[], slot: SlotToFill) {
  const { ctx, state } = run;
  const k = `${dayTypeBucket(slot.derived_day_type)}|${slot.shift_type_code}`;
  return cands.map(p => {
    const lifetime = (ctx.historicalAssignedByPid.get(p.id)?.get(k) || 0)
      + (state.bucketAssigned.get(`${p.id}|${k}`) || 0);
    const penalized = hasNoCallRequest(run, p.id, slot.slot_date);
    return {
      p,
      tier: penalized ? 1 : 0,
      violated: penalized ? (run.noCallViolated.get(p.id) || 0) : 0,
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
}

// ── derived (D-chain / span) fills — record every suppression (IF-4) ──
// `postCallTrigger` (2026-07-21): the just-placed anchor slot, passed ONLY for
// POSITIVE-offset dayChain links. It arms the seed-eviction path below —
// Gabriel's D1-overrides-pre-call rule for stale multi-pass seeds. Absent
// (negative links, spans) the body is the pre-change code byte for byte.
export function tryFillDerived(
  run: SolverRun, date: string, code: string, p: CandidateProvider,
  postCallTrigger?: SlotToFill,
) {
  const target = run.ctx.slotIndex.get(date)?.get(code);
  if (!target) { run.skippedDerived.push({ date, code, provider_id: p.id, reason: 'no-slot' }); return; }
  if (run.state.handledSlotIds.has(target.slot_id)) {
    run.skippedDerived.push({ date, code, provider_id: p.id, reason: 'already-handled' }); return;
  }
  const elig = evaluateEligibility(target, p, run.state, run.ctx, 'derived');
  if (!elig.eligible) {
    // A post-call link blocked by the provider's OWN stale pre-fill seed
    // evicts it and places the fill (the Hussain 9/30 bug). Any other
    // blocker — or a seed failing an eviction gate — falls through to the
    // unchanged skip record (invariant 4).
    if (postCallTrigger && elig.reason === 'same-date'
      && tryEvictSeedAndFill(run, target, p, postCallTrigger)) return;
    run.skippedDerived.push({ date, code, provider_id: p.id, reason: skipReasonFrom(elig.reason) });
    return;
  }
  record(run, target, p, 'd-chain');
}

// ── engine seed eviction (2026-07-21, the Hussain 9/30 bug) ─────────────────
// Multi-pass generation: run 1's C2 pre-filled a D3 the day before it; run 2
// filled the still-open PRIOR day's C2 with the same provider, and its +1 D1
// link found the provider "already assigned" — their own STALE auto-generated
// D3 seed — stranding the D1. Gabriel's standing rule (2026-07-19, the Jones
// fix): the post-call fill OVERRIDES any pre-call status. sequenceAutoFill has
// evicted such rows since then; this is the engine-side equivalent for SEEDS.
//
// Fires only when the positive-offset link fill is blocked ONLY by the
// provider's own seeded assignment(s) on the target date, every such seed
// passes the SHARED eviction gates (preFillEviction.mayEvictPreFill — one
// predicate, never two divergent copies), and the fill is otherwise eligible
// once the seed's claim is released (PTO/cross-site/caps still decline, seed
// intact). Evictions land on plan.evictions (never silent) and are EXECUTED
// by commitPlan before the fill writes.
function tryEvictSeedAndFill(
  run: SolverRun, target: SlotToFill, p: CandidateProvider, trigger: SlotToFill,
): boolean {
  const { ctx, state } = run;
  const date = target.slot_date;
  // "Blocked ONLY by the seed": a pattern post-call BLOCK (mandated day off)
  // on the date is inviolable (invariant 1), and an in-plan same-run
  // placement is a live decision, not a stale seed — both refuse.
  if (state.blockedOnDate.get(date)?.has(p.id)) return false;
  if (run.plan.assignments.some(a => a.provider_id === p.id && a.slot_date === date)) return false;

  // The claim holders: the provider's NON-OVERLAY seeds on the date (overlay
  // seeds never consumed the one-assignment-per-day budget, so they are not
  // the 'same-date' blocker). ALL of them must pass the shared gates —
  // missing eviction provenance (bare fixtures, pre-extension loads) is
  // conservatively non-evictable.
  const blockers = ctx.seedAssignments.filter(s =>
    s.provider_id === p.id && s.slot_date === date && !run.isOverlay(s.shift_type_code));
  if (blockers.length === 0) return false;

  const degraded = !ctx.shiftTypes;
  const stOf = (code: string, category: string): RankableShiftType =>
    ctx.shiftTypes?.get(code) ?? { code, category };
  const rank = (st: RankableShiftType | null | undefined) => shiftRank(st, degraded);
  const incomingRank = rank(stOf(trigger.shift_type_code, trigger.shift_type_category));
  const evictableCodes = preFillCodes(run.doc);
  for (const s of blockers) {
    if (!s.slot_id || !s.assignment_id) return false; // commit couldn't execute it
    if (!mayEvictPreFill(incomingRank, {
      source_type: s.source_type,
      same_version: s.schedule_version_id != null
        && s.schedule_version_id === ctx.scheduleVersionId,
      st: stOf(s.shift_type_code, s.shift_type_category),
    }, evictableCodes, rank)) return false;
  }

  // Tentatively release the seeds' one-assignment-per-day claim, then re-run
  // the FULL derived gate: the eviction proceeds only when the seed was the
  // ONLY blocker. Otherwise roll the claim back — the caller records the
  // original skip and the plan is byte-identical to the pre-change engine.
  state.assignedOnDate.get(date)?.delete(p.id);
  if (!evaluateEligibility(target, p, state, ctx, 'derived').eligible) {
    markAssigned(state, date, p.id);
    return false;
  }
  // Workday-credit bookkeeping: the seed's credit for the date is deliberately
  // NOT removed — record() below re-credits the SAME date and the ledger is a
  // per-(provider,date) set, so eviction + refill nets to exactly one credit
  // (pinned in seedEviction.test.ts). Bucket counts are untouched: pre-fills
  // are non-call by gate (mayEvictPreFill refuses call-category occupants).
  for (const s of blockers) {
    (run.plan.evictions ??= []).push({
      date, code: s.shift_type_code,
      provider_id: p.id, provider_name: p.short_display_name,
      slot_id: s.slot_id!, assignment_id: s.assignment_id!,
      trigger_date: trigger.slot_date, trigger_code: trigger.shift_type_code,
    });
  }
  record(run, target, p, 'd-chain');
  return true;
}

// dayChains: per-code pre/post fills (links) and post-call blocks for the
// provider who was just placed on `slot`.
export function applyDayChains(run: SolverRun, slot: SlotToFill, p: CandidateProvider) {
  const { state } = run;
  for (const chain of dayChainsFor(run.doc, slot.shift_type_code, slot.derived_day_type)) {
    for (const link of chain.links ?? []) {
      if (link.unlessCallWithinDays != null
        && hadCallWithin(state, p.id, slot.slot_date, link.unlessCallWithinDays)) {
        run.waivedLinkKeys.add(`${addDays(slot.slot_date, link.offset)}|${link.code}`);
        continue;
      }
      // Positive-offset (post-call) links arm the seed-eviction path with the
      // just-placed anchor as the trigger; negative (pre-call) links never
      // evict — mirroring sequenceAutoFill's offset gate.
      tryFillDerived(run, addDays(slot.slot_date, link.offset), link.code, p,
        link.offset > 0 ? slot : undefined);
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
      creditWorkDay(state, run.budget, p.id, blockedDate);
    }
  }
}

// blocks: same-provider multi-day chains anchored on the placed slot's day
// type (classic Saturday weekend chain; proposed friday chain).
export function applyBlockChains(run: SolverRun, slot: SlotToFill, chosen: CandidateProvider) {
  const { ctx, state, overrides, skippedDerived } = run;
  const links = blockChainsFor(run.doc, slot.derived_day_type).get(slot.shift_type_code);
  if (!links) return;
  // This placement is a CHAIN ANCHOR: record it on the plan so the optimizer
  // never moves it (its chain partner is pinned separately — moving the
  // anchor severs the designed same-provider pairing). Each slot is placed
  // at most once, so no dedup needed.
  run.chainAnchorSlotIds.push(slot.slot_id);
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
      const f = overrideFor(run, target);
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
        record(run, target, f, 'weekend-chain'); applyDayChains(run, target, f);
      } else {
        // Invariant 4 (2026-07-16): the override pins a provider who cannot
        // take the chain target — the designed pairing severs through the
        // OVERRIDE path. Record it with the real reason (re-run the same
        // 'call-no-quota' gate overrideFor used); the slot itself is still
        // reported by the main loop ('Forced provider ineligible'). This
        // was previously a silent continue.
        const pinnedId = overrides.get(target.slot_id)!;
        const pinned = run.providerById.get(pinnedId);
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
    record(run, target, chosen, 'weekend-chain');
    applyDayChains(run, target, chosen);
  }
}

// "Next call" per provider, from this block's assignments + seeds (any call
// category, not a code literal). Built once after every call placement pass;
// shared by the relief pass and the mop-up sweep (both place only NON-call
// slots, so the map never goes stale between them).
export function buildProviderCalls(run: SolverRun) {
  const providerCalls = run.providerCalls;
  const pushCall = (pid: string, date: string, code: string) => {
    if (!providerCalls.has(pid)) providerCalls.set(pid, []);
    providerCalls.get(pid)!.push({ date, code });
  };
  for (const a of run.plan.assignments) if (a.shift_type_category === 'call') pushCall(a.provider_id, a.slot_date, a.shift_type_code);
  for (const seed of run.ctx.seedAssignments) if (seed.shift_type_category === 'call') pushCall(seed.provider_id, seed.slot_date, seed.shift_type_code);
  for (const arr of providerCalls.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
}

// "First on out-list" ranking (relief + mop-up): soonest next call (most
// needs relief), then that call's rank tier, then most-recently-called,
// then id.
export function rankByNextCall(run: SolverRun, cands: CandidateProvider[], date: string) {
  return cands.map(p => {
    const nextCall = (run.providerCalls.get(p.id) || []).find(c => c.date > date);
    return {
      p,
      distance: nextCall ? daysBetween(date, nextCall.date) : Infinity,
      tier: nextCall ? run.callRank(nextCall.code) : 99,
      recency: daysSinceLastCall(run.state, p.id, date),
    };
  }).sort((a, b) =>
    a.distance - b.distance || a.tier - b.tier ||
    a.recency - b.recency || a.p.id.localeCompare(b.p.id),
  );
}

// Map an eligibility rejection reason to a skippedDerived reason.
export function skipReasonFrom(reason: string | undefined): SkippedDerived['reason'] {
  if (reason === 'availability-blocked' || reason === 'weekend-adjacent-pto') return 'pto';
  if (reason === 'cross-site') return 'cross-site';
  if (reason === 'same-date') return 'occupied';
  return 'ineligible';
}
