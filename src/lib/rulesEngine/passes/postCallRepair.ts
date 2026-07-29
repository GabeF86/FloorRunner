// ── post-call repair pass (Gabriel 2026-07-29) ────────────────────────────
//
// THE BUG. A provider can be the target of two pattern rules on one date:
//   • their previous day's call declares a POST-CALL day code (weekendV2's
//     C2 → +1 D1; classic's the same), and
//   • a weekend block chain declares a day code on that same date (weekendV2's
//     saturday C3 neuro anchor → −1 D4 on the Friday before).
// dayTypeFillOrder fills SATURDAY before WEEKDAY, so the neuro anchor's D4
// lands first. When the Thursday C2 is placed later, its +1 D1 link finds the
// provider already assigned that Friday, records 'already-handled', and the
// D1 slot is left OPEN while the provider sits in D4.
//
// Live on the Paoli Aug-2026 block: Jones (Thu 8/13 C2, neuro 8/15-16) and
// Kalawadia (Thu 8/20 C2, neuro 8/22-23) both held Friday D4 with Friday D1
// empty, plus two more of the same shape. Gabriel: "if there are two linked D
// spots for one provider, obviously the lower one should have priority."
//
// WHY THE EXISTING RULE DID NOT COVER IT. The standing "post-call fill
// OVERRIDES any pre-call status" rule (preFillEviction.ts, 2026-07-19) has two
// writers, and neither reaches this case: sequenceAutoFill evicts DB rows on
// the manual path, and solveKernel.tryEvictSeedAndFill evicts SEEDS from a
// PREVIOUS generation — it explicitly refuses an in-plan same-run placement
// ("a live decision, not a stale seed"). Here the D4 is an in-run placement,
// so nothing displaced it.
//
// THE REPAIR. Rather than relax that guard mid-solve — which would let a
// post-call link displace arbitrary live decisions and put the weekend chains
// at risk — this runs as a separate pass once the call schedule is complete
// and moves the provider DOWN into the post-call slot the pattern already
// asked for. It only ever relocates a provider WITHIN one date, so no
// availability, post-call-rest, workday-credit or call-bucket fact changes:
// the provider works that day either way. What changes is which day code.
//
// ORDER. Runs after buildProviderCalls and BEFORE the relief and mop-up
// passes, so the day slot it vacates is still open for those passes to refill
// with somebody else (the whole point — the neuro doc's D4 should go to
// another provider, not go dark).
import { addDays } from '../shared';
import { dayChainsFor } from '../callPattern';
import { evaluateEligibility } from '../eligibility';
import { record } from '../solveKernel';
import { markAssigned } from '../solveState';
import type { SolverRun } from '../solveKernel';
import type { PlannedAssignment } from '../genTypes';

export function runPostCallRepairPass(run: SolverRun): void {
  const { ctx, state, doc, plan } = run;

  // Trigger set: every CALL the provider holds, from BOTH sources — this run's
  // placements and the seeds a Continue run started from. A seeded C2 declares
  // the same post-call link as a freshly placed one.
  const isCall = (a: { shift_type_category: string }) => a.shift_type_category === 'call';
  const triggers = [...plan.assignments, ...ctx.seedAssignments]
    .filter(a => isCall(a) && a.provider_id)
    .map(a => ({
      pid: a.provider_id, date: a.slot_date,
      code: a.shift_type_code, dayType: a.derived_day_type,
    }));

  for (const trigger of triggers) {
    for (const chain of dayChainsFor(doc, trigger.code, trigger.dayType)) {
      for (const link of chain.links ?? []) {
        // POST-call only. A negative offset is a pre-call fill, and the
        // "post-call overrides pre-call" precedence runs the other way — a
        // pre-call link must never pull a provider out of a post-call spot.
        if (link.offset <= 0) continue;
        const date = addDays(trigger.date, link.offset);
        const target = ctx.slotIndex.get(date)?.get(link.code);
        // Target must exist and still be genuinely OPEN. Two guards, because
        // they cover different things and neither subsumes the other:
        //   • ctx.slotIndex holds ONLY OPEN slots (genContext drops any slot
        //     whose assigned count meets required_count), so in production a
        //     slot someone already holds is simply absent here;
        //   • handledSlotIds catches everything placed during THIS run.
        // The seed sweep is belt-and-braces: seedSolveState does NOT populate
        // handledSlotIds, so a fixture (or any future loader that indexes
        // filled slots) must not let this pass move a provider on top of a
        // seeded assignment.
        if (!target || state.handledSlotIds.has(target.slot_id)) continue;
        if (ctx.seedAssignments.some(s =>
          s.slot_date === date && s.shift_type_code === link.code && s.provider_id)) continue;

        // Where is this provider on that date? Only a REGULAR slot placed by a
        // pattern LINK fill is movable, and both link kinds count:
        //   'd-chain'      — dayChains links (classic C1 → −1 D2)
        //   'weekend-chain' — block-chain links (weekendV2's saturday neuro
        //                     anchor → −1 D4, which is Gabriel's actual case)
        // Calls are never relocated, and main-loop / relief / mop-up / span /
        // pre-pto placements are decisions this pass has no mandate to
        // second-guess (relief and mop-up have not run yet anyway).
        const idx = plan.assignments.findIndex(a =>
          a.provider_id === trigger.pid
          && a.slot_date === date
          && a.shift_type_category === 'regular'
          && (a.source === 'd-chain' || a.source === 'weekend-chain'));
        if (idx < 0) continue;
        const current: PlannedAssignment = plan.assignments[idx];
        if (current.shift_type_code === link.code) continue;   // already right
        if (current.slot_id === target.slot_id) continue;

        const provider = ctx.providers.find(p => p.id === trigger.pid);
        if (!provider) continue;

        // Eligibility for the target, with the provider's OWN same-date claim
        // released — otherwise the move always self-rejects on 'same-date'.
        // Every other gate (site, credentials, locked slot, provider group,
        // post-call block) still runs, and the claim is restored either way:
        // the provider is assigned on this date regardless of which slot wins.
        state.assignedOnDate.get(date)?.delete(trigger.pid);
        const elig = evaluateEligibility(target, provider, state, ctx, 'derived');
        markAssigned(state, date, trigger.pid);
        if (!elig.eligible) continue;

        // Vacate, then place. Un-handling the old slot is what lets the relief
        // and mop-up passes hand it to somebody else.
        plan.assignments.splice(idx, 1);
        state.handledSlotIds.delete(current.slot_id);
        record(run, target, provider, 'd-chain');
        // record() appends. Put the relocated entry back where the original
        // sat so plan.assignments keeps its placement order — downstream
        // consumers (commitPlan, the golden plan pins, the parity net) compare
        // this array positionally, and a repair should change WHICH slot a
        // provider holds, never the order of the plan.
        plan.assignments.splice(idx, 0, plan.assignments.pop()!);
        (plan.postCallRepairs ??= []).push({
          date,
          provider_id: provider.id,
          provider_name: provider.short_display_name,
          from_code: current.shift_type_code,
          to_code: link.code,
          trigger_date: trigger.date,
          trigger_code: trigger.code,
        });
      }
    }
  }
}
