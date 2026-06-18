// Operating-hours math for the Grid Calculator.
//
// Each `GridRoom` carries an optional `weekdayCloseHour` (when the last case
// finishes Mon-Fri) and `weekendOpen` (whether Sat-Sun mirror the weekday
// schedule). Universal defaults come from `DEFAULT_ROOM_HOURS` in types.ts.
//
// These helpers convert a sites array into weekly + annual demand hours,
// which drive the FTE-hours recommendation. The demand model is intentionally
// minimal — it does NOT account for call shifts, post-call relief, or PTO
// (those live in the simulator). It answers "how many provider-hours per
// week does this room schedule require?"

import {
  DEFAULT_ROOM_HOURS,
  type GridRoom,
  type GridSite,
} from './types';

/** Standard US FTE benchmark: 40 hours/week × 52 weeks/year. */
export const FTE_HOURS_PER_YEAR = 40 * 52;
export const WEEKS_PER_YEAR = 52;
export const WEEKDAYS_PER_WEEK = 5;
export const WEEKEND_DAYS_PER_WEEK = 2;

/** Effective weekday close hour for a room, with defaults applied. */
export function roomWeekdayCloseHour(room: GridRoom): number {
  return room.weekdayCloseHour ?? DEFAULT_ROOM_HOURS.weekdayCloseHour;
}

/** Effective weekend-open flag for a room, with defaults applied. */
export function roomWeekendOpen(room: GridRoom): boolean {
  return room.weekendOpen ?? DEFAULT_ROOM_HOURS.weekendOpen;
}

/** Daily hours of operation for one weekday (typically 7-17 = 10 hours). */
export function roomDailyHours(room: GridRoom): number {
  const closeHour = roomWeekdayCloseHour(room);
  return Math.max(0, closeHour - DEFAULT_ROOM_HOURS.weekdayStartHour);
}

/** Total room-hours per week for one room. */
export function roomWeeklyHours(room: GridRoom): number {
  const daily = roomDailyHours(room);
  const days = WEEKDAYS_PER_WEEK + (roomWeekendOpen(room) ? WEEKEND_DAYS_PER_WEEK : 0);
  return daily * days;
}

/** Total room-hours per week across all rooms in a site. */
export function siteWeeklyHours(site: GridSite): number {
  return site.rooms.reduce((acc, r) => acc + roomWeeklyHours(r), 0);
}

/** Total room-hours per week across all sites. */
export function totalWeeklyHours(sites: GridSite[]): number {
  return sites.reduce((acc, s) => acc + siteWeeklyHours(s), 0);
}

/**
 * Compact human-readable hours summary for a single room.
 * Examples: "M-F 7-15", "7d 7-17", "closed".
 */
export function formatRoomHours(room: GridRoom): string {
  const close = roomWeekdayCloseHour(room);
  if (close <= DEFAULT_ROOM_HOURS.weekdayStartHour) return 'closed';
  const span = `${DEFAULT_ROOM_HOURS.weekdayStartHour}-${close}`;
  return roomWeekendOpen(room) ? `7d ${span}` : `M-F ${span}`;
}

/**
 * Convert weekly room-hours into a baseline CRNA FTE count.
 *
 * Heuristic: every room-hour needs ~1 CRNA-hour of coverage during operating
 * hours (plus float overhead which the simulator layers on top). So required
 * CRNA FTE = weekly_room_hours / 40. Round up so we don't recommend a
 * fractional headcount where a hospital actually needs a body.
 */
export function crnaFteFromHours(weeklyHours: number, floatOverhead = 0.15): number {
  const baseline = weeklyHours / 40;
  return Math.ceil(baseline * (1 + floatOverhead));
}

/**
 * Convert weekly room-hours into a baseline Anesthesiologist FTE count.
 *
 * Heuristic: one supervisor covers ~3 rooms on average (mostly_1_3 default).
 * So required Anes FTE = (weekly_room_hours / 3) / 40, plus a coordinator + 1
 * extra to absorb post-call rest. Always at least 2.
 */
export function anesFteFromHours(weeklyHours: number, ratioTarget = 3): number {
  const baseline = weeklyHours / ratioTarget / 40;
  return Math.max(2, Math.ceil(baseline) + 2);
}
