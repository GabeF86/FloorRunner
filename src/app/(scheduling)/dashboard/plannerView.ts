// Pure view-layer helpers for the Physician Planner card (2026-07-20).
// Everything numeric the card renders comes from lib/plannerMath.ts; this
// module owns only VIEW concerns — month-range defaults, display formatting,
// picker filtering, what-if input parsing/clamping, bucket display order and
// delta tones — kept DB/DOM-free so vitest covers them directly. No obligation
// or working-days arithmetic lives here (that would re-home the math).

import { isValidDate } from '@/lib/validation/providers';
import { MAX_PLANNER_RANGE_DAYS, type PlannerRosterEntry, type PlannerWhatIf } from '@/lib/plannerMath';
import type { BadgeTone } from '@/components/ui';

export interface PlannerRange {
  date_start: string;
  date_end: string;
}

// ── Range defaults + validation ──────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Calendar month containing `dateIso` (current-stats default). */
export function monthRangeContaining(dateIso: string): PlannerRange {
  const y = Number(dateIso.slice(0, 4));
  const m = Number(dateIso.slice(5, 7)); // 1–12
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of the next month
  return {
    date_start: `${dateIso.slice(0, 7)}-01`,
    date_end: `${dateIso.slice(0, 7)}-${pad2(lastDay)}`,
  };
}

/** The calendar month AFTER the one containing `dateIso` (future-block default). */
export function monthRangeAfter(dateIso: string): PlannerRange {
  const y = Number(dateIso.slice(0, 4));
  const m = Number(dateIso.slice(5, 7)); // 1–12 → Date.UTC month index of the NEXT month
  const first = new Date(Date.UTC(y, m, 1));
  const ys = first.getUTCFullYear();
  const ms = first.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(ys, ms, 0)).getUTCDate();
  return {
    date_start: `${ys}-${pad2(ms)}-01`,
    date_end: `${ys}-${pad2(ms)}-${pad2(lastDay)}`,
  };
}

/** Calendar year of `dateIso` + the from/to params for the year-counter fetch. */
export function yearRangeOf(dateIso: string): { year: number; from: string; to: string } {
  const year = Number(dateIso.slice(0, 4));
  return { year, from: `${year}-01-01`, to: `${year}-12-31` };
}

// Fetchable range: two valid ISO dates, ordered, within the API's day cap —
// the same bounds the route 400s on, checked client-side so half-typed date
// inputs never fire doomed requests.
export function validPlannerRange(r: PlannerRange): boolean {
  if (!isValidDate(r.date_start) || !isValidDate(r.date_end)) return false;
  if (r.date_end < r.date_start) return false;
  const days =
    (Date.parse(`${r.date_end}T00:00:00Z`) - Date.parse(`${r.date_start}T00:00:00Z`)) / MS_PER_DAY + 1;
  return days <= MAX_PLANNER_RANGE_DAYS;
}

// ── Display formatting ───────────────────────────────────────────────────────

/** Fractional planner figures (expected calls, effective par): 1 decimal. */
export function fmt1(n: number): string {
  return n.toFixed(1);
}

/** FTE display: 2 decimals (0.60, 1.00). */
export function fmtFte(n: number): string {
  return n.toFixed(2);
}

/** Signed fixed-point with a typographic minus: +2 / −3.5 / 0.0. */
export function signedFmt(n: number, digits: number): string {
  const abs = Math.abs(n).toFixed(digits);
  if (n > 0) return `+${abs}`;
  if (n < 0) return `−${abs}`;
  return (0).toFixed(digits);
}

/** Signed integer: +2 / −3 / 0. */
export function signed(n: number): string {
  return signedFmt(n, 0);
}

/** Over/under tone for a credited-vs-required delta: over warns, under alarms. */
export function deltaTone(delta: number): BadgeTone {
  if (delta > 0) return 'warn';
  if (delta < 0) return 'danger';
  return 'ok';
}

// ── Roster picker ────────────────────────────────────────────────────────────

/** "Last, First" when both exist, else the dashboard's display fallbacks. */
export function providerLabel(r: PlannerRosterEntry): string {
  if (r.last_name && r.first_name) return `${r.last_name}, ${r.first_name}`;
  return r.short_display_name || r.last_name || r.first_name || r.initials || r.provider_id;
}

/**
 * Case-insensitive substring filter over every name field, preserving the
 * roster's order (the API returns it last_name-ordered). Empty query → all.
 */
export function filterRoster(
  roster: ReadonlyArray<PlannerRosterEntry>,
  query: string,
): PlannerRosterEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...roster];
  return roster.filter(r =>
    [providerLabel(r), r.first_name, r.last_name, r.short_display_name, r.initials]
      .some(s => s != null && s.toLowerCase().includes(q)));
}

// ── Bucket display order ─────────────────────────────────────────────────────
// Chronological reading order for the fairness buckets (dayTypeBucket keys);
// unknown buckets sort after the known ones, alphabetically. Display-only —
// the buckets themselves come from the engine's dayTypeBucket.

const BUCKET_ORDER = ['weekday', 'friday', 'saturday', 'sunday', 'holiday'];

function bucketRank(b: string): number {
  const i = BUCKET_ORDER.indexOf(b);
  return i === -1 ? BUCKET_ORDER.length : i;
}

export function sortBucketRows<T extends { bucket: string }>(rows: ReadonlyArray<T>): T[] {
  return [...rows].sort(
    (a, b) => bucketRank(a.bucket) - bucketRank(b.bucket) || a.bucket.localeCompare(b.bucket));
}

export function bucketLabel(b: string): string {
  return b.charAt(0).toUpperCase() + b.slice(1);
}

// ── What-if input parsing (panel C) ──────────────────────────────────────────
// Free-text inputs → clamped PlannerWhatIf. Empty/garbage fields contribute
// nothing (the current value stays in force); a fully empty form yields null
// so the card can tell "no hypothetical" from "hypothetical equal to current".

export interface WhatIfInputs {
  fte: string;      // 0.1..1.0
  extraPto: string; // additional hypothetical PTO weekdays, ≥ 0
  sellback: string; // hypothetical sell-back weekdays, ≥ 0
  par: string;      // par-level override, > 0
  pool: string;     // pool ΣFTE override (advanced), > 0
}

export const EMPTY_WHAT_IF_INPUTS: WhatIfInputs = {
  fte: '', extraPto: '', sellback: '', par: '', pool: '',
};

export function parseFteInput(v: string): number | undefined {
  if (v.trim() === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0.1, n));
}

export function parseCountInput(v: string): number | undefined {
  if (v.trim() === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.round(n));
}

export function parsePositiveInput(v: string): number | undefined {
  if (v.trim() === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

export function buildWhatIf(i: WhatIfInputs): PlannerWhatIf | null {
  const wi: PlannerWhatIf = {};
  const fte = parseFteInput(i.fte);
  if (fte !== undefined) wi.fte = fte;
  const pto = parseCountInput(i.extraPto);
  if (pto !== undefined && pto > 0) wi.extraPtoWeekdays = pto;
  const sell = parseCountInput(i.sellback);
  if (sell !== undefined && sell > 0) wi.sellbackWeekdays = sell;
  const par = parsePositiveInput(i.par);
  if (par !== undefined) wi.parLevel = par;
  const pool = parsePositiveInput(i.pool);
  if (pool !== undefined) wi.poolFte = pool;
  return Object.keys(wi).length > 0 ? wi : null;
}

/** Hypothetical − current, for the what-if Δ column. */
export function numberDelta(current: number, hypothetical: number): number {
  return hypothetical - current;
}
