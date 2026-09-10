// Invitation tokens and their state machine. Pure; no DB, no network.
//
// ── WHY THE DATABASE NEVER HOLDS A USABLE TOKEN ────────────────────────────
// `generateInviteToken` returns the token AND its SHA-256. Only the hash is
// stored. The token itself exists in exactly two places — the email that
// carries it and the URL the invitee clicks — so a database read (a backup, a
// dump, a curious query, a future reporting integration) yields nothing that
// can be redeemed. Lookup works by hashing what the visitor presents and
// matching that, which needs no reversal.
//
// This matters more here than for a typical password reset: an invitation
// token, redeemed, binds a login to a specific physician's record. Whoever
// holds it becomes that person as far as the app is concerned.

import { createHash, randomBytes } from 'crypto';

/** How long an invitation stays redeemable. */
export const INVITE_TTL_DAYS = 14;

/** 32 bytes = 256 bits. base64url so it survives a URL path unescaped. */
const TOKEN_BYTES = 32;

export interface GeneratedToken {
  /** Goes in the link. Never stored. */
  token: string;
  /** Goes in the database. Never enough to redeem. */
  tokenHash: string;
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateInviteToken(): GeneratedToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashInviteToken(token) };
}

/** The stored row, reduced to what the state check needs. */
export interface InvitationRow {
  id: string;
  provider_id: string;
  email: string;
  status: 'pending' | 'accepted' | 'revoked';
  expires_at: string;
}

export type InvitationState =
  | 'valid'
  | 'not-found'
  | 'accepted'
  | 'revoked'
  | 'expired';

/**
 * Can this invitation be redeemed right now?
 *
 * Order is deliberate. `revoked` is reported ahead of `expired` so a token the
 * chief deliberately killed never reads as merely stale — the two call for
 * different responses when someone says they cannot get in. An unknown status
 * is reported as `revoked` rather than assumed pending: a value this code does
 * not recognise is not something to grant access on.
 *
 * An unparseable expiry is `expired` for the same reason — NaN comparisons are
 * all false, so a naive `now < expiry` check would have called it valid.
 */
export function invitationState(
  row: InvitationRow | null | undefined,
  now: Date,
): InvitationState {
  if (!row) return 'not-found';
  if (row.status === 'accepted') return 'accepted';
  if (row.status !== 'pending') return 'revoked';

  const expiry = Date.parse(row.expires_at);
  if (!Number.isFinite(expiry)) return 'expired';
  if (now.getTime() >= expiry) return 'expired';

  return 'valid';
}

export function inviteExpiry(now: Date): Date {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 86_400_000);
}

/**
 * The link the invitee clicks.
 *
 * The token is percent-encoded. Real tokens are base64url and never need it,
 * but a URL assembled from a value this function did not generate must not be
 * able to break out of its own path segment.
 */
export function inviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/join/${encodeURIComponent(token)}`;
}

/** What the /join page tells a visitor whose token will not work. */
export function invitationStateMessage(state: InvitationState): string {
  switch (state) {
    case 'valid':
      return '';
    case 'accepted':
      return 'This invitation has already been used. Try signing in instead.';
    case 'revoked':
      return 'This invitation is no longer valid. Ask for a new one.';
    case 'expired':
      return `This invitation has expired — they last ${INVITE_TTL_DAYS} days. Ask for a new one.`;
    case 'not-found':
    default:
      // Deliberately identical in tone to the others: a visitor probing tokens
      // learns nothing from the difference between "wrong" and "used".
      return 'This invitation link is not valid. Ask for a new one.';
  }
}
