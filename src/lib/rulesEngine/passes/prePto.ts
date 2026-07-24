// ── configurable placement passes (pre-PTO Thursday, etc.) ──
// Thursday -> providers with blocking PTO that week — PENDING included
// (isBlockingAvailability, spec §6.7: pending blocks everywhere, so pending
// also drives placement). genContext precomputes this; bare fixtures don't,
// so fall back to the shared builder (identical predicate). See ALGORITHM.md §7.
import { buildPrePtoByThursday } from '../shared';
import { evaluateEligibility } from '../eligibility';
import { record, applyDayChains, capRoom, callCapRoom, dayChainCallNeeds } from '../solveKernel';
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
    // Provider call caps (2026-07-22): same single-slot rule — a pre-PTO
    // placement is best-effort and silently skipped when the provider has no
    // room left under their stated per-code cap (the slot falls through to
    // the main loop / other candidates).
    if (run.callCaps && callCapRoom(run, p.id, slot.shift_type_code) < 1) return false;
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
      for (const p of ranked.slice(0, pass.maxProviders)) {
        for (const code of pass.codes) {
          if (tryPlacePrePto(codeMap.get(code), p)) break;
        }
      }
    }
  }
}
