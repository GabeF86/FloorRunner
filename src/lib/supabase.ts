import { createClient } from '@supabase/supabase-js';

const supabaseUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey  = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Single browser-side client (safe to call many times — returns same instance)
export const supabase = createClient(supabaseUrl, supabaseKey);
