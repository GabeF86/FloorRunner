// The house FTE-weighted call-obligation formula (spec choice A):
//   target = (slots in the bucket ÷ site call_par_level) × provider FTE.
// Single source for: grid over-par red cells, modal Extra Calls, and the
// modal's expected-calls displays. Blind to eligibility by design (mirrors
// the pre-existing Extra Calls semantics).
export function fteWeightedTarget(bucketTotal: number, parLevel: number, fte: number): number {
  if (!Number.isFinite(parLevel) || parLevel <= 0) return 0;
  return (bucketTotal / parLevel) * fte;
}

// ── Whole-number obligations, TOTAL level (2026-07-17) ───────────────────────
// A provider's obligatory call count is the ROUNDED total expected calls:
//   round( Σ_buckets fteWeightedTarget(bucketTotal, par, fte) )
//     ≡ round( totalCallSlots / par × fte )     (linearity)
// Round-half-up (Math.round): 1.5 → 2, 1.3 → 1, 0.45 → 0. Calls up to the
// rounded obligation are NEVER counted or labeled as extra. This rounding
// defines obligation/extra ACCOUNTING (and the engine's obligatory-mode cap);
// category-level fairness/rotation keeps the FRACTIONAL targets for ordering.
// Single home shared by the schedule grid, the Call Counts modal, and the
// rules engine (src/lib/rulesEngine/obligation.ts) so the three can't drift.
export function roundedObligation(totalExpected: number): number {
  if (!Number.isFinite(totalExpected) || totalExpected <= 0) return 0;
  return Math.round(totalExpected);
}

// Extra calls = everything past the rounded obligation, floored at 0.
export function extraCalls(actualCalls: number, totalExpected: number): number {
  return Math.max(0, actualCalls - roundedObligation(totalExpected));
}

// ── Effective par: the clamp shared by engine and UI (2026-07-17) ────────────
// A stored `sites.call_par_level` above the pool's summed FTE would make every
// FTE share proportionally short, so the engine clamps its quota denominator
// DOWN to Σ pool FTE (genContext.effectiveParLevel, which delegates here) —
// never up. The UI's obligation math MUST use the same clamp: with the live
// data (par 11, pool ΣFTE 8.82) a stored-par denominator makes every UI
// obligation ~20-25% lower than the engine's cap, so an obligatory-mode
// generation would render OVER labels on calls the engine placed WITHIN
// obligation. Zero/empty pool keeps the stored par (nothing to clamp to).
export function clampParToPoolFte(parLevel: number, poolFte: number): number {
  return poolFte > 0 ? Math.min(parLevel, poolFte) : parLevel;
}

// One call assignment as the OVER-selection helper sees it.
export interface OverParCall {
  id: string;           // assignment id
  provider_id: string;
  slot_date: string;    // ISO date
  shift_type_code: string;
}

// Per-slot OVER labeling (2026-07-17): when a provider exceeds their rounded
// TOTAL obligation, only their LAST N call assignments get the OVER treatment
// (N = extraCalls), chronological by slot_date with shift-code tiebreak — not
// every cell they own. `totalExpectedFor` returns the provider's FRACTIONAL
// total expected calls (the caller computes it from whatever slot totals it
// already has; the rounding lives here).
export function selectOverParAssignmentIds(
  calls: OverParCall[],
  totalExpectedFor: (providerId: string) => number,
): Set<string> {
  const byPid = new Map<string, OverParCall[]>();
  for (const c of calls) {
    const list = byPid.get(c.provider_id);
    if (list) list.push(c); else byPid.set(c.provider_id, [c]);
  }
  const over = new Set<string>();
  for (const [pid, list] of byPid) {
    const extra = extraCalls(list.length, totalExpectedFor(pid));
    if (extra <= 0) continue;
    list.sort((a, b) =>
      a.slot_date.localeCompare(b.slot_date)
      || a.shift_type_code.localeCompare(b.shift_type_code)
      || a.id.localeCompare(b.id));
    for (const c of list.slice(-extra)) over.add(c.id);
  }
  return over;
}

// ── Shared grid/modal obligation census (2026-07-17) ─────────────────────────
// ONE derivation of every obligation input the schedule page needs, consumed
// by BOTH the grid over-par memo and the Call Counts modal so the two surfaces
// cannot feed different denominators or call lists into the shared selector.
// (Before this, the grid counted every call-category slot while the modal
// skipped holiday day types and restricted to C1/C2/C3 — same selector,
// different inputs, disagreeing red cells.)
//
// Census rules (mirrors the engine, src/lib/rulesEngine/obligation.ts):
//   - totalCallSlots = EVERY call-category slot instance — holiday-dated
//     included, ANY call code (CB/beeper etc.), filled or not. Engine
//     equivalent: open call slots + call seeds.
//   - effectivePar  = clampParToPoolFte(stored par, generation-pool ΣFTE).
//     Pool mirrors loadGenerationContext: a non-empty `included_provider_ids`
//     override NARROWS the pool (Gabriel 2026-07-21) — it skips only the
//     home-site gate; the call_taker/partial_call_taker role criterion is
//     always intersected (a day doc in a custom pool never counts toward
//     call-pool FTE). Default pool = home-site call/partial-call takers.
//     Grid profiles are already restricted to active providers of the
//     schedule's provider group.
//   - fte coercion `|| 1` matches genContext's profile load (null/0 → 1);
//     providers with no profile default to 1 (pre-existing UI semantics —
//     expected stays blind to eligibility by design).

export interface CensusProfile {
  provider_id: string;
  home_site_id: string | null;
  call_taker: boolean;
  partial_call_taker: boolean;
  fte_value: number | null;
}

export interface CensusSlot {
  slot_date: string;
  shift_types: { category: string; code: string } | null;
  assignments?: Array<{ id: string; provider_id: string | null }> | null;
}

export interface CallObligationCensusInput {
  storedParLevel: number;              // sites.call_par_level (caller applies the ?? 12 fallback)
  siteId: string;                      // schedule.site_id — scopes the default pool
  includedProviderIds?: string[] | null; // schedule.included_provider_ids override pool
  profiles: CensusProfile[];
  slots: CensusSlot[];
}

export interface CallObligationCensus {
  poolFte: number;
  effectivePar: number;
  totalCallSlots: number;
  callRecords: OverParCall[];
  // Real FTE for ANY provider (profile value, engine coercion, `?? 1` when
  // unprofiled) — for workday math and display, which apply to everyone.
  fteFor: (providerId: string) => number;
  // CALL-OBLIGATION weight: the provider's FTE when they are a member of the
  // call pool, 0 otherwise (2026-07-22, Gabriel's 53.3-expected report — a day
  // doc owes zero calls; summing real FTE over non-pool providers inflated
  // every Expected figure by nonPoolFte/effectivePar). All obligation-derived
  // numbers (totalExpectedFor, over-par selection, the modal's Expected row)
  // MUST weight by this, never by fteFor.
  poolFteFor: (providerId: string) => number;
  totalExpectedFor: (providerId: string) => number;  // fractional — callers round via roundedObligation
  actualCallsFor: (providerId: string) => number;
  overParAssignmentIds: Set<string>;
}

export function computeCallObligationCensus(input: CallObligationCensusInput): CallObligationCensus {
  const override = input.includedProviderIds && input.includedProviderIds.length > 0
    ? new Set(input.includedProviderIds)
    : null;

  let poolFte = 0;
  const fteByPid = new Map<string, number>();
  const poolPids = new Set<string>();
  for (const prof of input.profiles) {
    const fte = prof.fte_value || 1; // engine coercion (genContext profile load)
    fteByPid.set(prof.provider_id, fte);
    // Role criterion applies on BOTH paths (override = narrowing, never
    // widening — mirrors genContext §3); override skips only the home-site gate.
    const inPool = (prof.call_taker || prof.partial_call_taker) && (override
      ? override.has(prof.provider_id)
      : prof.home_site_id === input.siteId);
    if (inPool) { poolFte += fte; poolPids.add(prof.provider_id); }
  }
  const effectivePar = clampParToPoolFte(input.storedParLevel, poolFte);

  let totalCallSlots = 0;
  const callRecords: OverParCall[] = [];
  const actualByPid = new Map<string, number>();
  for (const slot of input.slots) {
    if (slot.shift_types?.category !== 'call') continue;
    totalCallSlots++;
    for (const a of slot.assignments || []) {
      if (!a.provider_id) continue;
      callRecords.push({
        id: a.id, provider_id: a.provider_id,
        slot_date: slot.slot_date, shift_type_code: slot.shift_types.code,
      });
      actualByPid.set(a.provider_id, (actualByPid.get(a.provider_id) || 0) + 1);
    }
  }

  const fteFor = (pid: string) => fteByPid.get(pid) ?? 1;
  // Obligation weight: pool members only. A non-pool provider (day doc, a
  // visiting doc outside the override) owes zero calls — every call they DO
  // hold is beyond obligation by definition (over-par selection sees it).
  const poolFteFor = (pid: string) => (poolPids.has(pid) ? fteByPid.get(pid)! : 0);
  const totalExpectedFor = (pid: string) => fteWeightedTarget(totalCallSlots, effectivePar, poolFteFor(pid));
  return {
    poolFte,
    effectivePar,
    totalCallSlots,
    callRecords,
    fteFor,
    poolFteFor,
    totalExpectedFor,
    actualCallsFor: pid => actualByPid.get(pid) || 0,
    overParAssignmentIds: selectOverParAssignmentIds(callRecords, totalExpectedFor),
  };
}
