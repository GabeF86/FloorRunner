// The door. Every request passes through here, and anything not explicitly
// allowed is denied — see src/lib/auth/routeAccess.ts for why the decision is
// a pure function tested separately from this file.
//
// ── THE KILL SWITCH ────────────────────────────────────────────────────────
// AUTH_ENFORCED gates enforcement. It exists because RLS and a login wall with
// zero provisioned users lock everyone out, including the chief. The rollout
// is: ship this disabled, bootstrap and verify the admin account, then flip it
// on. It is also the fastest remedy if the gate ever misfires in production.
//
// "Fastest" is NOT "instant", and the difference matters during an incident:
// Vercel applies an environment variable at deploy time, so changing it takes
// effect only on the next deployment. Turning this off means editing the var
// AND redeploying (Vercel dashboard → Deployments → Redeploy, roughly a
// minute). An earlier version of this comment said "one env var, no deploy",
// which would have been a bad thing to be relying on while locked out.
//
// Default is DISABLED. That is the safe default for a rollout, and deliberately
// NOT the safe default for a security control, so it must not stay off: once
// the admin account is verified, set AUTH_ENFORCED=true in Vercel.
//
// Pre-flip checklist, verified 2026-09-15 against the live project:
//   - /login and /api/auth are 'public' in routeAccess, so the sign-in path
//     stays reachable once the door closes. This is the one gap that would be
//     unrecoverable without a redeploy.
//   - /join is public too, so outstanding invitations keep working.
//   - auth.users holds exactly ONE account (gabrielfarkas86@gmail.com),
//     confirmed, carrying the 'admin' role, with a successful recent sign-in.
//     One account means no second admin to recover with — which is why the
//     redeploy caveat above is worth knowing BEFORE flipping, not after.
//   - roleNames() failing returns [] → 'anonymous' → denied. That fails closed
//     on purpose, but note the consequence: if SUPABASE_SERVICE_ROLE_KEY were
//     ever absent from the deployment, even a correct sign-in would bounce
//     back to /login in a loop. It is present (the app reads RLS-enabled
//     tables in production, which only the service key can do).
//
// ── THE COST OF VERIFYING LOCALLY ──────────────────────────────────────────
// getClaims() proves a token was signed by this project and has not expired.
// It does NOT ask Supabase whether the account still exists, so unlike the
// getUser() call it replaced, DELETING a user or signing them out globally
// does not take effect until their token expires — up to the JWT lifetime,
// which defaults to one hour. Role changes have the same shape, bounded by the
// role cache's own minute.
//
// That is the standard bargain every stateless-JWT gate makes, and it is the
// right one here: the alternative was a network round trip to Supabase Auth on
// every page load AND every API call, and the pages are client components that
// make three to seven API calls each. If the revocation window ever needs to
// be smaller, shorten the JWT expiry in the Supabase dashboard rather than
// putting the round trip back — that tightens the bound without paying per
// request.
//
// Verified end to end on 2026-09-15 against a throwaway account: a signed-in
// provider reaches /me (200), is bounced from /dashboard to /me rather than to
// /login, and is refused the admin API (403); an anonymous request is refused
// everywhere (307 / 401). The 403-not-401 is the part that proves the token
// was actually verified rather than merely absent.

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { classifyRoute, isAllowed } from '@/lib/auth/routeAccess';
import { resolveSessionRole } from '@/lib/auth/roles';
import { makeJwksCache, makeRoleCache } from '@/lib/auth/gateCache';

const ENFORCED = process.env.AUTH_ENFORCED === 'true';

// ── Caching ────────────────────────────────────────────────────────────────
// Both caches live in lib/auth/gateCache.ts, where their behaviour is
// unit-tested. They are module scope here on purpose: that is what lets them
// survive across requests on a warm instance. Neither is load-bearing for
// correctness — a cold start, an evicted entry or a failed fetch all fall back
// to the slow path that was here before.
const jwks = makeJwksCache({ ttlMs: 10 * 60_000 });
const roles = makeRoleCache({ ttlMs: 60_000, max: 500 });

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

  // Establish who this is, WITHOUT a network round trip in the common case.
  //
  // getClaims() reads the session from the cookie, then verifies the token's
  // signature locally with WebCrypto against the project's public keys. It
  // falls back to getUser() only for symmetric (HS*) tokens or where WebCrypto
  // is unavailable; this project signs ES256, so the local path is the one
  // taken. The previous getUser() call went to Supabase Auth over the network
  // on every single request.
  //
  // Session refresh still happens and still lands on `res`: getClaims reads
  // through getSession(), which renews an expired token and writes the new
  // cookies through the handlers above. That is a network call ONCE an hour
  // per user, not once per request.
  const keys = await jwks.get(url);
  let userId: string | null = null;
  try {
    const { data } = await supabase.auth.getClaims(
      undefined,
      keys ? { jwks: keys as { keys: never[] } } : undefined,
    );
    const sub = data?.claims?.sub;
    userId = typeof sub === 'string' && sub ? sub : null;
  } catch {
    // A malformed or unverifiable token is not a signed-in user. Falls through
    // as anonymous, which the gate denies.
    userId = null;
  }

  if (!ENFORCED) return res;

  const access = classifyRoute(req.nextUrl.pathname);
  if (access === 'public') return res;

  const role = userId
    ? resolveSessionRole(userId, await roles.get(userId, roleNames))
    : 'anonymous';

  if (isAllowed(access, role)) return res;

  const isApi = req.nextUrl.pathname.startsWith('/api/');
  if (isApi) {
    return NextResponse.json(
      { error: userId ? 'Forbidden.' : 'Sign in required.' },
      { status: userId ? 403 : 401 },
    );
  }

  // Someone already signed in who wandered onto a page above their tier goes
  // somewhere they CAN use, not to a login form they have already satisfied —
  // bouncing them to /login would look like their password stopped working.
  if (role === 'provider') {
    return NextResponse.redirect(new URL('/me', req.url));
  }
  // Staff land on the staffing board: it is the page a coordinator opens first,
  // and unlike /me it has something to show them (they have no provider record).
  if (role === 'staff') {
    return NextResponse.redirect(new URL('/operations', req.url));
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
