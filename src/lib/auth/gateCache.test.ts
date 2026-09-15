import { describe, it, expect } from 'vitest';
import { makeRoleCache, makeJwksCache } from './gateCache';

/** A clock the test drives, so nothing here waits on real time. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('role cache', () => {
  it('reads through on a miss and serves the same answer after', async () => {
    const clock = fakeClock();
    const cache = makeRoleCache({ ttlMs: 60_000, max: 10, clock });
    let calls = 0;
    const load = async () => { calls++; return ['admin']; };

    expect(await cache.get('u1', load)).toEqual(['admin']);
    expect(await cache.get('u1', load)).toEqual(['admin']);
    expect(await cache.get('u1', load)).toEqual(['admin']);
    expect(calls).toBe(1);
  });

  it('keys by user — one person can never be served another\'s roles', async () => {
    // The failure this guards against is privilege confusion, which is the
    // worst thing a cache in an auth gate could do.
    const cache = makeRoleCache({ ttlMs: 60_000, max: 10, clock: fakeClock() });
    const roles: Record<string, string[]> = { admin1: ['admin'], prov1: ['provider'] };
    const load = async (id: string) => roles[id] ?? [];

    expect(await cache.get('admin1', load)).toEqual(['admin']);
    expect(await cache.get('prov1', load)).toEqual(['provider']);
    expect(await cache.get('admin1', load)).toEqual(['admin']);
    expect(await cache.get('prov1', load)).toEqual(['provider']);
  });

  it('re-reads once the entry is older than the TTL', async () => {
    const clock = fakeClock();
    const cache = makeRoleCache({ ttlMs: 60_000, max: 10, clock });
    let current = ['admin'];
    let calls = 0;
    const load = async () => { calls++; return current; };

    expect(await cache.get('u1', load)).toEqual(['admin']);
    clock.advance(59_999);
    expect(await cache.get('u1', load)).toEqual(['admin']);
    expect(calls).toBe(1);

    // Admin revoked in the database.
    current = ['provider'];
    clock.advance(2);
    expect(await cache.get('u1', load)).toEqual(['provider']);
    expect(calls).toBe(2);
  });

  it('NEVER caches an empty result', async () => {
    // The single most important line in the module. The uncached lookup
    // returns [] both for "holds no roles" and for "the database did not
    // answer" — it fails closed. Caching that would turn a one-second blip
    // into a full minute of a signed-in chief being bounced to /login.
    const clock = fakeClock();
    const cache = makeRoleCache({ ttlMs: 60_000, max: 10, clock });
    let calls = 0;
    let answer: string[] = [];
    const load = async () => { calls++; return answer; };

    expect(await cache.get('u1', load)).toEqual([]);
    expect(await cache.get('u1', load)).toEqual([]);
    expect(calls).toBe(2); // read through both times, not cached

    // The moment the database recovers, the very next request sees it —
    // no waiting for a TTL that was never started.
    answer = ['admin'];
    expect(await cache.get('u1', load)).toEqual(['admin']);
    expect(calls).toBe(3);
  });

  it('a miss behaves exactly like the uncached lookup', async () => {
    // The rule the whole module follows: a cache may make a decision fast, it
    // may never make one different.
    const cache = makeRoleCache({ ttlMs: 60_000, max: 10, clock: fakeClock() });
    for (const answer of [[], ['admin'], ['provider'], ['admin', 'provider']]) {
      cache.invalidate();
      expect(await cache.get('u', async () => answer)).toEqual(answer);
    }
  });

  it('clears rather than growing without bound', async () => {
    const cache = makeRoleCache({ ttlMs: 60_000, max: 3, clock: fakeClock() });
    for (const id of ['a', 'b', 'c']) await cache.get(id, async () => ['provider']);
    expect(cache.size).toBe(3);
    await cache.get('d', async () => ['provider']);
    expect(cache.size).toBe(1); // cleared, then the new entry
  });

  it('can be invalidated for one user or all, so a change can be forced through', async () => {
    const cache = makeRoleCache({ ttlMs: 60_000, max: 10, clock: fakeClock() });
    await cache.get('u1', async () => ['admin']);
    await cache.get('u2', async () => ['provider']);
    cache.invalidate('u1');
    expect(cache.size).toBe(1);
    cache.invalidate();
    expect(cache.size).toBe(0);
  });
});

describe('jwks cache', () => {
  const keySet = { keys: [{ kid: 'k1', alg: 'ES256' }] };
  const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

  it('fetches once and reuses — the reason getClaims is cheaper than getUser', async () => {
    // Without this the per-request Supabase client fetches the key set every
    // time, and local verification saves nothing at all.
    const clock = fakeClock();
    let calls = 0;
    const cache = makeJwksCache({
      ttlMs: 600_000, clock,
      fetchImpl: (async () => { calls++; return ok(keySet); }) as unknown as typeof fetch,
    });

    expect(await cache.get('https://x.supabase.co')).toEqual(keySet);
    expect(await cache.get('https://x.supabase.co')).toEqual(keySet);
    expect(calls).toBe(1);

    clock.advance(600_001);
    await cache.get('https://x.supabase.co');
    expect(calls).toBe(2);
  });

  it('asks the right URL', async () => {
    let seen = '';
    const cache = makeJwksCache({
      ttlMs: 1000, clock: fakeClock(),
      fetchImpl: (async (u: string) => { seen = u; return ok(keySet); }) as unknown as typeof fetch,
    });
    await cache.get('https://x.supabase.co');
    expect(seen).toBe('https://x.supabase.co/auth/v1/.well-known/jwks.json');
  });

  it('keeps a stale key set rather than none when a refresh fails', async () => {
    // Signing keys rotate on the order of months, so the old set is almost
    // certainly still valid — and returning null would push every request onto
    // the network path this exists to avoid.
    const clock = fakeClock();
    let mode: 'ok' | 'fail' = 'ok';
    const cache = makeJwksCache({
      ttlMs: 1000, clock,
      fetchImpl: (async () => {
        if (mode === 'fail') throw new Error('network down');
        return ok(keySet);
      }) as unknown as typeof fetch,
    });

    expect(await cache.get('https://x.supabase.co')).toEqual(keySet);
    mode = 'fail';
    clock.advance(2000);
    expect(await cache.get('https://x.supabase.co')).toEqual(keySet);
  });

  it('returns null when it has never succeeded, so the caller takes the slow path', async () => {
    const cache = makeJwksCache({
      ttlMs: 1000, clock: fakeClock(),
      fetchImpl: (async () => { throw new Error('down'); }) as unknown as typeof fetch,
    });
    expect(await cache.get('https://x.supabase.co')).toBeNull();
  });

  it('ignores a non-OK response and an empty key set', async () => {
    const cache = makeJwksCache({
      ttlMs: 1000, clock: fakeClock(),
      fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch,
    });
    expect(await cache.get('https://x.supabase.co')).toBeNull();

    const empty = makeJwksCache({
      ttlMs: 1000, clock: fakeClock(),
      fetchImpl: (async () => ok({ keys: [] })) as unknown as typeof fetch,
    });
    expect(await empty.get('https://x.supabase.co')).toBeNull();
  });
});
