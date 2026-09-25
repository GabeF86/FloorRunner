/* ───────────────────────────────────────────────────────────────────────────
 * FREE WEEKENDS — the outcome-based weekend-equity measure.
 *
 * Two physicians can hold identical call counts and live completely different
 * years: one takes eight weekend calls spread one per month and loses eight
 * weekends, the other takes the same eight in four back-to-back pairs and loses
 * four. Counting calls cannot see that. Counting the weekends that survive can.
 *
 * It is also the one weekend measure that cannot be gamed by trading a Saturday
 * for a Friday: the weekend is the Fri/Sat/Sun TRIPLE (lib/weekendGroup.ts —
 * the app's single definition, Gabriel 2026-07-22: "A no weekend call (no
 * Friday, no Saturday and no Sunday call) is considered one request not
 * three"), so moving work from one of its days to another changes nothing.
 *
 * ── WHAT SPENDS A WEEKEND ──────────────────────────────────────────────────
 * Any assignment of any category landing on the Friday, Saturday or Sunday,
 * plus any POST-CALL DAY landing on one. The post-call day is the day after a
 * `requires_post_call_rule` call (clinical invariant 1's own definition) and it
 * matters here more than anywhere: a Thursday 24h call puts the doctor in house
 * through Friday morning, and calling that weekend "free" would be the metric
 * lying about the thing it exists to measure.
 *
 * ── THE POST-CALL WALK IS DELIBERATELY UNCLIPPED ───────────────────────────
 * plannerMath's `postCallRestWorkdays` (and the engine's workDayReport) clip
 * rest days to WORKING days — weekdays minus major holidays — because they are
 * budgeting a working-days contract, where a Saturday rest day is not a day
 * owed. Reusing that set here would silently delete every weekend post-call
 * day, which is exactly the population this metric is about. So the walk is
 * date + 1, unclipped, and that divergence is the point rather than a drift.
 *
 * ── PTO IS NOT AN OCCUPANT ─────────────────────────────────────────────────
 * A weekend spent on approved leave is free: the physician owes the department
 * nothing that weekend. Availability is therefore not consulted at all. If a
 * "weekends at liberty, excluding leave" number is ever wanted it is a
 * different metric with a different name, not a flag on this one.
 *
 * ── COVERAGE ───────────────────────────────────────────────────────────────
 * A weekend is only counted — free OR spent — when ALL THREE of its days sit
 * inside the published span. One unpublished day means the answer is unknown,
 * and an unknown weekend counted as free would inflate the number that decides
 * who is treated fairly. Those weekends come back in `uncovered`, named, so the
 * UI can say "14 free of 20 weekends published; 6 not yet scheduled".
 * ─────────────────────────────────────────────────────────────────────────── */

import { addDays, dayOfWeekUTC } from '../rulesEngine/shared';
import { weekendGroupDates, weekendGroupKey } from '../weekendGroup';
import {
  computeCoverage, spanCovers,
  type Coverage, type DateSpan, type MetricAssignment,
} from './types';

/** Hard bound on the walk, ~10 years. A window wider than this is a caller
 *  bug; throwing makes it loud instead of silently truncating (the house rule
 *  plannerMath's MAX_PLANNER_RANGE_DAYS follows). */
export const MAX_WEEKENDS = 520;

/** Why a weekend is not free. */
export interface WeekendReason {
  /** The Fri/Sat/Sun date the obligation lands on. */
  date: string;
  kind: 'assignment' | 'post_call';
  /** The assignment's code, or — for a post-call day — the code of the call
   *  that generated it, so the UI can say "post-call after C1". */
  code: string;
  /** For a post-call day, the date of the call. Same as `date` otherwise. */
  sourceDate: string;
}

export interface WeekendSummary {
  /** The Saturday that names this weekend — the app's weekend key. */
  saturday: string;
  /** [Friday, Saturday, Sunday]. */
  dates: string[];
  /** Empty for a free weekend; date-ascending otherwise. */
  reasons: WeekendReason[];
}

export interface UncoveredWeekend {
  saturday: string;
  dates: string[];
  /** The days of it no published data answers for. */
  missing: string[];
}

export interface FreeWeekendsResult {
  window: DateSpan;
  coverage: Coverage;
  /** THE headline. Null — never 0 — when not one weekend in the window could
   *  be evaluated, because "0 free weekends" and "nothing is published yet"
   *  must never render the same. */
  freeWeekends: number | null;
  /** Weekends fully inside the published span. `free.length + occupied.length`. */
  weekendsEvaluated: number;
  free: WeekendSummary[];
  occupied: WeekendSummary[];
  /** Weekends in the window the data cannot answer for. */
  uncovered: UncoveredWeekend[];
  /** True when every weekend the window contains was evaluable. */
  complete: boolean;
}

/** One post-call rest day: the day after a `requires_post_call_rule`
 *  assignment. UNCLIPPED — see the header. */
export interface PostCallRestDay {
  date: string;
  sourceDate: string;
  sourceCode: string;
}

export function postCallRestDays(
  assignments: ReadonlyArray<MetricAssignment>,
): PostCallRestDay[] {
  const out: PostCallRestDay[] = [];
  for (const a of assignments) {
    if (!a.requiresPostCall) continue;
    out.push({ date: addDays(a.date, 1), sourceDate: a.date, sourceCode: a.code });
  }
  return out.sort((x, y) => x.date.localeCompare(y.date) || x.sourceCode.localeCompare(y.sourceCode));
}

/**
 * Saturday key → everything of the provider's that lands in that weekend.
 *
 * THE occupancy rule, exported so `nextUp`'s "next weekend on" tile reads it
 * rather than re-deriving it — two derivations would eventually disagree about
 * whether a weekend was spent, and a dashboard that contradicts itself on its
 * own front page is worse than one that omits the tile.
 *
 * Weekends with nothing in them are simply absent from the map.
 */
export function weekendOccupancy(
  assignments: ReadonlyArray<MetricAssignment>,
): Map<string, WeekendReason[]> {
  const out = new Map<string, WeekendReason[]>();
  const push = (r: WeekendReason) => {
    const key = weekendGroupKey(r.date);
    if (!key) return;                     // Mon–Thu: not part of any weekend
    const list = out.get(key);
    if (list) list.push(r); else out.set(key, [r]);
  };

  for (const a of assignments) {
    push({ date: a.date, kind: 'assignment', code: a.code, sourceDate: a.date });
  }
  for (const rest of postCallRestDays(assignments)) {
    push({
      date: rest.date, kind: 'post_call',
      code: rest.sourceCode, sourceDate: rest.sourceDate,
    });
  }

  for (const list of out.values()) {
    list.sort((a, b) =>
      a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code));
  }
  return out;
}

/** The Saturdays naming every weekend whose Saturday falls in the window. */
export function weekendSaturdaysIn(window: DateSpan): string[] {
  if (window.end < window.start) return [];
  const delta = (6 - dayOfWeekUTC(window.start) + 7) % 7;   // 6 = Saturday
  const out: string[] = [];
  for (let sat = addDays(window.start, delta); sat <= window.end; sat = addDays(sat, 7)) {
    out.push(sat);
    if (out.length > MAX_WEEKENDS) {
      throw new Error(`free-weekend window exceeds ${MAX_WEEKENDS} weekends`);
    }
  }
  return out;
}

/**
 * Free weekends in a window.
 *
 * `assignments` must cover the PUBLISHED SPAN, not merely the window: a weekend
 * named by a Saturday on the window's first day reaches back to the Thursday
 * (for a post-call Friday), and a short read would report it free.
 */
export function computeFreeWeekends(input: {
  window: DateSpan;
  /** The span published schedule data covers. Null when none does. */
  published: DateSpan | null;
  assignments: ReadonlyArray<MetricAssignment>;
}): FreeWeekendsResult {
  const { window, published } = input;
  const coverage = computeCoverage(window, published);
  const occupancy = weekendOccupancy(input.assignments);

  const free: WeekendSummary[] = [];
  const occupied: WeekendSummary[] = [];
  const uncovered: UncoveredWeekend[] = [];

  for (const saturday of weekendSaturdaysIn(window)) {
    const dates = weekendGroupDates(saturday);
    const missing = dates.filter(d => !spanCovers(published ?? null, d));
    if (missing.length > 0) {
      uncovered.push({ saturday, dates, missing });
      continue;
    }
    const reasons = occupancy.get(saturday) ?? [];
    if (reasons.length === 0) free.push({ saturday, dates, reasons: [] });
    else occupied.push({ saturday, dates, reasons });
  }

  const weekendsEvaluated = free.length + occupied.length;
  return {
    window,
    coverage,
    freeWeekends: weekendsEvaluated === 0 ? null : free.length,
    weekendsEvaluated,
    free,
    occupied,
    uncovered,
    complete: uncovered.length === 0,
  };
}
