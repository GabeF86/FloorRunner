import { createClient } from '@supabase/supabase-js';

// Server-side client factory for API routes (uses service role to bypass RLS).
// Lazy-constructed inside the function — never at module scope — so Next.js
// can import this module during build-time page-data collection without
// needing Supabase env vars present in the build environment. Env vars are
// only required when the function is actually called at request time.
export function makeServerClient(schema: 'public' | 'scheduling') {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase env vars missing — set NEXT_PUBLIC_SUPABASE_URL and either SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    );
  }
  return createClient(url, key, {
    db: { schema },
    auth: { autoRefreshToken: false, persistSession: false },
    // ── NEVER CACHE A DATABASE READ (2026-09-17) ───────────────────────────
    // supabase-js calls the GLOBAL fetch, and Next's App Router replaces
    // global fetch with a caching one. So every server-side query in this app
    // was eligible for Next's Data Cache, and reads were being served from it
    // — a staffing-demand row that had just been deleted came back on the next
    // request, and rows that had just been written did not.
    //
    // It presents as "my entry did not save". The write landed every time; the
    // read that followed was a cached copy of the world from before it, which
    // is the worst possible shape for a bug of this kind — the database is
    // right and the screen is wrong, so the user retypes and loses more.
    //
    // `dynamic = 'force-dynamic'` on a route does NOT cover this: that governs
    // route rendering, not the fetch cache underneath a library. The fix has to
    // sit here, at the one place every server client is built, or the next
    // module to query Supabase inherits the same trap.
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, cache: 'no-store' }),
    },
  });
}
