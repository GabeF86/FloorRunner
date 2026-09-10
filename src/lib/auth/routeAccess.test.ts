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

  it('classifies every real chief-facing page as admin-only', () => {
    for (const p of [
      '/schedules', '/schedules/abc-123', '/providers', '/providers/abc-123',
      '/board', '/sites', '/rules', '/reports', '/settings', '/requests',
      '/block-prep', '/grid-calculator', '/staffing-calculator',
    ]) {
      expect(classifyRoute(p), p).toBe('admin');
    }
  });

  it('classifies every real chief-facing API as admin-only', () => {
    for (const p of [
      '/api/scheduling/providers',
      '/api/scheduling/providers/abc-123',
      '/api/scheduling/providers/abc-123/burden',
      '/api/scheduling/schedules',
      '/api/scheduling/block-prep',
      '/api/scheduling/holiday-call',
      '/api/scheduling/organizations',
    ]) {
      expect(classifyRoute(p), p).toBe('admin');
    }
  });
});

describe('classifyRoute — the named exceptions', () => {
  it('classifies the sign-in and join paths as public', () => {
    expect(classifyRoute('/login')).toBe('public');
    expect(classifyRoute('/join/some-token')).toBe('public');
    expect(classifyRoute('/api/auth/callback')).toBe('public');
    expect(classifyRoute('/api/auth/accept-invite')).toBe('public');
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
    expect(classifyRoute('/api/scheduling/providers/x/me')).toBe('admin');
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
    expect(PUBLIC_PREFIXES.length).toBeLessThanOrEqual(6);
  });
});
