// ── relief pass (codes + day types from the pattern; IF-2 fixes) ──
// "First on out-list" ranking via solveKernel.rankByNextCall; requires
// buildProviderCalls to have run. See ALGORITHM.md §10.
import { evaluateEligibility } from '../eligibility';
import { record, rankByNextCall, pushUnfilled } from '../solveKernel';
import type { SolverRun } from '../solveKernel';
import type { SlotToFill } from '../genTypes';

export function runReliefPass(run: SolverRun, scheduleDates: string[]): void {
  const { ctx, state, doc, reliefCodes } = run;
  if (!doc.reliefPass?.enabled) return;
  const reliefDayTypes = doc.reliefPass.dayTypes as string[];
  for (const date of scheduleDates) {
    const codeMap = ctx.slotIndex.get(date);
    if (!codeMap) continue;
    // Day-type gate from ANY existing relief slot (IF-2: not just D4/D5, so
    // dates whose only relief slots are D6-D9 are not skipped). All slots on
    // a date share one derived day type, so any sample decides for the date.
    const sampleD = reliefCodes.map(c => codeMap.get(c)).find((s): s is SlotToFill => !!s);
    if (!sampleD) continue;
    if (!reliefDayTypes.includes(sampleD.derived_day_type)) continue;

    // Work-to-required (2026-07-24, root-cause fix): candidates were formerly
    // PRE-FILTERED against the sample slot's eligibility, so a provider
    // ineligible for the SAMPLE code (per-code credential exclude) was dropped
    // for EVERY code that date — contradicting the per-code rescan below and
    // idling under-required providers while later-code inventory sat open.
    // Rank the whole pool instead; the per-code eligibility check in the scan
    // is the one and only gate. (Ranking a superset picks identically when
    // per-code eligibility matches the old prefilter — the sort is a total
    // order, so a filtered subset preserves relative order.)
    // The FIRST existing relief slot on the date is the "early-out" position —
    // clinical next-call ordering stays primary there; every later position is
    // inventory, ranked deficit-first (see rankByNextCall).
    const earlyOutSlotId = sampleD.slot_id;
    let earlyRanked: ReturnType<typeof rankByNextCall> | null = null;
    let inventoryRanked: ReturnType<typeof rankByNextCall> | null = null;

    for (const code of reliefCodes) {
      const slot = codeMap.get(code);
      if (!slot) continue;
      if (state.handledSlotIds.has(slot.slot_id)) continue;
      // Sequence-owned relief-code slot (e.g. weekend-v2's Friday D4, the
      // Sat-C3 block-chain link): NOT relief inventory. If its chain fired,
      // it is already handled above; if the chain broke, it must stay open
      // — the mop-up sweep reports the orphan (never fills it).
      if (run.sequenceOwnedSlotIds.has(slot.slot_id)) continue;
      const scored = slot.slot_id === earlyOutSlotId
        ? (earlyRanked ??= rankByNextCall(run, ctx.providers, date, 'early-out'))
        : (inventoryRanked ??= rankByNextCall(run, ctx.providers, date, 'inventory'));
      // IF-2: rescan from rank 0 per code — skip anyone already placed this
      // date or ineligible for THIS specific slot (per-code credential lists
      // differ). A provider skipped for one code is reconsidered for later ones.
      const pick = scored.find(s => !state.assignedOnDate.get(date)?.has(s.p.id)
        && evaluateEligibility(slot, s.p, state, ctx, 'derived').eligible);
      if (!pick) {
        pushUnfilled(run, slot, 'No eligible relief provider');
        continue;
      }
      record(run, slot, pick.p, 'relief-order');
    }
  }
}
