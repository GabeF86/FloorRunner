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
// byte-identical output (golden parity). See ALGORITHM.md §10.5.
import { evaluateEligibility } from '../eligibility';
import { record, rankByNextCall, pushUnfilled } from '../solveKernel';
import type { SolverRun } from '../solveKernel';

export function runMopUpPass(run: SolverRun, scheduleDates: string[]): void {
  const { ctx, state, plan, skippedDerived, waivedLinkKeys } = run;
  if (!ctx.shiftTypes) return;
  const alreadyReported = new Set(plan.unfilled.map(u => u.slot_id));
  const skippedKeys = new Set(skippedDerived.map(s => `${s.date}|${s.code}`));
  for (const date of scheduleDates) {
    const codeMap = ctx.slotIndex.get(date);
    if (!codeMap) continue;
    for (const code of [...codeMap.keys()].sort()) {
      const slot = codeMap.get(code)!;
      if (slot.shift_type_category === 'call') continue;           // call slots: main loop reports
      if (ctx.shiftTypes.get(code)?.generation_engine !== 'call') continue; // day_pool/none: other engines own it
      if (state.handledSlotIds.has(slot.slot_id)) continue;
      if (alreadyReported.has(slot.slot_id)) continue;             // relief pass already reported it
      if (run.sequenceOwnedSlotIds.has(slot.slot_id)) {
        const key = `${slot.slot_date}|${slot.shift_type_code}`;
        pushUnfilled(run, slot, skippedKeys.has(key)
          ? 'sequence-orphan: chain link severed'
          : waivedLinkKeys.has(key)
            ? 'sequence-orphan: pre-call fill waived'
            : 'sequence-orphan: chain source unfilled');
        continue;
      }
      const available = ctx.providers.filter(
        p => evaluateEligibility(slot, p, state, ctx, 'derived').eligible);
      if (available.length === 0) {
        pushUnfilled(run, slot, 'No eligible provider for call-engine day slot');
        continue;
      }
      // Orphans are pure coverage inventory (their chain semantics already
      // broke): rank deficit-first so under-required providers reach their
      // obligation (work-to-required, 2026-07-24); clinical next-call order
      // still decides within an equal-deficit tier.
      record(run, slot, rankByNextCall(run, available, date, 'inventory')[0].p, 'day-mop-up');
    }
  }
}
