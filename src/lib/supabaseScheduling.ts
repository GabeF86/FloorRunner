import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Client for the scheduling schema (separate from the public schema used by floor runner)
export const sbScheduling = createClient(supabaseUrl, supabaseKey, {
  db: { schema: 'scheduling' },
});

// Server-side client for API routes (uses service role to bypass RLS)
export function sbSchedulingServer() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: { schema: 'scheduling' },
      auth: { autoRefreshToken: false, persistSession: false },
    }
  );
}
