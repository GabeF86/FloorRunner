import { describe, it, expect } from 'vitest';
import {
  generateInviteToken,
  hashInviteToken,
  invitationState,
  inviteExpiry,
  inviteUrl,
  INVITE_TTL_DAYS,
  type InvitationRow,
} from './invitations';

const NOW = new Date('2026-09-09T12:00:00Z');

function row(over: Partial<InvitationRow> = {}): InvitationRow {
  return {
    id: 'inv-1',
    provider_id: 'prov-1',
    email: 'doc@example.com',
    status: 'pending',
    expires_at: '2026-09-23T12:00:00Z',
    ...over,
  };
}

describe('token generation', () => {
  it('never returns the same token twice', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateInviteToken().token);
    expect(seen.size).toBe(200);
  });

  it('produces a URL-safe token with no padding', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateInviteToken().token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('produces at least 256 bits of entropy', () => {
    // base64url: 4 chars per 3 bytes. 32 bytes -> 43 chars.
    expect(generateInviteToken().token.length).toBeGreaterThanOrEqual(43);
  });

  it('returns a hash that is NOT the token', () => {
    // The whole point: what lands in the database must not be usable as a link.
    const { token, tokenHash } = generateInviteToken();
    expect(tokenHash).not.toBe(token);
    expect(tokenHash).not.toContain(token);
  });

  it('returns a sha256 hex digest', () => {
    expect(generateInviteToken().tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes deterministically, so a presented token can be looked up', () => {
    const { token, tokenHash } = generateInviteToken();
    expect(hashInviteToken(token)).toBe(tokenHash);
  });

  it('gives different tokens different hashes', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});

describe('invitationState', () => {
  it('accepts a pending invitation inside its window', () => {
    expect(invitationState(row(), NOW)).toBe('valid');
  });

  it('rejects a missing invitation', () => {
    expect(invitationState(null, NOW)).toBe('not-found');
    expect(invitationState(undefined, NOW)).toBe('not-found');
  });

  it('rejects an already-accepted invitation', () => {
    // Single use. A token that has been redeemed is spent, even in-window.
    expect(invitationState(row({ status: 'accepted' }), NOW)).toBe('accepted');
  });

  it('rejects a revoked invitation', () => {
    expect(invitationState(row({ status: 'revoked' }), NOW)).toBe('revoked');
  });

  it('rejects an expired invitation', () => {
    expect(invitationState(row({ expires_at: '2026-09-09T11:59:59Z' }), NOW)).toBe('expired');
  });

  it('treats the exact expiry instant as expired', () => {
    expect(invitationState(row({ expires_at: NOW.toISOString() }), NOW)).toBe('expired');
  });

  it('reports revoked BEFORE expired when both are true', () => {
    // A revoked token must never read as merely stale — the difference matters
    // when the chief is looking at why someone cannot get in.
    expect(invitationState(
      row({ status: 'revoked', expires_at: '2020-01-01T00:00:00Z' }), NOW,
    )).toBe('revoked');
  });

  it('rejects an unparseable expiry rather than treating it as valid', () => {
    expect(invitationState(row({ expires_at: 'not-a-date' }), NOW)).toBe('expired');
  });

  it('rejects an unknown status rather than assuming pending', () => {
    expect(invitationState(row({ status: 'wat' as InvitationRow['status'] }), NOW))
      .toBe('revoked');
  });
});

describe('inviteExpiry', () => {
  it('is INVITE_TTL_DAYS after the given instant', () => {
    const exp = inviteExpiry(NOW);
    const days = (exp.getTime() - NOW.getTime()) / 86_400_000;
    expect(days).toBe(INVITE_TTL_DAYS);
  });

  it('produces an expiry that its own state check calls valid', () => {
    const exp = inviteExpiry(NOW);
    expect(invitationState(row({ expires_at: exp.toISOString() }), NOW)).toBe('valid');
  });

  it('is two weeks', () => {
    expect(INVITE_TTL_DAYS).toBe(14);
  });
});

describe('inviteUrl', () => {
  it('builds a /join link carrying the token', () => {
    expect(inviteUrl('https://floor-runner.vercel.app', 'abc123'))
      .toBe('https://floor-runner.vercel.app/join/abc123');
  });

  it('does not double a trailing slash on the origin', () => {
    expect(inviteUrl('https://x.dev/', 'abc123')).toBe('https://x.dev/join/abc123');
  });

  it('percent-encodes a token so it cannot alter the path', () => {
    // Tokens are base64url and never need this, but a link built from
    // arbitrary input must not be able to escape its own path segment.
    expect(inviteUrl('https://x.dev', 'a/b?c')).toBe('https://x.dev/join/a%2Fb%3Fc');
  });
});
