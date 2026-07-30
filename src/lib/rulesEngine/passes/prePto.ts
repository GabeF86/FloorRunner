// ── configurable placement passes (pre-PTO Thursday, etc.) ──
// Thursday -> providers with blocking PTO that week — PENDING included
// (isBlockingAvailability, spec §6.7: pending blocks everywhere, so pending
// also drives placement). genContext precomputes this; bare fixtures don't,
// so fall back to the shared builder (identical predicate). See ALGORITHM.md §7.
import { buildPrePtoByThursday } from '../shared';
import { evaluateEligibility } from '../eligibility';
import { record, applyDayChains, capRoom, capAdmitsPlacements, dayChainCallNeeds } from '../solveKernel';
import type { SolverRun } from '../solveKernel';
import type { SlotToFill, CandidateProvider } from '../genTypes';

export function runPrePtoPass(run: SolverRun): void {
  const { ctx, state } = run;
  const prePtoByThursday = ctx.prePtoByThursday
    ?? buildPrePtoByThursday(ctx.providers, ctx.availByPid, ctx.slotIndex);
  const tryPlacePrePto = (slot: SlotToFill | undefined, p: CandidateProvider): boolean => {
    if (!slot) return false;
    if (run.overrides?.has(slot.slot_id)) return false; // override authoritative; main loop handles it
    if (state.handledSlotIds.has(slot.slot_id)) return false;
    // Obligatory mode: a pre-PTO placement is a call assignment like any
    // other — it needs cap-room for itself PLUS every live call-category
    // dayChain link the placement will fire (2026-07-24 whole-block rule;
    // tryPlacePrePto never fires block chains, so dayChain links are the
    // whole charge). A provider without room is skipped — the slot falls to
    // the main loop / other candidates, never placed past the cap.
    if (run.obligatory && capRoom(run, p.id) < 1 + dayChainCallNeeds(run, slot)) return false;
    // Provider call caps (2026-07-22; generalized keys 2026-07-26): same
    // single-slot rule — a pre-PTO placement is best-effort and silently
    // skipped when the provider has no room left under any stated cap
    // (per-code or scenario) the placement would charge (the slot falls
    // through to the main loop / other candidates).
    if (run.callCaps && !capAdmitsPlacements(run, p.id,
      [{ date: slot.slot_date, code: slot.shift_type_code }])) return false;
    if (!evaluateEligibility(slot, p, state, ctx, 'call').eligible) return false;
    record(run, slot, p, 'pre-pto-thursday');
    applyDayChains(run, slot, p);
    return true;
  };
  for (const pass of run.doc.placementPasses) {
    if (pass.kind !== 'pre_pto' || !pass.enabled) continue;
    for (const [thuDate, pidSet] of prePtoByThursday) {
      const codeMap = ctx.slotIndex.get(thuDate);
      if (!codeMap) continue;
      const ranked = Array.from(pidSet).sort()
        .map(pid => run.providerById.get(pid))
        .filter((p): p is CandidateProvider => !!p);
      // Each PTO-bound provider (up to maxProviders) takes the first available
      // pass code (classic: C1 preferred, else C2). See ALGORITHM.md §7.
      //
      // maxProviders caps PLACEMENTS, not ATTEMPTS (Gabriel 2026-08: "the
      // engine is giving thursday calls to people that arent on pto the
      // following week, that should not happen").
      //
      // It used to slice the candidate list to maxProviders BEFORE testing
      // anything, and tryPlacePrePto is best-effort — it silently declines on
      // the obligation cap, a stated provider cap, or any eligibility gate. So
      // if one of the two sliced candidates could not take the slot, the pass
      // gave up and the Thursday fell to the main loop, where ANY provider
      // could take it — while other PTO-bound docs that week were still
      // available and untried. On the live Paoli block every leaking Thursday
      // had 2–5 pre-PTO docs to choose from, so this was never a supply
      // problem: it was the slice discarding candidates before asking them.
      //
      // Ordering is unchanged (provider-id sort — deterministic, and the
      // candidates are peers here), so a Thursday whose first candidates DO
      // succeed places exactly who it placed before.
      let placed = 0;
      for (const p of ranked) {
        if (placed >= pass.maxProviders) break;
        for (const code of pass.codes) {
          if (tryPlacePrePto(codeMap.get(code), p)) { placed++; break; }
        }
      }
    }
  }
}
