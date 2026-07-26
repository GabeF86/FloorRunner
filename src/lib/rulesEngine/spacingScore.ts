// Spacing score (Paoli phase 2, 2026-07-26) — the prompt's lexicographic
// optimization objective as a deterministic scoring function over a candidate
// plan. Multi-start (multiStart.ts) runs greedy+optimizer K times and keeps
// the lexicographically SMALLEST score tuple.
//
// CALL BLOCKS: maximal runs of same-provider call days joined by pattern
// chain or scenario linkage — a designed multi-day block (the Paoli weekend
// chain, a same-weekend linkage pair) is a SINGLE unit, so inside-block
// adjacency is never penalized. Two independent adjacent calls stay two
// blocks and are penalized via the gap keys.
//
// Score tuple, lower = better, in the prompt's priority order (3–9 after the
// two variance keys):
//   1 targetVariance     Σ |placed − target| (exact fractions; + unmet fixed)
//   2 workdayShortfall   Σ max(0, required − credited)
//   3 negMinGap          −(min inter-block gap) — maximizing the min gap
//   4 gapsLe2            count of gaps ≤ 2 days (near-adjacent blocks)
//   5 consecutiveWeekends count of adjacent weekend pairs with calls
//   6 gapVariance        Σ per-provider population variance of gaps
//   7 spreadDeviation    early/mid/late tertile deviation from even spread
//   8 rolling7Multi      adjacent block pairs starting within a 7-day window
//   9 softPrefViolations scenario preference violations
import { addDays, daysBetween, dayOfWeekUTC, dayTypeFromDow } from './shared';
import { CLASSIC_PATTERN, blockChainsFor, dayChainsFor } from './callPattern';
import { parentCallCodeOf } from '@/lib/callBurden';
import { tallyCallsByPidCode } from './providerCaps';
import { computeWorkDayReport } from './workDayReport';
import {
  scenarioBucketOf, weekendAnchorOf, memberMatches, NEURO_KEY,
} from './scenario';
import type { GenerationContext, SolutionPlan } from './genTypes';

export const SPACING_SCORE_KEYS = [
  'targetVariance', 'workdayShortfall', 'negMinGap', 'gapsLe2',
  'consecutiveWeekends', 'gapVariance', 'spreadDeviation',
  'rolling7Multi', 'softPrefViolations',
] as const;

const SCORE_EPS = 1e-9;

export function compareSpacingScores(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (Math.abs(d) > SCORE_EPS) return d;
  }
  return 0;
}

export interface CallBlockRun {
  start: string;
  end: string;
  dates: string[]; // sorted distinct call dates in the block
}

interface CallEvent { date: string; code: string } // code parent-mapped

// Every provider's realized call events (plan + seeds), parent-mapped and
// date-sorted. Shared by block computation, variance and preference keys.
function callEventsByPid(ctx: GenerationContext, plan: SolutionPlan): Map<string, CallEvent[]> {
  const out = new Map<string, CallEvent[]>();
  const push = (pid: string, date: string, code: string) => {
    const parent = parentCallCodeOf(code, ctx.shiftTypes?.get(code));
    const list = out.get(pid) ?? [];
    list.push({ date, code: parent });
    out.set(pid, list);
  };
  for (const a of plan.assignments) {
    if (a.shift_type_category === 'call') push(a.provider_id, a.slot_date, a.shift_type_code);
  }
  for (const s of ctx.seedAssignments) {
    if (s.shift_type_category === 'call') push(s.provider_id, s.slot_date, s.shift_type_code);
  }
  for (const list of out.values()) list.sort((x, y) => x.date.localeCompare(y.date) || x.code.localeCompare(y.code));
  return out;
}

// Are two call events (a.date <= b.date) joined BY DESIGN — a pattern block
// chain, a call-category dayChain link, or a hard scenario same-weekend/
// same-date linkage? Day types derive from the day of week (holiday typing is
// unknowable post-hoc; every shipped pattern scopes holiday day types with
// weekday — the sequenceOwnership precedent).
function joinedByDesign(
  ctx: GenerationContext, pid: string, a: CallEvent, b: CallEvent,
): boolean {
  if (a.date === b.date) return true; // split segments / overlay coexistence
  const doc = ctx.callPattern ?? CLASSIC_PATTERN;
  const offset = daysBetween(a.date, b.date);
  const dayTypeOf = (d: string) => dayTypeFromDow(dayOfWeekUTC(d));

  // Block chains, both directions (anchor at a linking forward to b, or
  // anchor at b linking backward to a).
  const anchors: Array<[CallEvent, CallEvent, number]> = [[a, b, offset], [b, a, -offset]];
  for (const [anchor, other, off] of anchors) {
    const links = blockChainsFor(doc, dayTypeOf(anchor.date)).get(anchor.code);
    if (links && links.some(l => l.offset === off && l.code === other.code)) return true;
    // Call-category dayChain links (rare; the seam matches chainCallNeeds).
    for (const chain of dayChainsFor(doc, anchor.code, dayTypeOf(anchor.date))) {
      if ((chain.links ?? []).some(l => l.offset === off && l.code === other.code)) return true;
    }
  }

  // Hard scenario linkages: both events match distinct members within the
  // linkage's scope (same weekend / same date).
  const sp = ctx.scenario?.providers.get(pid);
  if (sp) {
    const neuro = ctx.scenario!.neuroCode;
    for (const l of sp.linkages) {
      if (l.members.length < 2) continue;
      if (l.kind === 'same-weekend') {
        const wa = weekendAnchorOf(a.date);
        if (wa == null || wa !== weekendAnchorOf(b.date)) continue;
      } else if (l.kind === 'same-date') {
        continue; // different dates by construction here
      } else {
        continue;
      }
      const mA = l.members.findIndex(m => memberMatches(m, a.date, a.code, neuro));
      if (mA < 0) continue;
      if (l.members.some((m, i) => i !== mA && memberMatches(m, b.date, b.code, neuro))) return true;
    }
  }
  return false;
}

// Maximal joined runs per provider. Transitive: consecutive events chain into
// one block when each adjacent pair (or any pair within the block's reach) is
// design-joined. Events are few per provider — the quadratic pass is cheap
// and deterministic.
export function computeCallBlocks(
  ctx: GenerationContext, plan: SolutionPlan,
): Map<string, CallBlockRun[]> {
  const out = new Map<string, CallBlockRun[]>();
  for (const [pid, events] of callEventsByPid(ctx, plan)) {
    const blocks: CallEvent[][] = [];
    for (const e of events) {
      const current = blocks[blocks.length - 1];
      if (current && current.some(prev => joinedByDesign(ctx, pid, prev, e))) {
        current.push(e);
      } else {
        blocks.push([e]);
      }
    }
    out.set(pid, blocks.map(evts => {
      const dates = [...new Set(evts.map(e => e.date))].sort();
      return { start: dates[0], end: dates[dates.length - 1], dates };
    }));
  }
  return out;
}

// ── the score tuple ──────────────────────────────────────────────────────────

export function spacingScore(ctx: GenerationContext, plan: SolutionPlan): number[] {
  const scenario = ctx.scenario ?? null;
  const events = callEventsByPid(ctx, plan);

  // 1 — mandatory + target variance (exact fractions, incl. NEURO units and
  // unrealized scenario fixed assignments).
  let targetVariance = 0;
  if (scenario) {
    const tally = tallyCallsByPidCode(plan.assignments, ctx.seedAssignments, ctx.shiftTypes, scenario);
    for (const sp of scenario.providers.values()) {
      const pid = sp.provider_id;
      for (const [key, target] of sp.targets) {
        targetVariance += Math.abs((tally.get(`${pid}|S:${key}`) || 0) - target);
      }
      if (sp.neuroTarget != null) {
        targetVariance += Math.abs((tally.get(`${pid}|S:${NEURO_KEY}`) || 0) - sp.neuroTarget);
      }
      for (const f of sp.fixedAssignments) {
        const realized = (events.get(pid) ?? []).some(e => e.date === f.date && e.code === f.code);
        if (!realized) targetVariance += 1;
      }
    }
  }

  // 2 — workday shortfall (0 without a budget).
  let workdayShortfall = 0;
  if (ctx.workDayBudget) {
    for (const row of computeWorkDayReport(ctx, plan)) {
      if (row.delta < 0) workdayShortfall += -row.delta;
    }
  }

  // Blocks + gaps.
  const blocksByPid = computeCallBlocks(ctx, plan);
  const spanDays = scheduleSpanDays(ctx);
  const allGaps: number[] = [];
  let gapsLe2 = 0;
  let gapVariance = 0;
  let rolling7Multi = 0;
  let spreadDeviation = 0;
  let consecutiveWeekends = 0;
  for (const [pid, blocks] of blocksByPid) {
    const gaps: number[] = [];
    for (let i = 1; i < blocks.length; i++) {
      const gap = daysBetween(blocks[i - 1].end, blocks[i].start);
      gaps.push(gap);
      if (gap <= 2) gapsLe2++;
      if (gap < 7) rolling7Multi++;
    }
    allGaps.push(...gaps);
    if (gaps.length >= 2) {
      const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      gapVariance += gaps.reduce((s, g) => s + (g - mean) * (g - mean), 0) / gaps.length;
    }
    // Early/mid/late tertile spread of block starts.
    if (blocks.length > 0 && spanDays.days > 0) {
      const counts = [0, 0, 0];
      for (const b of blocks) {
        const frac = daysBetween(spanDays.start, b.start) / spanDays.days;
        counts[Math.min(2, Math.max(0, Math.floor(frac * 3)))]++;
      }
      const expected = blocks.length / 3;
      spreadDeviation += counts.reduce((s, c) => s + Math.abs(c - expected), 0);
    }
    // Consecutive weekends: adjacent weekend anchors exactly 7 days apart.
    const weekendAnchors = [...new Set(
      (events.get(pid) ?? []).map(e => weekendAnchorOf(e.date)).filter((w): w is string => w != null),
    )].sort();
    for (let i = 1; i < weekendAnchors.length; i++) {
      if (daysBetween(weekendAnchors[i - 1], weekendAnchors[i]) === 7) consecutiveWeekends++;
    }
  }
  const minGap = allGaps.length > 0 ? Math.min(...allGaps) : spanDays.days;

  // 9 — soft preference violations.
  let softPrefViolations = 0;
  if (scenario) {
    for (const sp of scenario.providers.values()) {
      const own = events.get(sp.provider_id) ?? [];
      for (const pref of sp.preferences) {
        if (pref.kind === 'weekday' && pref.weekday != null) {
          const bucketOfPref = scenarioBucketOf(dateForDow(pref.weekday));
          softPrefViolations += own.filter(e =>
            (pref.codes.length === 0 || pref.codes.includes(e.code))
            && scenarioBucketOf(e.date) === bucketOfPref
            && dayOfWeekUTC(e.date) !== pref.weekday).length;
        } else if (pref.kind === 'same-weekend') {
          // Effective member set: the preference members plus the members of
          // any same-source hard linkage (the "ideally same weekend as" tie).
          const effective = [
            ...pref.members,
            ...sp.linkages.filter(l => l.source === pref.source).flatMap(l => l.members),
          ];
          if (effective.length === 0) continue;
          const weekends = new Set<string>();
          for (const e of own) {
            const wk = weekendAnchorOf(e.date);
            if (wk && effective.some(m => memberMatches(m, e.date, e.code, scenario.neuroCode))) {
              weekends.add(wk);
            }
          }
          if (weekends.size > 1) softPrefViolations += weekends.size - 1;
        }
      }
    }
  }

  return [
    targetVariance,
    workdayShortfall,
    -minGap,
    gapsLe2,
    consecutiveWeekends,
    gapVariance,
    spreadDeviation,
    rolling7Multi,
    softPrefViolations,
  ];
}

// The block span (first..last schedule date) — for the tertile spread and the
// no-gaps minGap default (an unpenalized best case).
function scheduleSpanDays(ctx: GenerationContext): { start: string; days: number } {
  const dates = ctx.scheduleDates ?? Array.from(ctx.slotIndex.keys()).sort();
  if (dates.length === 0) return { start: '1970-01-01', days: 0 };
  return { start: dates[0], days: Math.max(1, daysBetween(dates[0], dates[dates.length - 1]) + 1) };
}

// Any concrete date falling on `dow` (for bucket classification of a
// preferred weekday — Mon..Thu → MTH etc.). 2026-08-09 is a Sunday.
function dateForDow(dow: number): string {
  return addDays('2026-08-09', dow === 0 ? 0 : dow);
}
