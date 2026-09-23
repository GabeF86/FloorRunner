// Build a CP-SAT model input from a GenerationContext.
//
// Lifted out of scripts/exportCpsatModel.ts so the model has one home and the
// apply path can rebuild it without shelling through a file. The script is now
// a thin caller.
//
// ── THE ONE DESIGN RULE THAT MAKES THE SOLVER SAFE ────────────────────────
// The model does NOT re-implement the clinical rules. It consumes the
// ENGINE'S OWN eligibility verdicts, so a pair the engine refuses is a pair
// the solver cannot use. Re-deriving "can this provider take this slot" in
// Python would let the solver "win" by forgetting a rule — e.g. the
// adjacent-week PTO exclusion — which is not a better schedule, it is a
// broken one.
//
// ── STATIC VS DYNAMIC GATES ───────────────────────────────────────────────
// evaluateEligibility is stateful. Run against an EMPTY solve state only the
// static gates can fire, so what comes back is exactly the static
// feasibility:
//
//   STATIC   → the variable domain (provider group, site credentials, weekday
//              availability, PTO/leave with bookend, adjacent-week weekend
//              exclusion, cross-schedule conflicts against published versions)
//
//   DYNAMIC  → exported as data, modelled as CONSTRAINTS in Python (one call
//              per provider per day, post-call rest, bucket quota, obligation
//              ceiling, pattern chains)
//
// 'call-no-quota' deliberately: the quota is a dynamic rule the model states
// explicitly, and letting it fire here would bake a greedy artefact into the
// domain.
//
// WHAT THE SOLVER IS NEVER ASKED TO DO: decide structure. It reassigns WHO
// holds an already-constructed call slot. Chains ride along as equalities,
// seeds are fixed, and every derived day slot is re-derived by solve()
// afterwards — see cpsatPolish.ts.
import { evaluateEligibility } from './eligibility';
import { emptySolveState } from './solveState';
import { totalExpectedCalls } from './obligation';
import { CLASSIC_PATTERN, dayChainsFor, postCallBlockOffsets } from './callPattern';
import { dayTypeBucketOn, addDays } from './shared';
import type { GenerationContext, SlotToFill } from './genTypes';

export interface CpsatModelSlot {
  id: string;
  date: string;
  code: string;
  dayType: string;
  bucket: string;
  /** Provider ids the engine says MAY hold this slot (static gates only). */
  eligible: string[];
  /** A seed the engine would not overwrite — fixed, not a decision. */
  fixedTo: string | null;
  /** Placing this slot blocks its holder on these dates (post-call rest). */
  blocksDates: string[];
}

export interface CpsatModelChain {
  /** Anchor slot id; the linked slot must go to the SAME provider. */
  from: string;
  to: string;
  kind: 'block' | 'dayChain';
}

export interface CpsatModelProvider {
  id: string;
  name: string;
  fte: number;
  obligation: number;
  /** Calls already committed elsewhere in this block (spent capacity). */
  priorCalls: number;
  busyDates: string[];
  bucketTargets: Record<string, number>;
}

export interface CpsatModel {
  meta: {
    versionId: string;
    from: string;
    to: string;
    parLevel: number;
    exportedAt: string | null;   // stamped by the caller, never in here
  };
  providers: CpsatModelProvider[];
  slots: CpsatModelSlot[];
  chains: CpsatModelChain[];
  stats: {
    callSlots: number;
    providers: number;
    feasiblePairs: number;
    seededSlots: number;
    priorCalls: number;
    chains: number;
    avgEligiblePerSlot: number;
    /** Slots no provider can hold even before a constraint — unfillable for
     *  the engine AND the solver. Reported, never hidden. */
    noCandidateSlots: number;
  };
}

/**
 * De-identification note: `name` is the provider's short display name and is
 * the ONLY human-readable field in the model. A remote solver service does not
 * need it — strip it before sending anything off this machine.
 */
export function buildCpsatModel(ctx: GenerationContext): CpsatModel {
  const doc = ctx.callPattern ?? CLASSIC_PATTERN;
  const callSlots = ctx.slotsToFill.filter(s => s.shift_type_category === 'call');
  const providers = ctx.providers.filter(p => p.fte_value > 0);

  const emptyState = emptySolveState();
  let pairs = 0;
  const slots: CpsatModelSlot[] = callSlots.map((s: SlotToFill) => {
    const eligible = providers
      .filter(p => evaluateEligibility(s, p, emptyState, ctx, 'call-no-quota').eligible)
      .map(p => p.id);
    pairs += eligible.length;
    return {
      id: s.slot_id,
      date: s.slot_date,
      code: s.shift_type_code,
      dayType: s.derived_day_type,
      bucket: `${dayTypeBucketOn(s.derived_day_type, s.slot_date)}|${s.shift_type_code}`,
      eligible,
      fixedTo: null,
      blocksDates: postCallBlockOffsets(doc, s.shift_type_code, s.derived_day_type)
        .map(o => addDays(s.slot_date, o)),
    };
  });

  // ── Seeds: calls ALREADY HELD, which the model must carry too ───────────
  // Seeded call slots are not in slotsToFill — they are done, not open. They
  // are far from irrelevant: they consume the holder's obligation, occupy a
  // date, and trigger post-call rest. The first version of the exporter
  // ignored them and handed the solver 16 calls of capacity the engine had
  // already spent, which flattered the challenger. A benchmark that flatters
  // the challenger is worse than no benchmark.
  const slotById = new Map(slots.map(s => [s.id, s]));
  let seeded = 0;
  const priorCalls: Record<string, number> = {};
  const busyDates: Record<string, string[]> = {};
  for (const seed of ctx.seedAssignments) {
    if (seed.shift_type_category !== 'call' || !seed.provider_id) continue;
    const target = seed.slot_id ? slotById.get(seed.slot_id) : undefined;
    if (target) { target.fixedTo = seed.provider_id; seeded++; continue; }
    priorCalls[seed.provider_id] = (priorCalls[seed.provider_id] ?? 0) + 1;
    (busyDates[seed.provider_id] ??= []).push(seed.slot_date);
    for (const o of postCallBlockOffsets(
      doc, seed.shift_type_code, seed.derived_day_type ?? 'weekday')) {
      busyDates[seed.provider_id].push(addDays(seed.slot_date, o));
    }
  }

  // ── Pattern chains: same-provider coupling ──────────────────────────────
  // A chain says "whoever takes the anchor also takes the link". The engine
  // enforces it by construction; the model needs it as an equality.
  const byDateCode = new Map<string, string>();
  for (const s of slots) byDateCode.set(`${s.date}|${s.code}`, s.id);
  const chains: CpsatModelChain[] = [];
  const addChain = (
    from: CpsatModelSlot, date: string, code: string, kind: CpsatModelChain['kind'],
  ) => {
    const to = byDateCode.get(`${date}|${code}`);
    if (to && to !== from.id) chains.push({ from: from.id, to, kind });
  };
  for (const s of slots) {
    for (const block of doc.blocks) {
      if (block.anchorDayType !== s.dayType) continue;
      for (const chain of block.chains) {
        if (chain.trigger !== s.code) continue;
        for (const link of chain.links) addChain(s, addDays(s.date, link.offset), link.code, 'block');
      }
    }
    for (const chain of dayChainsFor(doc, s.code, s.dayType)) {
      for (const link of chain.links ?? []) {
        addChain(s, addDays(s.date, link.offset), link.code, 'dayChain');
      }
    }
  }

  const obligations = totalExpectedCalls(ctx);
  return {
    meta: {
      versionId: ctx.scheduleVersionId,
      from: slots.reduce((a, s) => (s.date < a ? s.date : a), '9999'),
      to: slots.reduce((a, s) => (s.date > a ? s.date : a), '0000'),
      parLevel: ctx.parLevel,
      exportedAt: null,
    },
    providers: providers.map(p => ({
      id: p.id,
      name: p.short_display_name || p.id.slice(0, 8),
      fte: p.fte_value,
      obligation: Math.round(obligations.get(p.id) ?? 0),
      priorCalls: priorCalls[p.id] ?? 0,
      busyDates: [...new Set(busyDates[p.id] ?? [])],
      bucketTargets: Object.fromEntries(
        [...ctx.bucketTarget.entries()]
          .filter(([k]) => k.startsWith(`${p.id}|`))
          .map(([k, v]) => [k.slice(p.id.length + 1), v]),
      ),
    })),
    slots,
    chains,
    stats: {
      callSlots: slots.length,
      providers: providers.length,
      feasiblePairs: pairs,
      seededSlots: seeded,
      priorCalls: Object.values(priorCalls).reduce((a, b) => a + b, 0),
      chains: chains.length,
      avgEligiblePerSlot: +(pairs / Math.max(slots.length, 1)).toFixed(2),
      noCandidateSlots: slots.filter(s => s.eligible.length === 0 && !s.fixedTo).length,
    },
  };
}
