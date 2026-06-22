// Shared scaffolding for the per-facility staffing calculators. The facility
// algorithms differ (rooms/ratios/roles), but config clamping, break-analysis
// aggregation, severity thresholds, the break-coverage notes block, and the
// feasibility summary are identical — they live here.

import type {
  AvailableStaff, BreakAnalysis, BreakSource, CalculatorConfig, ConfigField,
} from './types';

export const BREAKS_PER_FLOAT = 5;

/* ── Staffing strategy weight ────────────────────────────────────────────────
   A global 3-way lever biasing the MD-vs-CRNA mix wherever a facility algorithm
   has a genuine choice (solo MD vs supervised CRNAs, MD float vs CRNA float).
   'balanced' reproduces each facility's default behavior exactly. */

export type StaffingWeight = 'solo' | 'balanced' | 'crna';

export const STAFFING_WEIGHT_OPTIONS: { value: string; label: string }[] = [
  { value: 'solo', label: 'More Solo MD' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'crna', label: 'More CRNA' },
];

// Shared config field — placed first in each facility schema so it renders at
// the top of the configuration card.
export function staffingWeightField(): ConfigField {
  return {
    key: 'staffingWeight',
    label: 'Staffing strategy',
    section: 'Staffing strategy',
    kind: 'select',
    defaultValue: 'balanced',
    options: STAFFING_WEIGHT_OPTIONS,
    helpText: 'Bias the MD-vs-CRNA mix where the algorithm has a choice.',
  };
}

export function readStaffingWeight(cfg: CalculatorConfig): StaffingWeight {
  const v = cfg.staffingWeight;
  return v === 'solo' || v === 'crna' ? v : 'balanced';
}

type Severity = BreakAnalysis['severity'];

// Coverage-percentage → severity band. One source of truth for the thresholds.
export function severityFor(pct: number): Severity {
  if (pct >= 100) return 'ok';
  if (pct >= 75) return 'tight';
  if (pct >= 50) return 'warning';
  return 'critical';
}

// Coerce + clamp a raw config against its schema: numbers rounded into
// [min,max] (NaN/missing/non-number → defaultValue), toggles → boolean.
// The pure calculate() functions can't trust the UI to have validated input.
export function clampConfig(schema: ConfigField[], cfgIn: CalculatorConfig): CalculatorConfig {
  const out: CalculatorConfig = {};
  for (const f of schema) {
    const raw = cfgIn[f.key];
    if (f.kind === 'toggle') {
      out[f.key] = Boolean(raw);
    } else if (f.kind === 'select') {
      const valid = (f.options || []).map((o) => o.value);
      out[f.key] = typeof raw === 'string' && valid.includes(raw) ? raw : (f.defaultValue as string);
    } else {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) {
        out[f.key] = f.defaultValue;
      } else {
        const lo = f.min ?? 0;
        const hi = f.max ?? Number.MAX_SAFE_INTEGER;
        out[f.key] = Math.min(hi, Math.max(lo, Math.round(n)));
      }
    }
  }
  return out;
}

// Aggregate break demand + sources into the BreakAnalysis the UI renders.
export function buildBreakAnalysis(demand: number, sources: BreakSource[]): BreakAnalysis {
  const capacity = sources.reduce((sum, s) => sum + s.breaks, 0);
  const gap = demand - capacity;
  const pctRaw = demand > 0 ? Math.round((capacity / demand) * 100) : 100;
  return {
    demand,
    capacity,
    sources,
    gap,
    pct: Math.min(pctRaw, 100),
    severity: severityFor(pctRaw),
    unrelieved: Math.max(0, gap),
  };
}

// The "── BREAK COVERAGE ──" notes block (header + per-source + total + a
// severity line). Returned as an array the facility appends to its notes.
export function breakCoverageNotes(a: BreakAnalysis): string[] {
  const out: string[] = ['── BREAK COVERAGE ──'];
  for (const s of a.sources) {
    out.push(`  ☕ ${s.label}: ${s.breaks} break${s.breaks !== 1 ? 's' : ''} (${s.detail})`);
  }
  out.push(`  📊 Total: ${a.capacity} break slots for ${a.demand} providers needing breaks`);
  const pct = a.pct;
  if (a.severity === 'ok') out.push(`  ✅ Coverage sufficient (${pct}%).`);
  else if (a.severity === 'tight') out.push(`  ⚠️ Coverage tight (${pct}%). Some breaks may be delayed.`);
  else if (a.severity === 'warning') out.push(`  🔴 Coverage strained (${pct}%). ${a.unrelieved} providers may not get timely breaks.`);
  else out.push(`  🚨 CRITICAL (${pct}%). ${a.unrelieved} providers will not get breaks without pulling coverage.`);
  return out;
}

/* ── Cross-cover resolution ──────────────────────────────────────────────────
   Intermittent / partial-day sites (DCCV/TEE, IR, cardioversions) don't always
   warrant a fully dedicated MD/CRNA. When a site is flagged "cross cover", the
   facility algorithm tallies the flexible coverage already on the board — float
   CRNAs/MDs, the schedule runner's spare capacity, the OB MD between cases, an
   idle Endo MD, supervising MDs below ratio — and lets that absorb the demand
   first. Only the unabsorbed remainder ("shortfall") becomes new headcount.
   Both facilities share this so the math + notes stay consistent. */

export interface CrossCoverFlexSource {
  label: string;     // e.g. "Floats", "OB MD", "Schedule runner"
  capacity: number;  // intermittent-coverage units this source can lend
}

export interface CrossCoverResolution {
  demand: number;        // intermittent rooms/cases needing coverage
  flexCapacity: number;  // sum of source capacities
  absorbed: number;      // min(demand, flexCapacity) — covered without new staff
  shortfall: number;     // demand the flex pool can't cover → needs dedicated staff
  sources: CrossCoverFlexSource[];
}

// Pure tally — how much of `demand` the flexible pool can absorb.
export function resolveCrossCover(
  demand: number, sources: CrossCoverFlexSource[],
): CrossCoverResolution {
  const d = Math.max(0, Math.floor(demand));
  const flexCapacity = sources.reduce((sum, s) => sum + Math.max(0, s.capacity), 0);
  const absorbed = Math.min(d, flexCapacity);
  return { demand: d, flexCapacity, absorbed, shortfall: Math.max(0, d - absorbed), sources };
}

// Human-readable explanation of a cross-cover outcome — appended to facility
// notes. Empty when there's no demand. Always names which flex sources covered
// it (or why extra staff was needed) so the plan is auditable.
export function crossCoverNotes(label: string, r: CrossCoverResolution): string[] {
  if (r.demand <= 0) return [];
  const out: string[] = [];
  const used = r.sources.filter((s) => s.capacity > 0).map((s) => `${s.label} ×${s.capacity}`);
  const usedText = used.length > 0 ? used.join(', ') : 'no flexible staff';
  const cases = (n: number) => `${n} case${n !== 1 ? 's' : ''}`;
  if (r.shortfall === 0) {
    out.push(`🔄 ${label} cross-covered — ${cases(r.demand)} absorbed by flexible coverage (${usedText}). No dedicated provider added.`);
  } else if (r.absorbed > 0) {
    out.push(`🔄 ${label} cross-cover — ${r.absorbed}/${r.demand} absorbed by flex (${usedText}); ${cases(r.shortfall)} need dedicated coverage.`);
    out.push(`🟠 ${label}: flexible coverage insufficient — added ${cases(r.shortfall)} of dedicated staffing.`);
  } else {
    out.push(`🟠 ${label} cross-cover requested but no flexible coverage available — added ${cases(r.demand)} of dedicated staffing.`);
  }
  return out;
}

// Additive feasibility summary: warn when the plan needs more staff than are
// available. Empty array when the plan fits.
export function feasibilityNotes(
  totalMDs: number, totalCRNAs: number, avail: AvailableStaff,
): string[] {
  const out: string[] = [];
  const mdOver = totalMDs - avail.mds;
  const crnaOver = totalCRNAs - avail.crnas;
  if (mdOver > 0) out.push(`🚨 Plan needs ${mdOver} more MD${mdOver !== 1 ? 's' : ''} than available (${totalMDs} planned / ${avail.mds} available).`);
  if (crnaOver > 0) out.push(`🚨 Plan needs ${crnaOver} more CRNA${crnaOver !== 1 ? 's' : ''} than available (${totalCRNAs} planned / ${avail.crnas} available).`);
  return out;
}
