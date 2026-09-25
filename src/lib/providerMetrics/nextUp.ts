/* ───────────────────────────────────────────────────────────────────────────
 * NEXT UP — the next 30 days, for one physician.
 *
 * This is the tile that earns a weekly visit, and it is the reason the rest of
 * the dashboard gets seen at all: nobody opens a page to read their own
 * fairness statistics, but everybody opens one to find out when they are next
 * in house. Five answers, each a date the physician can act on:
 *
 *   next call                when, and which code
 *   next post-call day       the day off the call earns (invariant 1)
 *   next weekend on          the Fri/Sat/Sun they lose
 *   next PTO block           the leave already on the books
 *   next holiday obligation  Thanksgiving, Christmas, New Year
 *
 * ── EVERY "NOTHING" IS LABELLED ────────────────────────────────────────────
 * A blank tile has two completely different meanings — "you are clear for a
 * month" and "next month has not been built yet" — and published data starts
 * only 2026-09-01, so the second is the common case at the edges. Each answer
 * therefore ships with a `MetricStatus`: `none_in_window` is a trustworthy all
 * clear, `partially_covered` / `not_covered` are not. Nothing in here reports
 * an empty result as a confident zero.
 *
 * The same care applies to the non-schedule sources. An empty `availability`
 * array is ambiguous — no PTO on file, or the read failed — so by default it is
 * reported as `not_covered`, and a caller that KNOWS the read succeeded says so
 * with `availabilityLoaded: true`. Same for the holiday calendar.
 *
 * ── TODAY COUNTS ───────────────────────────────────────────────────────────
 * The window is inclusive of `today`. A tile that hides the call you are on
 * right now is wrong in the only way that matters at 06:00. `today` is an
 * ARGUMENT — never `new Date()` — so the tile is deterministic and its tests
 * do not drift into failure.
 *
 * ── RULES ARE BORROWED, NOT RESTATED ───────────────────────────────────────
 *   weekends       freeWeekends.weekendOccupancy — the identical rule the free
 *                  weekend count uses, so the two tiles cannot contradict each
 *                  other on the same page
 *   post-call      freeWeekends.postCallRestDays (date + 1, unclipped)
 *   holiday span   holidayCall.holidayBlockDates — Thanksgiving takes the
 *                  Friday after and the Wednesday before, Christmas takes the
 *                  weekend behind it
 *   holiday plans  holidayCall.HOLIDAY_CALL_TYPE rows, the chief's plan of
 *                  record, which exists long before any schedule covers it
 *   live/dismissed rulesEngine/shared.isDismissedAvailability — pending counts,
 *                  denied and canceled do not
 *   parent code    callBurden.parentCallCodeOf — never a code-name pattern
 * ─────────────────────────────────────────────────────────────────────────── */

import { daysBetween, isDismissedAvailability } from '../rulesEngine/shared';
import { parentCallCodeOf } from '../callBurden';
import { HOLIDAY_CALL_TYPE, holidayBlockDates } from '../holidayCall';
import { weekendGroupDates } from '../weekendGroup';
import {
  postCallRestDays, weekendOccupancy, type WeekendReason,
} from './freeWeekends';
import {
  computeCoverage, horizonWindow, statusFor,
  type Coverage, type DateSpan, type MetricAssignment, type MetricAvailability,
  type MetricHoliday, type MetricStatus,
} from './types';

export const DEFAULT_HORIZON_DAYS = 30;

/** The availability type this tile reads as leave. Other blocking types (sick,
 *  fmla, …) are real but are not "your next PTO block", and lumping them in
 *  would label somebody's medical leave as vacation on their own dashboard. */
export const PTO_TYPE = 'pto';

export interface NextCall {
  date: string;
  /** The stored code — a split segment keeps its own. */
  code: string;
  /** The code it groups under for obligations and fairness. */
  parentCode: string;
  siteId: string | null;
  dayType: string | null;
  requiresPostCall: boolean;
  /** The post-call day this call earns, when it earns one. */
  postCallDate: string | null;
  daysAway: number;
}

export interface NextPostCall {
  date: string;
  /** The call that earned it. */
  sourceDate: string;
  sourceCode: string;
  daysAway: number;
}

export interface NextWeekendOn {
  /** The Saturday naming the weekend — the app's weekend key. */
  saturday: string;
  /** [Friday, Saturday, Sunday]. */
  dates: string[];
  /** What lands in it: assignments and post-call days, date-ascending. */
  reasons: WeekendReason[];
  /** Days to the first of those that is not already past. */
  daysAway: number;
}

export interface NextPto {
  start: string;
  end: string;
  /** 'approved' | 'pending' | … — a pending block is shown AS pending: it
   *  blocks scheduling everywhere (invariant 2) but has not been granted. */
  approvalStatus: string;
  /** Negative while a block is already running. */
  daysAway: number;
  inProgress: boolean;
}

export interface NextHolidayObligation {
  date: string;
  /** The holiday the date belongs to, named. */
  holiday: string;
  /** The call code, when one is known. */
  code: string | null;
  /** 'assignment' = a real slot on the schedule; 'recorded' = the chief's
   *  holiday-call plan of record, before any schedule covers the date. */
  source: 'assignment' | 'recorded';
  daysAway: number;
}

export interface NextUpStatuses {
  call: MetricStatus;
  postCall: MetricStatus;
  weekend: MetricStatus;
  pto: MetricStatus;
  holiday: MetricStatus;
}

export interface NextUpResult {
  today: string;
  horizonDays: number;
  window: DateSpan;
  /** Coverage of the SCHEDULE data. PTO and the holiday plan of record do not
   *  depend on a published schedule and carry their own statuses. */
  coverage: Coverage;
  nextCall: NextCall | null;
  nextPostCall: NextPostCall | null;
  nextWeekendOn: NextWeekendOn | null;
  nextPto: NextPto | null;
  nextHolidayObligation: NextHolidayObligation | null;
  status: NextUpStatuses;
}

export interface NextUpInput {
  /** Calendar day, from the caller (see todayLocalISO in lib/scheduleBoard). */
  today: string;
  /** Days INCLUDING today. Default 30 ⇒ today plus the 29 days after it. */
  horizonDays?: number;
  /** The provider's assignments. Supply at least [today − 1, window end]: a
   *  call the day BEFORE today produces a post-call day that is today. */
  assignments: ReadonlyArray<MetricAssignment>;
  availability: ReadonlyArray<MetricAvailability>;
  holidays: ReadonlyArray<MetricHoliday>;
  /** Span published schedule data covers. Null when none does. */
  published: DateSpan | null;
  /** Pass true when the availability read SUCCEEDED but came back empty —
   *  without it an empty array reports `not_covered`, never a confident
   *  "no PTO". Defaults to `availability.length > 0`. */
  availabilityLoaded?: boolean;
  /** Same, for the holiday calendar. Defaults to `holidays.length > 0`. */
  holidayCalendarLoaded?: boolean;
}

/** A source that is not the published schedule: loaded or not, full coverage
 *  either way, because it does not depend on a schedule existing. */
function sourceCoverage(window: DateSpan, loaded: boolean): Coverage {
  return computeCoverage(window, loaded ? window : null);
}

export function computeNextUp(input: NextUpInput): NextUpResult {
  const { today, published } = input;
  const horizonDays = input.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const window = horizonWindow(today, horizonDays);
  const coverage = computeCoverage(window, published);
  const inWindow = (d: string) => d >= window.start && d <= window.end;

  // ── Next call ────────────────────────────────────────────────────────────
  const calls = input.assignments
    .filter(a => a.category === 'call' && inWindow(a.date))
    .sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
  const call = calls[0];
  const nextCall: NextCall | null = call
    ? {
        date: call.date,
        code: call.code,
        parentCode: parentCallCodeOf(call.code, { parent_call_code: call.parentCode ?? null }),
        siteId: call.siteId ?? null,
        dayType: call.dayType ?? null,
        requiresPostCall: !!call.requiresPostCall,
        postCallDate: call.requiresPostCall
          ? postCallRestDays([call])[0]?.date ?? null
          : null,
        daysAway: daysBetween(today, call.date),
      }
    : null;

  // ── Next post-call day ───────────────────────────────────────────────────
  // Derived from ALL assignments, then filtered: the call that earns today's
  // post-call day happened yesterday, outside the window.
  const rest = postCallRestDays(input.assignments).filter(r => inWindow(r.date))[0];
  const nextPostCall: NextPostCall | null = rest
    ? { ...rest, daysAway: daysBetween(today, rest.date) }
    : null;

  // ── Next weekend on ──────────────────────────────────────────────────────
  // Same occupancy rule the free-weekend count uses. A weekend qualifies when
  // something lands in it on a date inside the window — a Friday already past
  // does not resurrect last weekend, and a Sunday past the horizon does not
  // pull next month's weekend forward.
  let nextWeekendOn: NextWeekendOn | null = null;
  const occupancy = weekendOccupancy(input.assignments);
  for (const saturday of [...occupancy.keys()].sort()) {
    const reasons = occupancy.get(saturday) ?? [];
    const upcoming = reasons.filter(r => inWindow(r.date));
    if (upcoming.length === 0) continue;
    nextWeekendOn = {
      saturday,
      dates: weekendGroupDates(saturday),
      reasons,
      daysAway: daysBetween(today, upcoming[0].date),
    };
    break;
  }

  // ── Next PTO block ───────────────────────────────────────────────────────
  // Live rows only (pending counts — invariant 2 — denied/canceled do not).
  // A block already running is the answer: it is the leave that concerns them.
  const ptoRows = input.availability
    .filter(r => r.availability_type === PTO_TYPE && !isDismissedAvailability(r))
    .filter(r => r.end_date >= window.start && r.start_date <= window.end)
    .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.end_date.localeCompare(b.end_date));
  const pto = ptoRows[0];
  const nextPto: NextPto | null = pto
    ? {
        start: pto.start_date,
        end: pto.end_date,
        approvalStatus: pto.approval_status,
        daysAway: daysBetween(today, pto.start_date),
        inProgress: pto.start_date <= today,
      }
    : null;

  // ── Next holiday obligation ──────────────────────────────────────────────
  const holidayByDate = new Map<string, string>();
  for (const h of input.holidays) {
    const name = h.name || h.holiday_date;
    for (const d of holidayBlockDates(h.holiday_date, h.name)) {
      if (!holidayByDate.has(d)) holidayByDate.set(d, name);
    }
  }

  const holidayHits: NextHolidayObligation[] = [];
  for (const a of input.assignments) {
    const holiday = holidayByDate.get(a.date);
    if (!holiday || !inWindow(a.date)) continue;
    holidayHits.push({
      date: a.date, holiday, code: a.code, source: 'assignment',
      daysAway: daysBetween(today, a.date),
    });
  }
  // The chief's plan of record, which predates any schedule covering the date.
  for (const r of input.availability) {
    if (r.availability_type !== HOLIDAY_CALL_TYPE || isDismissedAvailability(r)) continue;
    for (const [date, holiday] of holidayByDate) {
      if (date < r.start_date || date > r.end_date || !inWindow(date)) continue;
      holidayHits.push({
        date, holiday, code: r.reason_code ?? null, source: 'recorded',
        daysAway: daysBetween(today, date),
      });
    }
  }
  holidayHits.sort((a, b) =>
    a.date.localeCompare(b.date)
    // A real assignment beats a recorded intention for the same day: it is the
    // one that has actually been built.
    || a.source.localeCompare(b.source)
    || (a.code ?? '').localeCompare(b.code ?? ''));
  const nextHolidayObligation = holidayHits[0] ?? null;

  const availabilityLoaded = input.availabilityLoaded ?? input.availability.length > 0;
  const holidayLoaded = input.holidayCalendarLoaded ?? input.holidays.length > 0;
  const availCoverage = sourceCoverage(window, availabilityLoaded);
  // A holiday obligation needs BOTH the calendar (to know which days are
  // holidays) and, for the assignment half, the published schedule. The weaker
  // of the two governs, so an unbuilt December cannot report "no holiday call".
  const holidayCoverage = holidayLoaded ? coverage : sourceCoverage(window, false);

  return {
    today,
    horizonDays,
    window,
    coverage,
    nextCall,
    nextPostCall,
    nextWeekendOn,
    nextPto,
    nextHolidayObligation,
    status: {
      call: statusFor(!!nextCall, coverage),
      postCall: statusFor(!!nextPostCall, coverage),
      weekend: statusFor(!!nextWeekendOn, coverage),
      pto: statusFor(!!nextPto, availCoverage),
      holiday: statusFor(!!nextHolidayObligation, holidayCoverage),
    },
  };
}
