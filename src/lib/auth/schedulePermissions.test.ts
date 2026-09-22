/**
 * Who may do what to a schedule.
 *
 * These are security assertions, so most of them are REFUSALS. The ones that
 * matter most: a provider must never see a draft, and a hidden schedule must
 * not reappear in an ordinary list for anybody.
 */
import { describe, it, expect } from 'vitest';
import {
  canViewSchedule, canEditSchedule, canDeleteSchedule,
  canSeeDeleted, canRestoreSchedule, visibleSchedules,
  type ScheduleActor, type ScheduleSubject, type ScheduleStatus,
} from './schedulePermissions';

const PAOLI = 'site-paoli';
const RIDDLE = 'site-riddle';

const sched = (status: ScheduleStatus, over: Partial<ScheduleSubject> = {}): ScheduleSubject =>
  ({ siteId: PAOLI, status, ...over });

const admin: ScheduleActor = { role: 'admin', providerId: null };
const staff: ScheduleActor = { role: 'staff', providerId: null };
const plainProvider: ScheduleActor = { role: 'provider', providerId: 'p1' };
const chiefOfPaoli: ScheduleActor = {
  role: 'provider', providerId: 'p2', chiefOfSiteIds: [PAOLI],
};
const maker: ScheduleActor = {
  role: 'provider', providerId: 'p3', scheduleMaker: true,
};
const anon: ScheduleActor = { role: 'anonymous', providerId: null };

const UNPUBLISHED: ScheduleStatus[] = ['draft', 'review', 'archived'];

describe('a provider sees published schedules and nothing else', () => {
  it('sees a published one', () => {
    expect(canViewSchedule(plainProvider, sched('published'))).toBe(true);
  });

  it.each(UNPUBLISHED)('cannot see a %s', (status) => {
    expect(canViewSchedule(plainProvider, sched(status))).toBe(false);
  });

  it.each(UNPUBLISHED)('cannot edit a %s either', (status) => {
    expect(canEditSchedule(plainProvider, sched(status))).toBe(false);
  });

  it('cannot edit even a published one', () => {
    expect(canEditSchedule(plainProvider, sched('published'))).toBe(false);
  });

  it('cannot delete anything', () => {
    expect(canDeleteSchedule(plainProvider, sched('published'))).toBe(false);
    expect(canDeleteSchedule(plainProvider, sched('draft'))).toBe(false);
  });
});

describe('a site chief works drafts AT THEIR OWN SITE', () => {
  it.each(UNPUBLISHED)('sees and edits a %s at their site', (status) => {
    expect(canViewSchedule(chiefOfPaoli, sched(status))).toBe(true);
    expect(canEditSchedule(chiefOfPaoli, sched(status))).toBe(true);
  });

  it.each(UNPUBLISHED)('is refused a %s at ANOTHER site', (status) => {
    // The whole reason the chief is modelled per-site. Running Paoli confers
    // nothing at Riddle.
    const other = sched(status, { siteId: RIDDLE });
    expect(canViewSchedule(chiefOfPaoli, other)).toBe(false);
    expect(canEditSchedule(chiefOfPaoli, other)).toBe(false);
  });

  it('cannot DELETE without also holding the Schedule Maker flag', () => {
    // Taken literally from "Only Admins or Schedule makers can delete". A
    // chief can hand themselves the flag, so this is one click, not a wall.
    expect(canDeleteSchedule(chiefOfPaoli, sched('draft'))).toBe(false);
  });

  it('can delete once they also hold the flag', () => {
    expect(canDeleteSchedule(
      { ...chiefOfPaoli, scheduleMaker: true }, sched('draft'))).toBe(true);
  });

  it('does not get to edit a PUBLISHED schedule by virtue of the post', () => {
    expect(canEditSchedule(chiefOfPaoli, sched('published'))).toBe(false);
  });
});

describe('a schedule maker works drafts anywhere, and may delete', () => {
  it.each(UNPUBLISHED)('sees and edits a %s at any site', (status) => {
    expect(canViewSchedule(maker, sched(status, { siteId: RIDDLE }))).toBe(true);
    expect(canEditSchedule(maker, sched(status, { siteId: RIDDLE }))).toBe(true);
  });

  it('may delete', () => {
    expect(canDeleteSchedule(maker, sched('draft'))).toBe(true);
    expect(canDeleteSchedule(maker, sched('published'))).toBe(true);
  });

  it('may NOT restore, or even see, what is deleted — that is admin-only', () => {
    expect(canSeeDeleted(maker)).toBe(false);
    expect(canRestoreSchedule(maker)).toBe(false);
  });
});

describe('back office staff', () => {
  // Not named in the brief. Treated as able to work schedules because that is
  // what the tier exists for, and refused deletion because the brief names
  // exactly two deleting parties.
  it.each(UNPUBLISHED)('sees and edits a %s', (status) => {
    expect(canViewSchedule(staff, sched(status))).toBe(true);
    expect(canEditSchedule(staff, sched(status))).toBe(true);
  });

  it('cannot delete', () => {
    expect(canDeleteSchedule(staff, sched('draft'))).toBe(false);
  });

  it('cannot reach the recycle view', () => {
    expect(canSeeDeleted(staff)).toBe(false);
  });
});

describe('anonymous gets nothing', () => {
  it.each(['published', ...UNPUBLISHED] as ScheduleStatus[])('cannot see a %s', (status) => {
    expect(canViewSchedule(anon, sched(status))).toBe(false);
  });

  it('cannot edit or delete', () => {
    expect(canEditSchedule(anon, sched('published'))).toBe(false);
    expect(canDeleteSchedule(anon, sched('published'))).toBe(false);
  });

  it('an UNRECOGNISED role is denied, not treated as harmless', () => {
    const weird = { role: 'superuser' as never, providerId: null };
    expect(canViewSchedule(weird, sched('draft'))).toBe(false);
    expect(canEditSchedule(weird, sched('draft'))).toBe(false);
    expect(canDeleteSchedule(weird, sched('draft'))).toBe(false);
  });
});

describe('a deleted schedule is hidden from the ordinary lists', () => {
  const gone = sched('published', { deletedAt: '2026-09-22T10:00:00Z' });

  it('is invisible even to an admin in the normal view', () => {
    // It reappears through the recycle view, never by quietly sitting among
    // the live ones.
    expect(canViewSchedule(admin, gone)).toBe(false);
  });

  it('cannot be edited or deleted again', () => {
    expect(canEditSchedule(admin, gone)).toBe(false);
    expect(canDeleteSchedule(admin, gone)).toBe(false);
  });

  it('only an admin may see or restore it', () => {
    expect(canSeeDeleted(admin)).toBe(true);
    expect(canRestoreSchedule(admin)).toBe(true);
    for (const a of [staff, maker, chiefOfPaoli, plainProvider, anon]) {
      expect(canSeeDeleted(a)).toBe(false);
      expect(canRestoreSchedule(a)).toBe(false);
    }
  });
});

describe('visibleSchedules', () => {
  const list: ScheduleSubject[] = [
    sched('published'),
    sched('draft'),
    sched('published', { siteId: RIDDLE }),
    sched('draft', { siteId: RIDDLE }),
    sched('published', { deletedAt: '2026-09-22T10:00:00Z' }),
  ];

  it('gives a provider only the live published ones', () => {
    expect(visibleSchedules(plainProvider, list)).toHaveLength(2);
  });

  it('gives a Paoli chief the published ones plus Paoli drafts', () => {
    const seen = visibleSchedules(chiefOfPaoli, list);
    expect(seen).toHaveLength(3);
    expect(seen.some(s => s.siteId === RIDDLE && s.status === 'draft')).toBe(false);
  });

  it('never includes a deleted schedule by default, for anybody', () => {
    for (const a of [admin, staff, maker, chiefOfPaoli, plainProvider]) {
      expect(visibleSchedules(a, list).some(s => s.deletedAt)).toBe(false);
    }
  });

  it('includes deleted ones ONLY for an admin who asked', () => {
    expect(visibleSchedules(admin, list, true).some(s => s.deletedAt)).toBe(true);
  });

  it('ignores includeDeleted for everyone else — a caller cannot widen it by mistake', () => {
    // The flag is a view toggle, not a permission. If a route passed it
    // through from a query string, this is what stops that being a leak.
    for (const a of [staff, maker, chiefOfPaoli, plainProvider, anon]) {
      expect(visibleSchedules(a, list, true).some(s => s.deletedAt), a.role).toBe(false);
    }
  });
});
