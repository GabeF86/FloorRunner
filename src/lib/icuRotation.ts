// ICU rotation entry helpers (patch29 feature). Pure date math + row
// planning shared by the profile Availability tab's ICU section.
//
// Convention: an ICU week is stored as TWO provider_availability rows —
//   1. availability_type 'blocked', reason_code 'icu_week'  — the week itself
//   2. availability_type 'blocked', reason_code 'icu_post_call' — the Monday
//      immediately AFTER the week's end (strictly after: a week ending on a
//      Monday gets the NEXT Monday).
// 'blocked' is already in the engine's BLOCKING_AVAIL set, so no engine
// change is needed — these rows block call and day placement everywhere.
// The Monday row is skipped when an existing blocked row already covers that
// date (e.g. back-to-back ICU weeks), so entries never duplicate.

export const ICU_WEEK_REASON = 'icu_week';
export const ICU_POST_CALL_REASON = 'icu_post_call';

// Minimal availability-row shape the helpers need. UI rows and API rows both
// satisfy this structurally.
export interface IcuAvailabilityRow {
  id: string;
  availability_type: string;
  reason_code: string | null;
  start_date: string;
  end_date: string;
}

export interface IcuRowPayload {
  availability_type: 'blocked';
  reason_code: string;
  start_date: string;
  end_date: string;
}

export interface IcuPlan {
  week: IcuRowPayload;
  // Null when an existing blocked row already covers the Monday.
  monday: IcuRowPayload | null;
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Default week end: start + 6 days (a 7-day week). */
export function icuWeekEnd(start: string): string {
  return addDays(start, 6);
}

/** The Monday strictly after `end` (an end falling ON Monday → next Monday). */
export function icuMondayAfter(end: string): string {
  const dow = new Date(end + 'T00:00:00Z').getUTCDay(); // 0=Sun
  let delta = (1 - dow + 7) % 7;
  if (delta === 0) delta = 7;
  return addDays(end, delta);
}

/**
 * Plan the row inserts for one ICU week entry. `existing` is the provider's
 * current availability rows; if any 'blocked' row already covers the post-call
 * Monday, the Monday row is omitted (never duplicated).
 */
export function planIcuEntry(
  start: string,
  end: string | undefined,
  existing: IcuAvailabilityRow[],
): IcuPlan {
  const weekEnd = end || icuWeekEnd(start);
  if (weekEnd < start) {
    throw new Error('ICU week end date must be on or after the start date');
  }
  const monday = icuMondayAfter(weekEnd);
  const covered = existing.some(r =>
    r.availability_type === 'blocked' &&
    r.start_date <= monday && r.end_date >= monday,
  );
  return {
    week: {
      availability_type: 'blocked',
      reason_code: ICU_WEEK_REASON,
      start_date: start,
      end_date: weekEnd,
    },
    monday: covered ? null : {
      availability_type: 'blocked',
      reason_code: ICU_POST_CALL_REASON,
      start_date: monday,
      end_date: monday,
    },
  };
}

export interface IcuPair<R extends IcuAvailabilityRow> {
  week: R;
  monday: R | null;
}

/**
 * Group a provider's availability rows into displayable ICU entries: each
 * icu_week row plus the icu_post_call row sitting on its post-week Monday
 * (if one exists). Deleting an entry deletes both pieces together.
 */
export function pairIcuRows<R extends IcuAvailabilityRow>(rows: R[]): IcuPair<R>[] {
  const weeks = rows.filter(r => r.availability_type === 'blocked' && r.reason_code === ICU_WEEK_REASON);
  const mondays = rows.filter(r => r.availability_type === 'blocked' && r.reason_code === ICU_POST_CALL_REASON);
  const used = new Set<string>();
  return weeks
    .slice()
    .sort((a, b) => a.start_date.localeCompare(b.start_date))
    .map(week => {
      const target = icuMondayAfter(week.end_date);
      const monday = mondays.find(m => !used.has(m.id) && m.start_date === target) || null;
      if (monday) used.add(monday.id);
      return { week, monday };
    });
}
