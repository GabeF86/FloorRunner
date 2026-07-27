// Neuro weekend vocabulary (spec 2026-07-27). ONE home for three questions:
//   - how many weekend units does this FTE owe per block? (bands)
//   - how many has a provider actually earned? (pair 1.0 / single day 0.5)
//   - who is short?  (the report the generation banner shows)
// The solver's FTE gate, its remainder eligibility gate, its scoring tier and
// the generation report all consume this module, so they share ONE definition
// of owed/credited/short and cannot drift on the ARITHMETIC.
//
// They CAN disagree on WHO it applies to, deliberately (2026-07-27). scoreCall
// (solveKernel.ts) exempts any provider whose scenario manifest states a
// `neuroTarget` from the steering tier — there the manifest outranks the FTE
// band — while computeNeuroReport carries no such exemption. So a manifest
// provider with a stated target of 0 is intentionally not steered onto neuro
// and is then flagged short by the report. That is the accepted trade, not a
// bug: a visible false-positive on the generation banner, fixable in the
// workbook where the number lives, beats a silent misroute under scarcity.
// Don't "reconcile" the two by adding the exemption here — the report losing
// the row is exactly the silence the trade was made to avoid.
//
// SHARED WITH, BUT NOT EQUAL TO, the Call Counts "Obligatory Weekends" column
// (lib/callCountDays.ts). Shared: the weekend GROUPING (`weekendGroupKey` —
// the Fri/Sat/Sun group keyed by its Saturday) and the half-unit granularity
// (a pair is one, a lone weekend day is half). Different: the QUESTION. The
// UI column asks "did this doc give up their weekend?" and credits by call
// burden weight capped at one, so a 24h Saturday-only neuro call is 1.0 there.
// This module asks "how much of the neuro duty did they cover?", so the same
// call is 0.5 units here. Both answers are correct for their own question and
// this divergence is expected — do not edit either to match the other.
// WEIGHT_EPSILON absorbs float noise on comparisons.
import { WEIGHT_EPSILON } from '@/lib/callBurden';
import { weekendGroupKey } from '@/lib/weekendGroup';

export interface NeuroRequirementBand {
  minFte: number;
  units: number;
}

export interface NeuroWeekendConfig {
  code: string;
  requirementBands: NeuroRequirementBand[];
}

export interface NeuroPlacement {
  provider_id: string;
  slot_date: string;
  code: string;
}

export interface NeuroReportRow {
  provider_id: string;
  fte: number;
  owed: number;
  credited: number;
  short: number;
}

/** Units owed per block for `fte` — the highest band whose minFte it clears.
 * 0 when no band matches (a provider below every stated band owes nothing).
 * Ties (two bands stating the same minFte) resolve to whichever is declared
 * first in `requirementBands` — config authoring should avoid duplicates,
 * but this module does not guard against them. `fte` is expected positive;
 * it arrives from `CandidateProvider.fte_value`, which the context loader
 * already coerces (null/0 → 1). */
export function owedUnitsFor(fte: number, config: NeuroWeekendConfig): number {
  let best: NeuroRequirementBand | null = null;
  for (const band of config.requirementBands) {
    if (fte + WEIGHT_EPSILON < band.minFte) continue;
    if (!best || band.minFte > best.minFte) best = band;
  }
  return best?.units ?? 0;
}

/** Units earned per provider: neuro-code placements grouped into weekends,
 * each weekend capped at ONE unit and a lone day worth half. Non-neuro codes
 * and Mon–Thu dates contribute nothing. */
export function creditedUnitsByProvider(
  placements: ReadonlyArray<NeuroPlacement>,
  config: NeuroWeekendConfig,
): Map<string, number> {
  // pid -> weekend key -> distinct weekend DATES held
  const byPid = new Map<string, Map<string, Set<string>>>();
  for (const p of placements) {
    if (p.code !== config.code) continue;
    const key = weekendGroupKey(p.slot_date);
    if (!key) continue;
    let weekends = byPid.get(p.provider_id);
    if (!weekends) { weekends = new Map(); byPid.set(p.provider_id, weekends); }
    let dates = weekends.get(key);
    if (!dates) { dates = new Set(); weekends.set(key, dates); }
    dates.add(p.slot_date);
  }
  const out = new Map<string, number>();
  for (const [pid, weekends] of byPid) {
    let units = 0;
    for (const dates of weekends.values()) units += dates.size >= 2 ? 1 : 0.5;
    out.set(pid, units);
  }
  return out;
}

/** Shortfall in weekend units, epsilon-clamped so float noise never reports a
 * provider as owing a sliver they cannot possibly take. ONE definition, shared
 * by the report, the remainder gate and scoreCall's steering tier — the three
 * must never disagree about whether a provider is short. EXPORTED 2026-07-27:
 * the steering tier briefly carried its own `Math.max(0, owed - credited)`,
 * which is this function minus the epsilon clamp. */
export function shortfall(owed: number, credited: number): number {
  const gap = owed - credited;
  return gap <= WEIGHT_EPSILON ? 0 : gap;
}

/** The solver's per-provider call ledger — one `SolveState.callCodesByDate`
 * value, `date -> parent call codes realized so far` (seeds included) —
 * flattened into the placement shape this module consumes. Lives here because
 * the remainder gate and the steering tier both need it and MUST agree; the
 * adapter was briefly copied verbatim into both call sites (2026-07-27). */
export function ledgerPlacements(
  ledger: ReadonlyMap<string, ReadonlySet<string>> | undefined,
  providerId: string,
): NeuroPlacement[] {
  const out: NeuroPlacement[] = [];
  for (const [slot_date, codes] of ledger ?? []) {
    for (const code of codes) out.push({ provider_id: providerId, slot_date, code });
  }
  return out;
}

/** Credited units for ONE provider straight off their ledger. Callers scoring
 * a whole candidate list should instead build placements with
 * `ledgerPlacements` and make a single batched `creditedUnitsByProvider` call —
 * `creditedUnitsByProvider` is a batch function, and calling it once per
 * candidate with a one-element array is measurable inside the solver's hot
 * path. This is the convenience form for a gate judging one candidate. */
export function creditedUnitsFromLedger(
  ledger: ReadonlyMap<string, ReadonlySet<string>> | undefined,
  providerId: string,
  config: NeuroWeekendConfig,
): number {
  return creditedUnitsByProvider(ledgerPlacements(ledger, providerId), config)
    .get(providerId) || 0;
}

/** Per-provider owed/credited/short, for providers who owe anything at all.
 * Providers with NO placements are still reported — that is the case worth
 * catching, and the reason this lives here instead of in a per-assignment
 * evaluator (which would have nothing to anchor a flag on). */
export function computeNeuroReport(
  providers: ReadonlyArray<{ id: string; fte_value: number }>,
  placements: ReadonlyArray<NeuroPlacement>,
  config: NeuroWeekendConfig,
): NeuroReportRow[] {
  const credited = creditedUnitsByProvider(placements, config);
  const rows: NeuroReportRow[] = [];
  for (const p of providers) {
    const owed = owedUnitsFor(p.fte_value, config);
    if (owed <= 0) continue;
    const got = credited.get(p.id) || 0;
    rows.push({
      provider_id: p.id, fte: p.fte_value, owed, credited: got,
      short: shortfall(owed, got),
    });
  }
  return rows.sort((a, b) => a.provider_id.localeCompare(b.provider_id));
}

/** Is this provider still short by at least half a unit? The remainder gate's
 * question: only a short provider may take a leftover single neuro day. */
export function isShortByHalfUnit(
  fte: number, creditedUnits: number, config: NeuroWeekendConfig,
): boolean {
  return shortfall(owedUnitsFor(fte, config), creditedUnits) >= 0.5 - WEIGHT_EPSILON;
}

/** One human-readable warning per SHORT provider, for the generation banner.
 * Satisfied providers produce nothing. */
export function neuroShortfallWarnings(
  rows: ReadonlyArray<NeuroReportRow>,
  nameOf: (providerId: string) => string,
): string[] {
  return rows
    .filter(r => r.short > WEIGHT_EPSILON)
    .map(r => `${nameOf(r.provider_id)} is short ${r.short} of ${r.owed} `
      + `neuro weekend${r.owed === 1 ? '' : 's'} this block (has ${r.credited}).`);
}
