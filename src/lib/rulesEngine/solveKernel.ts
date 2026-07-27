// The solve kernel (2026-07-20 solve decomposition): the SolverRun context
// object bundling one solve() invocation's inputs + mutable products, and the
// placement kernel formerly written as closures inside solve() —
// record / tryFillDerived / applyDayChains / applyBlockChains / scoreCall /
// rankByNextCall plus their small helpers. Bodies are the closure bodies,
// mechanically converted to take the run object; behavior is byte-identical.
// solve.ts builds the run and orchestrates; the pass modules (passes/) and
// the main loop consume these functions.
import { addDays, daysBetween, dayTypeBucket, datesOverlap, dayOfWeekUTC } from './shared';
import { evaluateEligibility } from './eligibility';
import { dayChainsFor, blockChainsFor } from './callPattern';
import { mayEvictPreFill, preFillCodes, shiftRank } from './preFillEviction';
import type { RankableShiftType } from './preFillEviction';
import type { CallPatternDoc, PatternBlockLink } from './callPattern';
import { creditWorkDay, markAssigned, markBlocked, incBucket, addCallDate, daysSinceLastCall, hadCallWithin } from './solveState';
import type { SolveState } from './solveState';
import type { CallCaps } from './providerCaps';
import { scenarioChargeKeys } from './providerCaps';
import {
  weekendAnchorOf, scenarioBucketOf, scenarioProhibits, memberMatches,
  memberRealizedInWeekend, NEURO_KEY,
} from './scenario';
import type { ScenarioDoc } from './scenario';
import { WEIGHT_EPSILON } from '@/lib/callBurden';
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
  // Provider call caps (2026-07-22, patch34 provider_limits; GENERALIZED
  // 2026-07-26 for the scenario layer): null unless the parent schedule
  // states per-code call caps OR the scenario states targets — every cap
  // branch is inert then (blank-fallback pin). callCodeTally
  // (`${pid}|${capKey}` → weighted usage, all key kinds — see CallCaps in
  // providerCaps.ts) is seeded from call seeds and maintained by record()
  // only when callCaps is non-null.
  callCaps: CallCaps | null;
  callCodeTally: Map<string, number>;
  // Scenario projection (2026-07-26, Paoli phase 2): null = no manifest ⇒
  // every scenario branch inert, byte-identical plans.
  scenario: ScenarioDoc | null;
  // Multi-start tie-break seed: 0 = identity (pre-seed byte-identical order);
  // nonzero permutes ONLY scoreCall's final id tiebreak via tieHash below.
  tieBreakSeed: number;
  // No-call request soft avoidance (§11 tier 0).
  noCallByPid: Map<string, Array<{ start_date: string; end_date: string }>>;
  noCallViolated: Map<string, number>;
  // Call-request soft preference (2026-07-22, §11 — mirror of the no-call
  // tier): live call_request coverage per provider, the fair-grant counter,
  // and the per-provider CONTRADICTORY dates (covered by BOTH live request
  // types — treated as neither, warned once on plan.requestWarnings). All
  // three empty when no call_request rows exist ⇒ every branch inert.
  callReqByPid: Map<string, Array<{ start_date: string; end_date: string }>>;
  callReqGranted: Map<string, number>;
  contraReqDates: Map<string, Set<string>>;
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
  // Contradictory dates (both request types live) are treated as neither —
  // no-op with zero call_request rows (contraReqDates is then always empty).
  if (run.contraReqDates.get(pid)?.has(date)) return false;
  return live.some(e => datesOverlap(e.start_date, e.end_date, date));
}

// Mirror of hasNoCallRequest for the preferred tier: a live call_request
// covering the date, unless the date is contradictory (then neither).
export function hasCallRequest(run: SolverRun, pid: string, date: string): boolean {
  const live = run.callReqByPid.get(pid);
  if (!live) return false;
  if (run.contraReqDates.get(pid)?.has(date)) return false;
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

// Fairness of grant (mirror of noteViolation): a call landing on the
// provider's live call-request date is a granted request — count it so later
// preferred-vs-preferred choices favor someone not yet granted.
export function noteGrant(run: SolverRun, pid: string, date: string) {
  if (hasCallRequest(run, pid, date)) {
    run.callReqGranted.set(pid, (run.callReqGranted.get(pid) || 0) + 1);
  }
}

// Obligatory mode: remaining cap-room under the provider's rounded TOTAL
// obligation. Only meaningful when run.obligatory (obligationByPid non-null).
export function capRoom(run: SolverRun, pid: string): number {
  return (run.obligationByPid!.get(pid) ?? 0) - (run.callCountByPid.get(pid) || 0);
}

// A minFte link fires only for an anchor provider clearing the floor
// (2026-07-27). Absent minFte = always fires, so every pre-existing pattern
// behaves byte-identically.
function linkFiresFor(link: PatternBlockLink, fte: number): boolean {
  return link.minFte == null || fte + WEIGHT_EPSILON >= link.minFte;
}

// Chain-block atomicity: the WHOLE block counts against the cap upfront —
// an anchor is only eligible when cap-room >= 1 + its LIVE call-category
// links: block-chain links AND dayChain links (2026-07-24 — a call-category
// dayChain link is a real call the placement will fire via applyDayChains;
// no shipped pattern has one, but the seam is pinned). Target slot exists,
// unhandled, category 'call'. Links that later sever don't consume the cap
// (only real placements increment the counter), so reserved-but-unused room
// frees back up for later slots. Waivable links (unlessCallWithinDays) are
// counted even when they would waive — a per-slot over-reservation the same
// free-back-up rule absorbs (keeps this per-slot, not per-provider).
// `p` (2026-07-27) is the prospective anchor: passing it skips links the FTE
// gate will suppress, so a sub-floor anchor is never charged for a partner
// shift it will not take. Omitting it counts every link (pre-gate behavior).
export function chainCallNeeds(run: SolverRun, slot: SlotToFill, p?: CandidateProvider): number {
  let n = dayChainCallNeeds(run, slot);
  const links = blockChainsFor(run.doc, slot.derived_day_type).get(slot.shift_type_code);
  if (links) {
    for (const link of links) {
      // A link the FTE gate will suppress must not reserve obligation room.
      if (p && !linkFiresFor(link, p.fte_value)) continue;
      const t = run.ctx.slotIndex.get(addDays(slot.slot_date, link.offset))?.get(link.code);
      if (t && !run.state.handledSlotIds.has(t.slot_id) && t.shift_type_category === 'call') n++;
    }
  }
  return n;
}

// LIVE call-category dayChain links a placement on `slot` would fire
// (applyDayChains). Split out from chainCallNeeds for the passes that fire
// dayChains but never block chains (pre-PTO, spans) — they charge
// 1 + THIS per slot, not the full block. NOTE the recursion boundary: links
// of a chain's own targets are NOT counted (a call link nested under a
// block-chain link) — the tryFillDerived obligation-cap guard refuses those
// at fill time, recorded, never past the cap.
export function dayChainCallNeeds(run: SolverRun, slot: SlotToFill): number {
  let n = 0;
  for (const chain of dayChainsFor(run.doc, slot.shift_type_code, slot.derived_day_type)) {
    for (const link of chain.links ?? []) {
      const t = run.ctx.slotIndex.get(addDays(slot.slot_date, link.offset))?.get(link.code);
      if (t && !run.state.handledSlotIds.has(t.slot_id) && t.shift_type_category === 'call') n++;
    }
  }
  return n;
}

// ── Provider call caps (2026-07-22, patch34; generalized 2026-07-26) ────────
// One placement's cap CHARGES: the per-code key (always) plus, for scenario
// providers, the (dow-bucket,code)/either-or keys (scenarioChargeKeys,
// providerCaps.ts) and the weekend-distinct NEURO unit. `sim` carries the
// simulated neuro weekends within one multi-placement admission (a Sat C3
// anchor + its Fri/Sun C3 links charge ONE unit, matching "exactly one
// Saturday/Sunday pair" — pairs, not days, count toward the NEURO target).
function capCharges(
  run: SolverRun, pid: string, date: string, code: string,
  sim?: Set<string>,
): Array<{ key: string; amount: number }> {
  const out: Array<{ key: string; amount: number }> = [{ key: code, amount: 1 }];
  const scenario = run.scenario;
  if (scenario && scenario.providers.has(pid)) {
    for (const sk of scenarioChargeKeys(scenario, pid, date, code)) {
      out.push({ key: sk, amount: 1 });
    }
    if (code === scenario.neuroCode) {
      const wk = weekendAnchorOf(date);
      if (wk) {
        const already = ownNeuroInWeekend(run, pid, wk) || sim?.has(wk);
        if (!already) out.push({ key: `S:${NEURO_KEY}`, amount: 1 });
        sim?.add(wk);
      }
    }
  }
  return out;
}

// Does the provider already hold a realized neuro-code call (plan or seed) in
// the weekend anchored at `weekendAnchor`? Reads the callCodesByDate ledger.
function ownNeuroInWeekend(run: SolverRun, pid: string, weekendAnchor: string): boolean {
  const scenario = run.scenario!;
  const byDate = run.state.callCodesByDate.get(pid);
  if (!byDate) return false;
  for (const d of [addDays(weekendAnchor, -1), weekendAnchor, addDays(weekendAnchor, 1)]) {
    if (byDate.get(d)?.has(scenario.neuroCode)) return true;
  }
  return false;
}

// Cap admission for a LIST of same-provider call placements (an anchor plus
// its designed chain links, a span's call slots, a single pre-PTO slot):
// simulate every charge, then check ONLY the provider's cap entries the
// simulation touched — an entry a seed already overfilled must not veto an
// unrelated placement. Always true when no caps are stated.
export function capAdmitsPlacements(
  run: SolverRun, pid: string,
  placements: ReadonlyArray<{ date: string; code: string }>,
): boolean {
  const byKey = run.callCaps?.get(pid);
  if (!byKey) return true;
  const delta = new Map<string, number>();
  const sim = new Set<string>();
  for (const pl of placements) {
    for (const { key, amount } of capCharges(run, pid, pl.date, pl.code, sim)) {
      delta.set(key, (delta.get(key) || 0) + amount);
    }
  }
  for (const [key, add] of delta) {
    const cap = byKey.get(key);
    if (cap == null) continue;
    const usage = (run.callCodeTally.get(`${pid}|${key}`) || 0) + add;
    if (usage > cap + WEIGHT_EPSILON) return false;
  }
  return true;
}

// LIVE call-category block-chain link placements a fill on `slot` would fire
// (target slot exists, unhandled, category 'call'). Links that later sever
// don't consume the tally (only real placements increment it in record()),
// so reserved-but-unused room frees back up.
// `p` (2026-07-27) is the prospective anchor — the SAME gate chainCallNeeds
// applies: a link the FTE gate will suppress is never fired for this
// provider, so reserving cap room for it would blank the ANCHOR day and
// leave the orphan filled (exactly backwards). Omitting `p` counts every
// link (pre-gate behavior).
export function liveBlockChainCallLinks(
  run: SolverRun, slot: SlotToFill, p?: CandidateProvider,
): Array<{ date: string; code: string }> {
  const out: Array<{ date: string; code: string }> = [];
  const links = blockChainsFor(run.doc, slot.derived_day_type).get(slot.shift_type_code);
  if (links) {
    for (const link of links) {
      if (p && !linkFiresFor(link, p.fte_value)) continue;
      const date = addDays(slot.slot_date, link.offset);
      const t = run.ctx.slotIndex.get(date)?.get(link.code);
      if (t && !run.state.handledSlotIds.has(t.slot_id) && t.shift_type_category === 'call') {
        out.push({ date, code: link.code });
      }
    }
  }
  return out;
}

// Cap admission for a call placement — WHOLE-BLOCK at anchor time: the anchor
// plus every same-provider call the designed block will place must fit under
// that provider's caps, per key — per (bucket,code) for scenario ceilings.
// Never sever a designed pairing halfway (the 2026-07-16 severance-bug
// class). Non-anchor slots degenerate to a single-placement check. Always
// true when no caps are stated.
export function admitsUnderCallCaps(run: SolverRun, pid: string, slot: SlotToFill): boolean {
  if (!run.callCaps || slot.shift_type_category !== 'call') return true;
  if (!run.callCaps.has(pid)) return true; // no caps stated for this provider
  // The prospective anchor drives the FTE gate (providerById is built from
  // ctx.providers, so every candidate resolves) — an FTE-suppressed link must
  // reserve no cap room for THIS provider.
  return capAdmitsPlacements(run, pid, [
    { date: slot.slot_date, code: slot.shift_type_code },
    ...liveBlockChainCallLinks(run, slot, run.providerById.get(pid)),
  ]);
}

// Scenario chain-clean preference (2026-07-26): a candidate whose designed
// chain link would land on one of their OWN prohibited (date, code)s severs
// the pairing by construction — when chain-clean candidates exist, restrict
// to them so the designed pairing survives. When NOBODY is clean the full
// set stays (a filled anchor with a recorded severed link beats an open
// anchor). A filter, never a gate — inert without a scenario.
export function preferScenarioChainClean(
  run: SolverRun, cands: CandidateProvider[], slot: SlotToFill,
): CandidateProvider[] {
  if (!run.scenario || slot.shift_type_category !== 'call') return cands;
  const clean = cands.filter(p => {
    const sp = run.scenario!.providers.get(p.id);
    if (!sp) return true;
    // Links are resolved PER CANDIDATE (2026-07-27): an FTE-suppressed link
    // never fires for this provider, so it cannot sever their pairing and
    // must not disqualify them. With no live links everyone is clean, which
    // reproduces the old `links.length === 0 → return cands` early-out.
    const links = liveBlockChainCallLinks(run, slot, p);
    return links.every(l => !scenarioProhibits(sp, l.date, l.code));
  });
  return clean.length > 0 ? clean : cands;
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
    // Provider call caps: every REAL call placement (any source — chain links
    // and overridden pins included) maintains the tally, per KEY (per-code +
    // scenario bucket/either-or/neuro — capCharges is the one home). Computed
    // BEFORE addCallDate below so the neuro weekend-unit charge doesn't see
    // this placement as its own prior.
    if (run.callCaps) {
      for (const { key, amount } of capCharges(run, p.id, slot.slot_date, slot.shift_type_code)) {
        const k = `${p.id}|${key}`;
        run.callCodeTally.set(k, (run.callCodeTally.get(k) || 0) + amount);
      }
    }
    addCallDate(state, p.id, slot.slot_date, slot.shift_type_code);
    // Obligatory mode: every REAL call placement (any source — chain links
    // included) consumes the provider's cap.
    if (run.obligatory) run.callCountByPid.set(p.id, (run.callCountByPid.get(p.id) || 0) + 1);
    // Fair denial: a call landing on the provider's live no-call-request
    // date is a violated request — count it so later penalized-vs-penalized
    // choices prefer someone not yet denied. In obligatory mode the same
    // placement ALSO consumed the cap above: a violated request is still an
    // obligation call.
    noteViolation(run, p.id, slot.slot_date);
    // Fair grant (mirror): a call landing on the provider's live
    // call-request date is a granted request — spread later grants.
    noteGrant(run, p.id, slot.slot_date);
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

// Deterministic 32-bit FNV-1a of (seed, id) — the multi-start tie-break
// shuffle key. Seed 0 never reaches this (identity order pinned).
export function tieHash(seed: number, id: string): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Scenario target-progress ratio (2026-07-26): for a scenario provider with a
// stated target covering this slot, fairness steering is placed / target —
// the least-variance objective (the manifest's numbers ARE the block's fair
// share, historical deficits deliberately excluded). Null = no stated target
// (fall back to the lifetime/FTE ratio).
function scenarioTargetRatio(run: SolverRun, pid: string, slot: SlotToFill): number | null {
  const scenario = run.scenario;
  if (!scenario) return null;
  const sp = scenario.providers.get(pid);
  if (!sp || slot.shift_type_category !== 'call') return null;
  if (slot.shift_type_code === scenario.neuroCode) {
    if (sp.neuroTarget == null) return null;
    const units = run.callCodeTally.get(`${pid}|S:${NEURO_KEY}`) || 0;
    return units / Math.max(sp.neuroTarget, 0.01);
  }
  const key = `${scenarioBucketOf(slot.slot_date)}|${slot.shift_type_code}`;
  const target = sp.targets.get(key);
  if (target == null) return null;
  const placed = run.callCodeTally.get(`${pid}|S:${key}`) || 0;
  return placed / Math.max(target, 0.01);
}

// Scenario soft-preference tier (2026-07-26): −1 when this slot matches a
// stated preference for the candidate, else 0 — a SOFT tier exactly like the
// request tiers (never a gate; caps/quotas/safety all still bind).
//   • weekday preference (Kalawadia "prefers Tuesday for C1"): the slot's dow
//     and code match.
//   • same-weekend preference (Simon "ideally on the same weekend as his
//     Friday C1"): the slot matches a preference member AND the provider has
//     a realized call in THIS weekend matching a member of the same-source
//     linkage (or another preference member) — the nudge that co-locates the
//     'ideally' pieces once one of them lands.
function scenarioPrefTier(run: SolverRun, pid: string, slot: SlotToFill): number {
  const scenario = run.scenario;
  if (!scenario || slot.shift_type_category !== 'call') return 0;
  const sp = scenario.providers.get(pid);
  if (!sp || sp.preferences.length === 0) return 0;
  const dow = dayOfWeekUTC(slot.slot_date);
  const code = slot.shift_type_code;
  for (const pref of sp.preferences) {
    if (pref.kind === 'weekday') {
      if (pref.weekday === dow && (pref.codes.length === 0 || pref.codes.includes(code))) return -1;
      continue;
    }
    if (pref.kind === 'same-weekend') {
      const matches = (m: { dow: number | null; date: string | null; code: string }) =>
        memberMatches(m, slot.slot_date, code, scenario.neuroCode);
      if (!pref.members.some(matches)) continue;
      const wk = weekendAnchorOf(slot.slot_date);
      if (!wk) continue;
      const led = run.state.callCodesByDate.get(pid);
      const companions = sp.linkages
        .filter(l => l.source === pref.source)
        .flatMap(l => l.members)
        .concat(pref.members.filter(m => !matches(m)));
      if (companions.some(m => memberRealizedInWeekend(led, m, wk, scenario.neuroCode))) return -1;
    }
  }
  return 0;
}

// Main-loop scoring tuple: request sort tier first (call-request PREFERRED
// tier -1 sorts before every neutral candidate; no-call penalized tier 1
// sorts after — soft in both directions, never a gate), then fair-grant
// count within the preferred tier, then fair-denial count within the
// penalized tier, then the SCENARIO soft-preference tier (2026-07-26 — soft
// like the request tiers, below them by design), then lowest ratio (lifetime
// bucket-ratio, or the scenario target-progress ratio for manifest
// providers), then least-recently called, then id — with the multi-start
// tie-break hash permuting ONLY that final id ordering when a nonzero seed
// is set. Shared by the main loop, spans, and quota relaxation. With no live
// requests, no scenario and seed 0 the tuple is the pre-change
// ratio/recency/id sort, byte for byte.
export function scoreCall(run: SolverRun, cands: CandidateProvider[], slot: SlotToFill) {
  const { ctx, state } = run;
  const k = `${dayTypeBucket(slot.derived_day_type)}|${slot.shift_type_code}`;
  const seed = run.tieBreakSeed;
  return cands.map(p => {
    const lifetime = (ctx.historicalAssignedByPid.get(p.id)?.get(k) || 0)
      + (state.bucketAssigned.get(`${p.id}|${k}`) || 0);
    const preferred = hasCallRequest(run, p.id, slot.slot_date);
    const penalized = !preferred && hasNoCallRequest(run, p.id, slot.slot_date);
    const targetRatio = scenarioTargetRatio(run, p.id, slot);
    return {
      p,
      tier: preferred ? -1 : penalized ? 1 : 0,
      granted: preferred ? (run.callReqGranted.get(p.id) || 0) : 0,
      violated: penalized ? (run.noCallViolated.get(p.id) || 0) : 0,
      prefTier: scenarioPrefTier(run, p.id, slot),
      ratio: targetRatio ?? (lifetime / Math.max(p.fte_value, 0.01)),
      recency: daysSinceLastCall(state, p.id, slot.slot_date),
    };
  }).sort((a, b) =>
    a.tier - b.tier ||
    a.granted - b.granted ||
    a.violated - b.violated ||
    a.prefTier - b.prefTier ||
    a.ratio - b.ratio ||
    b.recency - a.recency ||
    (seed ? (tieHash(seed, a.p.id) - tieHash(seed, b.p.id)) : 0) ||
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
  // Obligation cap (2026-07-24): a CALL-category link fill is a real call —
  // it must NEVER land past the provider's obligation (Gabriel: everything
  // past the cap is a PAID pickup a human places, the engine never does).
  // Properly admitted anchors reserved this room upfront (chainCallNeeds /
  // dayChainCallNeeds), so this guard only fires on placements no admission
  // gate could see — a call link nested under a chain link (the documented
  // recursion boundary). Refused and RECORDED (invariant 4), never silent;
  // the open slot falls to the main loop for providers with room.
  if (run.obligatory && target.shift_type_category === 'call' && capRoom(run, p.id) < 1) {
    run.skippedDerived.push({ date, code, provider_id: p.id, reason: 'obligation-cap' });
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
    // FTE gate (2026-07-27): the designed pair is intentionally half-placed
    // for a sub-floor anchor. Record it (invariant 4) and mark the target a
    // neuro REMAINDER so only a provider short of their requirement can take
    // it (eligibility 'neuro-remainder'); otherwise it stays open for the
    // admin, which is the stated behavior.
    // ORDERING IS DELIBERATE: this fires BEFORE the !target check, so a
    // minFte link whose target slot doesn't exist records 'fte-gated' rather
    // than 'no-slot'. The gate is the more specific truth (that link was
    // never going to fire for this provider), and invariant 4 is satisfied
    // either way — the severance is recorded, never silently dropped.
    if (!linkFiresFor(link, chosen.fte_value)) {
      skippedDerived.push({ date, code: link.code, provider_id: chosen.id, reason: 'fte-gated' });
      const gatedTarget = ctx.slotIndex.get(date)?.get(link.code);
      if (gatedTarget) state.neuroRemainderSlotIds.add(gatedTarget.slot_id);
      continue;
    }
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
      // Obligation cap (2026-07-24): a link pin for a DIFFERENT provider than
      // the designed partner was never reserved at anchor admission — an
      // at-cap pin is refused here, the severance recorded, and the slot
      // falls through to the main loop's forced gate ('obligation-cap').
      // The designed partner (f === chosen) IS reserved (chainCallNeeds
      // counted this link at the anchor) and stays un-gated: gating it would
      // sever a healthy designed pairing at the recursion boundary.
      if (f && f.id !== chosen.id && run.obligatory
        && target.shift_type_category === 'call' && capRoom(run, f.id) < 1) {
        skippedDerived.push({
          date: target.slot_date, code: target.shift_type_code,
          provider_id: f.id, reason: 'obligation-cap',
        });
        continue; // slot stays unhandled — main loop reports it
      }
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

// Workday DEFICIT (work-to-required, 2026-07-24): how many more working days
// the provider must still be credited to reach `required` (round(FTE × WD) −
// PTO). Live during the solve — every placement/credit shrinks it. 0 without a
// budget (bare/parity fixtures) so every deficit comparison below is inert.
export function workDayDeficit(run: SolverRun, pid: string): number {
  const b = run.budget?.byProvider.get(pid);
  if (!b) return 0;
  return Math.max(0, b.required - (run.state.creditedWorkDays.get(pid)?.size ?? 0));
}

// "First on out-list" ranking (relief + mop-up), two modes (work-to-required,
// 2026-07-24 — design decision, stated deliberately):
//   'early-out'  — the FIRST relief position on a date (its holder leaves
//     earliest, so next-call adjacency is the clinical point of the code):
//     soonest next call, then that call's rank tier, then most-recently-
//     called — the full clinical tuple PRESERVED — with the workday deficit
//     only breaking exact clinical ties (it replaces part of the arbitrary
//     id tiebreak, never a clinical key).
//   'inventory'  — every later relief position and every mop-up orphan is
//     coverage inventory whose block-level job is getting every provider to
//     their required working days: the DEFICIT (descending) is the primary
//     tier, and the clinical next-call tuple is preserved WITHIN a tier, so
//     equal-deficit candidates still order clinically.
// Without a workDayBudget every deficit is 0 and both modes reduce to the
// pre-change clinical ordering byte for byte (golden parity / fillAll pins).
export type ReliefRankMode = 'early-out' | 'inventory';
export function rankByNextCall(
  run: SolverRun, cands: CandidateProvider[], date: string,
  mode: ReliefRankMode = 'early-out',
) {
  return cands.map(p => {
    const nextCall = (run.providerCalls.get(p.id) || []).find(c => c.date > date);
    return {
      p,
      deficit: workDayDeficit(run, p.id),
      distance: nextCall ? daysBetween(date, nextCall.date) : Infinity,
      tier: nextCall ? run.callRank(nextCall.code) : 99,
      recency: daysSinceLastCall(run.state, p.id, date),
    };
  }).sort((a, b) => (mode === 'inventory'
    ? b.deficit - a.deficit ||
      a.distance - b.distance || a.tier - b.tier ||
      a.recency - b.recency || a.p.id.localeCompare(b.p.id)
    : a.distance - b.distance || a.tier - b.tier ||
      a.recency - b.recency || b.deficit - a.deficit ||
      a.p.id.localeCompare(b.p.id)),
  );
}

// Map an eligibility rejection reason to a skippedDerived reason.
export function skipReasonFrom(reason: string | undefined): SkippedDerived['reason'] {
  if (reason === 'availability-blocked' || reason === 'weekend-adjacent-pto') return 'pto';
  if (reason === 'cross-site') return 'cross-site';
  if (reason === 'same-date') return 'occupied';
  return 'ineligible';
}
