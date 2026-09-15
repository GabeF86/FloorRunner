import { addDays, daysBetween } from './shared';
import { CLASSIC_PATTERN } from './callPattern';
import type { CallPatternDoc } from './callPattern';
import type { GenerationContext, SolutionPlan, SolutionMetrics } from './genTypes';

// Two call dates closer than this (in days) count as a burnout, UNLESS both
// fall inside the same pattern-block window (see blockExemptionWindows below):
// block chains deliberately give one provider adjacent calls (classic weekend
// chain Fri-C2 -> Sat-C1 -> Sun-C2), so tight spacing there is by design.
const BURNOUT_MIN_GAP_DAYS = 2;

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

// Burnout exemption windows, derived from the pattern doc instead of the old
// hard-coded Fri-Sun weekend set: for each doc.blocks entry, every date in the
// plan whose derived day type matches the block's anchorDayType opens a window
// [anchor + minOff, anchor + maxOff], where minOff/maxOff are the min/max link
// offsets across that block's chains together with 0 (the anchor itself).
// Classic: offsets {-1, +1} -> Fri-Sun around each Saturday — exact parity
// with the previous WEEKEND_BLOCK_DAY_TYPES behavior on engine-produced plans.
// Deliberately broad: windows anchor on ANY assignment matching anchorDayType
// and exempt ALL pairs inside — this is a metric tiebreak only, never validity.
//
// Anchors come from plan assignments AND call seeds, which must stay in step
// with what noteCall counts. When the numerator folded in seeds but this did
// not, the metric contradicted itself: a pattern-designed Sat/Sun chain scored
// 0 burnout when both halves were planned and 1 when the Saturday happened to
// be committed in an earlier pass — the same clinical situation, scored
// differently by an accident of staging. That mattered in the staged flow this
// change exists for: a Friday C2 left open by stage 1 and filled on Continue
// is movable, so at equal skips and fairness the optimizer was steering it
// AWAY from the provider the pattern wants paired.
function blockExemptionWindows(
  doc: CallPatternDoc,
  anchors: Array<{ slot_date: string; derived_day_type: string }>,
): Array<{ start: string; end: string }> {
  const windows: Array<{ start: string; end: string }> = [];
  if (doc.blocks.length === 0) return windows;
  const datesByDayType = new Map<string, Set<string>>();
  for (const a of anchors) {
    let set = datesByDayType.get(a.derived_day_type);
    if (!set) { set = new Set(); datesByDayType.set(a.derived_day_type, set); }
    set.add(a.slot_date);
  }
  for (const block of doc.blocks) {
    let minOff = 0;
    let maxOff = 0;
    for (const chain of block.chains) {
      for (const link of chain.links) {
        if (link.offset < minOff) minOff = link.offset;
        if (link.offset > maxOff) maxOff = link.offset;
      }
    }
    for (const anchor of datesByDayType.get(block.anchorDayType) ?? []) {
      windows.push({ start: addDays(anchor, minOff), end: addDays(anchor, maxOff) });
    }
  }
  return windows;
}

// Pure quality score for a solved schedule. Used as a report today and as the
// objective Phase 2b's local search minimizes.
export function scoreSolution(plan: SolutionPlan, ctx: GenerationContext): SolutionMetrics {
  const filled = plan.assignments.length;
  const skipped = plan.unfilled.length;
  const doc = ctx.callPattern ?? CLASSIC_PATTERN;

  // This-block call counts + call dates per provider. Call-ness is the shift
  // type's CATEGORY (both engines stamp it on every assignment), not a code
  // literal — custom call codes (e.g. 'NC') count exactly like C1.
  const blockCallCount = new Map<string, number>();
  const callDates = new Map<string, string[]>();
  const noteCall = (provider_id: string, slot_date: string) => {
    blockCallCount.set(provider_id, (blockCallCount.get(provider_id) || 0) + 1);
    const list = callDates.get(provider_id) || [];
    list.push(slot_date);
    callDates.set(provider_id, list);
  };
  for (const a of plan.assignments) {
    if (a.shift_type_category !== 'call') continue;
    noteCall(a.provider_id, a.slot_date);
  }
  // SEEDS COUNT TOO. Historical totals only reach back to before the block
  // starts, so a call already committed INSIDE this block was invisible here —
  // and that is the normal case in the staged flow (fill the weekends, commit,
  // then Continue over the rest, ALGORITHM.md §4.5). On the second pass every
  // committed weekend read as zero, so fairness saw a pool that had taken no
  // call and burnout could not see a new call landing a day after a committed
  // one. plan+seeds is the rule providerCaps.tallyCallsByPidCode,
  // obligation.planWithinObligations and workDayReport already use; this makes
  // the optimizer's objective agree with the caps it is optimizing against.
  for (const seed of ctx.seedAssignments) {
    if (seed.shift_type_category !== 'call') continue;
    noteCall(seed.provider_id, seed.slot_date);
  }

  // Fairness: stdev over the pool of lifetime ratio = (historical + block) / fte.
  const ratios: number[] = [];
  for (const p of ctx.providers) {
    const lifetime = historicalCallTotal(ctx, p.id) + (blockCallCount.get(p.id) || 0);
    ratios.push(lifetime / Math.max(p.fte_value, 0.01));
  }
  const fairnessStdev = populationStdev(ratios);

  // Burnout: per provider, count adjacent (date-sorted) call pairs spaced
  // < BURNOUT_MIN_GAP_DAYS apart that do NOT both fall inside the same
  // pattern-block exemption window.
  const windows = blockExemptionWindows(doc, [
    ...plan.assignments,
    ...ctx.seedAssignments.filter(s => s.shift_type_category === 'call'),
  ]);
  const exemptPair = (d1: string, d2: string) => // d1 <= d2
    windows.some(w => w.start <= d1 && d2 <= w.end);
  let burnout = 0;
  for (const list of callDates.values()) {
    const sorted = [...list].sort();
    for (let i = 1; i < sorted.length; i++) {
      const gap = daysBetween(sorted[i - 1], sorted[i]);
      if (gap < BURNOUT_MIN_GAP_DAYS && !exemptPair(sorted[i - 1], sorted[i])) {
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
