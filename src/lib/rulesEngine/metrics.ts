import { daysBetween } from './shared';
import type { GenerationContext, SolutionPlan, SolutionMetrics } from './genTypes';

const CALL_CODES = ['C1', 'C2', 'C3'];
// Two call dates closer than this (in days) count as a burnout, UNLESS both
// fall on the Fri–Sun weekend block (the intended weekend call chain gives one
// provider Fri-C2 → Sat-C1 → Sun-C2, so adjacent calls within this block are
// by design, not burnout).
const BURNOUT_MIN_GAP_DAYS = 2;
const WEEKEND_BLOCK_DAY_TYPES = new Set(['friday', 'saturday', 'sunday']);

// Sum a provider's historical call count across all buckets.
function historicalCallTotal(ctx: GenerationContext, pid: string): number {
  const byBucket = ctx.historicalAssignedByPid.get(pid);
  if (!byBucket) return 0;
  let total = 0;
  for (const n of byBucket.values()) total += n;
  return total;
}

function populationStdev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(variance);
}

// Pure quality score for a solved schedule. Used as a report today and as the
// objective Phase 2b's local search minimizes.
export function scoreSolution(plan: SolutionPlan, ctx: GenerationContext): SolutionMetrics {
  const filled = plan.assignments.length;
  const skipped = plan.unfilled.length;

  // This-block call counts + call dates per provider.
  const blockCallCount = new Map<string, number>();
  const callDates = new Map<string, Array<{ date: string; weekend: boolean }>>();
  for (const a of plan.assignments) {
    if (!CALL_CODES.includes(a.shift_type_code)) continue;
    blockCallCount.set(a.provider_id, (blockCallCount.get(a.provider_id) || 0) + 1);
    const list = callDates.get(a.provider_id) || [];
    list.push({ date: a.slot_date, weekend: WEEKEND_BLOCK_DAY_TYPES.has(a.derived_day_type) });
    callDates.set(a.provider_id, list);
  }

  // Fairness: stdev over the pool of lifetime ratio = (historical + block) / fte.
  const ratios: number[] = [];
  for (const p of ctx.providers) {
    const lifetime = historicalCallTotal(ctx, p.id) + (blockCallCount.get(p.id) || 0);
    ratios.push(lifetime / Math.max(p.fte_value, 0.01));
  }
  const fairnessStdev = populationStdev(ratios);

  // Burnout: per provider, count adjacent (date-sorted) call pairs spaced
  // < BURNOUT_MIN_GAP_DAYS apart that are NOT a weekend pair.
  let burnout = 0;
  for (const list of callDates.values()) {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < sorted.length; i++) {
      const gap = daysBetween(sorted[i - 1].date, sorted[i].date);
      if (gap < BURNOUT_MIN_GAP_DAYS && !(sorted[i - 1].weekend && sorted[i].weekend)) {
        burnout++;
      }
    }
  }

  return {
    filled,
    skipped,
    fairnessStdev,
    burnout,
    providersUsed: blockCallCount.size,
  };
}
