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
  });
}
