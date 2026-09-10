// Turning "who is signed in" into "what may they reach". Pure.
//
// The role names are the ones patch48 seeded into scheduling.roles. They are
// compared EXACTLY — not lower-cased, not prefix-matched — because a role name
// is data someone can type, and "Administrator" should not become admin.

import type { SessionRole } from './routeAccess';

export const ADMIN_ROLE = 'admin';
export const PROVIDER_ROLE = 'provider';

/**
 * The effective role for a session.
 *
 * A signed-in user holding no recognised role resolves to `anonymous`, not to
 * `provider`. That is the half-provisioned case — an auth user exists but the
 * grant never landed — and it must get nothing rather than inherit the lowest
 * real role by virtue of merely being signed in. The invitation-acceptance
 * transaction is what prevents that state from occurring in the first place;
 * this is the second line.
 */
export function resolveSessionRole(
  userId: string | null | undefined,
  roleNames: readonly string[] | null | undefined,
): SessionRole {
  if (!userId) return 'anonymous';
  const names = (roleNames ?? []).filter((n): n is string => typeof n === 'string');
  if (names.includes(ADMIN_ROLE)) return 'admin';
  if (names.includes(PROVIDER_ROLE)) return 'provider';
  return 'anonymous';
}
