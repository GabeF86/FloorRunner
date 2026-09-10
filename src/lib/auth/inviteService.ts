// Issuing and redeeming invitations. Takes injected clients so the whole
// thing is testable without a database or an auth server.
//
// ── WHY COMPENSATION AND NOT A TRANSACTION ─────────────────────────────────
// Redeeming an invitation spans two systems: Supabase Auth (auth.users, only
// reachable over the Admin API) and the scheduling schema. No transaction can
// cover both. So acceptance runs forward and, on any failure, unwinds what it
// already did in reverse order.
//
// The state this exists to prevent is an auth user with no provider link. That
// person could sign in, and `resolveSessionRole` would hand them 'anonymous'
// -- so every page would deny them, their invitation would read 'accepted',
// and nothing in the UI could explain it or fix it. A stranded account is
// worse than a failed acceptance, because a failed acceptance can be retried:
// the invitation stays pending and the token still works.

import { hashInviteToken, invitationState, inviteExpiry, inviteUrl } from './invitations';
import type { InvitationRow, InvitationState } from './invitations';
import { ADMIN_ROLE, PROVIDER_ROLE } from './roles';
import { passwordError } from './password';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

/** The slice of the Supabase Auth Admin API this needs. */
export interface AuthAdmin {
  createUser(args: { email: string; password: string; email_confirm: boolean }):
    Promise<{ data: { user: { id: string } | null } | null; error: { message: string } | null }>;
  deleteUser(id: string): Promise<{ error: { message: string } | null }>;
}

export interface ServiceResult<T> {
  ok: boolean;
  status: number;
  error?: string;
  data?: T;
}

const fail = (status: number, error: string): ServiceResult<never> =>
  ({ ok: false, status, error });

// ── Issuing ────────────────────────────────────────────────────────────────

export interface CreatedInvitation {
  url: string;
  email: string;
  expiresAt: string;
  providerName: string;
}

/**
 * Issue an invitation, revoking any outstanding one for the same provider.
 *
 * The revoke-first step is not tidiness: `provider_invitations_one_pending`
 * makes two pending rows impossible, so skipping it would make re-inviting
 * fail on a unique violation. Revoking also means the superseded link stops
 * working the moment a new one is issued, which is what a chief re-sending an
 * invitation expects.
 */
export async function createInvitation(
  sb: Sb,
  authAdminUserId: string | null,
  args: { providerId: string; email: string; origin: string; now: Date; role?: 'admin' | 'provider' },
): Promise<ServiceResult<CreatedInvitation>> {
  const email = args.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return fail(400, 'A valid email address is required to send an invitation.');
  }

  const prov = await sb
    .from('providers')
    .select('id, first_name, last_name, short_display_name, linked_user_id')
    .eq('id', args.providerId)
    .maybeSingle();
  if (prov.error) return fail(500, prov.error.message);
  if (!prov.data) return fail(404, 'Provider not found.');
  if (prov.data.linked_user_id) {
    return fail(409, 'This provider already has a login. Nothing to invite.');
  }

  const revoke = await sb
    .from('provider_invitations')
    .update({ status: 'revoked', updated_at: args.now.toISOString() })
    .eq('provider_id', args.providerId)
    .eq('status', 'pending');
  if (revoke.error) return fail(500, revoke.error.message);

  const { token, tokenHash } = (await import('./invitations')).generateInviteToken();
  const expiresAt = inviteExpiry(args.now).toISOString();

  const ins = await sb
    .from('provider_invitations')
    .insert({
      provider_id: args.providerId,
      email,
      token_hash: tokenHash,
      expires_at: expiresAt,
      status: 'pending',
      role: args.role === ADMIN_ROLE ? ADMIN_ROLE : PROVIDER_ROLE,
      invited_by: authAdminUserId,
    })
    .select('id')
    .single();
  if (ins.error) return fail(500, ins.error.message);

  const name = prov.data.short_display_name
    || [prov.data.first_name, prov.data.last_name].filter(Boolean).join(' ')
    || 'this provider';

  return {
    ok: true,
    status: 200,
    data: { url: inviteUrl(args.origin, token), email, expiresAt, providerName: name },
  };
}

// ── Resolving ──────────────────────────────────────────────────────────────

export interface ResolvedInvitation {
  state: InvitationState;
  email: string | null;
  providerName: string | null;
}

/**
 * What the /join page shows before anyone types a password.
 *
 * Returns the same shape for every failure mode; the caller renders a message
 * from `invitationStateMessage`, which is deliberately uniform in tone so that
 * someone probing tokens learns nothing from the difference between "wrong"
 * and "already used".
 */
export async function resolveInvitation(
  sb: Sb,
  token: string,
  now: Date,
): Promise<ResolvedInvitation> {
  const res = await sb
    .from('provider_invitations')
    .select('id, provider_id, email, status, expires_at, providers(first_name, last_name, short_display_name)')
    .eq('token_hash', hashInviteToken(token))
    .maybeSingle();

  if (res.error || !res.data) return { state: 'not-found', email: null, providerName: null };

  const row = res.data as InvitationRow & { providers?: unknown };
  const state = invitationState(row, now);
  if (state !== 'valid') return { state, email: null, providerName: null };

  const rel = row.providers;
  const p = (Array.isArray(rel) ? rel[0] : rel) as
    { first_name?: string; last_name?: string; short_display_name?: string } | undefined;

  return {
    state,
    email: row.email,
    providerName: p?.short_display_name
      || [p?.first_name, p?.last_name].filter(Boolean).join(' ')
      || null,
  };
}

// ── Redeeming ──────────────────────────────────────────────────────────────

export async function acceptInvitation(
  sb: Sb,
  auth: AuthAdmin,
  args: { token: string; password: string; now: Date },
): Promise<ServiceResult<{ providerId: string; email: string }>> {
  const pwError = passwordError(args.password);
  if (pwError) return fail(400, pwError);

  const found = await sb
    .from('provider_invitations')
    .select('id, provider_id, email, status, expires_at, role')
    .eq('token_hash', hashInviteToken(args.token))
    .maybeSingle();
  if (found.error) return fail(500, found.error.message);

  const invitation = found.data as (InvitationRow & { role?: string }) | null;
  const state = invitationState(invitation, args.now);
  if (state !== 'valid' || !invitation) {
    return fail(400, 'This invitation link is not valid. Ask for a new one.');
  }

  const prov = await sb
    .from('providers')
    .select('id, organization_id, first_name, last_name, linked_user_id')
    .eq('id', invitation.provider_id)
    .maybeSingle();
  if (prov.error) return fail(500, prov.error.message);
  if (!prov.data) return fail(404, 'Provider not found.');
  if (prov.data.linked_user_id) {
    return fail(409, 'This provider already has a login. Try signing in instead.');
  }

  const role = await sb
    .from('roles')
    .select('id')
    .eq('organization_id', prov.data.organization_id)
    // The role the INVITATION names, not one the redeemer chose. Anything
    // unrecognised falls back to provider -- an invitation carrying a garbled
    // role must never widen into admin.
    .eq('name', invitation.role === ADMIN_ROLE ? ADMIN_ROLE : PROVIDER_ROLE)
    .maybeSingle();
  if (role.error) return fail(500, role.error.message);
  if (!role.data) {
    // Resolved BEFORE the auth user is created, on purpose: discovering a
    // missing role afterwards would mean unwinding a live credential.
    return fail(500, 'The role named by this invitation is missing for this organization. Apply patch48.');
  }

  // ── forward, with an unwind stack ────────────────────────────────────────
  const undo: Array<() => Promise<void>> = [];
  const unwind = async () => {
    for (const step of undo.reverse()) {
      try { await step(); } catch { /* best effort; the caller already failed */ }
    }
  };

  const created = await auth.createUser({
    email: invitation.email,
    password: args.password,
    email_confirm: true,
  });
  if (created.error || !created.data?.user) {
    return fail(400, created.error?.message || 'Could not create the account.');
  }
  const userId = created.data.user.id;
  undo.push(async () => { await auth.deleteUser(userId); });

  const userRow = await sb.from('users').insert({
    id: userId,
    organization_id: prov.data.organization_id,
    email: invitation.email,
    first_name: prov.data.first_name,
    last_name: prov.data.last_name,
    is_active: true,
  });
  if (userRow.error) { await unwind(); return fail(500, userRow.error.message); }
  undo.push(async () => { await sb.from('users').delete().eq('id', userId); });

  const roleRow = await sb.from('user_roles').insert({ user_id: userId, role_id: role.data.id });
  if (roleRow.error) { await unwind(); return fail(500, roleRow.error.message); }
  undo.push(async () => {
    await sb.from('user_roles').delete().eq('user_id', userId);
  });

  const link = await sb
    .from('providers')
    .update({ linked_user_id: userId })
    .eq('id', invitation.provider_id)
    // Only link a provider that is still unlinked: two people redeeming
    // concurrently must not have the second silently overwrite the first.
    .is('linked_user_id', null)
    .select('id');
  if (link.error) { await unwind(); return fail(500, link.error.message); }
  if (!link.data || (link.data as unknown[]).length === 0) {
    await unwind();
    return fail(409, 'This provider already has a login. Try signing in instead.');
  }
  undo.push(async () => {
    await sb.from('providers').update({ linked_user_id: null }).eq('id', invitation.provider_id);
  });

  const close = await sb
    .from('provider_invitations')
    .update({
      status: 'accepted',
      accepted_at: args.now.toISOString(),
      accepted_user_id: userId,
      updated_at: args.now.toISOString(),
    })
    .eq('id', invitation.id)
    // Single use, enforced at the write: only a still-pending row closes.
    .eq('status', 'pending')
    .select('id');
  if (close.error) { await unwind(); return fail(500, close.error.message); }
  if (!close.data || (close.data as unknown[]).length === 0) {
    // Someone redeemed the same token in the meantime.
    await unwind();
    return fail(409, 'This invitation has already been used.');
  }

  return {
    ok: true,
    status: 200,
    data: { providerId: invitation.provider_id, email: invitation.email },
  };
}
