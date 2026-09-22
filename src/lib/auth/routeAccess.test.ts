import { describe, it, expect } from 'vitest';
import {
  classifyRoute,
  isAllowed,
  PUBLIC_PREFIXES,
  PROVIDER_PREFIXES,
  type Access,
  type SessionRole,
} from './routeAccess';

describe('classifyRoute — deny by default', () => {
  it('classifies an unknown API path as admin-only', () => {
    expect(classifyRoute('/api/scheduling/anything-at-all')).toBe('admin');
  });

  it('classifies a route that does not exist yet as admin-only', () => {
    // THE property this module exists for. A route added tomorrow, named in no
    // list, must be chief-only because doing nothing denies. If this ever
    // returns 'public' the whole design has failed.
    expect(classifyRoute('/api/scheduling/some/future/endpoint')).toBe('admin');
    expect(classifyRoute('/totally/unknown/page')).toBe('admin');
    expect(classifyRoute('/')).toBe('admin');
  });

  it('keeps the STRUCTURAL surfaces admin-only', () => {
    // These change how the system behaves rather than what it holds, so they
    // stay with the owner even though back-office staff work in the app all
    // day. /rules and call-patterns are the sharpest: an edit there silently
    // changes every future schedule at a site, and an invalid pattern document
    // falls back to the classic pattern WITHOUT erroring.
    for (const p of [
      '/rules', '/settings',
      '/api/scheduling/organizations',
      '/api/scheduling/call-patterns',
      '/api/scheduling/call-patterns/apply',
      '/api/scheduling/shift-types',
      '/api/scheduling/shift-templates',
      '/api/scheduling/assistant',
      '/api/scheduling/assistant/act',
      '/api/board/assistant',
      '/api/scheduling/debug',
    ]) {
      expect(classifyRoute(p), p).toBe('admin');
    }
  });

  it('classifies the operational surface as staff', () => {
    for (const p of [
      '/schedules', '/schedules/abc-123', '/providers', '/providers/abc-123',
      '/board', '/sites', '/reports', '/requests',
      // '/dashboard' EXACTLY is no longer staff — it is the UAS Master
      // roll-up, admin-only since 2026-09-22 (see the ADMIN_EXACT block
      // below). A site's own dashboard is still staff, which is the whole
      // point of matching it exactly rather than by prefix.
      '/dashboard/abc-123',
      '/block-prep', '/grid-calculator', '/staffing-calculator', '/operations',
      '/api/scheduling/providers',
      '/api/scheduling/providers/abc-123/burden',
      '/api/scheduling/schedules',
      '/api/scheduling/staffing-demand',
      '/api/scheduling/block-prep',
      '/api/scheduling/holiday-call',
    ]) {
      expect(classifyRoute(p), p).toBe('staff');
    }
  });

  it('does NOT let a carve-out be swallowed by a broader staff prefix', () => {
    // '/api/board' is a staff prefix; '/api/board/assistant' must not inherit
    // it. The carve-out is checked first precisely so that adding a wider
    // prefix later cannot quietly defeat it.
    expect(classifyRoute('/api/board')).toBe('staff');
    expect(classifyRoute('/api/board/assistant')).toBe('admin');
    expect(classifyRoute('/api/board/assistant/stream')).toBe('admin');
  });

  it('still denies by default — an unlisted route is admin', () => {
    for (const p of ['/api/scheduling/something-new', '/a-new-page', '/api/whatever']) {
      expect(classifyRoute(p), p).toBe('admin');
    }
  });
});

describe('classifyRoute — the named exceptions', () => {
  it('classifies the sign-in and join paths as public', () => {
    expect(classifyRoute('/login')).toBe('public');
    expect(classifyRoute('/join/some-token')).toBe('public');
    // The five real pre-session routes, named individually. '/api/auth' is
    // deliberately NOT a blanket prefix any more.
    expect(classifyRoute('/api/auth/signin')).toBe('public');
    expect(classifyRoute('/api/auth/signout')).toBe('public');
    expect(classifyRoute('/api/auth/me')).toBe('public');
    expect(classifyRoute('/api/auth/accept-invite')).toBe('public');
    expect(classifyRoute('/api/auth/invite/some-token')).toBe('public');
    // A route that does not exist under /api/auth is NOT public. It used to
    // be, because the whole namespace was listed.
    expect(classifyRoute('/api/auth/callback')).toBe('admin');
  });

  it('keeps the legacy tokenized request intake public', () => {
    // Open request windows must not break mid-block. Retiring this is a
    // follow-up once providers are on logins.
    expect(classifyRoute('/requests/submit/abc123')).toBe('public');
    expect(classifyRoute('/api/requests/submit/abc123')).toBe('public');
  });

  it('classifies the provider surface as provider-reachable', () => {
    expect(classifyRoute('/me')).toBe('provider');
    expect(classifyRoute('/me/onboarding')).toBe('provider');
    expect(classifyRoute('/api/scheduling/me/schedule')).toBe('provider');
    expect(classifyRoute('/api/scheduling/me/metrics')).toBe('provider');
  });

  it('does NOT let a /me prefix match a lookalike admin path', () => {
    // '/members' starts with '/me'. A naive startsWith would hand the whole
    // path to providers.
    expect(classifyRoute('/members')).toBe('admin');
    expect(classifyRoute('/metrics')).toBe('admin');
    expect(classifyRoute('/api/scheduling/mentions')).toBe('admin');
  });

  it('does NOT let a crafted path escape the provider namespace', () => {
    // Traversal-ish shapes must not be classified as provider just because
    // they contain the prefix somewhere.
    // Not 'provider' — the point of the test. It lands on the staff surface
    // because /api/scheduling/providers is one, which is correct: it is a
    // providers route, not the session-scoped /me namespace.
    expect(classifyRoute('/api/scheduling/providers/x/me')).toBe('staff');
    // A traversal shape is never normalised into an allowance.
    expect(classifyRoute('/api/scheduling/../scheduling/providers')).toBe('admin');
  });

  it('is not fooled by case', () => {
    // Next matches paths case-sensitively, so an uppercase variant is a
    // DIFFERENT route — it must not inherit a lower-cased allowance.
    expect(classifyRoute('/API/scheduling/me/schedule')).toBe('admin');
  });

  it('ignores query strings and trailing slashes', () => {
    expect(classifyRoute('/me/')).toBe('provider');
    expect(classifyRoute('/login/')).toBe('public');
  });
});

describe('isAllowed — role against classification', () => {
  const cases: Array<[Access, SessionRole, boolean]> = [
    ['public', 'anonymous', true],
    ['public', 'provider', true],
    ['public', 'admin', true],

    ['provider', 'anonymous', false],
    ['provider', 'provider', true],
    ['provider', 'admin', true], // an admin may view the provider surface

    ['admin', 'anonymous', false],
    ['admin', 'provider', false], // the case that matters
    ['admin', 'admin', true],
  ];

  for (const [access, role, expected] of cases) {
    it(`${role} on a ${access} route → ${expected ? 'allow' : 'deny'}`, () => {
      expect(isAllowed(access, role)).toBe(expected);
    });
  }

  it('denies a provider every admin path in the real route list', () => {
    for (const p of [
      '/providers', '/providers/abc-123', '/schedules', '/board', '/settings',
      '/api/scheduling/providers/abc-123/burden',
      '/api/scheduling/providers/abc-123/compensation',
    ]) {
      expect(isAllowed(classifyRoute(p), 'provider'), p).toBe(false);
    }
  });

  it('denies an unknown role rather than guessing', () => {
    expect(isAllowed('admin', 'wat' as SessionRole)).toBe(false);
    expect(isAllowed('provider', 'wat' as SessionRole)).toBe(false);
  });
});

describe('the prefix lists themselves', () => {
  it('every public prefix is absolute and non-empty', () => {
    // An empty or relative prefix would make startsWith match everything.
    for (const p of [...PUBLIC_PREFIXES, ...PROVIDER_PREFIXES]) {
      expect(p.startsWith('/'), p).toBe(true);
      expect(p.length, p).toBeGreaterThan(1);
    }
  });

  it('no provider prefix is also a public prefix', () => {
    for (const p of PROVIDER_PREFIXES) {
      expect(PUBLIC_PREFIXES).not.toContain(p);
    }
  });

  it('the public list stays short and reviewed', () => {
    // A guard against creep: every entry here is a route reachable with NO
    // credential. Growing this list should be a deliberate, noticed act.
    //
    // The ceiling rose from 6 to 10 on 2026-09-18 when the blanket
    // '/api/auth' prefix was replaced by the five real pre-session routes.
    // The COUNT went up and the SURFACE went down — a namespace prefix made
    // every future route beneath it public, which is what this guard is
    // actually for. Read the list, not just the number.
    expect(PUBLIC_PREFIXES.length).toBeLessThanOrEqual(10);
  });

  it('exposes no namespace prefix broad enough to catch a future route', () => {
    // The failure mode the narrowing fixed: '/api/auth' would have made a
    // later '/api/auth/users' public by default.
    for (const p of PUBLIC_PREFIXES) {
      expect(p.split('/').filter(Boolean).length, `${p} is too broad`)
        .toBeGreaterThanOrEqual(p.startsWith('/api/') ? 3 : 1);
    }
  });
});

// ── The staff tier (2026-09-18) ───────────────────────────────────────────
// Back-office coordinators work in the app all day but must not be able to
// change how it behaves, and must not be able to reach whatever user
// administration is eventually built.
describe('isAllowed — the staff tier', () => {
  it('lets staff reach the staff surface', () => {
    expect(isAllowed('staff', 'staff')).toBe(true);
  });

  it('does NOT let staff reach an admin surface', () => {
    expect(isAllowed('admin', 'staff')).toBe(false);
  });

  it('does NOT let staff reach the PROVIDER surface', () => {
    // A coordinator has no provider record, so /me has nothing to show them.
    // Granting it would also be a step toward one person's session reading
    // another person's clinical record.
    expect(isAllowed('provider', 'staff')).toBe(false);
  });

  it('does NOT let a provider reach the staff surface', () => {
    // The tiers are not nested. A physician gaining the coordinator surface
    // would get every colleague's record.
    expect(isAllowed('staff', 'provider')).toBe(false);
  });

  it('lets an admin reach everything, including staff', () => {
    expect(isAllowed('staff', 'admin')).toBe(true);
  });

  it('refuses an anonymous session at every non-public tier', () => {
    expect(isAllowed('staff', 'anonymous')).toBe(false);
    expect(isAllowed('provider', 'anonymous')).toBe(false);
    expect(isAllowed('admin', 'anonymous')).toBe(false);
  });

  it('refuses an unrecognised role rather than treating it as harmless', () => {
    expect(isAllowed('staff', 'nonsense' as never)).toBe(false);
  });
});

describe('the staff tier cannot reach anything structural', () => {
  // The whole point of the tier. Each of these, reached by staff, would let
  // one account change how schedules generate or who may sign in.
  const structural = [
    '/rules',
    '/settings',
    '/api/scheduling/call-patterns/propose',
    '/api/scheduling/call-patterns/apply',
    '/api/scheduling/call-patterns/revert',
    '/api/scheduling/shift-types',
    '/api/scheduling/shift-templates',
    '/api/scheduling/organizations',
    '/api/scheduling/assistant',
    '/api/board/assistant',
  ];

  it.each(structural)('%s is admin-only and closed to staff', (path) => {
    const access = classifyRoute(path);
    expect(access).toBe('admin');
    expect(isAllowed(access, 'staff')).toBe(false);
  });

  it('a future user-administration route is admin-only without anyone remembering', () => {
    // Deny-by-default is what guarantees this. There is no such route today —
    // invitations are minted by a local script needing the service-role key —
    // so "lock the owner out" is not reachable over HTTP by any role.
    for (const p of ['/api/auth/users', '/api/scheduling/users', '/api/scheduling/roles']) {
      expect(classifyRoute(p), p).toBe('admin');
    }
  });
});

describe('UAS Master is admin-only, its per-site dashboards are not', () => {
  // Gabriel 2026-09-22: the whole-group roll-up is for admins; a site's own
  // dashboard stays open to back office. Expressing that needed EXACT matching
  // — a prefix entry cannot separate a path from its own children.

  it('/dashboard itself is admin-only', () => {
    expect(classifyRoute('/dashboard')).toBe('admin');
    expect(isAllowed(classifyRoute('/dashboard'), 'staff')).toBe(false);
    expect(isAllowed(classifyRoute('/dashboard'), 'provider')).toBe(false);
    expect(isAllowed(classifyRoute('/dashboard'), 'anonymous')).toBe(false);
    expect(isAllowed(classifyRoute('/dashboard'), 'admin')).toBe(true);
  });

  it('a trailing slash is the same route, not a way around the gate', () => {
    expect(classifyRoute('/dashboard/')).toBe('admin');
  });

  it('a query string does not open it either', () => {
    expect(classifyRoute('/dashboard?site=all')).toBe('admin');
  });

  it('a SITE dashboard stays reachable by staff', () => {
    const p = '/dashboard/2ddd2427-22fb-4290-9c4c-03a957e5af4e';
    expect(classifyRoute(p)).toBe('staff');
    expect(isAllowed(classifyRoute(p), 'staff')).toBe(true);
  });

  it('the exact carve-out does not swallow a sibling route that merely starts the same', () => {
    // '/dashboards' is a different path and must not inherit the carve-out by
    // string prefix — it falls to the admin default for its own reason.
    expect(classifyRoute('/dashboards')).toBe('admin');
  });

  it('still denies a provider the per-site dashboard', () => {
    // Narrowing the roll-up must not accidentally widen anything below it.
    const p = '/dashboard/abc';
    expect(isAllowed(classifyRoute(p), 'provider')).toBe(false);
  });
});
