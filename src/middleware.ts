// The door. Every request passes through here, and anything not explicitly
// allowed is denied — see src/lib/auth/routeAccess.ts for why the decision is
// a pure function tested separately from this file.
//
// ── THE KILL SWITCH ────────────────────────────────────────────────────────
// AUTH_ENFORCED gates enforcement. It exists because RLS and a login wall with
// zero provisioned users lock everyone out, including the chief. The rollout
// is: ship this disabled, bootstrap and verify the admin account, then flip it
// on. It is also the fastest possible remedy if the gate ever misfires in
// production — one env var, no deploy.
//
// Default is DISABLED. That is the safe default for a rollout, and deliberately
// NOT the safe default for a security control, so it must not stay off: once
// the admin account is verified, set AUTH_ENFORCED=true in Vercel.

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { classifyRoute, isAllowed } from '@/lib/auth/routeAccess';
import { resolveSessionRole } from '@/lib/auth/roles';

const ENFORCED = process.env.AUTH_ENFORCED === 'true';

export async function middleware(req: NextRequest) {
  // The response must be created first and carried through: @supabase/ssr
  // refreshes the auth cookies by writing onto it, and a response built later
  // would drop that refresh and sign the user out on token expiry.
  let res = NextResponse.next({ request: { headers: req.headers } });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return res;

  const supabase = createServerClient(url, anon, {
    cookies: {
      get: (name: string) => req.cookies.get(name)?.value,
      set: (name: string, value: string, options: CookieOptions) => {
        req.cookies.set({ name, value, ...options });
        res = NextResponse.next({ request: { headers: req.headers } });
        res.cookies.set({ name, value, ...options });
      },
      remove: (name: string, options: CookieOptions) => {
        req.cookies.set({ name, value: '', ...options });
        res = NextResponse.next({ request: { headers: req.headers } });
        res.cookies.set({ name, value: '', ...options });
      },
    },
  });

  // Always refresh, even when not enforcing: it keeps sessions alive during
  // the rollout so the flip to enforcement does not sign everyone out.
  const { data: userData } = await supabase.auth.getUser();
  const user = userData?.user ?? null;

  if (!ENFORCED) return res;

  const access = classifyRoute(req.nextUrl.pathname);
  if (access === 'public') return res;

  const role = user
    ? resolveSessionRole(user.id, await roleNames(user.id))
    : 'anonymous';

  if (isAllowed(access, role)) return res;

  const isApi = req.nextUrl.pathname.startsWith('/api/');
  if (isApi) {
    return NextResponse.json(
      { error: user ? 'Forbidden.' : 'Sign in required.' },
      { status: user ? 403 : 401 },
    );
  }

  // A signed-in provider who wandered onto a chief page goes to their own
  // dashboard rather than to a login form they have already satisfied —
  // bouncing them to /login would look like their password stopped working.
  if (role === 'provider') {
    return NextResponse.redirect(new URL('/me', req.url));
  }

  const to = new URL('/login', req.url);
  to.searchParams.set('next', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(to);
}

/**
 * Role names for a user, via the service key.
 *
 * Inlined rather than imported from lib/auth/session.ts because that module
 * reaches for next/headers, which is not available in the middleware runtime.
 *
 * The service key is deliberate: reading user_roles through the user's own
 * session would make the authorization decision depend on the policies it is
 * meant to enforce, so a policy mistake could silently strip someone's admin
 * role. On failure this returns [], which resolves to 'anonymous' and denies —
 * the gate fails CLOSED.
 */
async function roleNames(userId: string): Promise<string[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return [];
  try {
    const sb = createClient(url, key, {
      db: { schema: 'scheduling' },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await sb.from('user_roles').select('roles(name)').eq('user_id', userId);
    if (error) return [];
    return (data ?? []).flatMap((r) => {
      const rel = (r as { roles?: unknown }).roles;
      const rows = Array.isArray(rel) ? rel : rel ? [rel] : [];
      return rows.map((x) => (x as { name?: string }).name).filter((n): n is string => !!n);
    });
  } catch {
    return [];
  }
}

export const config = {
  // Everything except Next's own assets and the favicon. Note the matcher does
  // NOT carve out /login or /api/auth — those are handled by classifyRoute, so
  // the public list lives in exactly one place rather than being split between
  // a regex here and a list there.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
