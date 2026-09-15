// A deliberately small client-side cache for the GETs that gate a page.
//
// ── THE PROBLEM IT SOLVES ──────────────────────────────────────────────────
// Every list page is a client component, so its data arrives only after the
// browser hydrates and fetches. Worse, five of them WATERFALL: they fetch the
// organization list first and gate the real query behind it
// (`if (!orgId) return`). There is exactly one organization, so that first
// round trip exists only to learn an id that never changes — and it delays
// everything behind it, on every navigation.
//
// The round trip is not cheap either. The auth gate matches /api/*, so each
// call re-establishes the session before it reaches a query.
//
// ── WHY THIS IS NOT A GENERAL SWR LAYER ────────────────────────────────────
// The obvious move is stale-while-revalidate over every endpoint. Rejected on
// purpose: this is a scheduling tool where people edit an assignment and
// immediately look to see it land. Serving them a stale list — even for a few
// seconds, even with a refresh behind it — reads as "my change did not save",
// which is a far worse failure than a slow page.
//
// So this caches only lookups that are BOTH gating and near-static: the
// organization (one row, never changes) and the site list (changes when a site
// is added, which is rare and which invalidates here explicitly). Provider,
// schedule and assignment reads deliberately stay uncached, so an edit is
// always visible the moment it is made.
//
// Scope is the tab: a module-level Map, cleared by a full page load. That is
// the right lifetime for "this never changes while you work".

interface Entry {
  at: number;
  status: number;
  body: string;
}

const entries = new Map<string, Entry>();
/** In-flight requests, so two components asking at once make ONE call. */
const inFlight = new Map<string, Promise<Response>>();

/** Long enough to cover a work session's navigation; short enough to self-heal. */
export const DEFAULT_TTL_MS = 5 * 60_000;

/**
 * A GET whose response may be served from this tab's memory.
 *
 * Returns a real Response, freshly constructed each time, because a Response
 * body can only be read once — handing the same object to two callers would
 * give the second one an empty body.
 *
 * A non-OK response is never cached: an error is a moment in time, and
 * remembering it would keep a page broken after the cause was fixed.
 */
export async function cachedFetch(
  url: string,
  opts: { ttlMs?: number; now?: () => number } = {},
): Promise<Response> {
  const { ttlMs = DEFAULT_TTL_MS, now = Date.now } = opts;

  const hit = entries.get(url);
  if (hit && now() - hit.at < ttlMs) {
    return new Response(hit.body, { status: hit.status });
  }

  const pending = inFlight.get(url);
  if (pending) {
    // Share the single outstanding request. `.clone()` so each awaiting caller
    // gets its own readable body.
    const shared = await pending;
    return shared.clone();
  }

  const request = (async () => {
    const res = await fetch(url);
    const body = await res.text();
    if (res.ok) entries.set(url, { at: now(), status: res.status, body });
    return new Response(body, { status: res.status });
  })();

  inFlight.set(url, request);
  try {
    const res = await request;
    return res.clone();
  } finally {
    inFlight.delete(url);
  }
}

/**
 * Drop cached entries. Call after a mutation that would change them.
 *
 * `prefix` is matched against the start of the URL, so invalidating
 * '/api/scheduling/sites' clears every query-string variant of it — which is
 * the point, since the caller rarely knows which variants are in play.
 */
export function invalidateCache(prefix?: string): void {
  if (prefix === undefined) {
    entries.clear();
    return;
  }
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}

/** Test seam. */
export function cacheSize(): number {
  return entries.size;
}
