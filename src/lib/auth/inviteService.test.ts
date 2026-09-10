// Invitation issue/redeem, exercised with injected clients — no DB, no auth
// server. The assertions that matter are the unwind ones: a failed acceptance
// must leave NO auth user, NO provider link, and a still-pending invitation.
import { describe, it, expect } from 'vitest';
import {
  acceptInvitation,
  createInvitation,
  resolveInvitation,
  type AuthAdmin,
} from './inviteService';
import { hashInviteToken } from './invitations';
import { passwordError, MIN_PASSWORD_LENGTH } from './password';

const NOW = new Date('2026-09-09T12:00:00Z');
const ORG = 'org-1';
const PROVIDER = 'prov-1';
const TOKEN = 'a-token';

interface Canned { data?: unknown; error?: { message: string } | null }

/**
 * Table-keyed fake. `handlers` may return a different canned response per
 * (table, verb), letting a test fail exactly one step of acceptance and assert
 * on what was unwound. Every call is recorded.
 */
function makeSb(handlers: Record<string, Canned | ((verb: string, calls: Call[]) => Canned)>) {
  const calls: Call[] = [];

  function builder(table: string) {
    let verb = 'select';
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit']) {
      b[m] = (...args: unknown[]) => { calls.push({ table, method: m, args }); return b; };
    }
    for (const m of ['update', 'upsert', 'insert', 'delete']) {
      b[m] = (...args: unknown[]) => {
        verb = m; calls.push({ table, method: m, args }); return b;
      };
    }
    const resolve = () => {
      const h = handlers[table];
      const c = typeof h === 'function' ? h(verb, calls) : (h ?? { data: null });
      return { data: c.data ?? null, error: c.error ?? null };
    };
    b.single = () => Promise.resolve(resolve());
    b.maybeSingle = () => Promise.resolve(resolve());
    b.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(ok, err);
    return b;
  }
  return { sb: { from: (t: string) => builder(t) }, calls };
}
interface Call { table: string; method: string; args: unknown[] }

function makeAuth(over: Partial<AuthAdmin> = {}): AuthAdmin & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    createUser: over.createUser ?? (async () => ({ data: { user: { id: 'user-1' } }, error: null })),
    deleteUser: over.deleteUser ?? (async (id: string) => { deleted.push(id); return { error: null }; }),
  } as AuthAdmin & { deleted: string[] };
}

const pendingInvite = {
  id: 'inv-1', provider_id: PROVIDER, email: 'doc@example.com',
  status: 'pending', expires_at: '2026-09-23T12:00:00Z',
};
const unlinkedProvider = {
  id: PROVIDER, organization_id: ORG, first_name: 'Ada', last_name: 'Lovelace',
  linked_user_id: null,
};

/** The all-steps-succeed configuration; individual tests override one table. */
function happy(over: Record<string, Canned | ((v: string, c: Call[]) => Canned)> = {}) {
  return makeSb({
    provider_invitations: (verb) =>
      verb === 'select' ? { data: pendingInvite } : { data: [{ id: 'inv-1' }] },
    providers: (verb) =>
      verb === 'select' ? { data: unlinkedProvider } : { data: [{ id: PROVIDER }] },
    roles: { data: { id: 'role-provider' } },
    users: { data: null },
    user_roles: { data: null },
    ...over,
  });
}

// ── password ───────────────────────────────────────────────────────────────

describe('passwordError', () => {
  it('rejects anything shorter than the minimum', () => {
    expect(passwordError('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toMatch(/at least/);
  });
  it('accepts the minimum exactly', () => {
    expect(passwordError('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });
  it('rejects leading or trailing whitespace', () => {
    expect(passwordError(' ' + 'a'.repeat(MIN_PASSWORD_LENGTH))).toMatch(/space/);
    expect(passwordError('a'.repeat(MIN_PASSWORD_LENGTH) + ' ')).toMatch(/space/);
  });
  it('rejects an absurdly long password rather than hashing it', () => {
    expect(passwordError('a'.repeat(5000))).toMatch(/too long/);
  });
  it('rejects a non-string', () => {
    expect(passwordError(null as unknown as string)).toMatch(/at least/);
  });
});

// ── issuing ────────────────────────────────────────────────────────────────

describe('createInvitation', () => {
  const args = { providerId: PROVIDER, email: 'Doc@Example.COM', origin: 'https://x.dev', now: NOW };

  it('stores a hash, never the token that is in the link', async () => {
    const { sb, calls } = makeSb({
      providers: { data: unlinkedProvider },
      provider_invitations: (verb) => verb === 'insert' ? { data: { id: 'inv-1' } } : { data: null },
    });
    const res = await createInvitation(sb, 'admin-1', args);
    expect(res.ok).toBe(true);

    const token = res.data!.url.split('/join/')[1];
    const inserted = calls.find(c => c.table === 'provider_invitations' && c.method === 'insert')!
      .args[0] as Record<string, unknown>;
    expect(inserted.token_hash).toBe(hashInviteToken(token));
    expect(inserted).not.toHaveProperty('token');
    expect(JSON.stringify(inserted)).not.toContain(token);
  });

  it('revokes any outstanding invitation before issuing a new one', async () => {
    // Not tidiness: the one-pending unique index makes a second insert fail,
    // and a superseded link must stop working immediately.
    const { sb, calls } = makeSb({
      providers: { data: unlinkedProvider },
      provider_invitations: (verb) => verb === 'insert' ? { data: { id: 'inv-2' } } : { data: null },
    });
    await createInvitation(sb, 'admin-1', args);

    const order = calls.filter(c => c.table === 'provider_invitations').map(c => c.method);
    expect(order.indexOf('update')).toBeLessThan(order.indexOf('insert'));
    const revoked = calls.find(c => c.table === 'provider_invitations' && c.method === 'update')!
      .args[0] as Record<string, unknown>;
    expect(revoked.status).toBe('revoked');
  });

  it('lower-cases and trims the email', async () => {
    const { sb, calls } = makeSb({
      providers: { data: unlinkedProvider },
      provider_invitations: (verb) => verb === 'insert' ? { data: { id: 'i' } } : { data: null },
    });
    await createInvitation(sb, null, { ...args, email: '  Doc@Example.COM  ' });
    const inserted = calls.find(c => c.method === 'insert')!.args[0] as Record<string, unknown>;
    expect(inserted.email).toBe('doc@example.com');
  });

  it('rejects a malformed email before writing anything', async () => {
    const { sb, calls } = makeSb({ providers: { data: unlinkedProvider } });
    const res = await createInvitation(sb, null, { ...args, email: 'not-an-email' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(calls.filter(c => c.method === 'insert')).toHaveLength(0);
  });

  it('refuses to invite a provider who already has a login', async () => {
    const { sb } = makeSb({ providers: { data: { ...unlinkedProvider, linked_user_id: 'u-9' } } });
    const res = await createInvitation(sb, null, args);
    expect(res.status).toBe(409);
  });

  it('404s an unknown provider', async () => {
    const { sb } = makeSb({ providers: { data: null } });
    expect((await createInvitation(sb, null, args)).status).toBe(404);
  });
});

// ── resolving ──────────────────────────────────────────────────────────────

describe('resolveInvitation', () => {
  it('returns the provider name for a valid token', async () => {
    const { sb } = makeSb({
      provider_invitations: {
        data: { ...pendingInvite, providers: { short_display_name: 'Lovelace' } },
      },
    });
    const r = await resolveInvitation(sb, TOKEN, NOW);
    expect(r.state).toBe('valid');
    expect(r.providerName).toBe('Lovelace');
    expect(r.email).toBe('doc@example.com');
  });

  it('leaks nothing for an expired token', async () => {
    // No email, no name — a probe learns only that it did not work.
    const { sb } = makeSb({
      provider_invitations: {
        data: { ...pendingInvite, expires_at: '2020-01-01T00:00:00Z', providers: { short_display_name: 'Lovelace' } },
      },
    });
    const r = await resolveInvitation(sb, TOKEN, NOW);
    expect(r.state).toBe('expired');
    expect(r.providerName).toBeNull();
    expect(r.email).toBeNull();
  });

  it('reports not-found for an unknown token', async () => {
    const { sb } = makeSb({ provider_invitations: { data: null } });
    expect((await resolveInvitation(sb, TOKEN, NOW)).state).toBe('not-found');
  });

  it('looks the token up by HASH, never by the token itself', async () => {
    const { sb, calls } = makeSb({ provider_invitations: { data: null } });
    await resolveInvitation(sb, TOKEN, NOW);
    const eq = calls.find(c => c.method === 'eq')!;
    expect(eq.args).toEqual(['token_hash', hashInviteToken(TOKEN)]);
    expect(eq.args).not.toContain(TOKEN);
  });
});

// ── redeeming ──────────────────────────────────────────────────────────────

describe('acceptInvitation — happy path', () => {
  it('creates the account, the user row, the role and the link', async () => {
    const { sb, calls } = happy();
    const auth = makeAuth();
    const res = await acceptInvitation(sb, auth, { token: TOKEN, password: 'correct-horse-battery', now: NOW });

    expect(res.ok).toBe(true);
    expect(calls.some(c => c.table === 'users' && c.method === 'insert')).toBe(true);
    expect(calls.some(c => c.table === 'user_roles' && c.method === 'insert')).toBe(true);
    const link = calls.find(c => c.table === 'providers' && c.method === 'update')!
      .args[0] as Record<string, unknown>;
    expect(link.linked_user_id).toBe('user-1');
    expect(auth.deleted).toEqual([]);
  });

  it('marks the invitation accepted, and only while it is still pending', async () => {
    const { sb, calls } = happy();
    await acceptInvitation(sb, makeAuth(), { token: TOKEN, password: 'correct-horse-battery', now: NOW });
    const close = calls.find(c => c.table === 'provider_invitations' && c.method === 'update')!
      .args[0] as Record<string, unknown>;
    expect(close.status).toBe('accepted');
    // The guard that makes redemption single-use at the write.
    expect(calls.some(c => c.table === 'provider_invitations'
      && c.method === 'eq' && (c.args as string[])[0] === 'status')).toBe(true);
  });

  it('links only a provider that is still unlinked', async () => {
    const { sb, calls } = happy();
    await acceptInvitation(sb, makeAuth(), { token: TOKEN, password: 'correct-horse-battery', now: NOW });
    expect(calls.some(c => c.table === 'providers' && c.method === 'is'
      && (c.args as unknown[])[0] === 'linked_user_id')).toBe(true);
  });
});

describe('acceptInvitation — refuses invalid tokens', () => {
  const pw = 'correct-horse-battery';

  it('rejects an expired invitation without creating an account', async () => {
    const { sb } = makeSb({
      provider_invitations: { data: { ...pendingInvite, expires_at: '2020-01-01T00:00:00Z' } },
    });
    const auth = makeAuth();
    let created = false;
    auth.createUser = async () => { created = true; return { data: { user: { id: 'x' } }, error: null }; };
    const res = await acceptInvitation(sb, auth, { token: TOKEN, password: pw, now: NOW });
    expect(res.ok).toBe(false);
    expect(created).toBe(false);
  });

  it('rejects an already-accepted invitation', async () => {
    const { sb } = makeSb({ provider_invitations: { data: { ...pendingInvite, status: 'accepted' } } });
    expect((await acceptInvitation(sb, makeAuth(), { token: TOKEN, password: pw, now: NOW })).ok).toBe(false);
  });

  it('rejects a weak password before touching anything', async () => {
    const { sb, calls } = happy();
    const res = await acceptInvitation(sb, makeAuth(), { token: TOKEN, password: 'short', now: NOW });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('resolves the role BEFORE creating the account', async () => {
    // Discovering a missing role afterwards would mean unwinding a live
    // credential; failing first means there is nothing to unwind.
    const { sb } = happy({ roles: { data: null } });
    const auth = makeAuth();
    let created = false;
    auth.createUser = async () => { created = true; return { data: { user: { id: 'x' } }, error: null }; };
    const res = await acceptInvitation(sb, auth, { token: TOKEN, password: pw, now: NOW });
    expect(res.ok).toBe(false);
    expect(created).toBe(false);
  });
});

describe('acceptInvitation — unwinds cleanly on every failure', () => {
  const pw = 'correct-horse-battery';

  it('deletes the auth user when the users insert fails', async () => {
    // The state this whole design exists to prevent: an auth user who can sign
    // in but resolves to no provider and no role.
    const { sb } = happy({ users: { error: { message: 'boom' } } });
    const auth = makeAuth();
    const res = await acceptInvitation(sb, auth, { token: TOKEN, password: pw, now: NOW });
    expect(res.ok).toBe(false);
    expect(auth.deleted).toEqual(['user-1']);
  });

  it('deletes the auth user and the users row when the role grant fails', async () => {
    const { sb, calls } = happy({ user_roles: { error: { message: 'boom' } } });
    const auth = makeAuth();
    const res = await acceptInvitation(sb, auth, { token: TOKEN, password: pw, now: NOW });
    expect(res.ok).toBe(false);
    expect(auth.deleted).toEqual(['user-1']);
    expect(calls.some(c => c.table === 'users' && c.method === 'delete')).toBe(true);
  });

  it('unwinds everything when the provider link fails', async () => {
    const { sb, calls } = happy({
      providers: (verb) => verb === 'select'
        ? { data: unlinkedProvider }
        : { error: { message: 'boom' } },
    });
    const auth = makeAuth();
    expect((await acceptInvitation(sb, auth, { token: TOKEN, password: pw, now: NOW })).ok).toBe(false);
    expect(auth.deleted).toEqual(['user-1']);
    expect(calls.some(c => c.table === 'users' && c.method === 'delete')).toBe(true);
    expect(calls.some(c => c.table === 'user_roles' && c.method === 'delete')).toBe(true);
  });

  it('unwinds, INCLUDING the link, when closing the invitation fails', async () => {
    const { sb, calls } = happy({
      provider_invitations: (verb) => verb === 'select'
        ? { data: pendingInvite }
        : { error: { message: 'boom' } },
    });
    const auth = makeAuth();
    expect((await acceptInvitation(sb, auth, { token: TOKEN, password: pw, now: NOW })).ok).toBe(false);
    expect(auth.deleted).toEqual(['user-1']);
    // linked_user_id must go back to null, or the provider is bound to a
    // deleted account and can never be invited again.
    const reverts = calls.filter(c => c.table === 'providers' && c.method === 'update')
      .map(c => c.args[0] as Record<string, unknown>);
    expect(reverts.some(r => r.linked_user_id === null)).toBe(true);
  });

  it('loses the race gracefully when another redemption linked first', async () => {
    const { sb } = happy({
      providers: (verb) => verb === 'select' ? { data: unlinkedProvider } : { data: [] },
    });
    const auth = makeAuth();
    const res = await acceptInvitation(sb, auth, { token: TOKEN, password: pw, now: NOW });
    expect(res.status).toBe(409);
    expect(auth.deleted).toEqual(['user-1']);
  });

  it('loses the race gracefully when another redemption closed the invitation', async () => {
    const { sb } = happy({
      provider_invitations: (verb) => verb === 'select' ? { data: pendingInvite } : { data: [] },
    });
    const auth = makeAuth();
    const res = await acceptInvitation(sb, auth, { token: TOKEN, password: pw, now: NOW });
    expect(res.status).toBe(409);
    expect(auth.deleted).toEqual(['user-1']);
  });

  it('reports a failed account creation without inventing an account', async () => {
    const { sb, calls } = happy();
    const auth = makeAuth({
      createUser: async () => ({ data: null, error: { message: 'email already registered' } }),
    });
    const res = await acceptInvitation(sb, auth, { token: TOKEN, password: pw, now: NOW });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already registered/);
    expect(calls.some(c => c.table === 'users' && c.method === 'insert')).toBe(false);
  });
});
