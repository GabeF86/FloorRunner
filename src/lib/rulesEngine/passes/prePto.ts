// ── configurable placement passes (pre-PTO Thursday, etc.) ──
// Thursday -> providers with blocking PTO that week — PENDING included
// (isBlockingAvailability, spec §6.7: pending blocks everywhere, so pending
// also drives placement). genContext precomputes this; bare fixtures don't,
// so fall back to the shared builder (identical predicate). See ALGORITHM.md §7.
import { buildPrePtoByThursday } from '../shared';
import { evaluateEligibility } from '../eligibility';
import { record, applyDayChains, capRoom } from '../solveKernel';
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
    // other — it needs cap-room. (tryPlacePrePto never fires block chains,
    // so one slot of room suffices.)
    if (run.obligatory && capRoom(run, p.id) < 1) return false;
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
