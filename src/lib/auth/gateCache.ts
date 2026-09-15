// The two caches the auth gate leans on, factored out of middleware.ts so the
// behaviour that matters is unit-testable. Edge middleware itself is not: it
// needs a NextRequest and the edge runtime, and "the gate is fast" is not the
// property worth pinning — "the gate is still correct while being fast" is.
//
// ── WHY CACHE AT ALL ───────────────────────────────────────────────────────
// The gate runs on every matched request, and the matcher includes /api/*.
// The app's pages are client components that fetch their own data, so one
// screen is a page load plus three to seven API calls. Anything the gate does
// per request is therefore paid four to eight times per navigation. It used to
// do two network round trips each time — validate the token against Supabase
// Auth, then query the database for the user's roles.
//
// ── THE RULE BOTH CACHES FOLLOW ────────────────────────────────────────────
// A miss must behave exactly like the uncached code did. A cache may be the
// reason a decision is FAST; it must never be the reason a decision is WRONG.

export interface Clock {
  now(): number;
}

const systemClock: Clock = { now: () => Date.now() };

/**
 * Per-user role names, held briefly.
 *
 * The alternative was Supabase's custom access token hook, which stamps roles
 * into the JWT and removes the query outright. Rejected for two reasons: a
 * token lives an hour, so revoking someone's admin would not take effect for
 * up to an hour; and enabling the hook is a dashboard change, so the code
 * could not ship on its own. A minute of staleness is a far easier thing to
 * reason about than an hour.
 *
 * The staleness window is real and worth stating plainly: for up to `ttlMs`
 * after a grant or a revocation, a warm instance may still act on the previous
 * roles.
 */
export function makeRoleCache(opts: {
  ttlMs: number;
  /** Runaway guard. This is a cache, not a session store. */
  max: number;
  clock?: Clock;
}) {
  const { ttlMs, max, clock = systemClock } = opts;
  const entries = new Map<string, { names: string[]; at: number }>();

  return {
    /** `load` is the uncached lookup; it runs on every miss. */
    async get(userId: string, load: (id: string) => Promise<string[]>): Promise<string[]> {
      const now = clock.now();
      const hit = entries.get(userId);
      if (hit && now - hit.at < ttlMs) return hit.names;

      const names = await load(userId);

      // An EMPTY result is never cached, and that is the important line in
      // this file. The uncached lookup returns [] both for "this user holds no
      // roles" and for "the database did not answer" — it fails closed on
      // purpose. Caching that would turn a one-second blip into a minute of a
      // signed-in chief being bounced to /login, and a half-provisioned user
      // is rare enough that re-reading for them costs nothing that matters.
      if (names.length > 0) {
        if (entries.size >= max) entries.clear();
        entries.set(userId, { names, at: now });
      }
      return names;
    },

    /** Test seam and an escape hatch if a role change must land immediately. */
    invalidate(userId?: string) {
      if (userId === undefined) entries.clear();
      else entries.delete(userId);
    },

    get size() {
      return entries.size;
    },
  };
}

export interface JwkSet {
  keys: unknown[];
}

/**
 * The project's JWT signing keys.
 *
 * getClaims() verifies a token's signature in-process, which is the entire
 * reason to prefer it to getUser(). But the Supabase client is constructed per
 * request, so the key cache INSIDE it is always cold and it would fetch the
 * key set on every call — trading one network round trip for another and
 * winning nothing. Holding the keys here and passing them in short-circuits
 * that lookup before any fetch happens.
 *
 * Signing keys rotate on the order of months, so a long TTL is right.
 */
export function makeJwksCache(opts: {
  ttlMs: number;
  fetchImpl?: typeof fetch;
  clock?: Clock;
}) {
  const { ttlMs, fetchImpl = fetch, clock = systemClock } = opts;
  let cached: JwkSet | null = null;
  let fetchedAt = 0;

  return {
    async get(supabaseUrl: string): Promise<JwkSet | null> {
      const now = clock.now();
      if (cached && now - fetchedAt < ttlMs) return cached;
      try {
        const res = await fetchImpl(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
        if (!res.ok) return cached; // a stale key set beats none
        const body = (await res.json()) as { keys?: unknown[] };
        if (Array.isArray(body.keys) && body.keys.length > 0) {
          cached = { keys: body.keys };
          fetchedAt = now;
        }
      } catch {
        // Network failure falls through deliberately. Returning null makes the
        // caller pass no keys, and getClaims then fetches the set itself or
        // falls back to getUser() — slower, never wrong.
      }
      return cached;
    },
  };
}
