// Contractual Hours Grid — the "what administrators see" view.
//
// PURPOSE
// -------
// Translates the universal `GridSite[]` model into the timeline-by-hour-block
// view that hospital administration uses to size their contractual obligation:
// 12 day-spanning time blocks (07:00 → 07:00 next day), one row per
// anesthetizing room, plus group rows (Main OR / NORA / Float / Call), plus
// the bottom-line CRNA / MD weekly hour totals and FTE rollups.
//
// This module is PURE — no React, no DOM, no I/O. It consumes a `GridSite[]`
// (which already carries `weekdayCloseHour` + `weekendOpen` per room) and
// emits a fully-decided `ContractualGrid` for the renderer to lay out.
//
// FTE MATH
// --------
// 1) Weekly hours per row = hrs/day × days/week.
// 2) FTE Mandated = weeklyHours / 40 (US 1.0 FTE benchmark — same constant
//    used by `operatingHours.crnaFteFromHours`).
// 3) Vacation FTE = mandated × 6/46 — each 1.0 FTE works 46 weeks/year
//    (52 - 6 vacation weeks), and the hospital must backfill the 6 weeks of
//    vacation. So `vacationFTE = mandatedFTE × 6/46` per the spec.
// 4) Projected FTE = Mandated + Vacation.
//
// MD HOURS HEURISTIC
// ------------------
// Every staffed room demands one CRNA-hour per operating hour. MDs supervise,
// so for the v1 grid we assume "mostly_1_3" supervision: one MD covers ~3
// CRNAs. `mdHrsPerDay = roomDailyHours / 3`. Solo MD rooms (Endo today, in a
// real seed) would use `mdHrsPerDay = roomDailyHours`, but we keep every
// Main OR + NORA room on the /3 divisor for v1 simplicity — the screenshot's
// numbers reconcile against that assumption.
//
// FLOAT
// -----
// Float is a synthetic concept — the float strategy module emits floats
// outside the room model. For v1 the contractual grid leaves the Float group
// empty (no rows). A later iteration can layer in fixed float headcount.

import {
  roomDailyHours,
  roomWeekendOpen,
} from './operatingHours';
import type { GridSite } from './types';

// ---------------------------------------------------------------------------
// Time blocks
// ---------------------------------------------------------------------------

/**
 * The hour boundaries that mark the edges of the admin spreadsheet's 12 time
 * blocks. Numbers are 24-hour ints (700 = 7am, 1200 = noon, 2400 = midnight,
 * 300 = 3am next day). 2400 is treated as the same instant as the next-day
 * 0, but we keep the literal because the source spreadsheet writes it as
 * "2400" on the wall.
 */
export type TimeBlockBoundary =
  | 700
  | 1200
  | 1500
  | 1600
  | 1700
  | 1800
  | 1900
  | 2000
  | 2300
  | 2400
  | 300
  | 500;

export interface TimeBlock {
  start: TimeBlockBoundary;
  end: TimeBlockBoundary | 700;
}

/**
 * The 12 contractual time blocks, spanning 07:00 to 07:00 next day.
 * Order matters — index 0 is the morning block; index 11 wraps back to 0700.
 *
 *   00: 0700-1200  (morning, all rooms running)
 *   01: 1200-1500  (afternoon)
 *   02: 1500-1600  (early-close rooms have wound down)
 *   03: 1600-1700  (standard close tail)
 *   04: 1700-1800  (5pm wind-down)
 *   05: 1800-1900  (late OR rooms)
 *   06: 1900-2000  (7pm late rooms)
 *   07: 2000-2300  (evening call coverage window)
 *   08: 2300-2400  (OB midnight tail)
 *   09: 2400-0300  (overnight — post-midnight call)
 *   10: 0300-0500  (deep overnight)
 *   11: 0500-0700  (pre-dawn — handoff back to weekday start)
 */
export const TIME_BLOCKS: ReadonlyArray<TimeBlock> = [
  { start: 700, end: 1200 },
  { start: 1200, end: 1500 },
  { start: 1500, end: 1600 },
  { start: 1600, end: 1700 },
  { start: 1700, end: 1800 },
  { start: 1800, end: 1900 },
  { start: 1900, end: 2000 },
  { start: 2000, end: 2300 },
  { start: 2300, end: 2400 },
  { start: 2400, end: 300 },
  { start: 300, end: 500 },
  { start: 500, end: 700 },
] as const;

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export type ContractualGroupId =
  | 'main_or'
  | 'nora'
  | 'float'
  | 'weekday_call'
  | 'weekend_call';

export interface ContractualRow {
  groupId: ContractualGroupId;
  groupLabel: string;
  /** Row label e.g. "OR 1", "Endo 1", "Float 1", "In House". */
  label: string;
  /** Optional sub-caption shown after the label (e.g. "11a-7p", "cross-covered"). */
  note?: string;
  /** Per-block flags: true means this row is active in that block. Same length as TIME_BLOCKS. */
  blocks: boolean[];
  /** Color theme for the bar — semantic, not site-specific. */
  barColor: string;
  /** Coverage hours per day for CRNA (0 if not staffed). */
  crnaHrsPerDay: number;
  /** Coverage hours per day for MD (0 if not staffed). */
  mdHrsPerDay: number;
  /** Days per week this row operates (typically 5 for weekday, 2 for weekend, 7 for OB). */
  daysPerWeek: number;
}

export interface ContractualGrid {
  rows: ContractualRow[];
  totals: {
    crnaWeeklyHours: number;
    mdWeeklyHours: number;
    crnaFteMandated: number;
    mdFteMandated: number;
    vacationWeeksPerFte: number;
    vacationHoursPerFte: number;
    crnaVacationFte: number;
    mdVacationFte: number;
    crnaProjectedFte: number;
    mdProjectedFte: number;
  };
}

// ---------------------------------------------------------------------------
// Group classification — universal, name-based.
// ---------------------------------------------------------------------------

const MAIN_OR_NAMES = new Set<string>(['main or', 'main', 'main or (4th floor)']);

/** Bucket a site name into one of the contractual group buckets. */
function groupForSite(site: GridSite): ContractualGroupId | 'skip' {
  const name = site.name.toLowerCase().trim();
  if (MAIN_OR_NAMES.has(name)) return 'main_or';
  // Float sites are intentionally skipped — see file header.
  if (name.includes('float')) return 'skip';
  // Everything else is Non-OR Anesthesia (NORA).
  return 'nora';
}

const GROUP_LABEL: Record<ContractualGroupId, string> = {
  main_or: 'Main OR',
  nora: 'NORA',
  float: 'Float',
  weekday_call: 'Weekday Call',
  weekend_call: 'Weekend Call',
};

// ---------------------------------------------------------------------------
// Block-coverage math.
// ---------------------------------------------------------------------------

/**
 * Convert a `TimeBlockBoundary` into the linear-minute coordinate of a 0700
 * day cycle. 0700 → 0, 1200 → 5h × 60 = 300, 0700 next day → 24h × 60 = 1440.
 *
 * Boundaries before 0700 (300, 500, 700) represent the *next* day, so they
 * get +24h. Boundary 2400 maps to exactly 17h × 60 = 1020 (i.e. 24:00 same
 * day = 7am + 17h). Boundary 700-as-end means "0700 next day" = 1440.
 */
function toMinutes(b: TimeBlockBoundary | 700): number {
  // Tail-end "0700" sentinel (only used as the end of block #11).
  if (b === 700) {
    // Heuristic: if used as start (block #0) it's 0; as end (block #11) it
    // wraps to 1440. We disambiguate at the call site, but every TIME_BLOCKS
    // entry uses 700 only at index-0 start and index-11 end. The caller
    // therefore knows which is which. This helper assumes "block end" when
    // the boundary is < 700 OR equal to 700-as-end (handled by caller via
    // isStart flag below).
    return 0;
  }
  // 300, 500 → next day → +24h.
  if (b < 700) return (24 * 60) + (Math.floor(b / 100) * 60) + (b % 100);
  // 700-2400 → same-day minutes.
  const hh = Math.floor(b / 100);
  const mm = b % 100;
  // Anchor 0700 at minute 0; minutes since 7am same day.
  return (hh - 7) * 60 + mm;
}

/** End-boundary version that knows 700 means "1440 minutes from 0700". */
function endToMinutes(b: TimeBlockBoundary | 700): number {
  if (b === 700) return 24 * 60; // 1440 — full day wrap
  return toMinutes(b);
}

/**
 * Weekday operating window in minutes since 0700. Weekday start is always
 * 0700 (per universal default in `operatingHours.ts`).
 *
 *   weekdayCloseHour = 15 → window = [0, 8h × 60] = [0, 480]
 *   weekdayCloseHour = 17 → window = [0, 600]
 *   weekdayCloseHour = 19 → window = [0, 720]
 *   weekdayCloseHour = 23 → window = [0, 960]
 *   weekdayCloseHour = 24 → window = [0, 1020]
 */
function roomWindowMinutes(weekdayCloseHour: number): { startMin: number; endMin: number } {
  const startMin = 0;
  const endMin = Math.max(0, weekdayCloseHour - 7) * 60;
  return { startMin, endMin };
}

/**
 * Decide whether a given time block intersects the room's operating window.
 * The block is active if [blockStart, blockEnd) overlaps [windowStart, windowEnd).
 */
function blockActive(
  block: TimeBlock,
  window: { startMin: number; endMin: number },
): boolean {
  if (window.endMin <= window.startMin) return false;
  const bStart = toMinutes(block.start);
  const bEnd = endToMinutes(block.end);
  return bStart < window.endMin && bEnd > window.startMin;
}

// ---------------------------------------------------------------------------
// Constants the math is pinned against.
// ---------------------------------------------------------------------------

const FTE_HOURS_PER_WEEK = 40;
const VACATION_WEEKS_PER_FTE = 6;
const VACATION_HOURS_PER_FTE = VACATION_WEEKS_PER_FTE * FTE_HOURS_PER_WEEK; // 240
const WEEKS_WORKED_PER_FTE = 52 - VACATION_WEEKS_PER_FTE; // 46
const MD_SUPERVISION_DIVISOR = 3; // mostly_1_3 default — 1 MD covers ~3 CRNAs.

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Build the contractual grid from a `GridSite[]`. Float sites are skipped;
 * Main OR sites become the `main_or` group; everything else becomes `nora`.
 * Per the file header, MD hours/day = roomDailyHours / 3 for v1.
 */
export function buildContractualGrid(sites: GridSite[]): ContractualGrid {
  const rows: ContractualRow[] = [];

  // Iterate in site-position order so the grid renders deterministically.
  const orderedSites = sites.slice().sort((a, b) => a.position - b.position);

  for (const site of orderedSites) {
    const group = groupForSite(site);
    if (group === 'skip') continue;

    for (const room of site.rooms) {
      const dailyHours = roomDailyHours(room);
      if (dailyHours <= 0) continue;

      const weekendOpen = roomWeekendOpen(room);
      const daysPerWeek = weekendOpen ? 7 : 5;

      // weekdayCloseHour defaults to 17 inside roomDailyHours; recompute here
      // so the block-overlap math gets the same effective close time.
      const effectiveClose = (room.weekdayCloseHour ?? 17);
      const window = roomWindowMinutes(effectiveClose);
      const blocks = TIME_BLOCKS.map((b) => blockActive(b, window));

      const crnaHrsPerDay = dailyHours;
      const mdHrsPerDay = dailyHours / MD_SUPERVISION_DIVISOR;

      rows.push({
        groupId: group,
        groupLabel: GROUP_LABEL[group],
        label: room.name,
        blocks,
        barColor: site.color,
        crnaHrsPerDay,
        mdHrsPerDay,
        daysPerWeek,
      });
    }
  }

  // Totals — pure sum of per-row weekly hours.
  const crnaWeeklyHours = rows.reduce(
    (acc, r) => acc + r.crnaHrsPerDay * r.daysPerWeek,
    0,
  );
  const mdWeeklyHours = rows.reduce(
    (acc, r) => acc + r.mdHrsPerDay * r.daysPerWeek,
    0,
  );

  const crnaFteMandated = crnaWeeklyHours / FTE_HOURS_PER_WEEK;
  const mdFteMandated = mdWeeklyHours / FTE_HOURS_PER_WEEK;

  // Vacation backfill — each FTE costs 6 of 46 worked-week FTE for replacement.
  const crnaVacationFte = crnaFteMandated * VACATION_WEEKS_PER_FTE / WEEKS_WORKED_PER_FTE;
  const mdVacationFte = mdFteMandated * VACATION_WEEKS_PER_FTE / WEEKS_WORKED_PER_FTE;

  return {
    rows,
    totals: {
      crnaWeeklyHours,
      mdWeeklyHours,
      crnaFteMandated,
      mdFteMandated,
      vacationWeeksPerFte: VACATION_WEEKS_PER_FTE,
      vacationHoursPerFte: VACATION_HOURS_PER_FTE,
      crnaVacationFte,
      mdVacationFte,
      crnaProjectedFte: crnaFteMandated + crnaVacationFte,
      mdProjectedFte: mdFteMandated + mdVacationFte,
    },
  };
}
