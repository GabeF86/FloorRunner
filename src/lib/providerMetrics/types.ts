/* ───────────────────────────────────────────────────────────────────────────
 * Shared vocabulary for the physician self-service metrics (/me).
 *
 * ── WHY A COVERAGE OBJECT SITS ON EVERY RESULT ─────────────────────────────
 * Published schedule data begins partway through the calendar — at the time of
 * writing, 2026-09-01. A window that reaches back before that is GENUINELY
 * UNANSWERED, and "0 free weekends" / "no upcoming call" would be a confident
 * lie about a period nobody has scheduled yet. So every module takes the span
 * the data actually covers, returns the span it actually evaluated, and says
 * in a field whether a zero means "none" or "nobody knows". The headline
 * numbers go NULL rather than 0 whenever the metric could not be evaluated at
 * all. This is the operations-page discipline (never render a confident zero)
 * applied to a physician's own dashboard, where the stakes are higher: this is
 * the screen a partner checks before complaining they got a raw deal.
 *
 * ── DATES ARE CALENDAR DAYS, NEVER INSTANTS ────────────────────────────────
 * Every date here is a plain 'YYYY-MM-DD' with no timezone, compared as a
 * string and walked with the engine's `addDays` (which parses at UTC midnight
 * and never touches local time). Nothing in this directory calls
 * `new Date().toISOString()`, `Date.now()` or `Math.random()` — `today` is an
 * argument, so every function is deterministic and testable. See
 * `todayLocalISO` in lib/scheduleBoard.ts for how the caller should obtain it.
 * ─────────────────────────────────────────────────────────────────────────── */

import { addDays, daysBetween } from '../rulesEngine/shared';

/** Inclusive calendar-day range. */
export interface DateSpan {
  start: string;
  end: string;
}

/**
 * One assignment the provider holds, flattened by the caller.
 *
 * Deliberately structural (not a DB row type) so it can be built from the
 * committed-assignment read, the grid payload, or a test fixture without an
 * adapter. `requiresPostCall` is `shift_types.requires_post_call_rule` — the
 * flag clinical invariant 1 is defined on.
 */
export interface MetricAssignment {
  date: string;
  /** The code actually stored — a split segment keeps its own code. */
  code: string;
  /** shift_types.category — 'call', 'day', … */
  category: string;
  /** shift_types.parent_call_code; absent ⇒ the code is its own parent. */
  parentCode?: string | null;
  requiresPostCall?: boolean | null;
  siteId?: string | null;
  /** schedule_slots.derived_day_type, when the caller has it. */
  dayType?: string | null;
}

/** A provider_availability row, as much of it as these metrics need. */
export interface MetricAvailability {
  availability_type: string;
  approval_status: string;
  start_date: string;
  end_date: string;
  reason_code?: string | null;
}

/** A holiday_calendar row. */
export interface MetricHoliday {
  holiday_date: string;
  /** Name drives the block expansion (Thanksgiving's Friday, New Year's Eve). */
  name?: string | null;
  is_major_holiday?: boolean | null;
}

export type CoverageKind = 'none' | 'partial' | 'full';

/**
 * How much of the asked-about window the supplied data can answer for.
 *
 * `span` is the INTERSECTION of the window and the published span — the only
 * dates a result may claim anything about.
 */
export interface Coverage {
  /** The window that was asked about. */
  window: DateSpan;
  /** What the caller said is published. Null when nothing is. */
  published: DateSpan | null;
  /** window ∩ published — the dates actually evaluated. Null when disjoint. */
  span: DateSpan | null;
  kind: CoverageKind;
  /** True when the data reaches back to the window's first day. When false, an
   *  "earliest" answer may have something earlier hiding in the unpublished
   *  head of the window. */
  coversWindowStart: boolean;
  /** Last day of the window the data can answer for; null when none. */
  coveredThrough: string | null;
  /** Days of the window nothing answers for. 0 only when kind is 'full'. */
  uncoveredDays: number;
}

/**
 * Whether a metric found something, found nothing, or could not look.
 *
 *   found              a real answer
 *   none_in_window     nothing — and the whole window is covered, so this is a
 *                      trustworthy negative
 *   partially_covered  nothing in the covered part; the rest is unpublished
 *   not_covered        nothing is published for this window at all
 */
export type MetricStatus = 'found' | 'none_in_window' | 'partially_covered' | 'not_covered';

/** Whole calendar days in an inclusive span; 0 for a reversed span. */
export function spanDays(span: DateSpan | null): number {
  if (!span || span.end < span.start) return 0;
  return daysBetween(span.start, span.end) + 1;
}

/** Is `date` inside the inclusive span? Plain string compare — correct for
 *  zero-padded ISO dates and inventing no timezone. */
export function spanCovers(span: DateSpan | null, date: string): boolean {
  return !!span && span.start <= date && date <= span.end;
}

/** window ∩ published, or null when they do not overlap. */
export function intersectSpan(a: DateSpan, b: DateSpan | null | undefined): DateSpan | null {
  if (!b) return null;
  const start = a.start > b.start ? a.start : b.start;
  const end = a.end < b.end ? a.end : b.end;
  return end < start ? null : { start, end };
}

/**
 * Build the coverage record for a window against the published span.
 *
 * A reversed window (end before start) is treated as empty and reports 'none' —
 * a caller that passes one gets nulls, never a fabricated zero.
 */
export function computeCoverage(
  window: DateSpan,
  published: DateSpan | null | undefined,
): Coverage {
  const empty: Coverage = {
    window,
    published: published ?? null,
    span: null,
    kind: 'none',
    coversWindowStart: false,
    coveredThrough: null,
    uncoveredDays: spanDays(window),
  };
  if (window.end < window.start) return { ...empty, uncoveredDays: 0 };
  const span = intersectSpan(window, published);
  if (!span) return empty;
  const full = span.start === window.start && span.end === window.end;
  return {
    window,
    published: published ?? null,
    span,
    kind: full ? 'full' : 'partial',
    coversWindowStart: span.start === window.start,
    coveredThrough: span.end,
    uncoveredDays: spanDays(window) - spanDays(span),
  };
}

/** The honest status for a metric that found (or did not find) something. */
export function statusFor(found: boolean, coverage: Coverage): MetricStatus {
  if (found) return 'found';
  if (coverage.kind === 'full') return 'none_in_window';
  if (coverage.kind === 'partial') return 'partially_covered';
  return 'not_covered';
}

/** `today` plus `horizonDays` calendar days INCLUDING today, so a 30-day
 *  horizon spans exactly 30 dates. */
export function horizonWindow(today: string, horizonDays: number): DateSpan {
  const n = Math.max(1, Math.floor(horizonDays));
  return { start: today, end: addDays(today, n - 1) };
}
