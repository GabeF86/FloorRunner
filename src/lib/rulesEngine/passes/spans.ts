// ── spans: multi-day same-provider obligations (e.g. Neuro beeper) ──
// Each span is scored against every covered slot and placed atomically; when
// nobody can take all of them the slots are reported unfilled and fall to the
// main call loop individually. See ALGORITHM.md §15 field map.
import { addDays } from '../shared';
import { evaluateEligibility } from '../eligibility';
import { record, applyDayChains, scoreCall, capRoom, capAdmitsPlacements, dayChainCallNeeds, pushUnfilled } from '../solveKernel';
import type { SolverRun } from '../solveKernel';
import type { SlotToFill } from '../genTypes';

export function runSpansPass(run: SolverRun, scheduleDates: string[]): void {
  const { ctx, state } = run;
  const dayTypeOfDate = (date: string): string | undefined => {
    for (const s of ctx.slotIndex.get(date)?.values() ?? []) return s.derived_day_type;
    return undefined;
  };
  for (const span of run.doc.spans) {
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
      // Provider call caps (2026-07-22; generalized keys 2026-07-26): a span
      // is admitted WHOLE against every stated cap — its call slots are
      // simulated together (per-code, and per (bucket,code)/NEURO/either-or
      // for scenario providers): the whole-block-admission rule, span-shaped.
      // Inert when no caps are stated.
      let capAdmitted = eligibleForSpan;
      if (run.callCaps) {
        const callPlacements = spanSlots
          .filter(s => s.shift_type_category === 'call')
          .map(s => ({ date: s.slot_date, code: s.shift_type_code }));
        capAdmitted = eligibleForSpan.filter(p => capAdmitsPlacements(run, p.id, callPlacements));
      }
      // Obligatory mode: a span is one atomic multi-call obligation — charge
      // its call slots against the cap upfront, same rule as chain blocks,
      // PLUS every live call-category dayChain link its placements will fire
      // (2026-07-24: applyDayChains runs per span slot; a call link is a real
      // call). A link targeting another span slot double-counts — a per-span
      // over-reservation the free-back-up rule absorbs (only real placements
      // consume the cap). The cap here is the obligation ceiling, NOT the
      // fairness quota — a refused span severs to capped individual fills.
      const spanCallCount = run.obligatory
        ? spanSlots.reduce((n, s) =>
            n + (s.shift_type_category === 'call' ? 1 : 0) + dayChainCallNeeds(run, s), 0)
        : 0;
      const candidates = run.obligatory
        ? capAdmitted.filter(p => capRoom(run, p.id) >= spanCallCount)
        : capAdmitted;
      if (candidates.length === 0) {
        // 'obligation-cap'/'provider-cap' only when that cap was the binding
        // blocker (someone was otherwise able to cover the whole span). The
        // slots stay in slotsToFill, so the main loop still attempts them
        // individually (within caps) — mirroring the severed-span fallback.
        const reason = run.callCaps && eligibleForSpan.length > 0 && capAdmitted.length === 0
          ? 'provider-cap'
          : run.obligatory && capAdmitted.length > 0
            ? 'obligation-cap' : 'No provider can cover full span';
        for (const s of spanSlots) pushUnfilled(run, s, reason);
        continue;
      }
      const winner = scoreCall(run, candidates, spanSlots[0])[0].p;
      for (const s of spanSlots) { record(run, s, winner, 'span'); applyDayChains(run, s, winner); }
    }
  }
}
