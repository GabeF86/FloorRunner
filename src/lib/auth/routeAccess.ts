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

export type Access = 'public' | 'provider' | 'staff' | 'admin';
export type SessionRole = 'anonymous' | 'provider' | 'staff' | 'admin';

/**
 * Reachable with NO credential.
 *
 * Every entry is a route anyone on the internet may call, so this list should
 * stay short and every addition should be argued for. A test pins its length.
 */
export const PUBLIC_PREFIXES: readonly string[] = [
  '/login',
  '/join',              // invitation acceptance — by definition pre-session
  // NAMED INDIVIDUALLY, not as a blanket '/api/auth' (narrowed 2026-09-18).
  // The namespace prefix made every FUTURE route under /api/auth public by
  // default — the exact inversion of the rule this file exists to enforce, and
  // /api/auth is precisely where user administration would be added. Found by
  // a test asserting a hypothetical /api/auth/users would be admin-only; it
  // was public.
  '/api/auth/signin',
  '/api/auth/signout',
  '/api/auth/me',         // returns an anonymous session when there is none
  '/api/auth/accept-invite',
  '/api/auth/invite',     // GET /invite/<token> — pre-session by definition
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
 * Reachable by back-office STAFF (and by an admin).
 *
 * The coordinator surface: enter and maintain operational data, work the
 * schedule, demonstrate the platform. It is an ALLOW-LIST, so the deny-by-
 * default rule still governs everything absent from it.
 *
 * ── WHAT IS DELIBERATELY NOT HERE, AND WHY ────────────────────────────────
 * Each of these is "structural" in the sense that it changes how the system
 * behaves rather than what it holds:
 *
 *   /settings, /api/scheduling/organizations
 *       organisation-level configuration.
 *   /rules, /api/scheduling/call-patterns
 *       the generation contract. Editing a call pattern silently changes every
 *       future schedule at a site, and an invalid document falls back to the
 *       classic pattern without erroring — a mistake here is both powerful and
 *       quiet.
 *   /api/scheduling/assistant, /api/board/assistant
 *       the LLM assistants can make structural changes and bulk assignment
 *       edits under one instruction. Undo exists, but "an assistant did
 *       something broad" is not a thing to hand to a second account before the
 *       first has watched it work.
 *   /api/scheduling/shift-types, /api/scheduling/shift-templates
 *       the vocabulary the schedule is written in.
 *   /api/scheduling/debug
 *
 * USER ADMINISTRATION is not on this list either — but note that today there
 * is NO route that creates or alters a login. Invitations are minted by a local
 * script that needs the service-role key and a shell. So "lock the owner out"
 * is not reachable over HTTP by anyone, whatever their role; when such a route
 * is added it will be admin-only by the deny-by-default rule, without anybody
 * having to remember.
 */
export const STAFF_PREFIXES: readonly string[] = [
  // Pages — read, demonstrate, and work the day.
  '/dashboard',
  '/operations',
  '/schedules',
  '/providers',
  '/sites',
  '/board',
  '/reports',
  '/requests',
  '/block-prep',
  '/staffing-calculator',
  '/grid-calculator',

  // Data entry and day-to-day operations.
  '/api/scheduling/staffing-demand',
  // Reads the published schedule's headcount for the staffing calculator.
  // /staffing-calculator is a staff page, so the route feeding it has to be
  // reachable by staff too — otherwise the page renders and its numbers 403.
  '/api/scheduling/staffing-availability',
  '/api/scheduling/availability',
  '/api/scheduling/providers',
  '/api/scheduling/sites',
  '/api/scheduling/schedules',
  '/api/scheduling/schedule-slots',
  '/api/scheduling/schedule-assignments',
  '/api/scheduling/requests',
  '/api/scheduling/request-windows',
  '/api/scheduling/holidays',
  '/api/scheduling/holiday-call',
  '/api/scheduling/custom-fields',
  '/api/scheduling/swaps',
  '/api/scheduling/open-call',
  '/api/scheduling/planner',
  '/api/scheduling/master-schedule',
  '/api/scheduling/block-prep',
  '/api/board',
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
  // Checked AFTER the two narrower lists and BEFORE the admin default. Order
  // matters: /api/board/assistant must not inherit the '/api/board' allowance,
  // so it is excluded explicitly below rather than by list ordering.
  if (ASSISTANT_PREFIXES.some(p => underPrefix(path, p))) return 'admin';
  for (const p of STAFF_PREFIXES) if (underPrefix(path, p)) return 'staff';
  return 'admin';
}

/**
 * Routes that sit UNDER an allowed staff prefix but must stay admin-only.
 *
 * Needed because the staff list is prefix-based: '/api/board' would otherwise
 * hand over '/api/board/assistant'. Checked before the staff list, so a
 * carve-out cannot be defeated by adding a broader prefix later.
 */
const ASSISTANT_PREFIXES: readonly string[] = [
  '/api/board/assistant',
  '/api/scheduling/assistant',
  '/api/scheduling/call-patterns',
  '/api/scheduling/shift-types',
  '/api/scheduling/shift-templates',
] as const;

/**
 * May a session with `role` reach a route classified `access`?
 *
 * An admin may reach every surface — useful for support, and strictly wider
 * than anything below. Staff reach the staff surface only: NOT the provider
 * surface, because a coordinator has no provider record and /me would have
 * nothing to show them. An unrecognised role is denied rather than treated as
 * anonymous-but-harmless.
 */
export function isAllowed(access: Access, role: SessionRole): boolean {
  if (access === 'public') return true;
  if (role === 'admin') return true;
  if (access === 'staff') return role === 'staff';
  if (access === 'provider') return role === 'provider';
  return false;
}
