// Who may reach which path. Pure, so the security property is a unit test
// rather than a claim about middleware behaviour.
//
// ── DENY BY DEFAULT ────────────────────────────────────────────────────────
// The alternative was an admin check at the top of each of the 67 API routes.
// Rejected: that is 67 chances to omit one, the omission is invisible, and
// every route written afterwards inherits the same trap. Here, a path named in
// no list classifies 'admin' — so a route added tomorrow is chief-only because
// nobody did anything. Exposing something requires editing a list below, which
// is a diff a reviewer sees.
//
// ── THE PROVIDER SURFACE IS A NAMESPACE, NOT AN ALLOW-LIST ─────────────────
// Everything a provider can reach lives under /me or /api/scheduling/me/, and
// those routes derive the provider from the SESSION. This is why the list is
// two prefixes instead of a growing enumeration, and it structurally prevents
// the obvious mistake: exposing /api/scheduling/providers/[id]/burden and
// trusting the [id] in the URL.

export type Access = 'public' | 'provider' | 'admin';
export type SessionRole = 'anonymous' | 'provider' | 'admin';

/**
 * Reachable with NO credential.
 *
 * Every entry is a route anyone on the internet may call, so this list should
 * stay short and every addition should be argued for. A test pins its length.
 */
export const PUBLIC_PREFIXES: readonly string[] = [
  '/login',
  '/join',              // invitation acceptance — by definition pre-session
  '/api/auth',          // sign-in, sign-out, invitation acceptance
  // The legacy tokenized request-window intake. Kept public so open windows do
  // not break mid-block; the token in the URL is its (weak) trust boundary.
  // Retiring it once providers hold logins is a follow-up — see the spec.
  '/requests/submit',
  '/api/requests/submit',
] as const;

/** Reachable by a signed-in provider (and by an admin). */
export const PROVIDER_PREFIXES: readonly string[] = [
  '/me',
  '/api/scheduling/me',
] as const;

/**
 * Does `pathname` sit at or below `prefix`?
 *
 * Segment-aware on purpose. A bare `startsWith` would classify '/members' as
 * the provider surface because it begins with '/me', and '/metrics' likewise —
 * handing admin pages to every physician. The match therefore requires the
 * prefix to be followed by end-of-path or a '/'.
 */
function underPrefix(pathname: string, prefix: string): boolean {
  if (!pathname.startsWith(prefix)) return false;
  const rest = pathname.slice(prefix.length);
  return rest === '' || rest === '/' || rest.startsWith('/');
}

/**
 * Classify a pathname. Anything not explicitly listed is 'admin'.
 *
 * Case-sensitive, matching Next's own routing: an uppercase variant is a
 * different route and must not inherit a lower-cased allowance.
 */
export function classifyRoute(pathname: string): Access {
  // Query and hash never participate; a trailing slash is the same route.
  const path = pathname.split(/[?#]/)[0].replace(/\/+$/, '') || '/';

  // A path containing a '..' segment is not something Next would route; treat
  // it as unknown rather than trying to normalize it into an allowance.
  if (path.split('/').includes('..')) return 'admin';

  for (const p of PUBLIC_PREFIXES) if (underPrefix(path, p)) return 'public';
  for (const p of PROVIDER_PREFIXES) if (underPrefix(path, p)) return 'provider';
  return 'admin';
}

/**
 * May a session with `role` reach a route classified `access`?
 *
 * An admin may reach the provider surface — useful for support, and it is
 * strictly narrower than what they already have. An unrecognised role is
 * denied rather than treated as anonymous-but-harmless.
 */
export function isAllowed(access: Access, role: SessionRole): boolean {
  if (access === 'public') return true;
  if (role === 'admin') return true;
  if (access === 'provider') return role === 'provider';
  return false;
}
