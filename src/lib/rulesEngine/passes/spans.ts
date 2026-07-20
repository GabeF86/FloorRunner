// ── spans: multi-day same-provider obligations (e.g. Neuro beeper) ──
// Each span is scored against every covered slot and placed atomically; when
// nobody can take all of them the slots are reported unfilled and fall to the
// main call loop individually. See ALGORITHM.md §15 field map.
import { addDays } from '../shared';
import { evaluateEligibility } from '../eligibility';
import { record, applyDayChains, scoreCall, capRoom, pushUnfilled } from '../solveKernel';
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
      // Obligatory mode: a span is one atomic multi-call obligation — charge
      // its call slots against the cap upfront, same rule as chain blocks.
      const spanCallCount = spanSlots.filter(s => s.shift_type_category === 'call').length;
      const candidates = run.obligatory
        ? eligibleForSpan.filter(p => capRoom(run, p.id) >= spanCallCount)
        : eligibleForSpan;
      if (candidates.length === 0) {
        // 'obligation-cap' only when the cap was the sole blocker (someone
        // was otherwise able to cover the whole span). The slots stay in
        // slotsToFill, so the main loop still attempts them individually
        // (within caps) — mirroring the existing severed-span fallback.
        const reason = run.obligatory && eligibleForSpan.length > 0
          ? 'obligation-cap' : 'No provider can cover full span';
        for (const s of spanSlots) pushUnfilled(run, s, reason);
        continue;
      }
      const winner = scoreCall(run, candidates, spanSlots[0])[0].p;
      for (const s of spanSlots) { record(run, s, winner, 'span'); applyDayChains(run, s, winner); }
    }
  }
}
