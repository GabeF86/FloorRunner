// Shared scaffolding for the per-facility staffing calculators. The facility
// algorithms differ (rooms/ratios/roles), but config clamping, break-analysis
// aggregation, severity thresholds, the break-coverage notes block, and the
// feasibility summary are identical — they live here.

import type {
  AvailableStaff, BreakAnalysis, BreakSource, CalculatorConfig, ConfigField,
} from './types';

export const BREAKS_PER_FLOAT = 5;

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
