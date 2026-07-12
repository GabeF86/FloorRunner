/**
 * Pins the unified schedule-status → Badge tone map so the three consumer
 * pages (dashboard, schedules list, schedule detail) can't silently drift
 * back to local variants.
 */
import { describe, it, expect } from 'vitest';
import { scheduleStatusTone, scheduleStatusLabel, SCHEDULE_STATUSES } from './statusTones';

describe('scheduleStatusTone', () => {
  it('pins the unified tone map', () => {
    expect(scheduleStatusTone('draft')).toBe('neutral');
    expect(scheduleStatusTone('review')).toBe('warn');
    expect(scheduleStatusTone('published')).toBe('ok');
    expect(scheduleStatusTone('revised')).toBe('warn');
    expect(scheduleStatusTone('archived')).toBe('neutral');
    expect(scheduleStatusTone('locked')).toBe('info');
  });

  it('falls back to neutral for unknown statuses', () => {
    expect(scheduleStatusTone('bogus')).toBe('neutral');
    expect(scheduleStatusTone('')).toBe('neutral');
  });
});

describe('scheduleStatusLabel', () => {
  it('capitalizes the raw status', () => {
    expect(scheduleStatusLabel('draft')).toBe('Draft');
    expect(scheduleStatusLabel('published')).toBe('Published');
  });
});

describe('SCHEDULE_STATUSES', () => {
  it('lists the workflow statuses in lifecycle order', () => {
    expect([...SCHEDULE_STATUSES]).toEqual(['draft', 'review', 'published', 'revised', 'archived']);
  });
});
