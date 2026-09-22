// Who may see, edit, delete and restore a schedule.
//
// Pure, so the security property is a unit test rather than a claim about what
// some component remembers to check — the same argument routeAccess.ts makes.
// routeAccess answers "may this session reach /schedules at all"; this answers
// "which of the schedules there may they see, and what may they do to one".
//
// ── THE RULES, AS STATED (Gabriel 2026-09-22) ──────────────────────────────
//   · Providers see PUBLISHED schedules only.
//   · Drafts and unpublished schedules are viewable and editable by admins,
//     the chief of THAT site, and anyone flagged Schedule Maker.
//   · Only admins and schedule makers may delete.
//   · A deleted schedule is hidden, never removed; admins can find and
//     restore it.
//
// ── TWO READINGS THAT ARE NOT IN THE BRIEF, AND THE CALL TAKEN ─────────────
// 1. BACK-OFFICE STAFF. The brief lists admins, chiefs and schedule makers —
//    all provider-side posts — and does not mention the `staff` tier. Staff
//    are treated here as able to view and edit drafts, because that tier was
//    created precisely to "work the schedule" and excluding it would leave the
//    coordinator unable to do the job the role exists for. They may NOT
//    delete: the brief names exactly two deleting parties and a coordinator is
//    neither.
// 2. A CHIEF WHO IS NOT A SCHEDULE MAKER CANNOT DELETE. Taken literally from
//    "Only Admins or Schedule makers can delete". A chief runs the hospital
//    and can hand themselves the Schedule Maker flag, so this costs them one
//    click rather than blocking them — and it keeps deletion to a list of two.
//
// Both are flagged rather than buried; change them here and the tests say what
// broke.

import type { SessionRole } from './routeAccess';

/** The version states a schedule can be in. Mirrors the DB enum. */
export type ScheduleStatus = 'draft' | 'review' | 'published' | 'archived';

/** Everything about the viewer that bears on a schedule decision. */
export interface ScheduleActor {
  role: SessionRole;
  /** Their provider record, when they have one. Staff and admins may not. */
  providerId: string | null;
  /** Site ids where this person is the chief. One per site, so a person is
   *  usually chief of nought or one — an array because nothing stops the same
   *  physician running two hospitals. */
  chiefOfSiteIds?: readonly string[];
  /** provider_employment_profiles.schedule_maker */
  scheduleMaker?: boolean;
}

/** The schedule being judged. */
export interface ScheduleSubject {
  siteId: string;
  status: ScheduleStatus;
  /** Set when soft-deleted. */
  deletedAt?: string | null;
}

/** A published schedule is the schedule of record — what is actually happening. */
function isPublished(s: ScheduleSubject): boolean {
  return s.status === 'published';
}

function isChiefOf(actor: ScheduleActor, siteId: string): boolean {
  return (actor.chiefOfSiteIds ?? []).includes(siteId);
}

/**
 * May this actor work on unpublished schedules at this site?
 *
 * The shared predicate behind viewing and editing a draft — they are the same
 * question, and splitting them would let the two drift so that somebody could
 * see a draft they cannot open, or open one they were not shown.
 */
function canWorkDrafts(actor: ScheduleActor, s: ScheduleSubject): boolean {
  if (actor.role === 'admin') return true;
  if (actor.role === 'staff') return true;          // see note 1 in the header
  if (actor.role !== 'provider') return false;      // anonymous, or unknown
  return isChiefOf(actor, s.siteId) || actor.scheduleMaker === true;
}

/**
 * May they see this schedule at all?
 *
 * Deletion is checked FIRST and for everyone including admins: a deleted
 * schedule is out of the ordinary lists by definition, and an admin reaches it
 * through the recycle view (canSeeDeleted), not by it quietly reappearing
 * among the live ones.
 */
export function canViewSchedule(actor: ScheduleActor, s: ScheduleSubject): boolean {
  if (s.deletedAt) return false;
  if (isPublished(s)) {
    // Published is the schedule of record. Everyone signed in may read it —
    // that is the point of publishing. Anonymous is not "everyone".
    return actor.role !== 'anonymous';
  }
  return canWorkDrafts(actor, s);
}

/** May they change assignments on it? */
export function canEditSchedule(actor: ScheduleActor, s: ScheduleSubject): boolean {
  if (s.deletedAt) return false;
  if (actor.role === 'admin') return true;
  if (isPublished(s)) {
    // Editing a PUBLISHED schedule changes what people are already working to.
    // Staff and schedule makers may still do it — that is the job — but a
    // provider who is merely a site chief does not get it by virtue of the
    // post alone.
    if (actor.role === 'staff') return true;
    return actor.role === 'provider' && actor.scheduleMaker === true;
  }
  return canWorkDrafts(actor, s);
}

/**
 * May they delete it?
 *
 * Admins and schedule makers only, exactly as stated. Note a site chief is
 * absent unless they also hold the flag — see note 2 in the header.
 */
export function canDeleteSchedule(actor: ScheduleActor, s: ScheduleSubject): boolean {
  if (s.deletedAt) return false;                    // already gone; restore, not delete
  if (actor.role === 'admin') return true;
  return actor.role === 'provider' && actor.scheduleMaker === true;
}

/**
 * May they see, and restore, what has been deleted?
 *
 * Admins only — "so that Admins can find and recover them if needed". Keeping
 * the recycle view narrower than the delete right is deliberate: the person
 * who can make something disappear should not necessarily be the person who
 * decides it comes back.
 */
export function canSeeDeleted(actor: ScheduleActor): boolean {
  return actor.role === 'admin';
}

export function canRestoreSchedule(actor: ScheduleActor): boolean {
  return actor.role === 'admin';
}

/**
 * Narrow a list of schedules to what this actor should be shown.
 *
 * `includeDeleted` is the recycle view, and it is ignored for anybody who is
 * not an admin — so a caller passing the flag by mistake cannot widen the list
 * for a provider.
 */
export function visibleSchedules<T extends ScheduleSubject>(
  actor: ScheduleActor,
  schedules: readonly T[],
  includeDeleted = false,
): T[] {
  const deletedToo = includeDeleted && canSeeDeleted(actor);
  return schedules.filter(s => (s.deletedAt
    ? deletedToo
    : canViewSchedule(actor, s)));
}
