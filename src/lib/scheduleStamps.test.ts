import { describe, it, expect } from 'vitest';
import { formatStamp, maxStamp, scheduleStamps, SAME_STAMP_TOLERANCE_MS } from './scheduleStamps';

// Draft timestamps on the schedules list (Gabriel 2026-07-27): "I want you to
// create a time stamp for each draft schedule that is made" — created + last
// edited, so six same-date-range drafts can be told apart by freshness.
//
// Every case pins timeZone so the suite doesn't depend on the machine's zone;
// production omits the option and renders in the viewer's local zone.
const TZ = { timeZone: 'America/New_York' } as const;

describe('formatStamp', () => {
  it('renders a local date + time in the agreed shape', () => {
    // 20:38Z = 4:38pm EDT
    expect(formatStamp('2026-07-26T20:38:00+00:00', TZ)).toBe('Jul 26, 4:38pm');
    expect(formatStamp('2026-07-26T13:05:00+00:00', TZ)).toBe('Jul 26, 9:05am');
  });

  it('survives Postgres microsecond precision', () => {
    expect(formatStamp('2026-07-26T21:02:11.482913+00:00', TZ)).toBe('Jul 26, 5:02pm');
  });

  it('renders the LOCAL day, not the UTC day', () => {
    // 01:15Z on the 27th is still 9:15pm on the 26th in New York.
    expect(formatStamp('2026-07-27T01:15:00+00:00', TZ)).toBe('Jul 26, 9:15pm');
  });

  it('returns null (never "Invalid Date") for missing or unparseable input', () => {
    expect(formatStamp(null, TZ)).toBeNull();
    expect(formatStamp(undefined, TZ)).toBeNull();
    expect(formatStamp('', TZ)).toBeNull();
    expect(formatStamp('   ', TZ)).toBeNull();
    expect(formatStamp('not a timestamp', TZ)).toBeNull();
  });
});

describe('scheduleStamps', () => {
  it('shows both lines when the draft was really edited later', () => {
    expect(scheduleStamps(
      '2026-07-26T20:38:00+00:00',
      '2026-07-26T21:02:00+00:00',
      TZ,
    )).toEqual({ created: 'Jul 26, 4:38pm', edited: 'Jul 26, 5:02pm' });
  });

  it('suppresses "edited" when updated_at equals created_at', () => {
    const t = '2026-07-24T13:12:00+00:00';
    expect(scheduleStamps(t, t, TZ)).toEqual({ created: 'Jul 24, 9:12am', edited: null });
  });

  it('suppresses "edited" for an insert-time double write inside the tolerance', () => {
    // Same second, and the tolerance boundary itself, both count as untouched.
    expect(scheduleStamps(
      '2026-07-24T13:12:00.100+00:00',
      '2026-07-24T13:12:00.640+00:00',
      TZ,
    ).edited).toBeNull();
    expect(scheduleStamps(
      '2026-07-24T13:12:00.000+00:00',
      new Date(Date.parse('2026-07-24T13:12:00.000+00:00') + SAME_STAMP_TOLERANCE_MS).toISOString(),
      TZ,
    ).edited).toBeNull();
  });

  it('shows "edited" once past the tolerance', () => {
    expect(scheduleStamps(
      '2026-07-24T13:12:00.000+00:00',
      new Date(Date.parse('2026-07-24T13:12:00.000+00:00') + SAME_STAMP_TOLERANCE_MS + 1).toISOString(),
      TZ,
    ).edited).toBe('Jul 24, 9:12am');
  });

  it('suppresses "edited" when updated_at precedes created_at (clock skew)', () => {
    expect(scheduleStamps(
      '2026-07-26T20:38:00+00:00',
      '2026-07-20T20:38:00+00:00',
      TZ,
    )).toEqual({ created: 'Jul 26, 4:38pm', edited: null });
  });

  it('drops only the line it cannot render', () => {
    expect(scheduleStamps(null, '2026-07-26T21:02:00+00:00', TZ))
      .toEqual({ created: null, edited: 'Jul 26, 5:02pm' });
    expect(scheduleStamps('2026-07-26T20:38:00+00:00', null, TZ))
      .toEqual({ created: 'Jul 26, 4:38pm', edited: null });
    expect(scheduleStamps(undefined, undefined, TZ))
      .toEqual({ created: null, edited: null });
  });
});

// maxStamp backs the last-activity rollup (lib/scheduleActivity.ts): the
// schedule row's own stamp, the version stamps and the two aggregate maxes all
// collapse through here, so the "which source wins" question has exactly one
// implementation.
describe('maxStamp', () => {
  it('returns the latest stamp regardless of argument order', () => {
    const row = '2026-07-26T21:38:00+00:00';   // schedules.updated_at
    const assign = '2026-07-27T04:16:00+00:00'; // max(assignments.updated_at)
    expect(maxStamp(row, assign)).toBe(assign);
    expect(maxStamp(assign, row)).toBe(assign);
  });

  it('returns the stamp VERBATIM, so Postgres precision survives', () => {
    // Not re-serialized through Date — .482913 would round to .482Z.
    expect(maxStamp('2026-07-01T00:00:00+00:00', '2026-07-26T21:02:11.482913+00:00'))
      .toBe('2026-07-26T21:02:11.482913+00:00');
  });

  it('ignores missing, blank and unparseable values', () => {
    expect(maxStamp(null, '2026-07-26T21:38:00+00:00', undefined, '', '   ', 'not a timestamp'))
      .toBe('2026-07-26T21:38:00+00:00');
  });

  it('is null when nothing is usable, including with no arguments at all', () => {
    expect(maxStamp()).toBeNull();
    expect(maxStamp(null, undefined, '')).toBeNull();
  });

  it('keeps the FIRST argument on a tie, so callers can order by preference', () => {
    const a = '2026-07-26T21:38:00+00:00';
    const b = '2026-07-26T17:38:00-04:00'; // same instant, different spelling
    expect(maxStamp(a, b)).toBe(a);
    expect(maxStamp(b, a)).toBe(b);
  });

  it('composes: a suppressed row stamp still shows "edited" once real work lands', () => {
    // The shipped bug, end to end. created == updated_at on the row, so the
    // row stamp alone suppresses; rolling in the assignment max un-suppresses.
    const created = '2026-07-26T21:38:00+00:00';
    expect(scheduleStamps(created, created, TZ).edited).toBeNull();
    expect(scheduleStamps(created, maxStamp(created, '2026-07-27T04:16:00+00:00'), TZ).edited)
      .toBe('Jul 27, 12:16am');
  });
});
