// Neuro weekend vocabulary (spec 2026-07-27). ONE home for three questions:
//   - how many weekend units does this FTE owe per block? (bands)
//   - how many has a provider actually earned? (pair 1.0 / single day 0.5)
//   - who is short?  (the report the generation banner shows)
// The solver's FTE gate, its remainder eligibility gate, its scoring tier and
// the generation report ALL consume this module, so placement rules and the
// report can never drift apart.
//
// The half-weekend arithmetic deliberately matches the Call Counts
// "Obligatory Weekends" column (lib/callCountDays.ts): a weekend is the
// Fri/Sat/Sun group keyed by its Saturday, a pair is one unit, a lone
// weekend day is half. WEIGHT_EPSILON absorbs float noise on comparisons.
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
 * 0 when no band matches (a provider below every stated band owes nothing). */
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
      short: Math.max(0, owed - got),
    });
  }
  return rows.sort((a, b) => a.provider_id.localeCompare(b.provider_id));
}

/** Is this provider still short by at least half a unit? The remainder gate's
 * question: only a short provider may take a leftover single neuro day. */
export function isShortByHalfUnit(
  fte: number, creditedUnits: number, config: NeuroWeekendConfig,
): boolean {
  return owedUnitsFor(fte, config) - creditedUnits >= 0.5 - WEIGHT_EPSILON;
}
