// Turn the session into the facts schedulePermissions needs.
//
// schedulePermissions.ts is pure and knows nothing about the database; this is
// the one place that reads the two DB facts it depends on — which sites this
// person is chief of, and whether they hold the Schedule Maker flag.
//
// ── WHY BOTH FACTS COME FROM THE PROVIDER ID, NEVER FROM A URL ─────────────
// The same rule the provider surface is built on: identity is derived from the
// SESSION. A chiefdom read from a site id in a query string would let anybody
// claim any hospital by editing the address bar.
//
// An actor is built even for anonymous and staff sessions, because "no
// provider record" is a perfectly ordinary state — admins and back-office
// coordinators have none — and the permission rules already handle it.

import { currentSession } from './session';
import type { ScheduleActor } from './schedulePermissions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchedulingClient = any;

/**
 * Read the chiefdoms and the Schedule Maker flag for one provider.
 *
 * A FAILED READ RETURNS THE NARROWER ANSWER, never the wider one. If the chief
 * lookup errors, this reports no chiefdoms — the person loses sight of drafts
 * until the database is answering again, which is the safe direction. The
 * opposite convention would hand somebody a hospital on a transient error.
 */
export async function scheduleActorFor(
  sb: SchedulingClient,
  session: { role: ScheduleActor['role']; providerId: string | null },
): Promise<ScheduleActor> {
  const base: ScheduleActor = {
    role: session.role,
    providerId: session.providerId,
    chiefOfSiteIds: [],
    scheduleMaker: false,
  };
  if (!session.providerId) return base;

  const [chiefRes, profileRes] = await Promise.all([
    sb.from('sites').select('id').eq('chief_provider_id', session.providerId),
    sb.from('provider_employment_profiles')
      .select('schedule_maker').eq('provider_id', session.providerId).maybeSingle(),
  ]);

  return {
    ...base,
    chiefOfSiteIds: chiefRes.error
      ? []
      : ((chiefRes.data ?? []) as Array<{ id: string }>).map(r => r.id),
    scheduleMaker: profileRes.error
      ? false
      : profileRes.data?.schedule_maker === true,
  };
}

/** The actor for the caller of the current request. */
export async function currentScheduleActor(sb: SchedulingClient): Promise<ScheduleActor> {
  const s = await currentSession();
  return scheduleActorFor(sb, { role: s.role, providerId: s.providerId });
}
