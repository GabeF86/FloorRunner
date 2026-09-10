// Session plumbing: cookie-backed Supabase clients and the role lookup.
//
// Distinct from src/lib/supabaseServer.ts, which builds a SERVICE-ROLE client
// that bypasses RLS. Everything here is scoped to the signed-in user.

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { resolveSessionRole } from './roles';
import type { SessionRole } from './routeAccess';

function env() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error(
      'Supabase auth env vars missing — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    );
  }
  return { url, anon };
}

/**
 * A user-scoped client for server components and route handlers.
 *
 * Reads and writes the auth cookies through next/headers. Writes are wrapped
 * in try/catch because a Server Component may not set cookies — the middleware
 * is what actually refreshes them, so a failure here is expected and benign.
 */
export function sbSession() {
  const { url, anon } = env();
  const store = cookies();
  return createServerClient(url, anon, {
    cookies: {
      get: (name: string) => store.get(name)?.value,
      set: (name: string, value: string, options: CookieOptions) => {
        try { store.set({ name, value, ...options }); } catch { /* RSC: middleware refreshes */ }
      },
      remove: (name: string, options: CookieOptions) => {
        try { store.set({ name, value: '', ...options }); } catch { /* as above */ }
      },
    },
  });
}

/**
 * Role names held by a user.
 *
 * Uses the SERVICE key deliberately. The alternative — reading user_roles
 * through the user's own session — makes the authorization decision depend on
 * the very policies it is meant to enforce, so a policy mistake could hide a
 * user's admin role and lock them out, or worse. The role lookup should not be
 * subject to RLS.
 */
export async function roleNamesFor(userId: string): Promise<string[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return [];

  const sb = createClient(url, key, {
    db: { schema: 'scheduling' },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await sb
    .from('user_roles')
    .select('roles(name)')
    .eq('user_id', userId);
  if (error) return [];

  return (data ?? []).flatMap((r) => {
    const rel = (r as { roles?: unknown }).roles;
    const rows = Array.isArray(rel) ? rel : rel ? [rel] : [];
    return rows.map((x) => (x as { name?: string }).name).filter((n): n is string => !!n);
  });
}

export interface SessionInfo {
  userId: string | null;
  role: SessionRole;
  email: string | null;
  /** The provider this login IS, or null for an admin who is not a physician. */
  providerId: string | null;
}

export const ANONYMOUS: SessionInfo = {
  userId: null, role: 'anonymous', email: null, providerId: null,
};

/** Resolve the caller from cookies. Never throws — an unreadable session is anonymous. */
export async function currentSession(): Promise<SessionInfo> {
  try {
    const { data, error } = await sbSession().auth.getUser();
    if (error || !data?.user) return ANONYMOUS;

    const userId = data.user.id;
    const [roles, providerId] = await Promise.all([
      roleNamesFor(userId),
      providerIdFor(userId),
    ]);
    return {
      userId,
      role: resolveSessionRole(userId, roles),
      email: data.user.email ?? null,
      providerId,
    };
  } catch {
    return ANONYMOUS;
  }
}

/** providers.linked_user_id → provider id. Service key, for the same reason as roleNamesFor. */
export async function providerIdFor(userId: string): Promise<string | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  const sb = createClient(url, key, {
    db: { schema: 'scheduling' },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await sb
    .from('providers')
    .select('id')
    .eq('linked_user_id', userId)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { id: string }).id;
}

/**
 * A hard admin gate, independent of AUTH_ENFORCED.
 *
 * The middleware is the general control, but it is env-gated so the rollout
 * can proceed without locking anyone out. That gate being off must NOT leave
 * account-creating routes open: minting an invitation yields a link that
 * creates a durable login bound to a real physician, which is a strictly worse
 * exposure than reading data. Those routes call this instead of relying on the
 * middleware, so they are closed from the moment they ship.
 *
 * Before any admin exists this denies everyone — correct, and the reason the
 * first account is bootstrapped by a local script rather than over HTTP.
 */
export async function requireAdmin(): Promise<
  { ok: true; session: SessionInfo } | { ok: false; status: number; error: string }
> {
  const session = await currentSession();
  if (!session.userId) return { ok: false, status: 401, error: 'Sign in required.' };
  if (session.role !== 'admin') return { ok: false, status: 403, error: 'Forbidden.' };
  return { ok: true, session };
}
