/* Physician self-service metrics (/me). Three pure functions over plain
 * inputs — no DB, no fetch, no clock. See each module's header for the rule it
 * implements and for what it reuses rather than restates. */

export {
  computeCoverage, statusFor, horizonWindow, intersectSpan, spanCovers, spanDays,
} from './types';
export type {
  Coverage, CoverageKind, DateSpan, MetricAssignment, MetricAvailability,
  MetricHoliday, MetricStatus,
} from './types';

export {
  computeFreeWeekends, weekendOccupancy, postCallRestDays, weekendSaturdaysIn,
  MAX_WEEKENDS,
} from './freeWeekends';
export type {
  FreeWeekendsResult, WeekendSummary, WeekendReason, UncoveredWeekend, PostCallRestDay,
} from './freeWeekends';

export {
  computeProviderSpacing, toSpacingSlots, medianOf, DEFAULT_TIGHT_GAP_DAYS,
} from './providerSpacing';
export type { ProviderSpacingResult } from './providerSpacing';

export {
  computeNextUp, DEFAULT_HORIZON_DAYS, PTO_TYPE,
} from './nextUp';
export type {
  NextUpInput, NextUpResult, NextUpStatuses, NextCall, NextPostCall,
  NextWeekendOn, NextPto, NextHolidayObligation,
} from './nextUp';
