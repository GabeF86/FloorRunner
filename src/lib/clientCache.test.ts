import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cachedFetch, invalidateCache, cacheSize, DEFAULT_TTL_MS } from './clientCache';

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** Counts calls and lets a test control what comes back. */
function stubFetch(handler: (url: string) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    calls.push(url);
    const { status = 200, body = { rows: [] } } = await handler(url);
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

beforeEach(() => {
  invalidateCache();
  vi.unstubAllGlobals();
});

describe('cachedFetch', () => {
  it('fetches once, then serves from memory', async () => {
    const clock = fakeClock();
    const calls = stubFetch(() => ({ body: { rows: [{ id: 'org1' }] } }));

    const a = await cachedFetch('/api/x', { now: clock.now });
    const b = await cachedFetch('/api/x', { now: clock.now });

    expect(await a.json()).toEqual({ rows: [{ id: 'org1' }] });
    expect(await b.json()).toEqual({ rows: [{ id: 'org1' }] });
    expect(calls).toHaveLength(1);
  });

  it('gives every caller its own readable body', async () => {
    // A Response body can be read once. Handing the same object to two callers
    // would give the second an empty body — a bug that looks like a failed
    // request rather than a cache fault.
    stubFetch(() => ({ body: { rows: [1, 2, 3] } }));
    const clock = fakeClock();
    const [a, b, c] = await Promise.all([
      cachedFetch('/api/x', { now: clock.now }),
      cachedFetch('/api/x', { now: clock.now }),
      cachedFetch('/api/x', { now: clock.now }),
    ]);
    expect(await a.json()).toEqual({ rows: [1, 2, 3] });
    expect(await b.json()).toEqual({ rows: [1, 2, 3] });
    expect(await c.json()).toEqual({ rows: [1, 2, 3] });
  });

  it('collapses concurrent requests into ONE network call', async () => {
    // Two components mounting together ask for the same gating lookup; only
    // one request should leave the browser.
    let release: (() => void) | null = null;
    const gate = new Promise<void>(r => { release = () => r(); });
    const calls = stubFetch(async () => { await gate; return { body: { rows: [] } }; });

    const clock = fakeClock();
    const all = Promise.all([
      cachedFetch('/api/x', { now: clock.now }),
      cachedFetch('/api/x', { now: clock.now }),
      cachedFetch('/api/x', { now: clock.now }),
    ]);
    release!();
    await all;
    expect(calls).toHaveLength(1);
  });

  it('re-fetches once the entry is stale', async () => {
    const clock = fakeClock();
    const calls = stubFetch(() => ({ body: { rows: [] } }));

    await cachedFetch('/api/x', { now: clock.now });
    clock.advance(DEFAULT_TTL_MS - 1);
    await cachedFetch('/api/x', { now: clock.now });
    expect(calls).toHaveLength(1);

    clock.advance(2);
    await cachedFetch('/api/x', { now: clock.now });
    expect(calls).toHaveLength(2);
  });

  it('keys by full URL, so a different query is a different entry', async () => {
    const calls = stubFetch(() => ({ body: { rows: [] } }));
    const clock = fakeClock();
    await cachedFetch('/api/sites?org_id=a', { now: clock.now });
    await cachedFetch('/api/sites?org_id=b', { now: clock.now });
    await cachedFetch('/api/sites?org_id=a', { now: clock.now });
    expect(calls).toEqual(['/api/sites?org_id=a', '/api/sites?org_id=b']);
  });

  it('NEVER caches a failure', async () => {
    // An error is a moment in time. Remembering it would keep a page broken
    // for minutes after the cause was fixed.
    const clock = fakeClock();
    let status = 500;
    const calls = stubFetch(() => ({ status, body: { error: 'boom' } }));

    const bad = await cachedFetch('/api/x', { now: clock.now });
    expect(bad.status).toBe(500);
    expect(cacheSize()).toBe(0);

    status = 200;
    const good = await cachedFetch('/api/x', { now: clock.now });
    expect(good.status).toBe(200);
    expect(calls).toHaveLength(2); // retried immediately, no TTL wait
  });

  it('preserves the status code so callers can branch on 401/403', async () => {
    // The auth gate answers 401 on /api/*, and pages read status to tell
    // "signed out" from "no rows".
    stubFetch(() => ({ status: 401, body: { error: 'Sign in required.' } }));
    const res = await cachedFetch('/api/x', { now: fakeClock().now });
    expect(res.status).toBe(401);
    expect(res.ok).toBe(false);
  });
});

describe('invalidateCache', () => {
  it('clears by prefix, covering every query-string variant', async () => {
    const clock = fakeClock();
    const calls = stubFetch(() => ({ body: { rows: [] } }));
    await cachedFetch('/api/sites?org_id=a', { now: clock.now });
    await cachedFetch('/api/sites?org_id=b', { now: clock.now });
    await cachedFetch('/api/providers?org_id=a', { now: clock.now });
    expect(cacheSize()).toBe(3);

    invalidateCache('/api/sites');
    expect(cacheSize()).toBe(1);

    await cachedFetch('/api/sites?org_id=a', { now: clock.now });
    expect(calls).toHaveLength(4); // the sites entry really was dropped
  });

  it('clears everything when given no prefix', async () => {
    const clock = fakeClock();
    stubFetch(() => ({ body: { rows: [] } }));
    await cachedFetch('/api/a', { now: clock.now });
    await cachedFetch('/api/b', { now: clock.now });
    invalidateCache();
    expect(cacheSize()).toBe(0);
  });
});
